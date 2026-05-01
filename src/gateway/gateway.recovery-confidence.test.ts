import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  getPlatformRuntimeCheckpointService,
  resetPlatformRuntimeCheckpointService,
} from "../platform/runtime/index.js";
import {
  buildSessionRunClosureSummary,
  readRecoveryConfidenceSnapshot,
  recordMessagingDeliveryAction,
  recordRunClosureFromEvidence,
  writeRecoverySessionStore,
} from "./recovery-confidence.test-helpers.js";
import { connectOk, installGatewayTestHooks, startServerWithClient } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const MAIN_SESSION_KEY = "agent:main:main";

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];
let sharedSessionStoreDir: string;
let sharedSessionStorePath: string;

beforeAll(async () => {
  const started = await startServerWithClient();
  server = started.server;
  ws = started.ws;
  await connectOk(ws);
  sharedSessionStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recovery-confidence-"));
  sharedSessionStorePath = path.join(sharedSessionStoreDir, "sessions.json");
});

afterEach(() => {
  resetPlatformRuntimeCheckpointService();
});

afterAll(async () => {
  ws.close();
  await server.close();
  await fs.rm(sharedSessionStoreDir, { recursive: true, force: true });
});

async function writeMainSession(entry: Record<string, unknown>) {
  await writeRecoverySessionStore({
    storePath: sharedSessionStorePath,
    entries: {
      main: {
        updatedAt: Date.now(),
        ...entry,
      },
    },
  });
}

