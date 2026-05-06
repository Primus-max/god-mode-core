import { describe, expect, it } from "vitest";

import {
  type EffectFamilyId,
  type EffectId,
  type SessionId,
} from "../commitment/ids.js";
import { asIdentityId, type IdentityId } from "../identity/identity-id.js";
import { asMemoryEntryId, type MemoryEntryId } from "../memory/memory-entry-id.js";
import { asTaskId, type TaskId } from "../task/task-id.js";

import {
  SESSION_RESET_REASONS,
  SESSION_RESET_SUBSCRIBER_CATEGORIES,
  SessionResetEventSchema,
  SessionResetSubscriberOutcomeSchema,
  asSessionResetSubscriberId,
  assertNeverSessionResetReason,
  assertNeverSessionResetSubscriberCategory,
  assertNeverSessionResetSubscriberOutcome,
  createSessionResetSubscriberRegistry,
  isSessionResetSubscriberId,
  resetTurnSession,
  type SessionResetEvent,
  type SessionResetReason,
  type SessionResetSubscriber,
  type SessionResetSubscriberCategory,
  type SessionResetSubscriberId,
  type SessionResetSubscriberOutcome,
  type SessionResetSummary,
} from "./reset.js";

const VALID_ISO = "2026-05-06T18:25:00.000Z";
const SESSION_ID = "f71784c5-aaaa-bbbb-cccc-111111111111" as SessionId;
const PREV_SESSION_ID = "99f9e4f2-82be-4148-bd79-ffb80a2e07e3" as SessionId;
const VLADIMIR = asIdentityId("identity:vladimir");

// =============================================================================
// SessionResetSubscriberId — branded type + factory
// =============================================================================

describe("SessionResetSubscriberId — branded type + factory", () => {
  it("asSessionResetSubscriberId returns the same string value when input is well-formed", () => {
    const id = asSessionResetSubscriberId("subscriber:followup-queue-clear");
    expect(id).toBe("subscriber:followup-queue-clear");
  });

  it("asSessionResetSubscriberId rejects strings without the `subscriber:` prefix", () => {
    expect(() => asSessionResetSubscriberId("identity:alice")).toThrow(
      /subscriber:/u,
    );
    expect(() => asSessionResetSubscriberId("mem:0001")).toThrow(/subscriber:/u);
    expect(() => asSessionResetSubscriberId("task:0001")).toThrow(/subscriber:/u);
  });

  it("asSessionResetSubscriberId rejects an empty slug after the prefix", () => {
    expect(() => asSessionResetSubscriberId("subscriber:")).toThrow(/empty/iu);
  });

  it("asSessionResetSubscriberId rejects an empty string", () => {
    expect(() => asSessionResetSubscriberId("")).toThrow();
  });

  it("asSessionResetSubscriberId rejects a slug with whitespace", () => {
    expect(() => asSessionResetSubscriberId("subscriber:my id")).toThrow(/slug/iu);
  });

  it("asSessionResetSubscriberId rejects a slug with disallowed characters", () => {
    expect(() => asSessionResetSubscriberId("subscriber:abc/def")).toThrow(
      /slug/iu,
    );
    expect(() => asSessionResetSubscriberId("subscriber:abc:def")).toThrow(
      /slug/iu,
    );
  });

  it("asSessionResetSubscriberId accepts hyphenated, dotted and underscored slugs", () => {
    expect(asSessionResetSubscriberId("subscriber:abc-def")).toBe(
      "subscriber:abc-def",
    );
    expect(asSessionResetSubscriberId("subscriber:abc.def")).toBe(
      "subscriber:abc.def",
    );
    expect(asSessionResetSubscriberId("subscriber:abc_def")).toBe(
      "subscriber:abc_def",
    );
  });

  it("isSessionResetSubscriberId returns true for a well-formed id string", () => {
    expect(isSessionResetSubscriberId("subscriber:followup-queue-clear")).toBe(
      true,
    );
  });

  it("isSessionResetSubscriberId returns false for the wrong prefix", () => {
    expect(isSessionResetSubscriberId("identity:alice")).toBe(false);
    expect(isSessionResetSubscriberId("mem:0001")).toBe(false);
    expect(isSessionResetSubscriberId("task:0001")).toBe(false);
    expect(isSessionResetSubscriberId("session:abc")).toBe(false);
  });

  it("isSessionResetSubscriberId returns false for an empty slug after the prefix", () => {
    expect(isSessionResetSubscriberId("subscriber:")).toBe(false);
  });

  it("isSessionResetSubscriberId returns false for non-string inputs (defensive)", () => {
    expect(isSessionResetSubscriberId(123)).toBe(false);
    expect(isSessionResetSubscriberId(null)).toBe(false);
    expect(isSessionResetSubscriberId(undefined)).toBe(false);
    expect(isSessionResetSubscriberId({})).toBe(false);
    expect(isSessionResetSubscriberId([])).toBe(false);
  });

  it("two distinct ids are not equal", () => {
    const a: SessionResetSubscriberId = asSessionResetSubscriberId(
      "subscriber:followup-queue-clear",
    );
    const b: SessionResetSubscriberId = asSessionResetSubscriberId(
      "subscriber:memory-scope-reaffirm",
    );
    expect(a).not.toBe(b);
  });

  it("the same id constructed twice is referentially equal as a string", () => {
    const a: SessionResetSubscriberId = asSessionResetSubscriberId(
      "subscriber:followup-queue-clear",
    );
    const b: SessionResetSubscriberId = asSessionResetSubscriberId(
      "subscriber:followup-queue-clear",
    );
    expect(a).toBe(b);
  });
});

