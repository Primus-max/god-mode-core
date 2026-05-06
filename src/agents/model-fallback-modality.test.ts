// NEW-A Phase 2 tests — `deriveTurnModalityRequirements` mapping matrix
// across attachment-kind × effect-family × `needsVision`, plus reverse-test
// confirming `'audio'` / `'video'` are typed-but-inert.
//
// Sub-plan: .cursor/plans/commitment_kernel_modality_aware_routing.plan.md
// (todo `ma-phase-2-types-and-derivation`).

import { describe, expect, it } from "vitest";
import {
  type ModalityRequirement,
  deriveTurnModalityRequirements,
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
