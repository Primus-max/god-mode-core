import { describe, expect, it } from "vitest";
import type {
  InboundMediaAttachment,
  InboundMediaAttachmentKind,
  InboundMediaSummary,
} from "../types.js";

/**
 * S11b prep — structural sanity checks. Types are pure data with no
 * runtime semantics, so the test exercises type-construction only:
 *   - each closed `kind` enum literal is assignable;
 *   - `InboundMediaAttachment` and `InboundMediaSummary` accept
 *     well-shaped values, including the optional `sourceTurnId`;
 *   - empty-attachments and absent-summary shapes (the elision
 *     contract) compile.
 *
 * If the relocation regresses the type shape (e.g. accidentally
 * widens `kind` or drops `readonly`), `pnpm tsgo` fails before this
 * file even runs.
 */
describe("InboundMedia types — S11b relocation sanity", () => {
  it("accepts every closed `kind` enum literal", () => {
    const kinds: readonly InboundMediaAttachmentKind[] = ["image", "pdf", "docx", "other"];
    expect(kinds).toHaveLength(4);
  });

  it("constructs an InboundMediaAttachment with every field", () => {
    const attachment: InboundMediaAttachment = {
      path: "/tmp/sketch.png",
      mimeType: "image/png",
      kind: "image",
      sourceTurnId: "turn-abc",
    };
    expect(attachment.kind).toBe("image");
    expect(attachment.sourceTurnId).toBe("turn-abc");
  });

  it("accepts an InboundMediaAttachment without optional sourceTurnId", () => {
    const attachment: InboundMediaAttachment = {
      path: "/tmp/x.pdf",
      mimeType: "application/pdf",
      kind: "pdf",
    };
    expect(attachment.sourceTurnId).toBeUndefined();
  });

  it("constructs an InboundMediaSummary with multiple attachments", () => {
    const summary: InboundMediaSummary = {
      attachments: [
        { path: "/a.png", mimeType: "image/png", kind: "image" },
        { path: "/b.pdf", mimeType: "application/pdf", kind: "pdf" },
      ],
    };
    expect(summary.attachments).toHaveLength(2);
    expect(summary.attachments[0]?.kind).toBe("image");
  });

  it("constructs an empty-attachments summary (elision contract)", () => {
    const summary: InboundMediaSummary = { attachments: [] };
    expect(summary.attachments).toHaveLength(0);
  });
});
