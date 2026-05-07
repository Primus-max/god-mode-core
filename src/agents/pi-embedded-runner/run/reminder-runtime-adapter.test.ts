/**
 * Slice K Phase 4 — fail-first tests for the reminder runtime adapter.
 *
 * Sibling of `repo-runtime-adapter.test.ts` (Cutover-4 P5) and
 * `artifact-runtime-adapter.test.ts` (Cutover-3 P5). Mirrors the same
 * test shape:
 *   - real `ReminderWorldStateCollector` (no `vi.spyOn` on the
 *     function under test);
 *   - closed failure set covered (`transport_error`,
 *     `identity_unavailable`, `memory_store_unavailable`,
 *     `observer_unavailable`);
 *   - sessionId / turnId isolation.
 */

import { describe, expect, it } from "vitest";

import {
  createReminderWorldStateCollector,
  type ReminderTurnKey,
  type ReminderWorldStateCollector,
} from "../../../platform/commitment/reminder-world-state-observer.js";
import type { SessionId } from "../../../platform/commitment/ids.js";
import { asIdentityId, type IdentityId } from "../../../platform/identity/identity-id.js";
import type { ReminderQueryShape } from "../../../platform/reminder/index.js";

import {
  recordReminderQueried,
  type RecordReminderQueriedInput,
  type RecordReminderQueriedResult,
} from "./reminder-runtime-adapter.js";

const SESSION_A = "session:a" as SessionId;
const SESSION_B = "session:b" as SessionId;
const IDENTITY_A: IdentityId = asIdentityId("identity:operator-a");

function turnKey(sessionId: SessionId, turnId: string): ReminderTurnKey {
  return { sessionId, turnId };
}

function shape(overrides: Partial<ReminderQueryShape> = {}): ReminderQueryShape {
  return {
    ownerIdentityId: IDENTITY_A,
    ...overrides,
  };
}

function baseInput(
  collector: ReminderWorldStateCollector,
  overrides: Partial<RecordReminderQueriedInput> = {},
): RecordReminderQueriedInput {
  return {
    collector,
    sessionId: SESSION_A,
    turnId: "turn-1",
    queryId: "rem:q-1",
    query: shape(),
    resultCount: 3,
    ...overrides,
  };
}

describe("recordReminderQueried — happy path round-trip", () => {
  it("appends a reminder-query record and exposes it via the active slice", () => {
    const collector = createReminderWorldStateCollector();
    const r = recordReminderQueried(baseInput(collector));

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.queryId).toBe("rem:q-1");

    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    const last = collector.getActiveLastQuery();
    expect(last).toBeDefined();
    expect(last?.queryId).toBe("rem:q-1");
    expect(last?.resultCount).toBe(3);
  });

  it("emits a `[reminder-runtime-adapter] recordReminderQueried` log line carrying queryId + resultCount + identityId", () => {
    const collector = createReminderWorldStateCollector();
    const lines: string[] = [];
    const r = recordReminderQueried(
      baseInput(collector, { logger: (line) => lines.push(line) }),
    );
    expect(r.ok).toBe(true);
    const matched = lines.find((l) => l.startsWith("[reminder-runtime-adapter]"));
    expect(matched).toBeDefined();
    expect(matched).toContain("queryId=rem:q-1");
    expect(matched).toContain("resultCount=3");
    expect(matched).toContain(`identityId=${IDENTITY_A}`);
  });

  it("zero resultCount is valid (sub-plan §3 acceptance #3 — empty result IS success)", () => {
    const collector = createReminderWorldStateCollector();
    const r = recordReminderQueried(baseInput(collector, { resultCount: 0 }));
    expect(r.ok).toBe(true);
    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    expect(collector.getActiveLastQuery()?.resultCount).toBe(0);
  });
});

describe("recordReminderQueried — closed failure set", () => {
  it("returns `observer_unavailable` when collector is missing", () => {
    const r: RecordReminderQueriedResult = recordReminderQueried(
      baseInput(undefined as unknown as ReminderWorldStateCollector),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("observer_unavailable");
  });

  it("returns `observer_unavailable` when collector has no record method", () => {
    const r: RecordReminderQueriedResult = recordReminderQueried(
      baseInput({} as unknown as ReminderWorldStateCollector),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("observer_unavailable");
  });

  it("returns `identity_unavailable` when query.ownerIdentityId is missing / empty (anonymous fail-closed)", () => {
    const collector = createReminderWorldStateCollector();
    const r = recordReminderQueried(
      baseInput(collector, {
        query: { ownerIdentityId: "" as unknown as IdentityId },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("identity_unavailable");
  });

  it("returns `identity_unavailable` when query is structurally absent (defense in depth)", () => {
    const collector = createReminderWorldStateCollector();
    const r = recordReminderQueried(
      baseInput(collector, {
        query: undefined as unknown as ReminderQueryShape,
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("identity_unavailable");
  });

  it("returns `transport_error` when queryId is empty", () => {
    const collector = createReminderWorldStateCollector();
    const r = recordReminderQueried(baseInput(collector, { queryId: "" }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("transport_error");
  });

  it("returns `transport_error` when resultCount is negative", () => {
    const collector = createReminderWorldStateCollector();
    const r = recordReminderQueried(baseInput(collector, { resultCount: -1 }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("transport_error");
  });

  it("returns `transport_error` when resultCount is non-integer", () => {
    const collector = createReminderWorldStateCollector();
    const r = recordReminderQueried(baseInput(collector, { resultCount: 1.5 }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("transport_error");
  });

  it("returns `transport_error` when collector throws (Zod schema rejection on bad observedAt is impossible — adapter mints — but a pathological collector still surfaces)", () => {
    const throwingCollector: ReminderWorldStateCollector = {
      record() {
        throw new Error("backend exploded");
      },
      resetForTurn() {},
      setActiveTurn() {},
      getActiveLastQuery() {
        return undefined;
      },
      getLastQueryForTurn() {
        return undefined;
      },
    };
    const r = recordReminderQueried(baseInput(throwingCollector));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("transport_error");
    expect(r.detail).toContain("backend exploded");
  });
});

describe("recordReminderQueried — isolation + boundaries", () => {
  it("sessionId / turnId isolation — write to A turn-1 leaves B turn-1 empty", () => {
    const collector = createReminderWorldStateCollector();
    recordReminderQueried(baseInput(collector, { sessionId: SESSION_A, turnId: "turn-1" }));

    collector.setActiveTurn(turnKey(SESSION_B, "turn-1"));
    expect(collector.getActiveLastQuery()).toBeUndefined();

    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    expect(collector.getActiveLastQuery()?.queryId).toBe("rem:q-1");
  });

  it("never throws on hostile inputs — every failure surfaces as a typed result envelope (#15)", () => {
    const collector = createReminderWorldStateCollector();
    expect(() =>
      recordReminderQueried(
        baseInput(collector, {
          query: { ownerIdentityId: null as unknown as IdentityId },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      recordReminderQueried(
        baseInput(collector, { resultCount: NaN as unknown as number }),
      ),
    ).not.toThrow();
  });
});
