/**
 * Bug F (persistent-worker subsequent push) Phase 5c — fail-first tests
 * for the production bootstrap that wires
 * `setProcessPersistentWorkerPushFireCallback`.
 *
 * Pre-fix proof: the file under test introduces
 * `bindProcessPersistentWorkerPushFireCallback`. Without that helper the
 * entire suite imports a non-existent symbol and fails at module-load
 * time — that IS the fail-first reproduction (the production binder is
 * NEVER bound on dev HEAD, and the symptom is exactly that
 * `getProcessPersistentWorkerPushFireCallback()` returns `undefined`
 * after gateway boot).
 *
 * No `vi.spyOn` shimming the helper under test (slice E discipline);
 * boundaries (subagentStore / collector / deliveryDispatch / logger)
 * are passed in as plain DI fakes so the closure is exercised against
 * the real `persistentWorkerPushFireCallback` + the real Phase 4
 * adapter.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetPersistentWorkerPushBootstrapForTests,
  bindProcessPersistentWorkerPushFireCallback,
  createDefaultPersistentWorkerSubagentStore,
  type PersistentWorkerPushBootstrapDeps,
} from "./persistent-worker-push-bootstrap.js";
import {
  addSubagentRunForTests,
  getProcessPersistentWorkerPushFireCallback,
  resetSubagentRegistryForTests,
} from "../agents/subagent-registry.js";
import type { SubagentRunRecord } from "../agents/subagent-registry.types.js";
import {
  type PersistentWorkerPushFireCallbackArgs,
  type PersistentWorkerPushFireCallbackDeps,
  type PersistentWorkerReportCollectorWithFailure,
  type PersistentWorkerSubagentStore,
} from "../cron/isolated-agent/persistent-worker-push-fire-callback.js";
import {
  createPersistentWorkerReportCollector,
  setProcessPersistentWorkerReportCollectorForTests,
  type PersistentWorkerReportCollector,
} from "../platform/commitment/persistent-worker-report-observer.js";
import type { PersistentWorkerPushDispatchPayload } from "../platform/persistent-worker/persistent-worker-push-runtime-adapter.js";
import { asIdentityId } from "../platform/identity/identity-id.js";
import type { ChannelId, SessionId } from "../platform/commitment/ids.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const TELEGRAM = "telegram" as ChannelId;

function makeDispatchOk(
  capture: PersistentWorkerPushDispatchPayload[] = [],
): PersistentWorkerPushFireCallbackDeps["deliveryDispatch"] {
  return async (payload) => {
    capture.push(payload);
    return { ok: true };
  };
}

function makeFixtureCollector(): PersistentWorkerReportCollector {
  // The observer module's `PersistentWorkerReportCollector` is the wider
  // surface (carries `recordFailure` / `setActiveTurn` / `freezeSnapshot`
  // — the in-memory impl always has them). The cron-fire callback
  // accepts the narrower `PersistentWorkerReportCollectorWithFailure`;
  // we narrow at the bootstrap-deps boundary via a structural cast.
  return createPersistentWorkerReportCollector();
}

function makeArgs(
  overrides: Partial<PersistentWorkerPushFireCallbackArgs> = {},
): PersistentWorkerPushFireCallbackArgs {
  return {
    sessionId: "agent:main:telegram:direct:6533456892" as SessionId,
    turnId: "wrk-001",
    workerRunId: "wrk-001",
    completedAt: new Date(0).toISOString(),
    channel: TELEGRAM,
    to: "6533456892",
    content: "Daily push: 3 new artifacts.",
    ...overrides,
  };
}

function makeRecord(
  overrides: Partial<SubagentRunRecord> = {},
): SubagentRunRecord {
  const now = Date.now();
  return {
    runId: "wrk-001",
    childSessionKey: "agent:main:subagent:child-1",
    requesterSessionKey: "agent:main:telegram:direct:6533456892",
    requesterDisplayKey: "telegram:6533456892",
    task: "daily push",
    cleanup: "keep",
    createdAt: now,
    spawnMode: "session",
    ownerIdentityId: VLADIMIR,
    requesterOrigin: { channel: TELEGRAM, to: "6533456892" },
    frozenResultText: "Daily push: 3 new artifacts.",
    endedAt: now,
    ...overrides,
  };
}

describe("persistent-worker-push-bootstrap — Phase 5c production wiring", () => {
  beforeEach(() => {
    __resetPersistentWorkerPushBootstrapForTests();
    setProcessPersistentWorkerReportCollectorForTests(undefined);
    // Reset the in-memory subagent registry without touching disk so
    // each test sees an isolated map.
    resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    __resetPersistentWorkerPushBootstrapForTests();
    setProcessPersistentWorkerReportCollectorForTests(undefined);
    resetSubagentRegistryForTests({ persist: false });
  });

  it("Case 1: after bootstrap, getProcessPersistentWorkerPushFireCallback returns a function", () => {
    expect(getProcessPersistentWorkerPushFireCallback()).toBeUndefined();

    const result = bindProcessPersistentWorkerPushFireCallback({
      deliveryDispatch: makeDispatchOk(),
    });

    expect(result.bound).toBe(true);
    expect(result.alreadyBound).toBe(false);
    const cb = getProcessPersistentWorkerPushFireCallback();
    expect(typeof cb).toBe("function");
  });

  it("Case 2: bootstrap is idempotent — calling twice does not break", () => {
    const first = bindProcessPersistentWorkerPushFireCallback({
      deliveryDispatch: makeDispatchOk(),
    });
    expect(first).toEqual({ bound: true, alreadyBound: false });

    // Second call must NOT throw and must report already-bound.
    const second = bindProcessPersistentWorkerPushFireCallback({
      deliveryDispatch: makeDispatchOk(),
    });
    expect(second).toEqual({ bound: false, alreadyBound: true });
    // Singleton still set.
    expect(typeof getProcessPersistentWorkerPushFireCallback()).toBe("function");
  });

  it("Case 3: bound callback uses the provided deliveryDispatch (assert called with the persisted ownerIdentityId)", async () => {
    const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
    const collector = makeFixtureCollector();
    addSubagentRunForTests(makeRecord());

    const bootstrapDeps: PersistentWorkerPushBootstrapDeps = {
      deliveryDispatch: makeDispatchOk(dispatchCapture),
      collector: collector as unknown as PersistentWorkerReportCollectorWithFailure,
    };
    bindProcessPersistentWorkerPushFireCallback(bootstrapDeps);

    const cb = getProcessPersistentWorkerPushFireCallback();
    expect(cb).toBeDefined();

    const result = await cb!(makeArgs());

    expect(result.kind).toBe("ok");
    expect(dispatchCapture).toHaveLength(1);
    expect(dispatchCapture[0]?.workerRunId).toBe("wrk-001");
    // The persisted record's ownerIdentityId must reach the dispatch
    // payload — proves identity injection runs through DI rather than
    // a global short-circuit.
    expect(dispatchCapture[0]?.wrappedScopeIdentityId).toBe(VLADIMIR);
    expect(dispatchCapture[0]?.channel).toBe(TELEGRAM);
    expect(dispatchCapture[0]?.to).toBe("6533456892");
  });

  it("Case 4: default subagentStore lookup goes through the registry's getSubagentRunRecord (DI, not global)", async () => {
    // Seed the registry with a record so the closure has something to
    // resolve.
    addSubagentRunForTests(makeRecord());

    const store: PersistentWorkerSubagentStore =
      createDefaultPersistentWorkerSubagentStore();
    const live = store.get("wrk-001");
    expect(live).toBeDefined();
    expect(live?.runId).toBe("wrk-001");
    expect(live?.ownerIdentityId).toBe(VLADIMIR);

    // Cross-check unknown id returns undefined (not a global hit).
    expect(store.get("does-not-exist")).toBeUndefined();
    expect(store.get("")).toBeUndefined();

    // Mark via the closure flips the persisted record (the closure is
    // a thin wrapper over `markSubagentRunSubsequentPushStatus`).
    expect(store.markSubsequentPushStatus("wrk-001", "pushed")).toBe(true);
    expect(store.get("wrk-001")?.subsequentPushStatus).toBe("pushed");

    // Unknown id → false.
    expect(store.markSubsequentPushStatus("does-not-exist", "pushed")).toBe(
      false,
    );
  });

  it("Case 5: bootstrap order — collector is resolved BEFORE the binder fires (eager observer wiring)", async () => {
    // Inject a fixture collector and assert that the very first
    // callback invocation writes through the SAME collector instance —
    // proving the bootstrap evaluated the collector accessor at bind
    // time, not after the first callback.
    const collector = makeFixtureCollector();
    setProcessPersistentWorkerReportCollectorForTests(collector);

    const dispatchCapture: PersistentWorkerPushDispatchPayload[] = [];
    addSubagentRunForTests(makeRecord());

    bindProcessPersistentWorkerPushFireCallback({
      deliveryDispatch: makeDispatchOk(dispatchCapture),
    });

    // Replace the singleton AFTER bind so we can prove the bootstrap
    // captured the prior instance (not the post-bind one). If the
    // bootstrap deferred resolution, the second collector would be
    // observed instead.
    const replacementCollector = makeFixtureCollector();
    setProcessPersistentWorkerReportCollectorForTests(replacementCollector);

    const cb = getProcessPersistentWorkerPushFireCallback();
    expect(cb).toBeDefined();

    const args = makeArgs();
    const collectorTurnKey = { sessionId: args.sessionId, turnId: args.turnId };
    collector.setActiveTurn(collectorTurnKey);
    replacementCollector.setActiveTurn(collectorTurnKey);

    const result = await cb!(args);
    expect(result.kind).toBe("ok");

    // Dispatch arrived → first collector saw the write; replacement
    // stayed empty.
    const firstSnap = collector.freezeSnapshot(collectorTurnKey);
    const secondSnap = replacementCollector.freezeSnapshot(collectorTurnKey);
    expect(firstSnap?.delivered.length ?? 0).toBe(1);
    expect(secondSnap?.delivered.length ?? 0).toBe(0);

    // Sanity: only one dispatch happened.
    expect(dispatchCapture).toHaveLength(1);
  });

  it("Case 6 (defensive): bootstrap throws when deliveryDispatch is missing", () => {
    // The binder demands `deliveryDispatch` — defense in depth so a
    // misconfigured caller cannot install a half-broken closure.
    expect(() =>
      bindProcessPersistentWorkerPushFireCallback(
        // @ts-expect-error — deliberate missing field
        {},
      ),
    ).toThrow(/deliveryDispatch required/);

    // Binder should NOT have been set on a thrown bind.
    expect(getProcessPersistentWorkerPushFireCallback()).toBeUndefined();
  });
});
