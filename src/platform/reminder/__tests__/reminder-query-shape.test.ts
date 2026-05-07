import { describe, expect, it } from "vitest";

import { asIdentityId } from "../../identity/identity-id.js";
import { asMemoryEntryId } from "../../memory/memory-entry-id.js";

import {
  ReminderEntrySchema,
  ReminderQueryShapeSchema,
  ReminderRecallResultSchema,
  UNMATCHED_REASONS,
  assertNeverUnmatchedReason,
  type ReminderEntry,
  type ReminderQueryShape,
  type ReminderRecallResult,
  type UnmatchedReason,
} from "../reminder-query-shape.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");
const ENTRY_ID = asMemoryEntryId("mem:abc-001");
const VALID_FROM = "2026-04-30T00:00:00.000Z";
const VALID_UNTIL = "2026-05-07T23:59:59.000Z";

describe("ReminderQueryShapeSchema — round-trip on the closed structured shape", () => {
  it("accepts the minimal shape (only ownerIdentityId)", () => {
    const query: ReminderQueryShape = { ownerIdentityId: VLADIMIR };
    const parsed = ReminderQueryShapeSchema.parse(query);
    expect(parsed.ownerIdentityId).toBe(VLADIMIR);
    expect(parsed.recallWindow).toBeUndefined();
    expect(parsed.effectFamilyFilter).toBeUndefined();
    expect(parsed.textHint).toBeUndefined();
    expect(parsed.limit).toBeUndefined();
  });

  it("accepts the full shape with every optional field populated", () => {
    const query: ReminderQueryShape = {
      ownerIdentityId: VLADIMIR,
      recallWindow: { from: VALID_FROM, until: VALID_UNTIL },
      effectFamilyFilter: ["artifact", "task"],
      textHint: "PDF offer",
      limit: 25,
    };
    const parsed = ReminderQueryShapeSchema.parse(query);
    expect(parsed.recallWindow?.from).toBe(VALID_FROM);
    expect(parsed.recallWindow?.until).toBe(VALID_UNTIL);
    expect(parsed.effectFamilyFilter).toEqual(["artifact", "task"]);
    expect(parsed.textHint).toBe("PDF offer");
    expect(parsed.limit).toBe(25);
  });

  it("accepts a one-sided recallWindow (only `from` OR only `until`)", () => {
    const onlyFrom = ReminderQueryShapeSchema.parse({
      ownerIdentityId: VLADIMIR,
      recallWindow: { from: VALID_FROM },
    });
    expect(onlyFrom.recallWindow?.from).toBe(VALID_FROM);
    expect(onlyFrom.recallWindow?.until).toBeUndefined();

    const onlyUntil = ReminderQueryShapeSchema.parse({
      ownerIdentityId: VLADIMIR,
      recallWindow: { until: VALID_UNTIL },
    });
    expect(onlyUntil.recallWindow?.until).toBe(VALID_UNTIL);
    expect(onlyUntil.recallWindow?.from).toBeUndefined();
  });
});

describe("ReminderQueryShapeSchema — recallWindow `from <= until` invariant", () => {
  it("rejects recallWindow when from > until", () => {
    const result = ReminderQueryShapeSchema.safeParse({
      ownerIdentityId: VLADIMIR,
      recallWindow: {
        from: "2026-05-07T12:00:00Z",
        until: "2026-05-07T11:00:00Z",
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error)).toContain(
        "recallWindow.from must be <= recallWindow.until",
      );
    }
  });

  it("accepts recallWindow when from === until", () => {
    const sameInstant = "2026-05-07T11:00:00Z";
    const parsed = ReminderQueryShapeSchema.parse({
      ownerIdentityId: VLADIMIR,
      recallWindow: { from: sameInstant, until: sameInstant },
    });
    expect(parsed.recallWindow?.from).toBe(sameInstant);
    expect(parsed.recallWindow?.until).toBe(sameInstant);
  });
});

