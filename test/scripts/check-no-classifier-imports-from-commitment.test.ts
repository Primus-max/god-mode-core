import { describe, expect, it } from "vitest";
import { findClassifierImportsFromCommitment } from "../../scripts/check-no-classifier-imports-from-commitment.mjs";

describe("check-no-classifier-imports-from-commitment", () => {
  it("flags imports from the legacy task classifier", () => {
    const source = `
      import type { TaskContract } from "../decision/task-classifier.js";
      function f(_contract: TaskContract): void {}
    `;

    expect(
      findClassifierImportsFromCommitment(source, "src/platform/commitment/anywhere.ts"),
    ).toEqual([
      {
        line: 2,
        importedFrom: "../decision/task-classifier.js",
        resolved: "src/platform/decision/task-classifier",
      },
    ]);
  });

  it("flags re-exports from the legacy task classifier", () => {
    const source = `
      export type { TaskContract } from "../decision/task-classifier.js";
    `;

    expect(
      findClassifierImportsFromCommitment(source, "src/platform/commitment/anywhere.ts"),
    ).toHaveLength(1);
  });

  it("allows commitment-local imports", () => {
    const source = `
      import type { SemanticIntent } from "./semantic-intent.js";
      function f(_intent: SemanticIntent): void {}
    `;

    expect(
      findClassifierImportsFromCommitment(source, "src/platform/commitment/anywhere.ts"),
    ).toEqual([]);
  });
});
