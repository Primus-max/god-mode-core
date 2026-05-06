// NEW-A Phase 2 tests — `deriveTurnModalityRequirements` mapping matrix
// across attachment-kind × effect-family × `needsVision`, plus reverse-test
// confirming `'audio'` / `'video'` are typed-but-inert.
// NEW-A Phase 3 tests — `modelCoversModalityRequirement` capability matrix.
//
// Sub-plan: .cursor/plans/commitment_kernel_modality_aware_routing.plan.md
// (todos `ma-phase-2-types-and-derivation`,
// `ma-phase-3-model-registry-surface-confirmation`).

import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "./model-catalog.js";
import {
  type ModalityRequirement,
  deriveTurnModalityRequirements,
  modelCoversModalityRequirement,
} from "./model-fallback-modality.js";

describe("deriveTurnModalityRequirements — Phase 2 mapping matrix", () => {
  it("image attachment → ['image', 'text'] (sorted)", () => {
    const result = deriveTurnModalityRequirements({
      inboundMediaSummary: {
        attachments: [{ kind: "image", path: "/tmp/photo.jpg" }],
      },
    });
    expect(result).toEqual(["image", "text"]);
  });

  it("pdf attachment → ['text'] (document-mode handled downstream)", () => {
    const result = deriveTurnModalityRequirements({
      inboundMediaSummary: {
        attachments: [{ kind: "pdf", path: "/tmp/doc.pdf" }],
      },
    });
    expect(result).toEqual(["text"]);
  });

  it("docx attachment → ['text']", () => {
    const result = deriveTurnModalityRequirements({
      inboundMediaSummary: {
        attachments: [{ kind: "docx", path: "/tmp/doc.docx" }],
      },
    });
    expect(result).toEqual(["text"]);
  });

  it("other attachment → ['text']", () => {
    const result = deriveTurnModalityRequirements({
      inboundMediaSummary: {
        attachments: [{ kind: "other", path: "/tmp/blob.bin" }],
      },
    });
    expect(result).toEqual(["text"]);
  });

  it("no attachments + no needsVision + no resolver → ['text']", () => {
    const result = deriveTurnModalityRequirements({});
    expect(result).toEqual(["text"]);
  });

  it("img2img desired family + image attachment → ['image', 'text']", () => {
    const result = deriveTurnModalityRequirements({
      inboundMediaSummary: {
        attachments: [{ kind: "image", path: "/tmp/source.jpg" }],
      },
      desiredEffectFamily: "image_generation_img2img",
    });
    expect(result).toEqual(["image", "text"]);
  });

  it("pure text-to-image desired family WITHOUT inbound image → ['text']", () => {
    // Generation effect alone does not require image-input on the planner
    // side — prompt is text, image is the output not the model INPUT
    // requirement. Confirms img2img branch is gated on inbound-image presence.
    const result = deriveTurnModalityRequirements({
      desiredEffectFamily: "image_generation",
    });
    expect(result).toEqual(["text"]);
  });

  it("needsVision === true + no attachment → ['image', 'text'] (defense-in-depth)", () => {
    const result = deriveTurnModalityRequirements({
      needsVision: true,
    });
    expect(result).toEqual(["image", "text"]);
  });

  it("multiple attachments (image + pdf) → ['image', 'text'] (image takes precedence)", () => {
    const result = deriveTurnModalityRequirements({
      inboundMediaSummary: {
        attachments: [
          { kind: "image", path: "/tmp/photo.jpg" },
          { kind: "pdf", path: "/tmp/doc.pdf" },
        ],
      },
    });
    expect(result).toEqual(["image", "text"]);
  });

  it("empty attachments array → ['text']", () => {
    const result = deriveTurnModalityRequirements({
      inboundMediaSummary: { attachments: [] },
    });
    expect(result).toEqual(["text"]);
  });
});

