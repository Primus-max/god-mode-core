import { describe, expect, it } from "vitest";

import {
  type EffectFamilyId,
  type EffectId,
  type SessionId,
} from "../commitment/ids.js";
import { asIdentityId, type IdentityId } from "../identity/identity-id.js";
import { asTaskId } from "../task/task-id.js";

import { assertNeverEpisodic, type EpisodicMemoryEvent } from "./episodic-memory-event.js";
import { asMemoryEntryId, type MemoryEntryId } from "./memory-entry-id.js";
import type { MemoryStore } from "./memory-store.js";

/**
 * The point of this file is to catch invariant #16 violations (brands
 * collapsing into one another) at COMPILE time. The bulk of the
 * assertions are `// @ts-expect-error` lines: if any of them stops
 * being an error, the file fails to compile and the test suite fails
 * before any runtime code runs.
 *
 * The tiny runtime expectations exist so vitest reports a single
 * deterministic pass/fail; the static guarantees come from the
 * compiler.
 */

const VLADIMIR = asIdentityId("identity:vladimir");
const ENTRY_ID = asMemoryEntryId("mem:0001");

describe("MemoryStore — brand discipline (compile-time)", () => {
  it("MemoryEntryId is NOT assignable from a raw string", () => {
    // @ts-expect-error - raw string is not a MemoryEntryId
    const bad: MemoryEntryId = "mem:0001";
    expect(typeof bad).toBe("string");
  });

  it("MemoryEntryId is NOT assignable from IdentityId", () => {
    // @ts-expect-error - IdentityId brand is distinct from MemoryEntryId brand
    const bad: MemoryEntryId = VLADIMIR;
    expect(typeof bad).toBe("string");
  });

  it("MemoryEntryId is NOT assignable from SessionId", () => {
    const sessionLike = "session:abc" as unknown as SessionId;
    // @ts-expect-error - SessionId brand is distinct from MemoryEntryId brand
    const bad: MemoryEntryId = sessionLike;
    expect(typeof bad).toBe("string");
  });

  it("MemoryEntryId is NOT assignable from EffectId", () => {
    const effectLike = "effect:abc" as unknown as EffectId;
    // @ts-expect-error - EffectId brand is distinct from MemoryEntryId brand
    const bad: MemoryEntryId = effectLike;
    expect(typeof bad).toBe("string");
  });

  it("MemoryEntryId is NOT assignable from EffectFamilyId", () => {
    const familyLike = "family:abc" as unknown as EffectFamilyId;
    // @ts-expect-error - EffectFamilyId brand is distinct from MemoryEntryId brand
    const bad: MemoryEntryId = familyLike;
    expect(typeof bad).toBe("string");
  });

  it("IdentityId is NOT assignable from MemoryEntryId (the brand is symmetric)", () => {
    // @ts-expect-error - MemoryEntryId brand is distinct from IdentityId brand
    const bad: IdentityId = ENTRY_ID;
    expect(typeof bad).toBe("string");
  });
});

describe("MemoryStore.forget — accepts ONLY a MemoryEntryId at the type level", () => {
  // Build a stub store whose method bodies don't matter — only the
  // call sites below exercise the type-checker. The runtime smoke
  // assertion at the bottom keeps vitest happy.
  const stub: MemoryStore = {
    storeEpisodic: async (_event: EpisodicMemoryEvent) => ENTRY_ID,
    storeSemantic: async () => ENTRY_ID,
    recall: async () => ({ entries: [] }),
    list: async () => ({ episodic: [], semantic: [] }),
    forget: async () => undefined,
  };

  it("rejects an IdentityId passed where a MemoryEntryId is required", () => {
    // @ts-expect-error - forget must not accept IdentityId
    void stub.forget(VLADIMIR);
    expect(typeof stub.forget).toBe("function");
  });

  it("rejects a SessionId passed where a MemoryEntryId is required", () => {
    const sessionLike = "session:abc" as unknown as SessionId;
    // @ts-expect-error - forget must not accept SessionId
    void stub.forget(sessionLike);
    expect(typeof stub.forget).toBe("function");
  });

  it("rejects an EffectId passed where a MemoryEntryId is required", () => {
    const effectLike = "effect:abc" as unknown as EffectId;
    // @ts-expect-error - forget must not accept EffectId
    void stub.forget(effectLike);
    expect(typeof stub.forget).toBe("function");
  });

  it("rejects a raw string passed where a MemoryEntryId is required", () => {
    // @ts-expect-error - forget must not accept a raw string
    void stub.forget("mem:0001");
    expect(typeof stub.forget).toBe("function");
  });

  it("accepts a MemoryEntryId — the only valid input", async () => {
    // No @ts-expect-error — this MUST type-check and resolve.
    await expect(stub.forget(ENTRY_ID)).resolves.toBeUndefined();
  });
});