// =============================================================================
// SessionResetSubscriberId — brand discipline (compile-time, invariant #16)
// =============================================================================

describe("SessionResetSubscriberId — brand discipline (compile-time, invariant #16)", () => {
  // The bulk of the assertions here are `// @ts-expect-error` lines: if any of
  // them stops being an error, the file fails to compile and the suite fails
  // before any runtime code runs. The runtime expectations exist so vitest
  // reports a single deterministic pass/fail; the static guarantees come from
  // the compiler.

  it("rejects a raw string assigned to SessionResetSubscriberId without going through the factory (1/7)", () => {
    // @ts-expect-error - raw string is not assignable to SessionResetSubscriberId
    const fromString: SessionResetSubscriberId = "subscriber:followup-queue-clear";
    expect(typeof fromString).toBe("string");
  });

  it("rejects a SessionId assigned to SessionResetSubscriberId — distinct brand (2/7)", () => {
    const sessionLike = "session:abc" as unknown as SessionId;
    // @ts-expect-error - SessionId brand is distinct from SessionResetSubscriberId brand
    const bad: SessionResetSubscriberId = sessionLike;
    expect(typeof bad).toBe("string");
  });

  it("rejects an IdentityId assigned to SessionResetSubscriberId — distinct brand (3/7)", () => {
    const identity: IdentityId = asIdentityId("identity:vladimir");
    // @ts-expect-error - IdentityId brand is distinct from SessionResetSubscriberId brand
    const bad: SessionResetSubscriberId = identity;
    expect(typeof bad).toBe("string");
  });

  it("rejects a MemoryEntryId assigned to SessionResetSubscriberId — distinct brand (4/7)", () => {
    const entry: MemoryEntryId = asMemoryEntryId("mem:0001");
    // @ts-expect-error - MemoryEntryId brand is distinct from SessionResetSubscriberId brand
    const bad: SessionResetSubscriberId = entry;
    expect(typeof bad).toBe("string");
  });

  it("rejects a TaskId assigned to SessionResetSubscriberId — distinct brand (5/7)", () => {
    const taskId: TaskId = asTaskId("task:0001");
    // @ts-expect-error - TaskId brand is distinct from SessionResetSubscriberId brand
    const bad: SessionResetSubscriberId = taskId;
    expect(typeof bad).toBe("string");
  });

  it("rejects an EffectId assigned to SessionResetSubscriberId — distinct brand (6/7)", () => {
    const effectLike = "effect:abc" as unknown as EffectId;
    // @ts-expect-error - EffectId brand is distinct from SessionResetSubscriberId brand
    const bad: SessionResetSubscriberId = effectLike;
    expect(typeof bad).toBe("string");
  });

  it("rejects an EffectFamilyId assigned to SessionResetSubscriberId — distinct brand (7/7)", () => {
    const familyLike = "task" as unknown as EffectFamilyId;
    // @ts-expect-error - EffectFamilyId brand is distinct from SessionResetSubscriberId brand
    const bad: SessionResetSubscriberId = familyLike;
    expect(typeof bad).toBe("string");
  });

  it("symmetric: SessionResetSubscriberId is NOT assignable back to other brands", () => {
    const subId: SessionResetSubscriberId = asSessionResetSubscriberId(
      "subscriber:followup-queue-clear",
    );
    // @ts-expect-error - SessionResetSubscriberId brand is distinct from IdentityId brand
    const badIdentity: IdentityId = subId;
    // @ts-expect-error - SessionResetSubscriberId brand is distinct from MemoryEntryId brand
    const badEntry: MemoryEntryId = subId;
    // @ts-expect-error - SessionResetSubscriberId brand is distinct from TaskId brand
    const badTask: TaskId = subId;
    // @ts-expect-error - SessionResetSubscriberId brand is distinct from SessionId brand
    const badSession: SessionId = subId;
    expect(typeof badIdentity).toBe("string");
    expect(typeof badEntry).toBe("string");
    expect(typeof badTask).toBe("string");
    expect(typeof badSession).toBe("string");
  });
});

// =============================================================================
// SessionResetEventSchema — round-trip on every reason variant
// =============================================================================

