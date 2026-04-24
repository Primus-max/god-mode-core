import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFallbackPdfHtmlBody,
  buildPromptOnlyPdfMaterializationRequest,
  inlinePdfImageAssets,
  looksLikeCompletePdfHtmlDocument,
  looksLikePdfHtmlPayload,
  normalizePdfBodyText,
  pdfNeedsManagedRendererFromConstraints,
  pdfRequestedPageCount,
  pdfWantsRichDraftFromConstraints,
} from "./pdf-tool.prompt-only.js";

describe("pdf tool prompt-only helpers", () => {
  it("only demands the managed renderer when the deliverable explicitly says so", () => {
    expect(pdfNeedsManagedRendererFromConstraints(undefined)).toBe(false);
    expect(pdfNeedsManagedRendererFromConstraints({ style: "minimal" })).toBe(false);
    expect(pdfNeedsManagedRendererFromConstraints({ style: "infographic" })).toBe(true);
    expect(pdfNeedsManagedRendererFromConstraints({ style: "presentation" })).toBe(true);
    expect(pdfNeedsManagedRendererFromConstraints({ needsManagedRenderer: true })).toBe(true);
  });

  it("always asks the model to draft a design — no minimal/rich fork", () => {
    expect(pdfWantsRichDraftFromConstraints(undefined)).toBe(true);
    expect(pdfWantsRichDraftFromConstraints({ style: "minimal" })).toBe(true);
    expect(pdfWantsRichDraftFromConstraints({ style: "rich" })).toBe(true);
    expect(pdfWantsRichDraftFromConstraints({ style: "presentation" })).toBe(true);
  });

  it("reads page count from constraints and clamps it to 1-12", () => {
    expect(pdfRequestedPageCount(undefined)).toBeNull();
    expect(pdfRequestedPageCount({ pageCount: 3 })).toBe(3);
    expect(pdfRequestedPageCount({ pageCount: 0 })).toBeNull();
    expect(pdfRequestedPageCount({ pageCount: 99 })).toBeNull();
    expect(pdfRequestedPageCount({ pageCount: Number.NaN })).toBeNull();
  });

  it("normalizes body text without parsing linguistic intent", () => {
    expect(normalizePdfBodyText("Create    a PDF    about routing   ")).toBe(
      "Create a PDF about routing",
    );
  });

  it("recognises a complete LLM-authored HTML document", () => {
    expect(looksLikeCompletePdfHtmlDocument("<!doctype html><html></html>")).toBe(true);
    expect(looksLikeCompletePdfHtmlDocument("<html><body>x</body></html>")).toBe(true);
    expect(looksLikeCompletePdfHtmlDocument("# Just markdown")).toBe(false);
  });

  it("recognises styled HTML fragments as PDF-ready payloads", () => {
    expect(looksLikePdfHtmlPayload("<style>body{}</style><section>hi</section>")).toBe(true);
    expect(looksLikePdfHtmlPayload("<h1>Title</h1><p>body</p>")).toBe(true);
    expect(looksLikePdfHtmlPayload("Just a sentence with no tags.")).toBe(false);
  });

  it("inlines image assets referenced by file name into LLM HTML output", () => {
    const html =
      '<article><img src="chart.png" alt="Chart"><img src="https://x/y.png" alt="external"></article>';
    const inlined = inlinePdfImageAssets(html, [
      { fileName: "chart.png", mimeType: "image/png", base64: "ZmFrZQ==" },
    ]);
    expect(inlined).toContain('src="data:image/png;base64,ZmFrZQ=="');
    expect(inlined).toContain('src="https://x/y.png"');
  });

  it("does not double-inline data URIs already present in the HTML", () => {
    const html = '<img src="data:image/png;base64,AAAA">';
    const inlined = inlinePdfImageAssets(html, [
      { fileName: "chart.png", mimeType: "image/png", base64: "ZmFrZQ==" },
    ]);
    expect(inlined).toBe(html);
  });

  it("renders the minimal fallback body without any opinionated styling", () => {
    const html = buildFallbackPdfHtmlBody({
      bodyMarkdown: "# Title\n\nBody paragraph.",
      images: [{ fileName: "diagram.png", mimeType: "image/png", base64: "ZmFrZQ==" }],
    });

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("data:image/png;base64,ZmFrZQ==");
    // No layered "deck" template, no decorative gradients, no font-family stack,
    // no hardcoded color palette — the LLM (or the eventual viewer) decides.
    expect(html).not.toContain("oc-pdf-deck");
    expect(html).not.toContain("oc-pdf-page");
    expect(html).not.toContain("break-before:page");
    expect(html).not.toContain("font-family");
    expect(html).not.toContain("linear-gradient");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
  });

  it("does not duplicate images that are already referenced by the markdown", () => {
    const html = buildFallbackPdfHtmlBody({
      bodyMarkdown: "# Title\n\n![alt](diagram.png)",
      images: [{ fileName: "diagram.png", mimeType: "image/png", base64: "ZmFrZQ==" }],
    });

    expect(html.match(/diagram\.png/giu)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(html.match(/<figure>/giu) ?? []).toHaveLength(0);
  });

  it("builds a canonical prompt-only pdf materialization request", () => {
    const request = buildPromptOnlyPdfMaterializationRequest({
      filename: "routing-report.pdf",
      title: "Routing Report",
      bodyHtml: "<h1>Routing</h1>",
      outputDir: path.join(os.tmpdir(), "openclaw-pdf-tool"),
    });

    expect(request).toMatchObject({
      artifactId: "pdf-tool-routing-report",
      renderKind: "pdf",
      documentInputKind: "html",
      rendererTarget: "pdf",
      baseFileName: "routing-report",
      payload: {
        html: "<h1>Routing</h1>",
      },
    });
  });
});