describe("gateway recovery confidence evals", () => {
  test("keeps confirmed delivery, closure truth, and handoff summary aligned", async () => {
    recordMessagingDeliveryAction({
      actionId: "messaging:success",
      runId: "run-success",
      requestRunId: "request-success",
      sessionKey: MAIN_SESSION_KEY,
      finalState: "confirmed",
      receipt: {
        operation: "deliver",
        deliveryResults: [
          {
            channel: "whatsapp",
            messageId: "msg-success",
            toJid: "jid-success",
          },
        ],
      },
    });
    const closure = recordRunClosureFromEvidence({
      runId: "run-success",
      requestRunId: "request-success",
      sessionKey: MAIN_SESSION_KEY,
      evidence: {
        hasOutput: true,
        stagedReplyCount: 1,
        attemptedDeliveryCount: 1,
        confirmedDeliveryCount: 1,
        deliveredReplyCount: 1,
      },
    });
    await writeMainSession({
      sessionId: "sess-success",
      status: "done",
      runClosureSummary: buildSessionRunClosureSummary(closure),
    });

    const snapshot = await readRecoveryConfidenceSnapshot({
      ws,
      sessionKey: MAIN_SESSION_KEY,
      requestRunId: "request-success",
    });

    expect(snapshot.row).toMatchObject({
      key: MAIN_SESSION_KEY,
      status: "done",
      handoffTruthSource: "closure",
      handoffRequestRunId: "request-success",
      handoffRunId: "run-success",
      runClosureSummary: expect.objectContaining({
        acceptanceStatus: "satisfied",
        action: "close",
      }),
    });
    expect(snapshot.actions).toEqual([
      expect.objectContaining({
        actionId: "messaging:success",
        runId: "run-success",
        idempotencyKey: "request-success",
        state: "confirmed",
      }),
    ]);
    expect(snapshot.closures).toEqual([
      expect.objectContaining({
        runId: "run-success",
        requestRunId: "request-success",
        acceptanceOutcome: expect.objectContaining({
          status: "satisfied",
          action: "close",
        }),
      }),
    ]);
    expect(snapshot.checkpoints).toEqual([]);
  });

  test("keeps non-clean delivery outcomes retryable instead of masking them as delivered", async () => {
    recordMessagingDeliveryAction({
      actionId: "messaging:failed",
      runId: "run-failed",
      requestRunId: "request-failed",
      sessionKey: MAIN_SESSION_KEY,
      finalState: "failed",
      lastError: "channel offline",
      retryable: true,
    });
    const closure = recordRunClosureFromEvidence({
      runId: "run-failed",
      requestRunId: "request-failed",
      sessionKey: MAIN_SESSION_KEY,
      evidence: {
        stagedReplyCount: 1,
        attemptedDeliveryCount: 1,
        confirmedDeliveryCount: 0,
        failedDeliveryCount: 1,
      },
    });
    await writeMainSession({
      sessionId: "sess-failed",
      status: "failed",
      runClosureSummary: buildSessionRunClosureSummary(closure),
    });

    const snapshot = await readRecoveryConfidenceSnapshot({
      ws,
      sessionKey: MAIN_SESSION_KEY,
      requestRunId: "request-failed",
    });

    expect(snapshot.row).toMatchObject({
      key: MAIN_SESSION_KEY,
      status: "blocked",
      handoffTruthSource: "closure",
      handoffRequestRunId: "request-failed",
      handoffRunId: "run-failed",
      runClosureSummary: expect.objectContaining({
        outcomeStatus: "partial",
        acceptanceStatus: "retryable",
        action: "retry",
        remediation: "semantic_retry",
      }),
    });
    expect(snapshot.actions).toEqual([
      expect.objectContaining({
        actionId: "messaging:failed",
        runId: "run-failed",
        idempotencyKey: "request-failed",
        state: "failed",
        retryable: true,
        lastError: "channel offline",
      }),
    ]);
    expect(snapshot.closures).toEqual([
      expect.objectContaining({
        runId: "run-failed",
        requestRunId: "request-failed",
        acceptanceOutcome: expect.objectContaining({
          status: "retryable",
          action: "retry",
          remediation: "semantic_retry",
        }),
      }),
    ]);
  });

  test("prefers active recovery handoff truth while reusing the original confirmed delivery evidence", async () => {
    recordMessagingDeliveryAction({
      actionId: "messaging:confirmed-once",
      runId: "run-original",
      requestRunId: "request-original",
      sessionKey: MAIN_SESSION_KEY,
      finalState: "confirmed",
      receipt: {
        operation: "deliver",
        deliveryResults: [
          {
            channel: "telegram",
            messageId: "msg-original",
            toJid: "jid-original",
          },
        ],
      },
    });
    const originalClosure = recordRunClosureFromEvidence({
      runId: "run-original",
      requestRunId: "request-original",
      sessionKey: MAIN_SESSION_KEY,
      evidence: {
        stagedReplyCount: 1,
        attemptedDeliveryCount: 1,
        confirmedDeliveryCount: 1,
        deliveredReplyCount: 1,
      },
    });
    const runtime = getPlatformRuntimeCheckpointService();
    runtime.createCheckpoint({
      id: "closure:run-recovery:resume",
      runId: "run-recovery",
      sessionKey: MAIN_SESSION_KEY,
      boundary: "exec_approval",
      blockedReason: "delivery confirmation needs closure recovery",
      target: {
        approvalId: "closure:run-recovery:resume",
        operation: "closure.recovery",
      },
      continuation: {
        kind: "closure_recovery",
        state: "running",
        attempts: 2,
      },
    });
    runtime.updateCheckpoint("closure:run-recovery:resume", {
      status: "resumed",
      resumedAtMs: 2_100,
    });
    await writeMainSession({
      sessionId: "sess-recovery",
      status: "blocked",
      runClosureSummary: buildSessionRunClosureSummary(originalClosure),
    });

    const snapshot = await readRecoveryConfidenceSnapshot({
      ws,
      sessionKey: MAIN_SESSION_KEY,
      requestRunId: "request-original",
    });
    const sessionActions = runtime.listActions({
      sessionKey: MAIN_SESSION_KEY,
      kind: "messaging_delivery",
    });

    expect(snapshot.row).toMatchObject({
      key: MAIN_SESSION_KEY,
      status: "running",
      handoffTruthSource: "recovery",
      handoffRequestRunId: "request-original",
      handoffRunId: "run-recovery",
      runClosureSummary: expect.objectContaining({
        runId: "run-original",
      }),
    });
    expect(snapshot.closures).toEqual([
      expect.objectContaining({
        runId: "run-original",
        requestRunId: "request-original",
      }),
    ]);
    expect(snapshot.checkpoints).toEqual([
      expect.objectContaining({
        id: "closure:run-recovery:resume",
        runId: "run-recovery",
        status: "resumed",
        continuation: expect.objectContaining({
          kind: "closure_recovery",
          state: "running",
          attempts: 2,
        }),
      }),
    ]);
    expect(snapshot.actions).toEqual([
      expect.objectContaining({
        actionId: "messaging:confirmed-once",
        runId: "run-original",
        idempotencyKey: "request-original",
        state: "confirmed",
      }),
    ]);
    expect(sessionActions).toEqual([
      expect.objectContaining({
        actionId: "messaging:confirmed-once",
        runId: "run-original",
        idempotencyKey: "request-original",
        state: "confirmed",
      }),
    ]);
  });
});
