import { describe, expect, it } from "vitest";
import { normalizeProfileHintList } from "./hints.js";

describe("normalizeProfileHintList", () => {
  it("returns a sorted deduped list for stable preference merging", () => {
    expect(normalizeProfileHintList(["exec", "read", "exec", " read "])).toEqual([
      "exec",
      "read",
    ]);
  });

  it("returns empty array for undefined or all-empty inputs", () => {
    expect(normalizeProfileHintList(undefined)).toEqual([]);
    expect(normalizeProfileHintList(["", "  "])).toEqual([]);
  });
});