describe("ReminderQueryShapeSchema — ISO-8601 boundary discipline", () => {
  it("rejects a malformed date string in recallWindow.from", () => {
    const result = ReminderQueryShapeSchema.safeParse({
      ownerIdentityId: VLADIMIR,
      recallWindow: { from: "not-a-date" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed date string in recallWindow.until (no T separator)", () => {
    // The shared `ISO8601_PATTERN` from
    // `episodic-memory-event.ts:389` is a SHAPE check, not a semantic
    // validator — it asserts the structural form but not that the
    // numeric components are calendar-valid. The regex requires the
    // literal `T` between date and time, the `Z` / numeric offset
    // suffix, and the leading-zero-padded segments. This case
    // violates the shape (missing `T`) so the regex rejects it.
    const result = ReminderQueryShapeSchema.safeParse({
      ownerIdentityId: VLADIMIR,
      recallWindow: { until: "2026-05-07 12:00:00Z" },
    });
    expect(result.success).toBe(false);
  });
});

describe("ReminderQueryShapeSchema — IdentityId brand discipline", () => {
  it("rejects a string that does not match the IdentityId format at runtime", () => {
    const result = ReminderQueryShapeSchema.safeParse({
      ownerIdentityId: "not-an-identity",
    });
    expect(result.success).toBe(false);
  });

  it("re-brands a valid identity-shaped string back into IdentityId at parse time", () => {
    const parsed = ReminderQueryShapeSchema.parse({
      ownerIdentityId: "identity:bob",
    });
    expect(parsed.ownerIdentityId).toBe("identity:bob");
  });

  it("rejects IdentityId substitution from raw string at compile-time", () => {
    // Brand discipline — IdentityId is non-substitutable from string.
    // @ts-expect-error — raw string cannot be assigned to IdentityId
    const _bad: ReminderQueryShape = { ownerIdentityId: "raw-string" };
    void _bad;
    // Sanity: the runtime guard ALSO rejects the same payload, so the
    // type-level check is corroborated by an end-to-end runtime test.
    const result = ReminderQueryShapeSchema.safeParse({
      ownerIdentityId: "raw-string",
    });
    expect(result.success).toBe(false);
  });

  it("rejects IdentityId substitution from MemoryEntryId at compile-time", () => {
    // Brand discipline — IdentityId is non-substitutable from MemoryEntryId
    // (different brand symbol per invariant #16).
    // @ts-expect-error — MemoryEntryId cannot be assigned to IdentityId
    const _bad: ReminderQueryShape = { ownerIdentityId: ENTRY_ID };
    void _bad;
  });

  it("accepts only IdentityId for ownerIdentityId at compile-time", () => {
    // Sanity: positive case to balance the @ts-expect-error above.
    const ok: ReminderQueryShape = { ownerIdentityId: VLADIMIR };
    expect(ok.ownerIdentityId).toBe(VLADIMIR);
  });
});

describe("ReminderQueryShapeSchema — strict-mode rejection of unknown keys", () => {
  it("rejects an extra unknown field at the top level", () => {
    const result = ReminderQueryShapeSchema.safeParse({
      ownerIdentityId: VLADIMIR,
      unknownField: "bad",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an extra unknown field inside recallWindow", () => {
    const result = ReminderQueryShapeSchema.safeParse({
      ownerIdentityId: VLADIMIR,
      recallWindow: { from: VALID_FROM, extra: "bad" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a free-form `query: string` field — invariants #5/#6 reverse-test", () => {
    // The reminder tool MUST NOT accept a free-form raw-text query
    // field; only the structured `textHint` slot is allowed.
    const result = ReminderQueryShapeSchema.safeParse({
      ownerIdentityId: VLADIMIR,
      query: "какой PDF я делал на прошлой неделе?",
    });
    expect(result.success).toBe(false);
  });
});

describe("ReminderQueryShapeSchema — effectFamilyFilter discipline", () => {
  it("rejects an empty effectFamilyFilter array", () => {
    const result = ReminderQueryShapeSchema.safeParse({
      ownerIdentityId: VLADIMIR,
      effectFamilyFilter: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error)).toContain(
        "must contain at least one entry",
      );
    }
  });

  it("rejects an effectFamilyFilter member outside the closed set", () => {
    const result = ReminderQueryShapeSchema.safeParse({
      ownerIdentityId: VLADIMIR,
      effectFamilyFilter: ["nonsense_family"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts the four LIT user-facing families", () => {
    const parsed = ReminderQueryShapeSchema.parse({
      ownerIdentityId: VLADIMIR,
      effectFamilyFilter: ["persistent_session", "task", "artifact", "repo"],
    });
    expect(parsed.effectFamilyFilter).toEqual([
      "persistent_session",
      "task",
      "artifact",
      "repo",
    ]);
  });
});

describe("ReminderQueryShapeSchema — textHint structural-only acceptance", () => {
  it("accepts textHint as a non-empty string with arbitrary content", () => {
    // textHint is STRUCTURAL ONLY — slice K modules NEVER regex it.
    // Schema-level discipline: any non-empty string is accepted; the
    // contractor's structured prompt slot is the sole producer.
    const parsed = ReminderQueryShapeSchema.parse({
      ownerIdentityId: VLADIMIR,
      textHint: "коммерческий offer для клиента Y",
    });
    expect(parsed.textHint).toBe("коммерческий offer для клиента Y");
  });

  it("rejects textHint when it is the empty string", () => {
    const result = ReminderQueryShapeSchema.safeParse({
      ownerIdentityId: VLADIMIR,
      textHint: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("ReminderQueryShapeSchema — limit positive-integer discipline", () => {
  it("accepts a positive integer limit", () => {
    const parsed = ReminderQueryShapeSchema.parse({
      ownerIdentityId: VLADIMIR,
      limit: 50,
    });
    expect(parsed.limit).toBe(50);
  });

  it("rejects limit = 0", () => {
    const result = ReminderQueryShapeSchema.safeParse({
      ownerIdentityId: VLADIMIR,
      limit: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative limit", () => {
    const result = ReminderQueryShapeSchema.safeParse({
      ownerIdentityId: VLADIMIR,
      limit: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer limit", () => {
    const result = ReminderQueryShapeSchema.safeParse({
      ownerIdentityId: VLADIMIR,
      limit: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("ReminderQueryShapeSchema — frozen output", () => {
  it("returns a frozen top-level object", () => {
    const parsed = ReminderQueryShapeSchema.parse({
      ownerIdentityId: VLADIMIR,
      recallWindow: { from: VALID_FROM, until: VALID_UNTIL },
      effectFamilyFilter: ["artifact"],
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("returns a frozen recallWindow nested object", () => {
    const parsed = ReminderQueryShapeSchema.parse({
      ownerIdentityId: VLADIMIR,
      recallWindow: { from: VALID_FROM },
    });
    expect(Object.isFrozen(parsed.recallWindow)).toBe(true);
  });

  it("returns a frozen effectFamilyFilter array", () => {
    const parsed = ReminderQueryShapeSchema.parse({
      ownerIdentityId: VLADIMIR,
      effectFamilyFilter: ["artifact"],
    });
    expect(Object.isFrozen(parsed.effectFamilyFilter)).toBe(true);
  });
});

describe("ReminderEntrySchema + ReminderRecallResultSchema — round-trip", () => {
  it("accepts a well-formed ReminderEntry", () => {
    const entry: ReminderEntry = {
      effectFamily: "artifact",
      occurredAt: VALID_UNTIL,
      summary: "PDF: offer-acme.pdf",
      payloadRef: { effectId: "effect-001", memoryEntryId: ENTRY_ID },
    };
    const parsed = ReminderEntrySchema.parse(entry);
    expect(parsed.effectFamily).toBe("artifact");
    expect(parsed.payloadRef.memoryEntryId).toBe(ENTRY_ID);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.payloadRef)).toBe(true);
  });

  it("accepts an empty ReminderRecallResult — empty entries IS success (sub-plan acceptance #3)", () => {
    const result: ReminderRecallResult = { entries: [], unmatched: [] };
    const parsed = ReminderRecallResultSchema.parse(result);
    expect(parsed.entries).toEqual([]);
    expect(parsed.unmatched).toEqual([]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.entries)).toBe(true);
    expect(Object.isFrozen(parsed.unmatched)).toBe(true);
  });

  it("accepts a ReminderRecallResult populated with all four UnmatchedReason values", () => {
    const result: ReminderRecallResult = {
      entries: [],
      unmatched: [
        "identity_unavailable",
        "recall_window_invalid",
        "family_unavailable",
        "memory_store_unavailable",
      ],
    };
    const parsed = ReminderRecallResultSchema.parse(result);
    expect(parsed.unmatched).toHaveLength(4);
  });

  it("rejects an UnmatchedReason value outside the closed set", () => {
    const r = ReminderRecallResultSchema.safeParse({
      entries: [],
      unmatched: ["unknown_reason"],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown key inside ReminderEntry.payloadRef (strict mode)", () => {
    const r = ReminderEntrySchema.safeParse({
      effectFamily: "artifact",
      occurredAt: VALID_UNTIL,
      summary: "PDF",
      payloadRef: { effectId: "e", memoryEntryId: ENTRY_ID, extra: "bad" },
    });
    expect(r.success).toBe(false);
  });
});

describe("UnmatchedReason — closed-set discipline", () => {
  it("UNMATCHED_REASONS exposes the same closed set the type union encodes", () => {
    expect(UNMATCHED_REASONS).toEqual([
      "identity_unavailable",
      "recall_window_invalid",
      "family_unavailable",
      "memory_store_unavailable",
    ]);
  });

  it("assertNeverUnmatchedReason throws when called with a value (forced via a safety cast)", () => {
    // Closed-set switches surface adding a new variant as a type
    // error in the default arm; this runtime guard is the second
    // line of defense, never the first.
    expect(() => {
      assertNeverUnmatchedReason("unexpected_variant" as never);
    }).toThrow(/assertNeverUnmatchedReason/);
  });

  it("compiles an exhaustive switch over UnmatchedReason", () => {
    function describeReason(reason: UnmatchedReason): string {
      switch (reason) {
        case "identity_unavailable":
          return "no identity";
        case "recall_window_invalid":
          return "bad window";
        case "family_unavailable":
          return "family failed";
        case "memory_store_unavailable":
          return "store down";
        default:
          return assertNeverUnmatchedReason(reason);
      }
    }
    expect(describeReason("identity_unavailable")).toBe("no identity");
  });
});

describe("ReminderQueryShape — operator-isolation type discipline (sanity)", () => {
  it("type system distinguishes two different operator IdentityIds at value-level", () => {
    // Sanity test: not a runtime guarantee, but a compile-time
    // check that two distinct IdentityIds round-trip without
    // collapsing — the storage layer enforces actual isolation in
    // Phase 4.
    const aQuery: ReminderQueryShape = { ownerIdentityId: VLADIMIR };
    const bQuery: ReminderQueryShape = { ownerIdentityId: ALICE };
    expect(aQuery.ownerIdentityId).not.toBe(bQuery.ownerIdentityId);
  });
});
