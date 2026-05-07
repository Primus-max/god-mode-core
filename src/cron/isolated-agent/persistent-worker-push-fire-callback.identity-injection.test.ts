/**
 * Bug F (persistent-worker subsequent push) Phase 5 — IDENTITY-INJECTION
 * lint-guard test. NEW structural invariant (sub-plan §1 audit §i):
 *
 *   "no `runPersistentWorkerSubsequentPush` invocation without
 *   `ownerIdentityId` resolved at persisted-`SubagentRunRecord` layer
 *   (NOT caller-supplied at cron callback boundary)."
 *
 * 3 cases per audit §i:
 *   1. byte-equal: `wrappedScopeIdentityId === record.ownerIdentityId`
 *      on the dispatch payload after a successful invocation;
 *   2. caller-mismatch reverse: when the caller passes args.workerRunId
 *      pointing at A's record but the args carry B's `sessionId`/`turnId`
 *      context, the dispatch payload's `wrappedScopeIdentityId` MUST
 *      still be A (record-derived, never caller-derived);
 *   3. anonymous fail-closed: when the persisted record has NO
 *      `ownerIdentityId`, dispatch is NEVER invoked.
 */

import { describe, expect, it } from "vitest";

import { createPersistentWorkerReportCollector } from "../../platform/commitment/persistent-worker-report-observer.js";
import { asIdentityId } from "../../platform/identity/identity-id.js";
import type { ChannelId, SessionId } from "../../platform/commitment/ids.js";
import {
  runPersistentWorkerSubsequentPush,
  type PersistentWorkerPushDispatchPayload,
} from "../../platform/persistent-worker/persistent-worker-push-runtime-adapter.js";

import {
  persistentWorkerPushFireCallback,
  type PersistentWorkerPushFireCallbackDeps,
  type PersistentWorkerReportCollectorWithFailure,
  type PersistentWorkerSubagentStore,
} from "./persistent-worker-push-fire-callback.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");
const TELEGRAM = "telegram" as ChannelId;
const SESSION_A = "session-a" as SessionId;
const SESSION_B = "session-b" as SessionId;

function buildDeps(
  storeSeed: Record<
    string,
    {
      runId: string;
      ownerIdentityId?: ReturnType<typeof asIdentityId>;
      subsequentPushStatus?: "pending" | "pushed" | "failed";
    }
  >,
): {
  deps: PersistentWorkerPushFireCallbackDeps;
  dispatchCapture: PersistentWorkerPushDispatchPayload[];
} {
  const records = new Map(Object.entries(storeSeed));
  const store: PersistentWorkerSubagentStore = {
    get(workerRunId) {
      return records.get(workerRunId);
    },
    markSubsequentPushStatus(workerRunId, status) {
      const r = records.get(workerRunId);
      if (!r) return false;
      records.set(workerRunId, { ...r, subsequentPushStatus: status });
      return true;
    },
  };
  const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
  const deps: PersistentWorkerPushFireCallbackDeps = {
    subagentStore: store,
    adapter: runPersistentWorkerSubsequentPush,
    collector:
      createPersistentWorkerReportCollector() as PersistentWorkerReportCollectorWithFailure,
    deliveryDispatch: async (payload) => {
      dispatchCapture.push(payload);
      return { ok: true };
    },
  };
  return { deps, dispatchCapture };
}

describe("persistent-worker-push-fire-callback — identity-injection lint guard", () => {
  it("CASE 1: wrappedScopeIdentityId === record.ownerIdentityId byte-equal on dispatch payload", async () => {
    const { deps, dispatchCapture } = buildDeps({
      "wrk-byte-equal": {
        runId: "wrk-byte-equal",
        ownerIdentityId: VLADIMIR,
        subsequentPushStatus: "pending",
      },
    });
    const result = await persistentWorkerPushFireCallback(deps, {
      sessionId: SESSION_A,
      turnId: "turn-1",
      workerRunId: "wrk-byte-equal",
      completedAt: "2026-05-07T11:00:00.000Z",
      channel: TELEGRAM,
      to: "6533456892",
      content: "x",
    });
    expect(result.kind).toBe("ok");
    expect(dispatchCapture[0]?.wrappedScopeIdentityId).toBe(VLADIMIR);
    // Strict byte-equal — same string reference (interned literal).
    expect(dispatchCapture[0]?.wrappedScopeIdentityId === VLADIMIR).toBe(true);
  });

  it("CASE 2: caller-mismatch reverse — args.sessionId=B but record.ownerIdentityId=A → dispatch payload carries A, never B", async () => {
    const { deps, dispatchCapture } = buildDeps({
      "wrk-mismatch": {
        runId: "wrk-mismatch",
        ownerIdentityId: VLADIMIR, // A's record
        subsequentPushStatus: "pending",
      },
    });
    // Caller passes B's sessionId — a buggy upstream caller might try
    // to derive identity from the session, but the callback MUST use
    // record.ownerIdentityId.
    const result = await persistentWorkerPushFireCallback(deps, {
      sessionId: SESSION_B, // B's session
      turnId: "turn-1",
      workerRunId: "wrk-mismatch",
      completedAt: "2026-05-07T11:00:00.000Z",
      channel: TELEGRAM,
      to: "6533456892",
      content: "x",
    });
    expect(result.kind).toBe("ok");
    expect(dispatchCapture[0]?.wrappedScopeIdentityId).toBe(VLADIMIR);
    expect(dispatchCapture[0]?.wrappedScopeIdentityId).not.toBe(ALICE);
  });

  it("CASE 3: anonymous fail-closed — record without ownerIdentityId → dispatch NEVER invoked", async () => {
    const { deps, dispatchCapture } = buildDeps({
      "wrk-anon": {
        runId: "wrk-anon",
        // ownerIdentityId omitted (pre-Phase-5 record OR identity
        // resolution failed at spawn time)
        subsequentPushStatus: "pending",
      },
    });
    const result = await persistentWorkerPushFireCallback(deps, {
      sessionId: SESSION_A,
      turnId: "turn-1",
      workerRunId: "wrk-anon",
      completedAt: "2026-05-07T11:00:00.000Z",
      channel: TELEGRAM,
      to: "6533456892",
      content: "x",
    });
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") throw new Error("expected fail");
    expect(result.reason).toBe("identity_unavailable");
    // ZERO dispatch invocations — no push went out.
    expect(dispatchCapture.length).toBe(0);
  });
});
