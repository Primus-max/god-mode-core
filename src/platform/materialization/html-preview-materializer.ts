import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { MaterializationOutputTarget, MaterializedArtifactOutput } from "./contracts.js";
import { escapeHtml, renderMarkdownToHtml } from "./markdown-report-materializer.js";

function renderJsonBlock(jsonData: unknown): string {
  return `<pre>${escapeHtml(JSON.stringify(jsonData, null, 2))}</pre>`;
}

function renderTextBlock(text: string): string {
  return `<p>${escapeHtml(text).replaceAll("\n", "<br />")}</p>`;
}

export function buildHtmlDocument(params: {
  title: string;
  bodyHtml: string;
  summary?: string;
}): string {
  const escapedTitle = escapeHtml(params.title);
  const escapedSummary = params.summary
    ? `<p class="summary">${escapeHtml(params.summary)}</p>`
    : "";
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${escapedTitle}</title>`,
    "  <style>",
    "    :root { color-scheme: light dark; }",
    "    body { font-family: Georgia, 'Times New Roman', serif; margin: 40px auto; max-width: 900px; line-height: 1.6; padding: 0 24px; }",
    "    h1, h2, h3, h4, h5, h6 { line-height: 1.25; }",
    "    pre { overflow-x: auto; padding: 16px; background: rgba(127, 127, 127, 0.12); border-radius: 8px; }",
    "    code { font-family: 'Cascadia Code', Consolas, monospace; }",
    "    table { border-collapse: collapse; width: 100%; margin: 16px 0; }",
    "    th, td { border: 1px solid rgba(127, 127, 127, 0.35); padding: 8px 10px; text-align: left; }",
    "    .summary { color: rgba(127, 127, 127, 0.95); }",
    "  </style>",
    "</head>",
    "<body>",
    `  <h1>${escapedTitle}</h1>`,
    `  ${escapedSummary}`,
    `  <main>${params.bodyHtml}</main>`,
    "</body>",
    "</html>",
  ].join("\n");
}

export function resolveHtmlBody(params: {
  html?: string;
  markdown?: string;
  text?: string;
  jsonData?: unknown;
}): string {
  if (params.html) {
    return params.html;
  }
  if (params.markdown) {
    return renderMarkdownToHtml(params.markdown);
  }
  if (params.text) {
    return renderTextBlock(params.text);
  }
  return renderJsonBlock(params.jsonData ?? {});
}

export function writeHtmlMaterialization(params: {
  outputDir: string;
  baseFileName: string;
  title: string;
  bodyHtml: string;
  summary?: string;
  outputTarget: MaterializationOutputTarget;
  renderKind: "html" | "site_preview";
}): MaterializedArtifactOutput {
  fs.mkdirSync(params.outputDir, { recursive: true });
  const filePath = path.join(params.outputDir, `${params.baseFileName}.html`);
  const html = buildHtmlDocument({
    title: params.title,
    bodyHtml: params.bodyHtml,
    summary: params.summary,
  });
  fs.writeFileSync(filePath, html, "utf8");
  const sizeBytes = fs.statSync(filePath).size;
  return {
    renderKind: params.renderKind,
    outputTarget: params.outputTarget,
    path: filePath,
    url: params.outputTarget === "preview" ? pathToFileURL(filePath).toString() : undefined,
    mimeType: "text/html",
    sizeBytes,
    lifecycle: params.outputTarget === "preview" ? "preview" : "draft",
  };
}
