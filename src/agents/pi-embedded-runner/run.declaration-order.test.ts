import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Regression test for the 2026-04 reorder bug: `finalizeRecipeResult` was
 * invoked from the `prior_evidence` early-return branch BEFORE its `const`
 * declaration further down in the same function scope. TypeScript caught it
 * as TS2448/TS2454, but at runtime the dead code path would have thrown a
 * TDZ ReferenceError ("Cannot access 'finalizeRecipeResult' before
 * initialization") the first time prior evidence was sufficient.
 *
 * This test guards against the same shape of bug regressing for any of the
 * inner closures inside `runEmbeddedPiAgent`: every `const NAME = ...`
 * declared inside the function must appear before its first call site.
 */
describe("pi-embedded-runner/run.ts declaration ordering", () => {
  const source = readFileSync(join(here, "run.ts"), "utf8");
  const lines = source.split(/\r?\n/);

  function firstIndex(predicate: (line: string) => boolean): number {
    return lines.findIndex(predicate);
  }

  it("declares finalizeRecipeResult before any call site", () => {
    const declIdx = firstIndex((line) => /\bconst finalizeRecipeResult\s*=/.test(line));
    expect(declIdx, "expected `const finalizeRecipeResult = ...` in run.ts").toBeGreaterThan(-1);

    let earliestCall = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (i === declIdx) continue;
      if (/\bfinalizeRecipeResult\s*\(/.test(lines[i] ?? "")) {
        earliestCall = i;
        break;
      }
    }

    expect(earliestCall, "no call sites for finalizeRecipeResult found").toBeGreaterThan(-1);
    expect(
      earliestCall,
      `finalizeRecipeResult is called on line ${earliestCall + 1} but declared on line ${declIdx + 1}`,
    ).toBeGreaterThan(declIdx);
  });

  it("declares hookCtx before any usage", () => {
    const declIdx = firstIndex((line) => /\bconst hookCtx\b/.test(line));
    expect(declIdx, "expected `const hookCtx = ...` in run.ts").toBeGreaterThan(-1);

    let earliestUse = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (i === declIdx) continue;
      const line = lines[i] ?? "";
      if (/\bhookCtx\b/.test(line) && !/\bconst\s+hookCtx\b/.test(line)) {
        earliestUse = i;
        break;
      }
    }

    expect(earliestUse, "no usage of hookCtx found").toBeGreaterThan(-1);
    expect(
      earliestUse,
      `hookCtx is used on line ${earliestUse + 1} but declared on line ${declIdx + 1}`,
    ).toBeGreaterThan(declIdx);
  });

  it("declares hookRunner before any usage", () => {
    const declIdx = firstIndex((line) => /\bconst hookRunner\b/.test(line));
    expect(declIdx, "expected `const hookRunner = ...` in run.ts").toBeGreaterThan(-1);

    let earliestUse = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (i === declIdx) continue;
      const line = lines[i] ?? "";
      if (/\bhookRunner\b/.test(line) && !/\bconst\s+hookRunner\b/.test(line)) {
        earliestUse = i;
        break;
      }
    }

    expect(earliestUse, "no usage of hookRunner found").toBeGreaterThan(-1);
    expect(
      earliestUse,
      `hookRunner is used on line ${earliestUse + 1} but declared on line ${declIdx + 1}`,
    ).toBeGreaterThan(declIdx);
  });
});