describe("deriveTurnModalityRequirements — output guarantees", () => {
  it("output is sorted (deterministic)", () => {
    const result = deriveTurnModalityRequirements({
      inboundMediaSummary: {
        attachments: [{ kind: "image", path: "/tmp/photo.jpg" }],
      },
      needsVision: true,
    });
    const sortedCopy = [...result].sort();
    expect([...result]).toEqual(sortedCopy);
  });

  it("output is frozen (caller cannot mutate)", () => {
    const result = deriveTurnModalityRequirements({});
    expect(Object.isFrozen(result)).toBe(true);
    // Cast to mutable to bypass compile-time `readonly` — verifies the
    // RUNTIME frozen guarantee (Object.freeze) actually rejects mutation.
    expect(() => {
      (result as ModalityRequirement[]).push("image");
    }).toThrow();
  });

  it("output is always non-empty (text always present)", () => {
    const empty = deriveTurnModalityRequirements({});
    expect(empty).toContain("text");
    const withImage = deriveTurnModalityRequirements({
      inboundMediaSummary: {
        attachments: [{ kind: "image" }],
      },
    });
    expect(withImage).toContain("text");
    const withDocs = deriveTurnModalityRequirements({
      inboundMediaSummary: {
        attachments: [{ kind: "pdf" }, { kind: "docx" }, { kind: "other" }],
      },
    });
    expect(withDocs).toContain("text");
  });

  it("duplicate image signals collapse to single requirement (set semantics)", () => {
    const result = deriveTurnModalityRequirements({
      inboundMediaSummary: {
        attachments: [
          { kind: "image", path: "/a.jpg" },
          { kind: "image", path: "/b.jpg" },
        ],
      },
      needsVision: true,
      desiredEffectFamily: "image_generation_img2img",
    });
    expect(result).toEqual(["image", "text"]);
  });
});

