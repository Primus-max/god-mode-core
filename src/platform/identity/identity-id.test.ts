import { describe, expect, it } from "vitest";

import { asIdentityId, isIdentityId, type IdentityId } from "./identity-id.js";

describe("IdentityId — branded type + factory", () => {
  it("asIdentityId returns the same string value when input is a well-formed identity id", () => {
    const value = asIdentityId("identity:vladimir");
    expect(value).toBe("identity:vladimir");
  });

  it("asIdentityId rejects strings without the `identity:` prefix", () => {
    expect(() => asIdentityId("vladimir")).toThrow(/identity:/u);
  });

  it("asIdentityId rejects an empty slug after the prefix", () => {
    expect(() => asIdentityId("identity:")).toThrow(/empty/iu);
  });

  it("asIdentityId rejects an empty string", () => {
    expect(() => asIdentityId("")).toThrow();
  });

  it("asIdentityId rejects a slug with whitespace", () => {
    expect(() => asIdentityId("identity:my user")).toThrow(/slug/iu);
  });

  it("asIdentityId accepts hyphenated and dotted slugs", () => {
    expect(asIdentityId("identity:vladimir-primary")).toBe("identity:vladimir-primary");
    expect(asIdentityId("identity:team.alpha")).toBe("identity:team.alpha");
  });

  it("asIdentityId accepts numeric-suffix slugs", () => {
    expect(asIdentityId("identity:user-42")).toBe("identity:user-42");
  });

  it("isIdentityId returns true for a well-formed identity id string", () => {
    expect(isIdentityId("identity:vladimir")).toBe(true);
  });

  it("isIdentityId returns false for a string missing the `identity:` prefix", () => {
    expect(isIdentityId("vladimir")).toBe(false);
  });

  it("isIdentityId returns false for an empty slug after the prefix", () => {
    expect(isIdentityId("identity:")).toBe(false);
  });

  it("isIdentityId returns false for non-string inputs (defensive)", () => {
    expect(isIdentityId(123)).toBe(false);
    expect(isIdentityId(null)).toBe(false);
    expect(isIdentityId(undefined)).toBe(false);
    expect(isIdentityId({})).toBe(false);
  });

  it("two distinct ids are not equal", () => {
    const a: IdentityId = asIdentityId("identity:alice");
    const b: IdentityId = asIdentityId("identity:bob");
    expect(a).not.toBe(b);
  });

  it("the same id constructed twice is referentially equal as a string (no caching needed; just equality)", () => {
    const a: IdentityId = asIdentityId("identity:vladimir");
    const b: IdentityId = asIdentityId("identity:vladimir");
    expect(a).toBe(b);
  });
});
