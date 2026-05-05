import { describe, expect, it } from "vitest";

import {
  type EffectFamilyId,
  type EffectId,
  type SessionId,
} from "../commitment/ids.js";
import { asIdentityId, type IdentityId } from "../identity/identity-id.js";
import { asMemoryEntryId, type MemoryEntryId } from "../memory/memory-entry-id.js";

import { asTaskId, isTaskId, type TaskId } from "./task-id.js";

describe("TaskId — branded type + factory", () => {
  it("asTaskId returns the same string value when input is a well-formed task id", () => {
    const id = asTaskId("task:0001");
    expect(id).toBe("task:0001");
  });

  it("asTaskId rejects strings without the `task:` prefix", () => {
    expect(() => asTaskId("identity:alice")).toThrow(/task:/u);
    expect(() => asTaskId("mem:0001")).toThrow(/task:/u);
  });

  it("asTaskId rejects an empty slug after the prefix", () => {
    expect(() => asTaskId("task:")).toThrow(/empty/iu);
  });

  it("asTaskId rejects an empty string", () => {
    expect(() => asTaskId("")).toThrow();
  });

  it("asTaskId rejects a slug with whitespace", () => {
    expect(() => asTaskId("task:my id")).toThrow(/slug/iu);
  });

  it("asTaskId rejects a slug with disallowed characters", () => {
    // forward slash is not in [A-Za-z0-9._-]
    expect(() => asTaskId("task:abc/def")).toThrow(/slug/iu);
    // colon (already used as the prefix separator) is rejected inside the slug
    expect(() => asTaskId("task:abc:def")).toThrow(/slug/iu);
  });

  it("asTaskId accepts hyphenated, dotted and underscored slugs", () => {
    expect(asTaskId("task:abc-def")).toBe("task:abc-def");
    expect(asTaskId("task:abc.def")).toBe("task:abc.def");
    expect(asTaskId("task:abc_def")).toBe("task:abc_def");
  });

  it("asTaskId accepts ULID-shaped slugs (a realistic generator output)", () => {
    expect(asTaskId("task:01HZX9KQ8M7E4Q2P3N4Z5T6Y7B")).toBe(
      "task:01HZX9KQ8M7E4Q2P3N4Z5T6Y7B",
    );
  });

  it("isTaskId returns true for a well-formed task id string", () => {
    expect(isTaskId("task:0001")).toBe(true);
  });

  it("isTaskId returns false for a string with the wrong prefix", () => {
    expect(isTaskId("identity:alice")).toBe(false);
    expect(isTaskId("session:abc")).toBe(false);
    expect(isTaskId("mem:0001")).toBe(false);
  });

  it("isTaskId returns false for an empty slug after the prefix", () => {
    expect(isTaskId("task:")).toBe(false);
  });

  it("isTaskId returns false for non-string inputs (defensive)", () => {
    expect(isTaskId(123)).toBe(false);
    expect(isTaskId(null)).toBe(false);
    expect(isTaskId(undefined)).toBe(false);
    expect(isTaskId({})).toBe(false);
    expect(isTaskId([])).toBe(false);
  });

  it("two distinct ids are not equal", () => {
    const a: TaskId = asTaskId("task:0001");
    const b: TaskId = asTaskId("task:0002");
    expect(a).not.toBe(b);
  });

  it("the same id constructed twice is referentially equal as a string", () => {
    const a: TaskId = asTaskId("task:0001");
    const b: TaskId = asTaskId("task:0001");
    expect(a).toBe(b);
  });
});

describe("TaskId — brand discipline (compile-time, invariant #16)", () => {
  // The bulk of the assertions in this block are `// @ts-expect-error`
  // lines: if any of them stops being an error, the file fails to
  // compile and the suite fails before any runtime code runs. The
  // tiny runtime expectations exist so vitest reports a single
  // deterministic pass/fail; the static guarantees come from the
  // compiler.

  it("rejects a raw string assigned to TaskId without going through the factory (1/6)", () => {
    // @ts-expect-error - raw string is not assignable to TaskId
    const fromString: TaskId = "task:0001";
    expect(typeof fromString).toBe("string");
  });

  it("rejects an IdentityId assigned to TaskId — distinct brand (2/6)", () => {
    const identity: IdentityId = asIdentityId("identity:vladimir");
    // @ts-expect-error - IdentityId brand is distinct from TaskId brand
    const bad: TaskId = identity;
    expect(typeof bad).toBe("string");
  });

  it("rejects a MemoryEntryId assigned to TaskId — distinct brand (3/6)", () => {
    const entry: MemoryEntryId = asMemoryEntryId("mem:0001");
    // @ts-expect-error - MemoryEntryId brand is distinct from TaskId brand
    const bad: TaskId = entry;
    expect(typeof bad).toBe("string");
  });

  it("rejects a SessionId assigned to TaskId — distinct brand (4/6)", () => {
    const sessionLike = "session:abc" as unknown as SessionId;
    // @ts-expect-error - SessionId brand is distinct from TaskId brand
    const bad: TaskId = sessionLike;
    expect(typeof bad).toBe("string");
  });

  it("rejects an EffectId assigned to TaskId — distinct brand (5/6)", () => {
    const effectLike = "effect:abc" as unknown as EffectId;
    // @ts-expect-error - EffectId brand is distinct from TaskId brand
    const bad: TaskId = effectLike;
    expect(typeof bad).toBe("string");
  });

  it("rejects an EffectFamilyId assigned to TaskId — distinct brand (6/6)", () => {
    const familyLike = "task" as unknown as EffectFamilyId;
    // @ts-expect-error - EffectFamilyId brand is distinct from TaskId brand
    const bad: TaskId = familyLike;
    expect(typeof bad).toBe("string");
  });

  it("symmetric: TaskId is NOT assignable back to IdentityId / MemoryEntryId", () => {
    const taskId: TaskId = asTaskId("task:0001");
    // @ts-expect-error - TaskId brand is distinct from IdentityId brand
    const badIdentity: IdentityId = taskId;
    // @ts-expect-error - TaskId brand is distinct from MemoryEntryId brand
    const badEntry: MemoryEntryId = taskId;
    expect(typeof badIdentity).toBe("string");
    expect(typeof badEntry).toBe("string");
  });
});
