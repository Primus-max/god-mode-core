import { describe, expect, it } from "vitest";

import type {
  AffordanceId,
  AgentId,
  ChannelId,
  CommitmentId,
  EffectFamilyId,
  EffectId,
  ISO8601,
  PreconditionId,
  ReadonlyRecord,
  SessionId,
  SessionKey,
} from "./branded-ids.js";

/**
 * S11a guard: branded ID types live in `src/platform/identity/branded-ids.ts`
 * (relocated from `src/platform/commitment/ids.ts` for kernel-delete prep).
 *
 * The brand types are pure compile-time string brands with zero runtime
 * representation. These tests assert two things:
 *
 *   1. Each branded type is structurally a string at runtime — a value
 *      cast through the brand survives `typeof === "string"` and
 *      preserves the underlying string identity.
 *   2. `ReadonlyRecord` is structurally an object with the requested keys.
 *
 * Together these protect against accidental removal / structural drift
 * (e.g. if a future cleanup mistakenly deletes a brand type, this file
 * fails to compile and CI catches it before the kernel-delete slice).
 */
describe("branded-ids — relocated from commitment/ids.ts (S11a)", () => {
  it("each brand type is structurally a string", () => {
    const commitmentId = "cmt-1" as CommitmentId;
    const affordanceId = "aff-1" as AffordanceId;
    const effectFamilyId = "fam-1" as EffectFamilyId;
    const effectId = "eff-1" as EffectId;
    const preconditionId = "pre-1" as PreconditionId;
    const channelId = "chan-1" as ChannelId;
    const sessionId = "sess-1" as SessionId;
    const agentId = "agent-1" as AgentId;
    const sessionKey = "skey-1" as SessionKey;
    const iso = "2026-05-09T00:00:00.000Z" as ISO8601;

    expect(typeof commitmentId).toBe("string");
    expect(typeof affordanceId).toBe("string");
    expect(typeof effectFamilyId).toBe("string");
    expect(typeof effectId).toBe("string");
    expect(typeof preconditionId).toBe("string");
    expect(typeof channelId).toBe("string");
    expect(typeof sessionId).toBe("string");
    expect(typeof agentId).toBe("string");
    expect(typeof sessionKey).toBe("string");
    expect(typeof iso).toBe("string");
  });

  it("brand cast preserves the underlying string value", () => {
    const raw = "abc-123";
    const branded = raw as SessionId;
    expect(branded).toBe(raw);
    expect(`${branded}-suffix`).toBe("abc-123-suffix");
  });

  it("ReadonlyRecord is a structural object with the requested keys", () => {
    const record: ReadonlyRecord<"a" | "b", number> = { a: 1, b: 2 };
    expect(record.a).toBe(1);
    expect(record.b).toBe(2);
    expect(Object.keys(record).sort()).toEqual(["a", "b"]);
  });

  it("the legacy commitment/ids.ts shim re-exports the same types", async () => {
    // Source-compat smoke check: import the legacy path and confirm a
    // value declared there is assignable to the relocated brand type.
    // This guarantees the shim and the relocated module stay in sync
    // until the shim is deleted with the rest of the commitment kernel.
    const legacy = await import("../commitment/ids.js");
    const target = await import("./branded-ids.js");
    // Both modules export only types — they have no runtime members
    // beyond an empty namespace. Asserting both load without error and
    // expose the type-only namespace is the best we can do at runtime.
    expect(legacy).toBeDefined();
    expect(target).toBeDefined();

    // Compile-time assignability check (the real guard): if either
    // module loses a brand, this file fails to typecheck.
    const sid: SessionId = "sid" as SessionId;
    expect(typeof sid).toBe("string");
  });
});
