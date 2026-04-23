import { describe, expect, it } from "vitest";
import {
  TASK_CAPABILITY_CATALOG,
  TASK_CAPABILITY_IDS,
  applyCatalogNormalizer,
  buildCapabilityPromptSection,
  getTaskCapability,
  type TaskCapabilityId,
} from "./capability-catalog.js";

describe("capability catalog (declarative SSoT)", () => {
  it("exposes every advertised id through the catalog", () => {
    expect(TASK_CAPABILITY_CATALOG.map((entry) => entry.id).toSorted()).toEqual(
      [...TASK_CAPABILITY_IDS].toSorted(),
    );
  });

  it("describes each capability without naming a tool, vendor, or product", () => {
    // The catalog must stay intent-level. If this regex ever needs to be
    // softened, that is a strong signal a capability has slipped into being a
    // disguised tool name and should be rethought.
    const forbiddenSubstrings = [
      "image_generate",
      "apply_patch",
      "playwright",
      "openai",
      "browser_use",
      "exec_tool",
      "ffmpeg",
    ];
    for (const entry of TASK_CAPABILITY_CATALOG) {
      const text = `${entry.intent}`.toLowerCase();
      for (const fragment of forbiddenSubstrings) {
        expect(text, `intent for ${entry.id} mentions ${fragment}`).not.toContain(fragment);
      }
    }
  });

  it("renders one bullet per catalog entry into the prompt section", () => {
    const rendered = buildCapabilityPromptSection();
    const lines = rendered.split("\n").filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(TASK_CAPABILITY_CATALOG.length);
    for (const line of lines) {
      expect(line).toMatch(/^ {3}- needs_/);
    }
  });

  it("returns the matching entry for a known id and undefined otherwise", () => {
    expect(getTaskCapability("needs_visual_composition")?.id).toBe("needs_visual_composition");
    expect(getTaskCapability("not-a-capability" as unknown as TaskCapabilityId)).toBeUndefined();
  });
});

describe("applyCatalogNormalizer", () => {
  function asSet(ids: TaskCapabilityId[]): Set<TaskCapabilityId> {
    return new Set(ids);
  }

  it("drops needs_visual_composition when the deliverable is a document", () => {
    const result = applyCatalogNormalizer({
      capabilities: asSet(["needs_visual_composition", "needs_multimodal_authoring"]),
      primaryOutcome: "document_package",
      deliverableKind: "document",
    });
    expect(Array.from(result).toSorted()).toEqual(["needs_multimodal_authoring"]);
  });

  it("keeps needs_visual_composition when deliverable.kind is image", () => {
    const result = applyCatalogNormalizer({
      capabilities: asSet(["needs_visual_composition"]),
      primaryOutcome: "document_package",
      deliverableKind: "image",
    });
    expect(Array.from(result)).toEqual(["needs_visual_composition"]);
  });

  it("leaves needs_visual_composition alone when no deliverable was resolved yet", () => {
    // Required so the legacy fallback inference can still see the capability
    // and choose kind=image; if we stripped it here the inference would fail.
    const result = applyCatalogNormalizer({
      capabilities: asSet(["needs_visual_composition"]),
      primaryOutcome: "document_package",
      deliverableKind: undefined,
    });
    expect(Array.from(result)).toEqual(["needs_visual_composition"]);
  });

  it("strips delivery-only capabilities on non-delivery outcomes", () => {
    const result = applyCatalogNormalizer({
      capabilities: asSet([
        "needs_external_delivery",
        "needs_high_reliability_provider",
        "needs_multimodal_authoring",
      ]),
      primaryOutcome: "document_package",
      deliverableKind: "document",
    });
    expect(Array.from(result).toSorted()).toEqual(["needs_multimodal_authoring"]);
  });

  it("preserves delivery-only capabilities on external_delivery outcomes", () => {
    const result = applyCatalogNormalizer({
      capabilities: asSet(["needs_external_delivery", "needs_high_reliability_provider"]),
      primaryOutcome: "external_delivery",
      deliverableKind: "external_delivery",
    });
    expect(Array.from(result).toSorted()).toEqual([
      "needs_external_delivery",
      "needs_high_reliability_provider",
    ]);
  });

  it("does not strip extraction-vs-tabular when extraction is not the dominant outcome", () => {
    // The classifier-side imperative normalizer owns the outcome-conditional
    // "extraction wins" rule. The catalog only enforces invariants that hold
    // independent of the dominant outcome.
    const result = applyCatalogNormalizer({
      capabilities: asSet(["needs_document_extraction", "needs_tabular_reasoning"]),
      primaryOutcome: "comparison_report",
      deliverableKind: "answer",
    });
    expect(Array.from(result).toSorted()).toEqual([
      "needs_document_extraction",
      "needs_tabular_reasoning",
    ]);
  });
});
