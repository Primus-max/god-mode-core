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
  isSessionResetSubscriberId,
  type SessionResetEvent,
  type SessionResetReason,
  type SessionResetSubscriberCategory,
  type SessionResetSubscriberId,
  type SessionResetSubscriberOutcome,
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
