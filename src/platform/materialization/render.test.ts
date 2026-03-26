import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TRUSTED_CAPABILITY_CATALOG } from "../bootstrap/defaults.js";
import { getPlatformBootstrapService, resetPlatformBootstrapService } from "../bootstrap/index.js";
import { getInitialProfile } from "../profile/defaults.js";
import { applyTaskOverlay } from "../profile/overlay.js";
import { createCapabilityRegistry } from "../registry/capability-registry.js";
import { materializeArtifact, renderMarkdownToHtml, runMaterializationBootstrap } from "./index.js";

function makePolicyContext(explicitApproval: boolean) {
  const profile = getInitialProfile("developer")!;
  return {
    activeProfileId: profile.id,
    activeProfile: profile,
    effective: applyTaskOverlay(
      profile,
      profile.taskOverlays?.find((overlay) => overlay.id === "code_first"),
    ),
    intent: "code" as const,
    explicitApproval,
  };
}

describe("materialization render layer", () => {
  afterEach(() => {
    resetPlatformBootstrapService();
  });

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
      installMethod: "download",
      reason: "renderer_unavailable",
      sourceDomain: "document",
    });
    expect(getPlatformBootstrapService().list()).toEqual([
      expect.objectContaining({
        capabilityId: "pdf-renderer",
        state: "pending",
      }),
    ]);
  });

  it("runs bootstrap orchestration for degraded pdf materialization on explicit approval", async () => {
    const outputDir = path.join(os.tmpdir(), "openclaw-materialization-tests", "bootstrap");
    const registry = createCapabilityRegistry([], TRUSTED_CAPABILITY_CATALOG);
    const result = materializeArtifact(
      {
        artifactId: "pdf-2",
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
      { pdfRendererAvailable: false, capabilityRegistry: registry },
    );

    const bootstrap = await runMaterializationBootstrap({
      materialization: result,
      policyContext: makePolicyContext(true),
      registry,
      installers: {
        download: async ({ request }) => ({
          ok: true,
          capability: {
            ...request.catalogEntry.capability,
            status: "available",
            trusted: true,
            installMethod: "download",
            sandboxed: true,
          },
        }),
      },
      availableBins: ["playwright"],
      runHealthCheckCommand: async () => true,
    });

    expect(bootstrap?.status).toBe("bootstrapped");
    expect(bootstrap?.lifecycle?.status).toBe("available");
    expect(registry.get("pdf-renderer")?.status).toBe("available");
  });
});