describe("deriveTurnModalityRequirements — reverse-test (typed-but-inert)", () => {
  // Reverse coverage required by Phase 2 spec: `'audio'` / `'video'` are
  // members of the `ModalityRequirement` union (typed) but NO derivation path
  // produces them today (inert). When future inbound kinds wire in audio /
  // video this test becomes the canary that flags the behaviour change.

  it("'audio' is never produced by any derivation input", () => {
    const inputs = [
      {},
      { inboundMediaSummary: { attachments: [] } },
      { inboundMediaSummary: { attachments: [{ kind: "image" as const }] } },
      { inboundMediaSummary: { attachments: [{ kind: "pdf" as const }] } },
      { inboundMediaSummary: { attachments: [{ kind: "docx" as const }] } },
      { inboundMediaSummary: { attachments: [{ kind: "other" as const }] } },
      { needsVision: true },
      { desiredEffectFamily: "image_generation" },
      {
        desiredEffectFamily: "image_generation_img2img",
        inboundMediaSummary: { attachments: [{ kind: "image" as const }] },
      },
    ];
    for (const input of inputs) {
      const result = deriveTurnModalityRequirements(input);
      expect(result).not.toContain("audio");
    }
  });

  it("'video' is never produced by any derivation input", () => {
    const inputs = [
      {},
      { inboundMediaSummary: { attachments: [] } },
      { inboundMediaSummary: { attachments: [{ kind: "image" as const }] } },
      { inboundMediaSummary: { attachments: [{ kind: "pdf" as const }] } },
      { needsVision: true },
      { desiredEffectFamily: "image_generation_img2img" },
    ];
    for (const input of inputs) {
      const result = deriveTurnModalityRequirements(input);
      expect(result).not.toContain("video");
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — `modelCoversModalityRequirement` capability matrix.
// ---------------------------------------------------------------------------

/**
 * Minimal `ModelCatalogEntry` factory — only fields the helper structurally
 * reads. Provider/id are NEVER read by the helper (capability-driven contract);
 * fixed strings here serve only as identification for failing-test diffs.
 */
function makeEntry(
  input: ModelCatalogEntry["input"],
): ModelCatalogEntry {
  return {
    id: "test-model",
    name: "test-model",
    provider: "test-provider",
    input,
  };
}

describe("modelCoversModalityRequirement — Phase 3 capability matrix", () => {
  it("entry input=['text'] covers 'text' → true", () => {
    expect(modelCoversModalityRequirement(makeEntry(["text"]), "text")).toBe(true);
  });

  it("entry input=['text'] does NOT cover 'image' → false", () => {
    expect(modelCoversModalityRequirement(makeEntry(["text"]), "image")).toBe(false);
  });

  it("entry input=['text','image'] covers both 'text' and 'image' → true/true", () => {
    const entry = makeEntry(["text", "image"]);
    expect(modelCoversModalityRequirement(entry, "text")).toBe(true);
    expect(modelCoversModalityRequirement(entry, "image")).toBe(true);
  });

  it("entry input=undefined covers 'text' → true (always-text invariant)", () => {
    expect(modelCoversModalityRequirement(makeEntry(undefined), "text")).toBe(true);
  });

  it("entry input=undefined does NOT cover 'image' (conservative undefined→text-only)", () => {
    // Many local providers omit the `input` field. Slice-level conservative
    // posture: assume `['text']`-only — must NOT silently grant image-capability.
    expect(modelCoversModalityRequirement(makeEntry(undefined), "image")).toBe(false);
  });

  it("entry input=['document'] does NOT cover 'image' → false", () => {
    // 'document' is its own catalog modality (PDF / docx native); does not imply
    // image capability.
    expect(modelCoversModalityRequirement(makeEntry(["document"]), "image")).toBe(false);
  });

  it("entry input=['document'] covers 'text' → true (text always covered)", () => {
    expect(modelCoversModalityRequirement(makeEntry(["document"]), "text")).toBe(true);
  });

  it("entry input=['image'] covers 'image' → true and 'text' → true (no model is text-blind)", () => {
    // Defensive — even an `input` list that pathologically omits 'text' still
    // accepts text (every chat-completion model accepts text). Helper's text
    // branch returns true unconditionally.
    const entry = makeEntry(["image"]);
    expect(modelCoversModalityRequirement(entry, "image")).toBe(true);
    expect(modelCoversModalityRequirement(entry, "text")).toBe(true);
  });

  it("entry input=[] does NOT cover 'image' but covers 'text'", () => {
    const entry = makeEntry([]);
    expect(modelCoversModalityRequirement(entry, "image")).toBe(false);
    expect(modelCoversModalityRequirement(entry, "text")).toBe(true);
  });
});

describe("modelCoversModalityRequirement — Phase 3 reverse-tests (typed-but-inert)", () => {
  // Reverse coverage required by Phase 3 spec: 'audio' / 'video' are members
  // of `ModalityRequirement` (typed) but no current `ModelInputType` value
  // declares them — helper MUST fail-closed. When a future slice widens
  // `ModelInputType` to include 'audio' or 'video', these tests become the
  // canary that forces an update to the helper.

  it("'audio' requirement against entry input=['text','image'] → false", () => {
    expect(
      modelCoversModalityRequirement(makeEntry(["text", "image"]), "audio"),
    ).toBe(false);
  });

  it("'audio' requirement against entry input=['text','image','document'] → false", () => {
    // Even a maximally-capable current catalog entry fails the audio check.
    expect(
      modelCoversModalityRequirement(makeEntry(["text", "image", "document"]), "audio"),
    ).toBe(false);
  });

  it("'audio' requirement against entry input=undefined → false", () => {
    expect(modelCoversModalityRequirement(makeEntry(undefined), "audio")).toBe(false);
  });

  it("'video' requirement against entry input=['text','image'] → false", () => {
    expect(
      modelCoversModalityRequirement(makeEntry(["text", "image"]), "video"),
    ).toBe(false);
  });

  it("'video' requirement against entry input=['text','image','document'] → false", () => {
    expect(
      modelCoversModalityRequirement(makeEntry(["text", "image", "document"]), "video"),
    ).toBe(false);
  });

  it("'video' requirement against entry input=undefined → false", () => {
    expect(modelCoversModalityRequirement(makeEntry(undefined), "video")).toBe(false);
  });

  it("ALL current ModelInputType combinations fail 'audio' and 'video' (matrix)", () => {
    // Closed enumeration of every non-empty subset of ModelInputType plus
    // undefined / empty. Each MUST fail-closed for audio + video.
    const allInputs: Array<ModelCatalogEntry["input"]> = [
      undefined,
      [],
      ["text"],
      ["image"],
      ["document"],
      ["text", "image"],
      ["text", "document"],
      ["image", "document"],
      ["text", "image", "document"],
    ];
    const inertRequirements: ModalityRequirement[] = ["audio", "video"];
    for (const input of allInputs) {
      for (const requirement of inertRequirements) {
        expect(modelCoversModalityRequirement(makeEntry(input), requirement)).toBe(
          false,
        );
      }
    }
  });
});

describe("modelCoversModalityRequirement — Phase 3 brand discipline", () => {
  it("helper does NOT branch on entry.provider / entry.id / entry.name (capability-driven)", () => {
    // Provider-agnostic invariant — same `input` capability list MUST yield
    // identical answer regardless of provider/id/name. Three entries with
    // wildly different provider strings but identical `input` field — all
    // three return the same answer for every requirement.
    const a: ModelCatalogEntry = {
      id: "claude-opus-4.6",
      name: "claude-opus-4.6",
      provider: "hydra",
      input: ["text"],
    };
    const b: ModelCatalogEntry = {
      id: "gpt-5.4",
      name: "gpt-5.4",
      provider: "hydra",
      input: ["text"],
    };
    const c: ModelCatalogEntry = {
      id: "local-llama",
      name: "local-llama",
      provider: "ollama",
      input: ["text"],
    };
    for (const requirement of ["text", "image", "audio", "video"] as const) {
      const answers = [a, b, c].map((entry) =>
        modelCoversModalityRequirement(entry, requirement),
      );
      expect(answers[0]).toBe(answers[1]);
      expect(answers[1]).toBe(answers[2]);
    }
  });
});