describe("EpisodicMemoryEvent — exhaustiveness compile-check", () => {
  // If a future contributor adds a 5th variant without extending this
  // switch, `assertNeverEpisodic(event)` becomes a compile error
  // because `event` is no longer narrowed to `never`. That is the
  // strongest signal the union has drifted.
  function describeEvent(event: EpisodicMemoryEvent): string {
    switch (event.effectFamily) {
      case "persistent_session":
        return "session";
      case "subagent":
        return "subagent";
      case "reminder":
        return "reminder";
      case "artifact":
        return "artifact";
      case "task":
        return "task";
      case "policy_approval":
        return "policy_approval";
      case "policy_budget":
        return "policy_budget";
      case "policy_role":
        return "policy_role";
      case "policy_retry":
        return "policy_retry";
      case "policy_escalation":
        return "policy_escalation";
      case "repo":
        return "repo";
      default:
        return assertNeverEpisodic(event);
    }
  }

  it("describeEvent covers all 5 variants", () => {
    const VALID_ISO = "2026-05-05T12:34:56.000Z";
    const variants: EpisodicMemoryEvent[] = [
      {
        identityId: VLADIMIR,
        effectFamily: "persistent_session",
        effectId: "e",
        payload: {
          messageRole: "user",
          messageText: "x",
          messageId: "m",
          occurredAt: VALID_ISO,
        },
      },
      {
        identityId: VLADIMIR,
        effectFamily: "subagent",
        effectId: "e",
        payload: { subagentId: "s", displayName: "n", occurredAt: VALID_ISO },
      },
      {
        identityId: VLADIMIR,
        effectFamily: "reminder",
        effectId: "e",
        payload: { reminderId: "r", fireAt: VALID_ISO, occurredAt: VALID_ISO },
      },
      {
        identityId: VLADIMIR,
        effectFamily: "artifact",
        effectId: "e",
        payload: { artifactId: "a", kind: "image", occurredAt: VALID_ISO },
      },
      {
        identityId: VLADIMIR,
        effectFamily: "task",
        effectId: "e",
        payload: {
          kind: "created",
          taskId: asTaskId("task:0001"),
          ownerIdentityId: VLADIMIR,
          label: "x",
          occurredAt: VALID_ISO,
        },
      },
    ];
    expect(variants.map(describeEvent)).toEqual([
      "session",
      "subagent",
      "reminder",
      "artifact",
      "task",
    ]);
  });
});

describe("MemoryStore — recall returns the empty-array contract (typed)", () => {
  it("the typed result MUST have a readonly entries array, never null/undefined", async () => {
    const stub: MemoryStore = {
      storeEpisodic: async () => ENTRY_ID,
      storeSemantic: async () => ENTRY_ID,
      // The literal here exercises the type: `entries: []` MUST satisfy
      // `MemoryRecallResult` without casting, proving the no-match
      // contract is reachable at the type level.
      recall: async () => ({ entries: [] }),
      list: async () => ({ episodic: [], semantic: [] }),
      forget: async () => undefined,
    };
    const result = await stub.recall({ identityId: VLADIMIR, query: "x" });
    expect(Array.isArray(result.entries)).toBe(true);
    expect(result.entries).toHaveLength(0);
  });
});
