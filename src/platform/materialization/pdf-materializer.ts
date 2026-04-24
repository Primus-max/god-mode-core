import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBrowserConfig } from "../../browser/config.js";
import { loadConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import {
  getApprovedCapabilityCatalogEntry,
  resolvePlatformBootstrapNodeCapabilityInstallDir,
} from "../bootstrap/index.js";
import type {
  MaterializationDocumentInputKind,
  MaterializationRendererTarget,
  MaterializedArtifactOutput,
} from "./contracts.js";

const require = createRequire(import.meta.url);

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&#39;/gu, "'")
    .replace(/&quot;/gu, '"')
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function resolvePdfBrowserLaunchOptions(): {
  extraArgs?: string[];
} {
  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const extraArgs = [...(resolved.noSandbox ? ["--no-sandbox"] : []), ...resolved.extraArgs];
  return {
    ...(extraArgs.length > 0 ? { extraArgs } : {}),
  };
}

function resolvePackageImportModuleUrl(packageDir: string): string | undefined {
  const manifestPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(manifestPath)) {
    return undefined;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      exports?: { ".": { import?: string } | string };
      module?: string;
      main?: string;
    };
    const rootExport = manifest.exports?.["."];
    const relativeEntry =
      typeof rootExport === "object" && typeof rootExport.import === "string"
        ? rootExport.import
        : typeof manifest.module === "string"
          ? manifest.module
          : typeof manifest.main === "string"
            ? manifest.main
            : "index.mjs";
    const entryPath = path.join(packageDir, relativeEntry.replace(/^\.\//u, ""));
    return fs.existsSync(entryPath) ? pathToFileURL(entryPath).toString() : undefined;
  } catch {
    return undefined;
  }
}

export function resolvePdfPlaywrightModuleUrl(): string {
  const entry = getApprovedCapabilityCatalogEntry("pdf-renderer");
  if (entry?.install?.method === "node") {
    const installDir = resolvePlatformBootstrapNodeCapabilityInstallDir({
      capabilityId: "pdf-renderer",
      stateDir: resolveStateDir(process.env),
    });
    const healthCheckScript = path.join(installDir, ".openclaw-bootstrap-healthcheck.cjs");
    if (fs.existsSync(healthCheckScript)) {
      const managedModuleUrl = resolvePackageImportModuleUrl(installDir);
      if (managedModuleUrl) {
        return managedModuleUrl;
      }
    }
  }
  return pathToFileURL(require.resolve("playwright-core")).toString();
}

function writePlaywrightPdf(params: { htmlPath: string; pdfPath: string }): void {
  const launchOptions = resolvePdfBrowserLaunchOptions();
  // Page geometry is intentionally driven from the document via CSS `@page`:
  //   @page { size: A4 landscape; margin: 0 } / @page { size: 1280px 720px } / etc.
  // We keep A4 + modest margins as a fallback only for legacy callers that emit
  // bare HTML without a `@page` rule. `preferCSSPageSize: true` ensures the
  // document wins whenever it declares its own size. Background colors/images
  // are always printed so dark themes, gradients and full-bleed art survive.
  const script = `
    import { pathToFileURL } from "node:url";

    const htmlPath = process.env.OPENCLAW_PDF_HTML;
    const pdfPath = process.env.OPENCLAW_PDF_OUT;
    const playwrightModuleUrl = process.env.OPENCLAW_PDF_PLAYWRIGHT_MODULE;
    const browserExtraArgsRaw = process.env.OPENCLAW_PDF_BROWSER_ARGS;
    if (!htmlPath || !pdfPath || !playwrightModuleUrl) {
      throw new Error("OPENCLAW_PDF_HTML / OPENCLAW_PDF_OUT / OPENCLAW_PDF_PLAYWRIGHT_MODULE env vars are required");
    }
    const playwrightModule = await import(playwrightModuleUrl);
    const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;
    if (!chromium) {
      throw new Error("playwright-core chromium export is unavailable");
    }
    const launchOptions = { headless: true };
    if (browserExtraArgsRaw) {
      launchOptions.args = JSON.parse(browserExtraArgsRaw);
    }

    const browser = await chromium.launch(launchOptions);
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(htmlPath).toString(), { waitUntil: "networkidle" });
      await page.emulateMedia({ media: "screen" });
      await page.pdf({
        path: pdfPath,
        format: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: "14mm", right: "12mm", bottom: "14mm", left: "12mm" },
      });
    } finally {
      await browser.close();
    }
  `;
  execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      OPENCLAW_PDF_HTML: params.htmlPath,
      OPENCLAW_PDF_OUT: params.pdfPath,
      OPENCLAW_PDF_PLAYWRIGHT_MODULE: resolvePdfPlaywrightModuleUrl(),
      ...(launchOptions.extraArgs
        ? { OPENCLAW_PDF_BROWSER_ARGS: JSON.stringify(launchOptions.extraArgs) }
        : {}),
    },
    stdio: "pipe",
  });
}

