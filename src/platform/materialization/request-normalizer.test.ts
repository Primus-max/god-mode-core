import { describe, expect, it } from "vitest";
import {
  canonicalizeMaterializationRequest,
  inferDocumentInputKind,
  inferRendererTarget,
} from "./request-normalizer.js";
import { resolveRendererDefinition } from "./renderer-registry.js";

describe("materialization request normalizer", () => {
  it("derives markdown input and html renderer target from a legacy html request", () => {
    const request = {
      artifactId: "legacy-html-1",
      label: "Legacy HTML",
      sourceDomain: "document" as const,
      renderKind: "html" as const,
      outputTarget: "file" as const,
      payload: {
        markdown: "# Legacy",
      },
    };

    expect(inferDocumentInputKind(request)).toBe("markdown");
    expect(inferRendererTarget(request)).toBe("html");

    const canonical = canonicalizeMaterializationRequest(request);
    expect(canonical.documentInputKind).toBe("markdown");
    expect(canonical.rendererTarget).toBe("html");
    expect(canonical.htmlBody).toContain("<h1>Legacy</h1>");
  });

  it("preserves explicit contract hints when provided", () => {
    const canonical = canonicalizeMaterializationRequest({
      artifactId: "explicit-pdf-1",
      label: "Explicit PDF",
      sourceDomain: "document",
      renderKind: "pdf",
      documentInputKind: "html",
      rendererTarget: "pdf",
      outputTarget: "file",
      payload: {
        html: "<h1>Ready</h1>",
      },
    });

    expect(canonical.documentInputKind).toBe("html");
    expect(canonical.rendererTarget).toBe("pdf");
    expect(canonical.htmlBody).toBe("<h1>Ready</h1>");
  });

  it("resolves renderers from the shared registry", () => {
    expect(
      resolveRendererDefinition({
        rendererTarget: "preview",
        outputTarget: "preview",
      }).id,
    ).toBe("html-preview");
    expect(
      resolveRendererDefinition({
        rendererTarget: "pdf",
        outputTarget: "file",
      }).id,
    ).toBe("pdf-from-html");
  });
});
