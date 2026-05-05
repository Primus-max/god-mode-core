import { describe, expect, it } from "vitest";

import { asIdentityId } from "../identity/identity-id.js";

import { asMemoryEntryId } from "./memory-entry-id.js";
import {
  MemoryRecallResultSchema,
  SemanticMemoryEntrySchema,
  SemanticMemoryMetadataSchema,
  SemanticMemoryQuerySchema,
  SemanticMemoryWriteSchema,
} from "./semantic-memory.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const ENTRY_ID = asMemoryEntryId("mem:entry-001");

describe("SemanticMemoryWriteSchema — round-trip + negative cases", () => {
  it("round-trips a write with metadata", () => {
    const write = {
      identityId: VLADIMIR,
      content: "favourite colour is teal",
      metadata: { source: "operator", confidence: 0.9, archived: false, note: null },
    };
    const parsed = SemanticMemoryWriteSchema.parse(write);
    expect(parsed.identityId).toBe(VLADIMIR);
    expect(parsed.content).toBe("favourite colour is teal");
    expect(parsed.metadata).toEqual(write.metadata);
  });

  it("round-trips a write without metadata", () => {
    const parsed = SemanticMemoryWriteSchema.parse({
      identityId: VLADIMIR,
      content: "hello",
    });
    expect(parsed.metadata).toBeUndefined();
  });

  it("rejects an empty content string", () => {
    expect(() =>
      SemanticMemoryWriteSchema.parse({ identityId: VLADIMIR, content: "" }),
    ).toThrow();
  });

  it("rejects a malformed identityId", () => {
    expect(() =>
      SemanticMemoryWriteSchema.parse({ identityId: "vladimir", content: "x" }),
    ).toThrow();
  });

  it("rejects a metadata value that is an array (only scalars allowed)", () => {
    expect(() =>
      SemanticMemoryWriteSchema.parse({
        identityId: VLADIMIR,
        content: "x",
        metadata: { tags: ["a", "b"] },
      }),
    ).toThrow();
  });

  it("rejects a metadata value that is a nested object (only scalars allowed)", () => {
    expect(() =>
      SemanticMemoryWriteSchema.parse({
        identityId: VLADIMIR,
        content: "x",
        metadata: { nested: { foo: "bar" } },
      }),
    ).toThrow();
  });
});

describe("SemanticMemoryQuerySchema — round-trip + negative cases", () => {
  it("round-trips with limit set", () => {
    const parsed = SemanticMemoryQuerySchema.parse({
      identityId: VLADIMIR,
      query: "favourite colour",
      limit: 5,
    });
    expect(parsed.limit).toBe(5);
  });

  it("round-trips without limit", () => {
    const parsed = SemanticMemoryQuerySchema.parse({
      identityId: VLADIMIR,
      query: "x",
    });
    expect(parsed.limit).toBeUndefined();
  });

  it("rejects an empty query string", () => {
    expect(() =>
      SemanticMemoryQuerySchema.parse({ identityId: VLADIMIR, query: "" }),
    ).toThrow();
  });

  it("rejects a non-positive limit", () => {
    expect(() =>
      SemanticMemoryQuerySchema.parse({ identityId: VLADIMIR, query: "x", limit: 0 }),
    ).toThrow();
    expect(() =>
      SemanticMemoryQuerySchema.parse({ identityId: VLADIMIR, query: "x", limit: -3 }),
    ).toThrow();
  });

  it("rejects a non-integer limit", () => {
    expect(() =>
      SemanticMemoryQuerySchema.parse({ identityId: VLADIMIR, query: "x", limit: 1.5 }),
    ).toThrow();
  });
});

describe("SemanticMemoryEntrySchema — round-trip + negative cases", () => {
  it("round-trips a well-formed entry", () => {
    const entry = {
      id: ENTRY_ID,
      identityId: VLADIMIR,
      content: "favourite colour is teal",
      metadata: { source: "operator" },
      score: 0.87,
    };
    const parsed = SemanticMemoryEntrySchema.parse(entry);
    expect(parsed.id).toBe(ENTRY_ID);
    expect(parsed.score).toBe(0.87);
  });

  it("rejects an entry with a malformed MemoryEntryId", () => {
    expect(() =>
      SemanticMemoryEntrySchema.parse({
        id: "not-a-mem-id",
        identityId: VLADIMIR,
        content: "x",
        metadata: {},
        score: 0.5,
      }),
    ).toThrow();
  });

  it("rejects an entry with a non-finite score (NaN/Infinity)", () => {
    expect(() =>
      SemanticMemoryEntrySchema.parse({
        id: ENTRY_ID,
        identityId: VLADIMIR,
        content: "x",
        metadata: {},
        score: Number.POSITIVE_INFINITY,
      }),
    ).toThrow();
    expect(() =>
      SemanticMemoryEntrySchema.parse({
        id: ENTRY_ID,
        identityId: VLADIMIR,
        content: "x",
        metadata: {},
        score: Number.NaN,
      }),
    ).toThrow();
  });

  it("rejects an entry missing the metadata field", () => {
    expect(() =>
      SemanticMemoryEntrySchema.parse({
        id: ENTRY_ID,
        identityId: VLADIMIR,
        content: "x",
        score: 0.5,
      }),
    ).toThrow();
  });
});

describe("MemoryRecallResultSchema — round-trip + empty case", () => {
  it("round-trips an empty entries array (the no-match contract)", () => {
    const parsed = MemoryRecallResultSchema.parse({ entries: [] });
    expect(parsed.entries).toHaveLength(0);
  });

  it("round-trips a result with one entry", () => {
    const parsed = MemoryRecallResultSchema.parse({
      entries: [
        {
          id: ENTRY_ID,
          identityId: VLADIMIR,
          content: "favourite colour is teal",
          metadata: {},
          score: 0.9,
        },
      ],
    });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.id).toBe(ENTRY_ID);
  });

  it("rejects a result missing the entries field", () => {
    expect(() => MemoryRecallResultSchema.parse({})).toThrow();
  });

  it("rejects a result with a malformed entry inside the array", () => {
    expect(() =>
      MemoryRecallResultSchema.parse({
        entries: [{ id: "bad", identityId: VLADIMIR, content: "x", metadata: {}, score: 0 }],
      }),
    ).toThrow();
  });
});

describe("SemanticMemoryMetadataSchema — scalar-only invariant", () => {
  it("accepts string, number, boolean, and null values", () => {
    const parsed = SemanticMemoryMetadataSchema.parse({
      str: "x",
      num: 42,
      bool: true,
      nul: null,
    });
    expect(parsed).toEqual({ str: "x", num: 42, bool: true, nul: null });
  });

  it("rejects nested objects and arrays (Phase 1 explicitly forbids them)", () => {
    expect(() => SemanticMemoryMetadataSchema.parse({ x: { y: 1 } })).toThrow();
    expect(() => SemanticMemoryMetadataSchema.parse({ x: [1, 2] })).toThrow();
  });

  it("rejects undefined values (only `null` is the allowed nullary)", () => {
    expect(() => SemanticMemoryMetadataSchema.parse({ x: undefined })).toThrow();
  });
});