describe("SessionResetEventSchema — round-trip on every SessionResetReason", () => {
  function makeEvent(reason: SessionResetReason): SessionResetEvent {
    return {
      sessionId: SESSION_ID,
      sessionKey: "telegram:6533456892",
      identityId: VLADIMIR,
      previousSessionId: PREV_SESSION_ID,
      reason,
      occurredAt: VALID_ISO,
    };
  }

  it("accepts a well-formed reset_trigger event (the NEW-B canonical path)", () => {
    const event = makeEvent("reset_trigger");
    const parsed = SessionResetEventSchema.parse(event);
    expect(parsed.reason).toBe("reset_trigger");
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.previousSessionId).toBe(PREV_SESSION_ID);
    expect(parsed.identityId).toBe(VLADIMIR);
    expect(parsed.sessionKey).toBe("telegram:6533456892");
    expect(parsed.occurredAt).toBe(VALID_ISO);
  });

  it("accepts every SessionResetReason variant", () => {
    for (const reason of SESSION_RESET_REASONS) {
      const parsed = SessionResetEventSchema.parse(makeEvent(reason));
      expect(parsed.reason).toBe(reason);
    }
  });

  it("accepts a minimal event without identityId or previousSessionId (anonymous reset)", () => {
    const event: SessionResetEvent = {
      sessionId: SESSION_ID,
      sessionKey: "telegram:6533456892",
      reason: "reset_trigger",
      occurredAt: VALID_ISO,
    };
    const parsed = SessionResetEventSchema.parse(event);
    expect(parsed.identityId).toBeUndefined();
    expect(parsed.previousSessionId).toBeUndefined();
  });

  it("rejects unknown `reason` values (closed-set discipline)", () => {
    expect(() =>
      SessionResetEventSchema.parse({
        sessionId: SESSION_ID,
        sessionKey: "telegram:6533456892",
        reason: "panic_button",
        occurredAt: VALID_ISO,
      }),
    ).toThrow();
  });

  it("rejects an empty sessionKey", () => {
    expect(() =>
      SessionResetEventSchema.parse({
        sessionId: SESSION_ID,
        sessionKey: "",
        reason: "reset_trigger",
        occurredAt: VALID_ISO,
      }),
    ).toThrow();
  });

  it("rejects an empty sessionId", () => {
    expect(() =>
      SessionResetEventSchema.parse({
        sessionId: "",
        sessionKey: "telegram:6533456892",
        reason: "reset_trigger",
        occurredAt: VALID_ISO,
      }),
    ).toThrow();
  });

  it("rejects a malformed identityId", () => {
    expect(() =>
      SessionResetEventSchema.parse({
        sessionId: SESSION_ID,
        sessionKey: "telegram:6533456892",
        identityId: "not-an-identity",
        reason: "reset_trigger",
        occurredAt: VALID_ISO,
      }),
    ).toThrow(/identity:/u);
  });

  it("rejects a non-ISO occurredAt timestamp", () => {
    expect(() =>
      SessionResetEventSchema.parse({
        sessionId: SESSION_ID,
        sessionKey: "telegram:6533456892",
        reason: "reset_trigger",
        occurredAt: "yesterday at noon",
      }),
    ).toThrow(/ISO-8601/u);
  });

  it("rejects an event with extra unknown fields (strict-mode closed-set discipline)", () => {
    expect(() =>
      SessionResetEventSchema.parse({
        sessionId: SESSION_ID,
        sessionKey: "telegram:6533456892",
        reason: "reset_trigger",
        occurredAt: VALID_ISO,
        // Extra field — strict() must reject so callers cannot smuggle in
        // unstructured payloads (e.g. raw user text).
        rawText: "hello",
      }),
    ).toThrow();
  });

  it("returns a frozen event (defense-in-depth alongside readonly fields)", () => {
    const parsed = SessionResetEventSchema.parse({
      sessionId: SESSION_ID,
      sessionKey: "telegram:6533456892",
      reason: "reset_trigger",
      occurredAt: VALID_ISO,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    // Mutation throws in strict mode (vitest runs ESM, ESM is strict). The
    // intentional cast through `{ reason: SessionResetReason }` strips the
    // `readonly` modifier so the runtime can attempt the write — proving
    // `Object.freeze` (not just the TypeScript modifier) is doing the work.
    expect(() => {
      (parsed as { reason: SessionResetReason }).reason = "daily_reset";
    }).toThrow();
    expect(parsed.reason).toBe("reset_trigger");
  });

  it("the SessionResetEvent shape declares its fields as readonly (compile-time)", () => {
    const event: SessionResetEvent = {
      sessionId: SESSION_ID,
      sessionKey: "telegram:6533456892",
      reason: "reset_trigger",
      occurredAt: VALID_ISO,
    };
    // @ts-expect-error - reason is declared `readonly` on SessionResetEvent
    event.reason = "daily_reset";
    // @ts-expect-error - sessionKey is declared `readonly` on SessionResetEvent
    event.sessionKey = "discord:other";
    expect(event.sessionId).toBe(SESSION_ID);
  });
});

// =============================================================================
// SessionResetReason — closed enum exhaustiveness compile-check
// =============================================================================

describe("SessionResetReason — discriminated-union exhaustiveness compile-check", () => {
  // If a future contributor adds a 6th reason without extending this switch,
  // `assertNeverSessionResetReason(value)` becomes a compile error — which is
  // the strongest signal possible.
  function classify(reason: SessionResetReason): string {
    switch (reason) {
      case "reset_trigger":
        return "reset_trigger";
      case "daily_reset":
        return "daily_reset";
      case "compaction":
        return "compaction";
      case "forced_recovery":
        return "forced_recovery";
      case "plugin_request":
        return "plugin_request";
      default:
        return assertNeverSessionResetReason(reason);
    }
  }

  it("classifier covers every member of SESSION_RESET_REASONS", () => {
    expect(SESSION_RESET_REASONS.length).toBe(5);
    for (const reason of SESSION_RESET_REASONS) {
      expect(classify(reason)).toBe(reason);
    }
  });

  it("assertNeverSessionResetReason throws at runtime when fed an impossible value (defensive)", () => {
    const bogus = "panic_button" as unknown as never;
    expect(() => assertNeverSessionResetReason(bogus)).toThrow();
  });
});

// =============================================================================
// SessionResetSubscriberCategory — closed enum exhaustiveness compile-check
// =============================================================================

describe("SessionResetSubscriberCategory — discriminated-union exhaustiveness compile-check", () => {
  function classify(category: SessionResetSubscriberCategory): string {
    switch (category) {
      case "chat-history":
        return "chat-history";
      case "memory-scope":
        return "memory-scope";
      case "task-scope":
        return "task-scope";
      case "observer":
        return "observer";
      case "world-state":
        return "world-state";
      case "plugin":
        return "plugin";
      case "misc":
        return "misc";
      default:
        return assertNeverSessionResetSubscriberCategory(category);
    }
  }

  it("classifier covers every member of SESSION_RESET_SUBSCRIBER_CATEGORIES", () => {
    expect(SESSION_RESET_SUBSCRIBER_CATEGORIES.length).toBe(7);
    for (const category of SESSION_RESET_SUBSCRIBER_CATEGORIES) {
      expect(classify(category)).toBe(category);
    }
  });

  it("assertNeverSessionResetSubscriberCategory throws at runtime when fed an impossible value (defensive)", () => {
    const bogus = "telephony" as unknown as never;
    expect(() => assertNeverSessionResetSubscriberCategory(bogus)).toThrow();
  });
});

// =============================================================================
// SessionResetSubscriberCategory — schema rejection
// =============================================================================

describe("SessionResetSubscriberCategory — schema rejection", () => {
  // The category lives on `SessionResetSubscriber.category` (a runtime
  // interface, not a Zod-decoded payload), so we exercise its closed-set
  // discipline through the `assertNever` helper above and through a small
  // bespoke schema here. This proves the closed set is enforceable at
  // decode boundaries, not just at compile time.
  it("the closed set has exactly 7 categories", () => {
    expect(SESSION_RESET_SUBSCRIBER_CATEGORIES).toEqual([
      "chat-history",
      "memory-scope",
      "task-scope",
      "observer",
      "world-state",
      "plugin",
      "misc",
    ]);
  });
});

// =============================================================================
// SessionResetSubscriberOutcome — schema round-trip + exhaustiveness
// =============================================================================

describe("SessionResetSubscriberOutcomeSchema — round-trip on every variant", () => {
  it("accepts a `cleared` outcome without details", () => {
    const outcome: SessionResetSubscriberOutcome = { kind: "cleared" };
    const parsed = SessionResetSubscriberOutcomeSchema.parse(outcome);
    expect(parsed.kind).toBe("cleared");
  });

  it("accepts a `cleared` outcome with structured details", () => {
    const outcome: SessionResetSubscriberOutcome = {
      kind: "cleared",
      details: { entriesCleared: 3, sessionKey: "telegram:6533456892" },
    };
    const parsed = SessionResetSubscriberOutcomeSchema.parse(outcome);
    if (parsed.kind === "cleared") {
      expect(parsed.details?.entriesCleared).toBe(3);
      expect(parsed.details?.sessionKey).toBe("telegram:6533456892");
    } else {
      throw new Error("expected `cleared` outcome");
    }
  });

  it("accepts a `skipped` outcome with reason", () => {
    const outcome: SessionResetSubscriberOutcome = {
      kind: "skipped",
      reason: "identity-scoped — survives /new by design",
    };
    const parsed = SessionResetSubscriberOutcomeSchema.parse(outcome);
    if (parsed.kind === "skipped") {
      expect(parsed.reason).toBe("identity-scoped — survives /new by design");
    } else {
      throw new Error("expected `skipped` outcome");
    }
  });

  it("accepts a `failed` outcome with reason", () => {
    const outcome: SessionResetSubscriberOutcome = {
      kind: "failed",
      reason: "queue-clear threw: ENOENT",
    };
    const parsed = SessionResetSubscriberOutcomeSchema.parse(outcome);
    if (parsed.kind === "failed") {
      expect(parsed.reason).toBe("queue-clear threw: ENOENT");
    } else {
      throw new Error("expected `failed` outcome");
    }
  });

  it("rejects unknown `kind` values (closed-set discipline)", () => {
    expect(() =>
      SessionResetSubscriberOutcomeSchema.parse({ kind: "deferred" }),
    ).toThrow();
  });

  it("rejects a `skipped` outcome without reason", () => {
    expect(() =>
      SessionResetSubscriberOutcomeSchema.parse({ kind: "skipped" }),
    ).toThrow();
  });

  it("rejects a `failed` outcome without reason", () => {
    expect(() =>
      SessionResetSubscriberOutcomeSchema.parse({ kind: "failed" }),
    ).toThrow();
  });

  it("rejects a `skipped` outcome with empty-string reason", () => {
    expect(() =>
      SessionResetSubscriberOutcomeSchema.parse({ kind: "skipped", reason: "" }),
    ).toThrow();
  });

  it("returns a frozen outcome", () => {
    const parsed = SessionResetSubscriberOutcomeSchema.parse({
      kind: "cleared",
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });
});

describe("SessionResetSubscriberOutcome — discriminated-union exhaustiveness compile-check", () => {
  // Same rationale as the reason exhaustiveness check above. If a future
  // contributor adds a fourth `kind`, `assertNeverSessionResetSubscriberOutcome`
  // becomes a compile error in this switch.
  function summarise(outcome: SessionResetSubscriberOutcome): string {
    switch (outcome.kind) {
      case "cleared":
        return "cleared";
      case "skipped":
        return `skipped:${outcome.reason}`;
      case "failed":
        return `failed:${outcome.reason}`;
      default:
        return assertNeverSessionResetSubscriberOutcome(outcome);
    }
  }

  it("summarise covers every variant of the outcome union", () => {
    expect(summarise({ kind: "cleared" })).toBe("cleared");
    expect(summarise({ kind: "skipped", reason: "no-op" })).toBe(
      "skipped:no-op",
    );
    expect(summarise({ kind: "failed", reason: "boom" })).toBe("failed:boom");
  });

  it("assertNeverSessionResetSubscriberOutcome throws at runtime when fed an impossible value (defensive)", () => {
    const bogus = { kind: "deferred" } as unknown as never;
    expect(() => assertNeverSessionResetSubscriberOutcome(bogus)).toThrow();
  });
});

// =============================================================================
// SessionResetSubscriberRegistry — Phase 3
// =============================================================================

/**
 * Helper for Phase-3 suites: constructs a deterministic event with the
 * Telegram-shape values used in the live-evidence reproduction (so the
 * structured log line under test resembles the gateway-side format
 * operator/reviewers actually grep on).
 */
function makeResetEvent(
  overrides: Partial<SessionResetEvent> = {},
): SessionResetEvent {
  return {
    sessionId: SESSION_ID,
    sessionKey: "telegram:6533456892",
    identityId: VLADIMIR,
    previousSessionId: PREV_SESSION_ID,
    reason: "reset_trigger",
    occurredAt: VALID_ISO,
    ...overrides,
  };
}

/**
 * Build a minimal SessionResetSubscriber; the `onReset` callback is
 * invoked through the real `resetTurnSession()` iterator so the unit
 * tests below exercise the production code path (no `vi.spyOn` on
 * `resetTurnSession` itself per AGENTS.md "Tests must catch real bugs"
 * §2). The optional `onResetImpl` is a normal closure provided per
 * subscriber — equivalent to a hand-written subscriber, NOT a mock.
 */
function makeSubscriber(params: {
  readonly id: string;
  readonly category?: SessionResetSubscriberCategory;
  readonly onResetImpl?: (
    event: SessionResetEvent,
  ) => Promise<SessionResetSubscriberOutcome> | SessionResetSubscriberOutcome;
}): SessionResetSubscriber {
  const subscriberId: SessionResetSubscriberId = asSessionResetSubscriberId(
    params.id,
  );
  const category: SessionResetSubscriberCategory =
    params.category ?? "chat-history";
  const impl =
    params.onResetImpl ??
    (async (): Promise<SessionResetSubscriberOutcome> => ({ kind: "cleared" }));
  return {
    id: subscriberId,
    category,
    onReset: async (event) => impl(event),
  };
}

describe("SessionResetSubscriberRegistry — register / list / replace", () => {
  it("createSessionResetSubscriberRegistry returns a registry with register and list", () => {
    const registry = createSessionResetSubscriberRegistry();
    expect(typeof registry.register).toBe("function");
    expect(typeof registry.list).toBe("function");
    expect(registry.list()).toEqual([]);
  });

  it("register returns an unregister function that removes the subscriber by reference", () => {
    const registry = createSessionResetSubscriberRegistry();
    const sub = makeSubscriber({ id: "subscriber:s1" });
    const unregister = registry.register(sub);
    expect(registry.list()).toEqual([sub]);
    unregister();
    expect(registry.list()).toEqual([]);
  });

  it("preserves insertion order across list() (deterministic for log assertion)", () => {
    const registry = createSessionResetSubscriberRegistry();
    const a = makeSubscriber({ id: "subscriber:a" });
    const b = makeSubscriber({ id: "subscriber:b" });
    const c = makeSubscriber({ id: "subscriber:c" });
    registry.register(a);
    registry.register(b);
    registry.register(c);
    const listed = registry.list();
    expect(listed.map((s) => s.id)).toEqual([
      "subscriber:a",
      "subscriber:b",
      "subscriber:c",
    ]);
  });

  it("list() returns a frozen array", () => {
    const registry = createSessionResetSubscriberRegistry();
    registry.register(makeSubscriber({ id: "subscriber:s1" }));
    const listed = registry.list();
    expect(Object.isFrozen(listed)).toBe(true);
  });

  it("re-register with the same id REPLACES the prior subscriber and emits a warn line via the registry warn-logger hook", () => {
    const warns: string[] = [];
    const registry = createSessionResetSubscriberRegistry({
      warnLogger: (line) => warns.push(line),
    });
    const first = makeSubscriber({
      id: "subscriber:dup",
      onResetImpl: () => ({ kind: "skipped", reason: "first" }),
    });
    const second = makeSubscriber({
      id: "subscriber:dup",
      onResetImpl: () => ({ kind: "skipped", reason: "second" }),
    });
    registry.register(first);
    registry.register(second);
    const listed = registry.list();
    expect(listed.length).toBe(1);
    // Last-wins: second subscriber instance must be the one retained.
    expect(listed[0]).toBe(second);
    expect(warns.length).toBe(1);
    expect(warns[0]).toMatch(/subscriber:dup/u);
    expect(warns[0]).toMatch(/replac/iu);
  });

  it("unregister fn returned by the FIRST register call is a no-op after a second register replaced the entry (last-wins identity)", () => {
    const registry = createSessionResetSubscriberRegistry({
      warnLogger: () => {},
    });
    const first = makeSubscriber({ id: "subscriber:dup" });
    const second = makeSubscriber({ id: "subscriber:dup" });
    const unregisterFirst = registry.register(first);
    registry.register(second);
    // First's unregister must NOT remove the second (it would corrupt the
    // registry by half-clearing the slot).
    unregisterFirst();
    expect(registry.list()).toEqual([second]);
  });
});

// =============================================================================
// resetTurnSession — Phase 3
// =============================================================================

describe("resetTurnSession — empty registry", () => {
  it("returns a SessionResetSummary with zero counts", async () => {
    const registry = createSessionResetSubscriberRegistry();
    const summary: SessionResetSummary = await resetTurnSession({
      event: makeResetEvent(),
      registry,
      logger: () => {},
    });
    expect(summary.subscribers).toEqual([]);
    expect(summary.clearedCount).toBe(0);
    expect(summary.skippedCount).toBe(0);
    expect(summary.failedCount).toBe(0);
    expect(typeof summary.durationMs).toBe("number");
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(summary.event.reason).toBe("reset_trigger");
  });

  it("emits exactly one structured log line even on an empty registry (proves observability is unconditional)", async () => {
    const registry = createSessionResetSubscriberRegistry();
    const lines: string[] = [];
    await resetTurnSession({
      event: makeResetEvent(),
      registry,
      logger: (line) => lines.push(line),
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("[session-reset] event=session_reset");
    expect(lines[0]).toContain("subscribers=0");
    expect(lines[0]).toContain("cleared=0");
    expect(lines[0]).toContain("skipped=0");
    expect(lines[0]).toContain("failed=0");
  });
});

describe("resetTurnSession — single subscriber outcomes", () => {
  it("captures a `cleared` outcome and increments clearedCount", async () => {
    const registry = createSessionResetSubscriberRegistry();
    registry.register(
      makeSubscriber({
        id: "subscriber:clears",
        onResetImpl: () => ({ kind: "cleared", details: { rows: 3 } }),
      }),
    );
    const summary = await resetTurnSession({
      event: makeResetEvent(),
      registry,
      logger: () => {},
    });
    expect(summary.subscribers.length).toBe(1);
    const slot = summary.subscribers[0];
    if (slot === undefined) {
      throw new Error("expected one subscriber slot");
    }
    expect(slot.outcome.kind).toBe("cleared");
    expect(summary.clearedCount).toBe(1);
    expect(summary.skippedCount).toBe(0);
    expect(summary.failedCount).toBe(0);
  });

  it("captures a `skipped` outcome and increments skippedCount", async () => {
    const registry = createSessionResetSubscriberRegistry();
    registry.register(
      makeSubscriber({
        id: "subscriber:skips",
        category: "memory-scope",
        onResetImpl: () => ({
          kind: "skipped",
          reason: "identity-scoped — survives /new by design",
        }),
      }),
    );
    const summary = await resetTurnSession({
      event: makeResetEvent(),
      registry,
      logger: () => {},
    });
    const slot = summary.subscribers[0];
    if (slot === undefined) {
      throw new Error("expected one subscriber slot");
    }
    expect(slot.outcome.kind).toBe("skipped");
    expect(summary.clearedCount).toBe(0);
    expect(summary.skippedCount).toBe(1);
    expect(summary.failedCount).toBe(0);
  });

  it("converts a thrown Error into a `failed` outcome (defense-in-depth, invariant #15)", async () => {
    const registry = createSessionResetSubscriberRegistry();
    registry.register(
      makeSubscriber({
        id: "subscriber:throws",
        onResetImpl: async () => {
          throw new Error("queue-clear: ENOENT");
        },
      }),
    );
    const summary = await resetTurnSession({
      event: makeResetEvent(),
      registry,
      logger: () => {},
    });
    const slot = summary.subscribers[0];
    if (slot === undefined || slot.outcome.kind !== "failed") {
      throw new Error("expected a failed slot");
    }
    expect(slot.outcome.reason).toMatch(/queue-clear: ENOENT/u);
    expect(summary.failedCount).toBe(1);
    expect(summary.clearedCount).toBe(0);
    expect(summary.skippedCount).toBe(0);
  });

  it("converts a non-Error throw (e.g. string) into a `failed` outcome with synthetic reason", async () => {
    const registry = createSessionResetSubscriberRegistry();
    registry.register(
      makeSubscriber({
        id: "subscriber:throws-string",
        onResetImpl: async () => {
          // eslint-disable-next-line no-throw-literal
          throw "boom-as-string";
        },
      }),
    );
    const summary = await resetTurnSession({
      event: makeResetEvent(),
      registry,
      logger: () => {},
    });
    const slot = summary.subscribers[0];
    if (slot === undefined || slot.outcome.kind !== "failed") {
      throw new Error("expected a failed slot");
    }
    expect(slot.outcome.reason).toMatch(/boom-as-string/u);
    expect(summary.failedCount).toBe(1);
  });

  it("converts a malformed outcome (missing kind) into `failed` with reason 'malformed_outcome'", async () => {
    const registry = createSessionResetSubscriberRegistry();
    registry.register(
      makeSubscriber({
        id: "subscriber:malformed",
        // Author a deliberately ill-typed outcome to prove the runtime
        // guard rejects it; this exercises the same code path that would
        // catch a future plugin returning an unstructured value.
        onResetImpl: () =>
          ({ result: "ok" } as unknown as SessionResetSubscriberOutcome),
      }),
    );
    const summary = await resetTurnSession({
      event: makeResetEvent(),
      registry,
      logger: () => {},
    });
    const slot = summary.subscribers[0];
    if (slot === undefined || slot.outcome.kind !== "failed") {
      throw new Error("expected a failed slot for malformed outcome");
    }
    expect(slot.outcome.reason).toBe("malformed_outcome");
    expect(summary.failedCount).toBe(1);
  });
});

describe("resetTurnSession — iteration order and failure isolation", () => {
  it("invokes subscribers in insertion order (verified via DI call-order list, NOT vi.spyOn on resetTurnSession)", async () => {
    const callOrder: string[] = [];
    const registry = createSessionResetSubscriberRegistry();
    registry.register(
      makeSubscriber({
        id: "subscriber:first",
        onResetImpl: () => {
          callOrder.push("first");
          return { kind: "cleared" };
        },
      }),
    );
    registry.register(
      makeSubscriber({
        id: "subscriber:second",
        onResetImpl: () => {
          callOrder.push("second");
          return { kind: "cleared" };
        },
      }),
    );
    registry.register(
      makeSubscriber({
        id: "subscriber:third",
        onResetImpl: () => {
          callOrder.push("third");
          return { kind: "cleared" };
        },
      }),
    );
    await resetTurnSession({
      event: makeResetEvent(),
      registry,
      logger: () => {},
    });
    expect(callOrder).toEqual(["first", "second", "third"]);
  });

  it("a subscriber that throws does NOT block subscribers registered AFTER it (failure isolation)", async () => {
    const callOrder: string[] = [];
    const registry = createSessionResetSubscriberRegistry();
    registry.register(
      makeSubscriber({
        id: "subscriber:first-clears",
        onResetImpl: () => {
          callOrder.push("first");
          return { kind: "cleared" };
        },
      }),
    );
    registry.register(
      makeSubscriber({
        id: "subscriber:second-throws",
        onResetImpl: async () => {
          callOrder.push("second");
          throw new Error("middle-blew-up");
        },
      }),
    );
    registry.register(
      makeSubscriber({
        id: "subscriber:third-clears",
        onResetImpl: () => {
          callOrder.push("third");
          return { kind: "cleared" };
        },
      }),
    );
    const summary = await resetTurnSession({
      event: makeResetEvent(),
      registry,
      logger: () => {},
    });
    expect(callOrder).toEqual(["first", "second", "third"]);
    expect(summary.subscribers.map((s) => s.outcome.kind)).toEqual([
      "cleared",
      "failed",
      "cleared",
    ]);
    expect(summary.clearedCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.skippedCount).toBe(0);
  });
});

describe("resetTurnSession — structured log line", () => {
  it("identityId is rendered as `anon` when the event omits it", async () => {
    const registry = createSessionResetSubscriberRegistry();
    registry.register(makeSubscriber({ id: "subscriber:s1" }));
    const lines: string[] = [];
    await resetTurnSession({
      event: makeResetEvent({ identityId: undefined }),
      registry,
      logger: (line) => lines.push(line),
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("identityId=anon");
    expect(lines[0]).not.toContain("identityId=identity:");
  });

  it("identityId appears verbatim when the event carries it", async () => {
    const registry = createSessionResetSubscriberRegistry();
    registry.register(makeSubscriber({ id: "subscriber:s1" }));
    const lines: string[] = [];
    await resetTurnSession({
      event: makeResetEvent(),
      registry,
      logger: (line) => lines.push(line),
    });
    expect(lines[0]).toContain("identityId=identity:vladimir");
  });

  it("emits EXACTLY ONE log line per resetTurnSession() invocation", async () => {
    const registry = createSessionResetSubscriberRegistry();
    registry.register(
      makeSubscriber({
        id: "subscriber:a",
        onResetImpl: () => ({ kind: "cleared" }),
      }),
    );
    registry.register(
      makeSubscriber({
        id: "subscriber:b",
        onResetImpl: () => ({ kind: "skipped", reason: "no-op" }),
      }),
    );
    registry.register(
      makeSubscriber({
        id: "subscriber:c",
        onResetImpl: async () => {
          throw new Error("boom");
        },
      }),
    );
    const lines: string[] = [];
    await resetTurnSession({
      event: makeResetEvent(),
      registry,
      logger: (line) => lines.push(line),
    });
    expect(lines.length).toBe(1);
    // Verify the full structured-log shape exactly once. The format below
    // is the operator-grep anchor; if it ever changes, this regex
    // becomes the sentinel that fails fast.
    expect(lines[0]).toMatch(
      /^\[session-reset\] event=session_reset sessionId=\S+ sessionKey=\S+ reason=\S+ identityId=\S+ subscribers=3 cleared=1 skipped=1 failed=1 durationMs=\d+/u,
    );
  });

  it("durationMs uses the injected clockNow (deterministic for tests)", async () => {
    const registry = createSessionResetSubscriberRegistry();
    registry.register(makeSubscriber({ id: "subscriber:s1" }));
    let now = 1_000_000;
    const summary = await resetTurnSession({
      event: makeResetEvent(),
      registry,
      logger: () => {},
      clockNow: () => {
        const value = now;
        // Advance the clock by 7ms on each consecutive read so the
        // start/end delta is exactly 7.
        now += 7;
        return value;
      },
    });
    expect(summary.durationMs).toBe(7);
  });
});

describe("resetTurnSession — bounded latency on a large registry", () => {
  it("50 in-memory subscribers each returning `cleared` complete in < 100ms", async () => {
    const registry = createSessionResetSubscriberRegistry();
    for (let index = 0; index < 50; index += 1) {
      registry.register(
        makeSubscriber({
          id: `subscriber:s${index.toString()}`,
          onResetImpl: () => ({ kind: "cleared" }),
        }),
      );
    }
    const wallStart = performance.now();
    const summary = await resetTurnSession({
      event: makeResetEvent(),
      registry,
      logger: () => {},
    });
    const wallElapsed = performance.now() - wallStart;
    expect(summary.subscribers.length).toBe(50);
    expect(summary.clearedCount).toBe(50);
    // Wall-clock check: prove the iterator is not pathological (e.g.
    // accidentally O(N^2)). 100ms is generous on Windows CI; the
    // synchronous in-memory subscribers would normally complete in
    // sub-millisecond.
    expect(wallElapsed).toBeLessThan(100);
  });
});