const COMPLETE_HTML_DOCUMENT_HEAD = /^\s*(?:<!doctype\b|<html\b)/iu;

function htmlIsCompleteDocument(html: string): boolean {
  return COMPLETE_HTML_DOCUMENT_HEAD.test(html);
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

/**
 * Wrap an HTML fragment with the bare minimum needed for Playwright to render it
 * to PDF: a doctype, charset, viewport and title. We deliberately do NOT inject
 * any opinionated typography, colors, gradients or layout — that's the LLM's job
 * (or the caller's). Page-break behaviour is left to the document author via
 * `break-before:page` / `page-break-before:always`.
 */
function wrapPdfHtmlFragment(params: { title: string; bodyHtml: string }): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtmlAttr(params.title)}</title>`,
    "</head>",
    "<body>",
    params.bodyHtml,
    "</body>",
    "</html>",
  ].join("\n");
}

function writeTempHtmlForPdf(params: {
  outputDir: string;
  baseFileName: string;
  title: string;
  bodyHtml: string;
  summary?: string;
}): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pdf-render-"));
  const htmlPath = path.join(tempDir, `${params.baseFileName}.html`);
  const documentHtml = htmlIsCompleteDocument(params.bodyHtml)
    ? params.bodyHtml
    : wrapPdfHtmlFragment({ title: params.title, bodyHtml: params.bodyHtml });
  fs.writeFileSync(htmlPath, documentHtml, "utf8");
  return htmlPath;
}

export function writePdfFileFromHtml(params: {
  outputDir: string;
  baseFileName: string;
  title: string;
  bodyHtml: string;
  summary?: string;
}): { path: string; sizeBytes: number } {
  fs.mkdirSync(params.outputDir, { recursive: true });
  const filePath = path.join(params.outputDir, `${params.baseFileName}.pdf`);
  const htmlPath = writeTempHtmlForPdf(params);
  try {
    writePlaywrightPdf({ htmlPath, pdfPath: filePath });
  } finally {
    fs.rmSync(path.dirname(htmlPath), { recursive: true, force: true });
  }
  return {
    path: filePath,
    sizeBytes: fs.statSync(filePath).size,
  };
}

export function writePdfMaterialization(params: {
  outputDir: string;
  baseFileName: string;
  html: string;
  title?: string;
  summary?: string;
  documentInputKind?: MaterializationDocumentInputKind;
  rendererTarget?: MaterializationRendererTarget;
  rendererId?: string;
}): MaterializedArtifactOutput {
  const text = stripHtml(params.html);
  const { path: filePath, sizeBytes } = writePdfFileFromHtml({
    outputDir: params.outputDir,
    baseFileName: params.baseFileName,
    title: params.title ?? params.baseFileName,
    summary: params.summary,
    bodyHtml: params.html || `<p>${text || "OpenClaw materialized artifact"}</p>`,
  });
  return {
    renderKind: "pdf",
    ...(params.documentInputKind ? { documentInputKind: params.documentInputKind } : {}),
    ...(params.rendererTarget ? { rendererTarget: params.rendererTarget } : {}),
    ...(params.rendererId ? { rendererId: params.rendererId } : {}),
    outputTarget: "file",
    path: filePath,
    mimeType: "application/pdf",
    sizeBytes,
    lifecycle: "draft",
  };
}
