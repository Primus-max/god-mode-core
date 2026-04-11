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
    "    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 40px auto; max-width: 960px; line-height: 1.6; padding: 0 24px; color: #111827; background: #fff; }",
    "    h1, h2, h3, h4, h5, h6 { line-height: 1.25; letter-spacing: -0.02em; }",
    "    h1 { font-size: 2.2rem; margin-bottom: 0.5rem; }",
    "    h2 { margin-top: 1.8rem; font-size: 1.45rem; }",
    "    h3 { margin-top: 1.4rem; font-size: 1.15rem; }",
    "    p, li { font-size: 0.98rem; }",
    "    pre { overflow-x: auto; padding: 16px; background: rgba(127, 127, 127, 0.12); border-radius: 12px; }",
    "    code { font-family: 'Cascadia Code', Consolas, monospace; }",
    "    table { border-collapse: separate; border-spacing: 0; width: 100%; margin: 18px 0 24px; overflow: hidden; border-radius: 14px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); }",
    "    th, td { border: 1px solid rgba(127, 127, 127, 0.22); padding: 10px 12px; text-align: left; vertical-align: top; }",
    "    th { background: linear-gradient(180deg, rgba(241, 245, 249, 0.95), rgba(226, 232, 240, 0.95)); font-weight: 700; }",
    "    tr:nth-child(even) td { background: rgba(248, 250, 252, 0.9); }",
    "    blockquote { margin: 18px 0; padding: 14px 18px; border-left: 4px solid #2563eb; background: rgba(239, 246, 255, 0.95); border-radius: 0 12px 12px 0; }",
    "    blockquote p { margin: 0; }",
    "    hr { border: 0; border-top: 1px solid rgba(148, 163, 184, 0.45); margin: 28px 0; }",
    "    ul, ol { padding-left: 1.35rem; }",
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
