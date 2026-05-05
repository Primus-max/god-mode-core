import { describe, expect, it } from "vitest";

import {
  asMemoryEntryId,
  isMemoryEntryId,
  type MemoryEntryId,
} from "./memory-entry-id.js";

describe("MemoryEntryId — branded type + factory", () => {
  it("asMemoryEntryId returns the same string value when input is a well-formed memory entry id", () => {
    const id = asMemoryEntryId("mem:0001");
    expect(id).toBe("mem:0001");
  });

  it("asMemoryEntryId rejects strings without the `mem:` prefix", () => {
    expect(() => asMemoryEntryId("identity:alice")).toThrow(/mem:/u);
  });

  it("asMemoryEntryId rejects an empty slug after the prefix", () => {
    expect(() => asMemoryEntryId("mem:")).toThrow(/empty/iu);
  });

  it("asMemoryEntryId rejects an empty string", () => {
    expect(() => asMemoryEntryId("")).toThrow();
  });

  it("asMemoryEntryId rejects a slug with whitespace", () => {
    expect(() => asMemoryEntryId("mem:my id")).toThrow(/slug/iu);
  });

  it("asMemoryEntryId rejects a slug with disallowed characters", () => {
    // forward slash is not in [A-Za-z0-9._-]
    expect(() => asMemoryEntryId("mem:abc/def")).toThrow(/slug/iu);
    // colon (already used as the prefix separator) is rejected inside the slug
    expect(() => asMemoryEntryId("mem:abc:def")).toThrow(/slug/iu);
  });

  it("asMemoryEntryId accepts hyphenated, dotted and underscored slugs", () => {
    expect(asMemoryEntryId("mem:abc-def")).toBe("mem:abc-def");
    expect(asMemoryEntryId("mem:abc.def")).toBe("mem:abc.def");
    expect(asMemoryEntryId("mem:abc_def")).toBe("mem:abc_def");
  });

  it("asMemoryEntryId accepts UUID-shaped slugs (the realistic Phase 2 generator output)", () => {
    expect(asMemoryEntryId("mem:01HZX9KQ8M7E4Q2P3N4Z5T6Y7B")).toBe(
      "mem:01HZX9KQ8M7E4Q2P3N4Z5T6Y7B",
    );
  });

  it("isMemoryEntryId returns true for a well-formed memory entry id string", () => {
    expect(isMemoryEntryId("mem:0001")).toBe(true);
  });

  it("isMemoryEntryId returns false for a string with the wrong prefix", () => {
    expect(isMemoryEntryId("identity:alice")).toBe(false);
    expect(isMemoryEntryId("session:abc")).toBe(false);
  });

  it("isMemoryEntryId returns false for an empty slug after the prefix", () => {
    expect(isMemoryEntryId("mem:")).toBe(false);
  });

  it("isMemoryEntryId returns false for non-string inputs (defensive)", () => {
    expect(isMemoryEntryId(123)).toBe(false);
    expect(isMemoryEntryId(null)).toBe(false);
    expect(isMemoryEntryId(undefined)).toBe(false);
    expect(isMemoryEntryId({})).toBe(false);
    expect(isMemoryEntryId([])).toBe(false);
  });

  it("two distinct ids are not equal", () => {
    const a: MemoryEntryId = asMemoryEntryId("mem:0001");
    const b: MemoryEntryId = asMemoryEntryId("mem:0002");
    expect(a).not.toBe(b);
  });

  it("the same id constructed twice is referentially equal as a string", () => {
    const a: MemoryEntryId = asMemoryEntryId("mem:0001");
    const b: MemoryEntryId = asMemoryEntryId("mem:0001");
    expect(a).toBe(b);
  });
});

describe("MemoryEntryId — brand discipline (compile-time)", () => {
  it("rejects a raw string assigned to MemoryEntryId without going through the factory", () => {
    // The runtime expectation here is trivial — it's the static `// @ts-expect-error`
    // comments below that carry the real assertion. If TypeScript ever stops
    // erroring on these lines, the test FILE fails to compile, which is the
    // strongest possible signal: brand discipline is broken.
    // @ts-expect-error - raw string is not assignable to MemoryEntryId
    const fromString: MemoryEntryId = "mem:0001";
    expect(typeof fromString).toBe("string");
  });

  it("rejects a literal string with the wrong shape assigned to MemoryEntryId", () => {
    // @ts-expect-error - even a non-conforming literal is not assignable to MemoryEntryId
    const fromBadString: MemoryEntryId = "not-a-memory-id";
    expect(typeof fromBadString).toBe("string");
  });
});
