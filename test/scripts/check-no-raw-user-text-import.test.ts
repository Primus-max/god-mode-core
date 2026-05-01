import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_SYMBOLS,
  WHITELIST_RELATIVE,
  findRawUserTextImports,
} from "../../scripts/check-no-raw-user-text-import.mjs";

describe("check-no-raw-user-text-import", () => {
  it("flags a default `RawUserTurn` import", () => {
    const source = `
      import { RawUserTurn } from "./raw-user-turn.js";
      const _x: RawUserTurn = null as never;
    `;
    const violations = findRawUserTextImports(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      symbol: "RawUserTurn",
      importedFrom: "./raw-user-turn.js",
      alias: null,
    });
  });

  it("flags a `UserPrompt` named import", () => {
    const source = `
      import { UserPrompt } from "./raw-user-turn.js";
      const _y: UserPrompt = "" as UserPrompt;
    `;
    const violations = findRawUserTextImports(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.symbol).toBe("UserPrompt");
  });

  it("flags an aliased import (`import { RawUserTurn as RUT }`)", () => {
    const source = `
      import { RawUserTurn as RUT } from "./raw-user-turn.js";
      const _x: RUT = null as never;
    `;
    const violations = findRawUserTextImports(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      symbol: "RawUserTurn",
      alias: "RUT",
    });
  });

  it("flags `import type { RawUserTurn }` the same as a value import", () => {
    const source = `
      import type { RawUserTurn } from "./raw-user-turn.js";
      function f(_t: RawUserTurn): void {}
    `;
    const violations = findRawUserTextImports(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.symbol).toBe("RawUserTurn");
  });

  it("flags `RawUserText` (internal but still part of the whitelist surface)", () => {
    const source = `
      import { RawUserText } from "./raw-user-turn.js";
      const _x: RawUserText = "" as RawUserText;
    `;
    const violations = findRawUserTextImports(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.symbol).toBe("RawUserText");
  });

  it("flags multiple forbidden symbols in a single import", () => {
    const source = `
      import { UserPrompt, RawUserTurn } from "./raw-user-turn.js";
      const _a: UserPrompt = "" as UserPrompt;
      const _b: RawUserTurn = null as never;
    `;
    const violations = findRawUserTextImports(source);
    expect(violations.map((v) => v.symbol).toSorted()).toEqual([
      "RawUserTurn",
      "UserPrompt",
    ]);
  });

  it("does not flag unrelated symbols (e.g. `SemanticIntent`)", () => {
    const source = `
      import type { SemanticIntent } from "./semantic-intent.js";
      function classify(): SemanticIntent { throw new Error("stub"); }
    `;
    expect(findRawUserTextImports(source)).toEqual([]);
  });

  it("does not flag mentions in strings or comments", () => {
    const source = `
      // RawUserTurn must only flow through IntentContractor.
      const note = "RawUserTurn / UserPrompt are whitelisted symbols";
      function f(): string { return note; }
    `;
    expect(findRawUserTextImports(source)).toEqual([]);
  });

  it("does not flag namespace imports", () => {
    const source = `
      import * as RawUserTurn from "./raw-user-turn.js";
      function f(): typeof RawUserTurn { return RawUserTurn; }
    `;
    expect(findRawUserTextImports(source)).toEqual([]);
  });

  it("does not flag re-exports (export type * from ...)", () => {
    const source = `
      export type * from "./raw-user-turn.js";
    `;
    expect(findRawUserTextImports(source)).toEqual([]);
  });

  it("exposes the canonical whitelist", () => {
    expect(WHITELIST_RELATIVE.has("src/platform/commitment/raw-user-turn.ts")).toBe(true);
    expect(WHITELIST_RELATIVE.has("src/platform/commitment/intent-contractor.ts")).toBe(true);
    expect(
      WHITELIST_RELATIVE.has("src/platform/commitment/intent-contractor-impl.ts"),
    ).toBe(true);
    expect(WHITELIST_RELATIVE.size).toBe(3);
  });

  it("exposes the canonical forbidden symbol set", () => {
    expect(FORBIDDEN_SYMBOLS.has("UserPrompt")).toBe(true);
    expect(FORBIDDEN_SYMBOLS.has("RawUserTurn")).toBe(true);
    expect(FORBIDDEN_SYMBOLS.has("RawUserText")).toBe(true);
    expect(FORBIDDEN_SYMBOLS.has("SemanticIntent")).toBe(false);
  });
});
