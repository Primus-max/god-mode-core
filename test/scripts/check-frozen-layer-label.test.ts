import { describe, expect, it } from "vitest";
import {
  findFrozenLayerTouches,
  parseFrozenLayerLabels,
  validateFrozenLayerLabel,
} from "../../scripts/check-frozen-layer-label.mjs";

describe("check-frozen-layer-label", () => {
  it("detects frozen layer path touches", () => {
    expect(
      findFrozenLayerTouches([
        "src/platform/plugin.ts",
        "src/platform/recipe/planner.ts",
        "src/platform/commitment/index.ts",
      ]),
    ).toEqual(["src/platform/plugin.ts", "src/platform/recipe/planner.ts"]);
  });

  it("allows PRs without frozen layer touches", () => {
    expect(
      validateFrozenLayerLabel({
        changedPaths: ["src/platform/commitment/index.ts"],
        prBody: "",
      }),
    ).toEqual({ ok: true });
  });

  it("fails frozen layer touches without a checked label", () => {
    const result = validateFrozenLayerLabel({
      changedPaths: ["src/platform/plugin.ts"],
      prBody: "- [ ] telemetry-only",
    });

    expect(result.ok).toBe(false);
  });

  it("accepts checked frozen-layer labels", () => {
    expect(
      validateFrozenLayerLabel({
        changedPaths: ["src/platform/decision/input.ts"],
        prBody: "- [x] telemetry-only",
      }),
    ).toEqual({ ok: true });
  });

  it("parses none of the above as an explicit label", () => {
    expect(parseFrozenLayerLabels("- [x] none of the above")).toEqual([
      "none of the above",
    ]);
  });

  it("requires tracking metadata for emergency rollback", () => {
    expect(
      validateFrozenLayerLabel({
        changedPaths: ["src/platform/decision/task-classifier.ts"],
        prBody: "- [x] emergency-rollback",
      }).ok,
    ).toBe(false);

    expect(
      validateFrozenLayerLabel({
        changedPaths: ["src/platform/decision/task-classifier.ts"],
        prBody: "- [x] emergency-rollback\nTracking: https://github.com/openclaw/openclaw/issues/1\nRetire-By: 2026-05-01",
      }),
    ).toEqual({ ok: true });
  });
});
