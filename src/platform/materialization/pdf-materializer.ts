import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHtmlDocument } from "./html-preview-materializer.js";
import type { MaterializedArtifactOutput } from "./contracts.js";

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

function writePlaywrightPdf(params: { htmlPath: string; pdfPath: string }): void {
  const script = `
    import { chromium } from "playwright";
    import { pathToFileURL } from "node:url";

    const htmlPath = process.env.OPENCLAW_PDF_HTML;
    const pdfPath = process.env.OPENCLAW_PDF_OUT;
    if (!htmlPath || !pdfPath) {
      throw new Error("OPENCLAW_PDF_HTML / OPENCLAW_PDF_OUT env vars are required");
    }

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(htmlPath).toString(), { waitUntil: "networkidle" });
      await page.emulateMedia({ media: "screen" });
      await page.pdf({
        path: pdfPath,
        format: "A4",
        printBackground: true,
        margin: { top: "14mm", right: "12mm", bottom: "14mm", left: "12mm" },
      });
    } finally {
      await browser.close();
    }
  `;
  execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      env: {
        ...process.env,
        OPENCLAW_PDF_HTML: params.htmlPath,
        OPENCLAW_PDF_OUT: params.pdfPath,
      },
      stdio: "pipe",
    },
  );
}

function writeTempHtmlForPdf(params: {
  outputDir: string;
  baseFileName: string;
  title: string;
  bodyHtml: string;
  summary?: string;
}): string {
  const htmlPath = path.join(
    os.tmpdir(),
    "openclaw-pdf-render",
    `${params.baseFileName}---${Date.now()}.html`,
  );
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(
    htmlPath,
    buildHtmlDocument({
      title: params.title,
      bodyHtml: params.bodyHtml,
      summary: params.summary,
    }),
    "utf8",
  );
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
    fs.rmSync(htmlPath, { force: true });
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
    outputTarget: "file",
    path: filePath,
    mimeType: "application/pdf",
    sizeBytes,
    lifecycle: "draft",
  };
}
