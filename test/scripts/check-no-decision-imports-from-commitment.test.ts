import { describe, expect, it } from "vitest";
import { findDecisionImportsFromCommitment } from "../../scripts/check-no-decision-imports-from-commitment.mjs";

describe("check-no-decision-imports-from-commitment", () => {
  it("allows sibling commitment imports", () => {
    const source = `
      import type { CommitmentId } from "./ids.js";
      function f(_id: CommitmentId): void {}
    `;
    expect(
      findDecisionImportsFromCommitment(
        source,
        "src/platform/commitment/anywhere.ts",
      ),
    ).toEqual([]);
  });

  it("flags `../decision/...` relative imports", () => {
    const source = `
      import type { TaskContract } from "../decision/contracts.js";
      function f(_c: TaskContract): void {}
    `;
    const violations = findDecisionImportsFromCommitment(
      source,
      "src/platform/commitment/anywhere.ts",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      importedFrom: "../decision/contracts.js",
      resolved: "src/platform/decision/contracts",
    });
  });

  it("flags deeper `../../platform/decision/...` paths", () => {
    const source = `
      import type { TaskContract } from "../../platform/decision/contracts.js";
      function f(_c: TaskContract): void {}
    `;
    const violations = findDecisionImportsFromCommitment(
      source,
      "src/platform/commitment/anywhere.ts",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.resolved).toBe("src/platform/decision/contracts");
  });

  it("flags re-exports from decision (`export ... from`)", () => {
    const source = `
      export type { TaskContract } from "../decision/contracts.js";
    `;
    const violations = findDecisionImportsFromCommitment(
      source,
      "src/platform/commitment/anywhere.ts",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.importedFrom).toBe("../decision/contracts.js");
  });

  it("ignores bare-specifier imports (third-party packages)", () => {
    const source = `
      import { z } from "zod";
      const _schema = z.string();
    `;
    expect(
      findDecisionImportsFromCommitment(
        source,
        "src/platform/commitment/anywhere.ts",
      ),
    ).toEqual([]);
  });

  it("ignores node: builtins", () => {
    const source = `
      import path from "node:path";
      const _p = path.sep;
    `;
    expect(
      findDecisionImportsFromCommitment(
        source,
        "src/platform/commitment/anywhere.ts",
      ),
    ).toEqual([]);
  });

  it("ignores imports that look like decision but resolve elsewhere", () => {
    const source = `
      import { x } from "./decision-helpers.js";
      const _y = x;
    `;
    expect(
      findDecisionImportsFromCommitment(
        source,
        "src/platform/commitment/anywhere.ts",
      ),
    ).toEqual([]);
  });

  it("ignores comments and strings that mention decision paths", () => {
    const source = `
      // ../decision/contracts.js was the legacy location
      const note = "../decision/contracts.js";
      function f(): string { return note; }
    `;
    expect(
      findDecisionImportsFromCommitment(
        source,
        "src/platform/commitment/anywhere.ts",
      ),
    ).toEqual([]);
  });
});
