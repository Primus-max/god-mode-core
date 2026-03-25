import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { materializeArtifact, renderMarkdownToHtml } from "./index.js";

describe("materialization render layer", () => {
  it("renders markdown to html with basic structure", () => {
    const html = renderMarkdownToHtml("# Title\n\n- one\n- two\n\n`code`");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<code>code</code>");
  });

  it("materializes markdown into a file-backed output with pdf companion", () => {
    const outputDir = path.join(os.tmpdir(), "openclaw-materialization-tests", "markdown-report");
    const result = materializeArtifact({
      artifactId: "doc-report-1",
      label: "Document Report",
      sourceDomain: "document",
      renderKind: "markdown",
      outputTarget: "file",
      outputDir,
      includePdf: true,
      payload: {
        title: "Document Report",
        markdown: "# Summary\n\nReport body.",
      },
    });

    expect(result.primary.path.endsWith(".md")).toBe(true);
    expect(fs.existsSync(result.primary.path)).toBe(true);
    expect(result.supporting?.some((output) => output.renderKind === "pdf")).toBe(true);
  });

  it("materializes preview html with a local preview url", () => {
    const outputDir = path.join(os.tmpdir(), "openclaw-materialization-tests", "preview");
    const result = materializeArtifact({
      artifactId: "preview-1",
      label: "Preview Site",
      sourceDomain: "developer",
      renderKind: "site_preview",
      outputTarget: "preview",
      outputDir,
      payload: {
        title: "Preview Site",
        markdown: "# Preview\n\nReady for review.",
      },
    });

    expect(result.primary.mimeType).toBe("text/html");
    expect(result.primary.url?.startsWith("file:///")).toBe(true);
  });

  it("falls back to html when the pdf renderer is unavailable", () => {
    const outputDir = path.join(os.tmpdir(), "openclaw-materialization-tests", "degraded");
    const result = materializeArtifact(
      {
        artifactId: "pdf-1",
        label: "PDF Report",
        sourceDomain: "document",
        renderKind: "pdf",
        outputTarget: "file",
        outputDir,
        payload: {
          title: "PDF Report",
          markdown: "# Fallback",
        },
      },
      { pdfRendererAvailable: false },
    );

    expect(result.degraded).toBe(true);
    expect(result.primary.renderKind).toBe("html");
    expect(result.warnings).toContain("pdf renderer unavailable; fell back to html output");
    expect(result.bootstrapRequest).toMatchObject({
      capabilityId: "pdf-renderer",
      reason: "renderer_unavailable",
      sourceDomain: "document",
    });
  });
});
