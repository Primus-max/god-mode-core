import { describe, expect, it } from "vitest";
import {
  assertUniqueIds,
  DEFAULT_GOLDEN_SET_PATH,
  loadGoldenSet,
} from "./golden-set.js";

describe("golden-set.json", () => {
  it("loads, validates, and has unique IDs", async () => {
    const cases = await loadGoldenSet(DEFAULT_GOLDEN_SET_PATH);
    expect(cases.length).toBeGreaterThanOrEqual(100);
    expect(() => assertUniqueIds(cases)).not.toThrow();
  });

  it("covers every primaryOutcome enum value at least once", async () => {
    const cases = await loadGoldenSet(DEFAULT_GOLDEN_SET_PATH);
    const expectedOutcomes = new Set(
      cases
        .map((c) => c.expectedTaskContract.primaryOutcome)
        .filter((value): value is NonNullable<typeof value> => value !== undefined),
    );
    for (const outcome of [
      "answer",
      "workspace_change",
      "external_delivery",
      "comparison_report",
      "calculation_result",
      "document_package",
      "document_extraction",
      "clarification_needed",
    ]) {
      expect(expectedOutcomes.has(outcome as never)).toBe(true);
    }
  });

  it("covers every deliverable.kind enum value at least once", async () => {
    const cases = await loadGoldenSet(DEFAULT_GOLDEN_SET_PATH);
    const expectedKinds = new Set(
      cases
        .map((c) => c.expectedTaskContract.deliverable?.kind)
        .filter((value): value is NonNullable<typeof value> => value !== undefined),
    );
    for (const kind of [
      "answer",
      "image",
      "document",
      "data",
      "site",
      "archive",
      "audio",
      "video",
      "code_change",
      "repo_operation",
      "external_delivery",
      "capability_install",
    ]) {
      expect(expectedKinds.has(kind as never)).toBe(true);
    }
  });

  it("contains both Russian and English cases", async () => {
    const cases = await loadGoldenSet(DEFAULT_GOLDEN_SET_PATH);
    const russian = cases.filter((c) => c.tags.includes("russian"));
    const english = cases.filter((c) => c.tags.includes("english"));
    expect(russian.length).toBeGreaterThanOrEqual(20);
    expect(english.length).toBeGreaterThanOrEqual(20);
  });
});
