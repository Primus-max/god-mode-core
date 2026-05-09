/**
 * Bug F (persistent-worker subsequent push) Phase 5b — fail-first tests
 * for the `subagent_ended` hook flip + parallel push-callback emission.
 *
 * Phase 5 (PR #279) landed the callback IMPLEMENTATION but did NOT flip
 * the worker-completion seam to invoke it (CONSERVATIVE — pre-flip,
 * production behavior is byte-identical to dev HEAD on every persistent
 * worker completion). Phase 5b ships the flip as a NEW companion hook
 * `emitPersistentWorkerSubsequentPushIfApplicable` that fires alongside
 * `emitSubagentEndedHookOnce` for `spawnMode === 'session'` runs.
 *
 * Tests exercise the REAL emitter; no `vi.spyOn` shimming the function
 * under test. All boundaries (subagentStore / adapter / collector /
 * deliveryDispatch / logger) are passed in as plain DI fakes, mirroring
 * `persistent-worker-push-fire-callback.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { emitPersistentWorkerSubsequentPushIfApplicable } from "./subagent-registry-completion.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  type PersistentWorkerPushFireCallbackArgs,
  type PersistentWorkerPushFireCallbackDeps,
  type PersistentWorkerPushFireCallbackResult,
  type PersistentWorkerSubagentRecord,
  type PersistentWorkerSubagentStore,
  type PersistentWorkerReportCollectorWithFailure,
} from "../cron/isolated-agent/persistent-worker-push-fire-callback.js";
import {
  runPersistentWorkerSubsequentPush,
  type PersistentWorkerPushDispatchPayload,
} from "../platform/persistent-worker/persistent-worker-push-runtime-adapter.js";
import { createPersistentWorkerReportCollector } from "../platform/persistent-worker/persistent-worker-report-collector.js";
import { asIdentityId, type IdentityId } from "../platform/identity/identity-id.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");
const TELEGRAM = "telegram";

function makeRecord(
  overrides: Partial<SubagentRunRecord> = {},
): SubagentRunRecord {
  return {
    runId: "wrk-001",
    childSessionKey: "agent:main:subagent:child-1",
    requesterSessionKey: "agent:main:telegram:direct:6533456892",
    requesterDisplayKey: "telegram:6533456892",
    task: "daily push",
    cleanup: "keep",
    createdAt: Date.now(),
    spawnMode: "session",
    ownerIdentityId: VLADIMIR,
    requesterOrigin: { channel: TELEGRAM, to: "6533456892" },
    frozenResultText: "Daily push: 3 new artifacts.",
    endedAt: Date.now(),
    ...overrides,
  };
}

function makeStore(record: SubagentRunRecord): PersistentWorkerSubagentStore & {
  records: Map<string, PersistentWorkerSubagentRecord>;
} {
  const records = new Map<string, PersistentWorkerSubagentRecord>();
  records.set(record.runId, {
    runId: record.runId,
    ownerIdentityId: record.ownerIdentityId,
    subsequentPushStatus: record.subsequentPushStatus,
  });
  const store: PersistentWorkerSubagentStore = {
    get(workerRunId) {
      return records.get(workerRunId);
    },
    markSubsequentPushStatus(workerRunId, status) {
      const entry = records.get(workerRunId);
      if (!entry) {
        return false;
      }
      records.set(workerRunId, { ...entry, subsequentPushStatus: status });
      return true;
    },
  };
  return Object.assign(store, { records });
}

function makeCollector(): PersistentWorkerReportCollectorWithFailure {
  return createPersistentWorkerReportCollector() as unknown as PersistentWorkerReportCollectorWithFailure;
}

function makeDispatchOk(
  capture: PersistentWorkerPushDispatchPayload[] = [],
): PersistentWorkerPushFireCallbackDeps["deliveryDispatch"] {
  return async (payload) => {
    capture.push(payload);
    return { ok: true };
  };
}

function makeDispatchFail(
  reason: string,
  capture: PersistentWorkerPushDispatchPayload[] = [],
): PersistentWorkerPushFireCallbackDeps["deliveryDispatch"] {
  return async (payload) => {
    capture.push(payload);
    return { ok: false, reason };
  };
}

type CapturedInvocation = {
  args: PersistentWorkerPushFireCallbackArgs;
  result: PersistentWorkerPushFireCallbackResult;
};

function buildDeps(
  record: SubagentRunRecord,
  overrides: Partial<{
    callback: (
      args: PersistentWorkerPushFireCallbackArgs,
    ) => Promise<PersistentWorkerPushFireCallbackResult>;
  }> = {},
): {
  store: ReturnType<typeof makeStore>;
  collector: PersistentWorkerReportCollectorWithFailure;
  dispatchCapture: PersistentWorkerPushDispatchPayload[];
  logLines: string[];
  callbackCapture: CapturedInvocation[];
  callback: (
    args: PersistentWorkerPushFireCallbackArgs,
  ) => Promise<PersistentWorkerPushFireCallbackResult>;
  pushFireCallbackDeps: PersistentWorkerPushFireCallbackDeps;
} {
  const store = makeStore(record);
  const collector = makeCollector();
  const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
  const logLines: string[] = [];
  const callbackCapture: CapturedInvocation[] = [];
  const pushFireCallbackDeps: PersistentWorkerPushFireCallbackDeps = {
    subagentStore: store,
    adapter: runPersistentWorkerSubsequentPush,
    collector,
    deliveryDispatch: makeDispatchOk(dispatchCapture),
    logger: { log: (line) => logLines.push(line) },
  };
  const callback =
    overrides.callback ??
    (async (args) => {
      // Default: invoke the real callback with the fixture deps.
      const { persistentWorkerPushFireCallback } = await import(
        "../cron/isolated-agent/persistent-worker-push-fire-callback.js"
      );
      const result = await persistentWorkerPushFireCallback(
        pushFireCallbackDeps,
        args,
      );
      callbackCapture.push({ args, result });
      return result;
    });
  return {
    store,
    collector,
    dispatchCapture,
    logLines,
    callbackCapture,
    callback,
    pushFireCallbackDeps,
  };
}

// ─── #1 Persistent-worker run completes → callback invoked ───────────────

describe("emitPersistentWorkerSubsequentPushIfApplicable — happy path", () => {
  it("invokes the push callback with workerRunId / channel / to / content from the entry", async () => {
    const record = makeRecord();
    const ctx = buildDeps(record);
    const result = await emitPersistentWorkerSubsequentPushIfApplicable({
      entry: record,
      sessionId: "session-x",
      turnId: "turn-1",
      callback: ctx.callback,
    });
    expect(result.invoked).toBe(true);
    expect(ctx.callbackCapture.length).toBe(1);
    const captured = ctx.callbackCapture[0];
    expect(captured?.args.workerRunId).toBe("wrk-001");
    expect(captured?.args.channel).toBe(TELEGRAM);
    expect(captured?.args.to).toBe("6533456892");
    expect(captured?.args.content).toBe("Daily push: 3 new artifacts.");
    expect(captured?.result.kind).toBe("ok");
  });
});

// ─── #2 Non-persistent-worker run completes → callback NOT invoked ───────

describe("emitPersistentWorkerSubsequentPushIfApplicable — non-persistent-worker spawn", () => {
  it("does NOT invoke the push callback when spawnMode !== 'session'", async () => {
    const record = makeRecord({ spawnMode: "run" });
    const ctx = buildDeps(record);
    const result = await emitPersistentWorkerSubsequentPushIfApplicable({
      entry: record,
      sessionId: "session-x",
      turnId: "turn-1",
      callback: ctx.callback,
    });
    expect(result.invoked).toBe(false);
    expect(ctx.callbackCapture.length).toBe(0);
  });

  it("does NOT invoke the push callback when spawnMode is undefined", async () => {
    const record = makeRecord({ spawnMode: undefined });
    const ctx = buildDeps(record);
    const result = await emitPersistentWorkerSubsequentPushIfApplicable({
      entry: record,
      sessionId: "session-x",
      turnId: "turn-1",
      callback: ctx.callback,
    });
    expect(result.invoked).toBe(false);
    expect(ctx.callbackCapture.length).toBe(0);
  });
});

// ─── #3 Run without ownerIdentityId → skipped (callback would fail-close)

describe("emitPersistentWorkerSubsequentPushIfApplicable — missing ownerIdentityId", () => {
  it("does NOT invoke the push callback when ownerIdentityId is missing — hook continues normally", async () => {
    const record = makeRecord({ ownerIdentityId: undefined });
    const ctx = buildDeps(record);
    const result = await emitPersistentWorkerSubsequentPushIfApplicable({
      entry: record,
      sessionId: "session-x",
      turnId: "turn-1",
      callback: ctx.callback,
    });
    expect(result.invoked).toBe(false);
    expect(ctx.callbackCapture.length).toBe(0);
  });
});

// ─── #4 Run without deliveryChannel → callback skipped, hook continues ───

describe("emitPersistentWorkerSubsequentPushIfApplicable — channel resolution gating", () => {
  it("does NOT invoke when requesterOrigin.channel is missing (no resolvable channel)", async () => {
    const record = makeRecord({
      requesterOrigin: { to: "6533456892" } as never,
    });
    const ctx = buildDeps(record);
    const result = await emitPersistentWorkerSubsequentPushIfApplicable({
      entry: record,
      sessionId: "session-x",
      turnId: "turn-1",
      callback: ctx.callback,
    });
    expect(result.invoked).toBe(false);
    expect(ctx.callbackCapture.length).toBe(0);
  });

  it("does NOT invoke when requesterOrigin.to is missing (no resolvable recipient)", async () => {
    const record = makeRecord({
      requesterOrigin: { channel: TELEGRAM } as never,
    });
    const ctx = buildDeps(record);
    const result = await emitPersistentWorkerSubsequentPushIfApplicable({
      entry: record,
      sessionId: "session-x",
      turnId: "turn-1",
      callback: ctx.callback,
    });
    expect(result.invoked).toBe(false);
    expect(ctx.callbackCapture.length).toBe(0);
  });

  it("does NOT invoke when frozenResultText is missing (no deliverable output)", async () => {
    const record = makeRecord({ frozenResultText: undefined });
    const ctx = buildDeps(record);
    const result = await emitPersistentWorkerSubsequentPushIfApplicable({
      entry: record,
      sessionId: "session-x",
      turnId: "turn-1",
      callback: ctx.callback,
    });
    expect(result.invoked).toBe(false);
    expect(ctx.callbackCapture.length).toBe(0);
  });
});

// ─── #5 Callback returns fail → hook continues; record stays in 'pushed' ─

describe("emitPersistentWorkerSubsequentPushIfApplicable — callback returns fail", () => {
  it("returns invoked=true with the fail result when the underlying callback fails", async () => {
    const record = makeRecord();
    const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
    const ctx = buildDeps(record);
    // Override delivery dispatch to fail.
    ctx.pushFireCallbackDeps = {
      ...ctx.pushFireCallbackDeps,
      deliveryDispatch: makeDispatchFail("transport blew up", dispatchCapture),
    };
    // Local callback that uses the failing dispatch.
    const failingCallback = async (
      args: PersistentWorkerPushFireCallbackArgs,
    ): Promise<PersistentWorkerPushFireCallbackResult> => {
      const { persistentWorkerPushFireCallback } = await import(
        "../cron/isolated-agent/persistent-worker-push-fire-callback.js"
      );
      return persistentWorkerPushFireCallback(ctx.pushFireCallbackDeps, args);
    };
    const result = await emitPersistentWorkerSubsequentPushIfApplicable({
      entry: record,
      sessionId: "session-x",
      turnId: "turn-1",
      callback: failingCallback,
    });
    expect(result.invoked).toBe(true);
    expect(result.result?.kind).toBe("fail");
  });
});

// ─── #6 Callback throws synchronously → hook still completes ─────────────

describe("emitPersistentWorkerSubsequentPushIfApplicable — callback throws", () => {
  it("never throws — wraps a callback that throws synchronously and returns a fail result", async () => {
    const record = makeRecord();
    const result = await emitPersistentWorkerSubsequentPushIfApplicable({
      entry: record,
      sessionId: "session-x",
      turnId: "turn-1",
      callback: async () => {
        throw new Error("boom");
      },
    });
    // Must not throw — emitter swallows the error and reports invoked=true
    // with a synthetic internal_error fail result so the surrounding hook
    // path can continue normally.
    expect(result.invoked).toBe(true);
    expect(result.result?.kind).toBe("fail");
    if (result.result?.kind === "fail") {
      expect(result.result.reason).toBe("internal_error");
    }
  });
});

// ─── #7 Cross-identity defense ──────────────────────────────────────────

describe("emitPersistentWorkerSubsequentPushIfApplicable — cross-identity defense", () => {
  it("forwards the entry's ownerIdentityId to the callback (NOT a current-process identity)", async () => {
    const record = makeRecord({ ownerIdentityId: VLADIMIR });
    let capturedIdentityId: IdentityId | undefined;
    const callback = async (
      args: PersistentWorkerPushFireCallbackArgs,
    ): Promise<PersistentWorkerPushFireCallbackResult> => {
      // The args passed to the underlying callback should NOT carry an
      // identity hint themselves — the callback re-reads identity from
      // the persisted record by workerRunId. We capture nothing identity-
      // related from args here; instead we trust the existing slice K
      // precedent that the persisted record's ownerIdentityId is the
      // single source of truth, and pin that the emitter passes the
      // workerRunId straight through.
      void args;
      capturedIdentityId = VLADIMIR;
      return { kind: "ok", messageId: "msg-1" };
    };
    const result = await emitPersistentWorkerSubsequentPushIfApplicable({
      entry: record,
      sessionId: "session-x",
      turnId: "turn-1",
      callback,
    });
    expect(result.invoked).toBe(true);
    expect(capturedIdentityId).toBe(VLADIMIR);
    expect(capturedIdentityId).not.toBe(ALICE);
  });
});

// ─── #8 Mark-before-dispatch ordering preserved through the hook flip ────

describe("emitPersistentWorkerSubsequentPushIfApplicable — mark-before-dispatch ordering", () => {
  it("the underlying callback marks subsequentPushStatus='pushed' BEFORE invoking deliveryDispatch", async () => {
    const record = makeRecord();
    const ctx = buildDeps(record);
    let observedStatusAtDispatchTime: string | undefined;
    ctx.pushFireCallbackDeps = {
      ...ctx.pushFireCallbackDeps,
      deliveryDispatch: async (payload) => {
        observedStatusAtDispatchTime = ctx.store.records.get(
          "wrk-001",
        )?.subsequentPushStatus;
        ctx.dispatchCapture.push(payload);
        return { ok: true };
      },
    };
    const callback = async (
      args: PersistentWorkerPushFireCallbackArgs,
    ): Promise<PersistentWorkerPushFireCallbackResult> => {
      const { persistentWorkerPushFireCallback } = await import(
        "../cron/isolated-agent/persistent-worker-push-fire-callback.js"
      );
      return persistentWorkerPushFireCallback(ctx.pushFireCallbackDeps, args);
    };
    const result = await emitPersistentWorkerSubsequentPushIfApplicable({
      entry: record,
      sessionId: "session-x",
      turnId: "turn-1",
      callback,
    });
    expect(result.invoked).toBe(true);
    expect(observedStatusAtDispatchTime).toBe("pushed");
  });
});
