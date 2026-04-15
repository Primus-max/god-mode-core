import path from "node:path";
import type { MaterializationRequest } from "../../platform/materialization/index.js";
import { escapeHtml, renderMarkdownToHtml } from "../../platform/materialization/index.js";

export type PromptOnlyPdfImageAsset = {
  fileName: string;
  mimeType: string;
  base64: string;
};

export function promptOnlyPdfNeedsManagedRenderer(prompt: string): boolean {
  return /(?:\b(?:report|table|invoice|formatted|layout|spreadsheet|save|html|infographic|presentation|slides|chart|graph|visual)\b|\.html?\b|html[-\s]?file|html[-\s]?файл|отч[её]т|таблиц|сохрани|сохранить|инфограф|презентац|слайд|график|диаграм|визуал)/iu.test(
    prompt,
  );
}

export function promptOnlyPdfWantsRichDraft(prompt: string): boolean {
  return /(?:\b(?:infographic|presentation|slides|magazine|brochure|visual|chart|graph)\b|инфограф|презентац|слайд|журнал|брошюр|визуал|график|диаграм)/iu.test(
    prompt,
  );
}

export function inferRequestedPageCount(prompt: string): number | null {
  const match = prompt.match(
    /(\d{1,2})\s*(?:pages?|slides?|страниц(?:а|ы|е)?|страниц|слайд(?:а|ов)?)/iu,
  );
  const raw = match?.[1];
  if (!raw) {
    return null;
  }
  const count = Number.parseInt(raw, 10);
  return Number.isFinite(count) && count > 0 && count <= 12 ? count : null;
}

export function buildGeneratedPdfText(prompt: string): string {
  return prompt
    .replace(/\s+/gu, " ")
    .replace(/^(create|generate|make|создай|сгенерируй|сделай)\s+/iu, "")
    .trim()
    .slice(0, 4000);
}

function normalizePromptOnlyPdfMarkdown(markdown: string): string {
  const normalizedLines = markdown
    .replaceAll("\r\n", "\n")
    .replace(/([^\n])\s+(#{1,6}\s+)/gu, "$1\n\n$2")
    .replace(/([^\n])\s+(---+)\s+(?=\S)/gu, "$1\n\n$2\n\n")
    .replace(/([^\n])\s+(!\[[^\]]*\]\([^)]+\))/gu, "$1\n\n$2")
    .split("\n")
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes(" - ")) {
        return [trimmed];
      }
      if (/^(?:[-*]\s+|\d+\.\s+)/u.test(trimmed)) {
        return [trimmed];
      }
      const parts = trimmed.split(/\s+-\s+/u).map((part) => part.trim()).filter(Boolean);
      if (parts.length < 3) {
        return [trimmed];
      }
      const averageLength =
        parts.reduce((sum, part) => sum + part.length, 0) / Math.max(parts.length, 1);
      if (averageLength > 110) {
        return [trimmed];
      }
      const [first, ...rest] = parts;
      if (/^#{1,6}\s+/u.test(first ?? "")) {
        return [first, "", ...rest.map((part) => `- ${part}`)];
      }
      return [trimmed];
    });
  return normalizedLines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function normalizePromptOnlyImageRef(value: string): string {
  const trimmed = value.trim();
  const withoutScheme = trimmed.replace(/^sandbox:\/*/iu, "");
  return path.posix.basename(withoutScheme.replaceAll("\\", "/")).toLowerCase();
}

function findPromptOnlyImageAsset(
  images: PromptOnlyPdfImageAsset[],
  ref: string,
): PromptOnlyPdfImageAsset | null {
  const normalizedRef = normalizePromptOnlyImageRef(ref);
  return (
    images.find((image) => normalizePromptOnlyImageRef(image.fileName) === normalizedRef) ?? null
  );
}

function renderPromptOnlyImageFigure(image: PromptOnlyPdfImageAsset, altText?: string): string {
  const safeAlt = escapeHtml(altText?.trim() || image.fileName);
  return `
    <figure class="oc-pdf-figure">
      <img
        src="data:${image.mimeType};base64,${image.base64}"
        alt="${safeAlt}"
        class="oc-pdf-image"
      />
      <figcaption class="oc-pdf-caption">${safeAlt}</figcaption>
    </figure>
  `.trim();
}

function renderPromptOnlyPdfPageHtml(params: {
  pageMarkdown: string;
  images: PromptOnlyPdfImageAsset[];
}): string {
  const normalizedMarkdown = normalizePromptOnlyPdfMarkdown(params.pageMarkdown);
  const htmlParts: string[] = [];
  const markdownBuffer: string[] = [];
  const flushMarkdown = () => {
    const markdown = markdownBuffer.join("\n").trim();
    if (!markdown) {
      markdownBuffer.length = 0;
      return;
    }
    htmlParts.push(renderMarkdownToHtml(markdown));
    markdownBuffer.length = 0;
  };

  for (const line of normalizedMarkdown.split("\n")) {
    const imageMatch = /^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/u.exec(line);
    if (!imageMatch) {
      markdownBuffer.push(line);
      continue;
    }
    flushMarkdown();
    const resolved = findPromptOnlyImageAsset(params.images, imageMatch[2] ?? "");
    if (resolved) {
      htmlParts.push(renderPromptOnlyImageFigure(resolved, imageMatch[1] ?? resolved.fileName));
      continue;
    }
    markdownBuffer.push(line);
  }

  flushMarkdown();
  return htmlParts.join("\n");
}

export function buildPromptOnlyPdfHtml(params: {
  bodyMarkdown: string;
  images: PromptOnlyPdfImageAsset[];
}): string {
  const normalizedMarkdown = normalizePromptOnlyPdfMarkdown(params.bodyMarkdown);
  const hasExplicitImageReferences = /!\[[^\]]*\]\(([^)]+)\)/u.test(normalizedMarkdown);
  const imagesHtml = params.images
    .map((image) => renderPromptOnlyImageFigure(image))
    .join("\n");
  const pages = normalizedMarkdown
    .split(/\n\s*---+\s*\n/iu)
    .map((pageMarkdown) => pageMarkdown.trim())
    .filter(Boolean);
  const pageSections = (pages.length > 0 ? pages : [params.bodyMarkdown.trim()])
    .map((pageMarkdown, index) => {
      const bodyHtml = renderPromptOnlyPdfPageHtml({
        pageMarkdown,
        images: params.images,
      });
      return `
        <section class="oc-pdf-page${index === 0 ? " oc-pdf-page-cover" : ""}" style="${index > 0 ? "break-before:page;page-break-before:always;" : ""}">
          ${index === 0 && imagesHtml && !hasExplicitImageReferences ? `<div class="oc-pdf-gallery">${imagesHtml}</div>` : ""}
          <div class="oc-pdf-page-body">${bodyHtml}</div>
        </section>
      `.trim();
    })
    .join("\n");
  return `
    <style>
      .oc-pdf-deck { font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; }
      .oc-pdf-pages { display: grid; gap: 28px; }
      .oc-pdf-page {
        position: relative;
        overflow: hidden;
        min-height: 960px;
        padding: 52px 54px;
        border-radius: 32px;
        background: linear-gradient(180deg, rgba(255,253,245,0.98), rgba(255,255,255,1));
        border: 1px solid rgba(148,163,184,0.22);
        box-shadow: 0 28px 70px rgba(15,23,42,0.10);
      }
      .oc-pdf-page:nth-child(even) {
        background: linear-gradient(180deg, rgba(240,249,255,0.98), rgba(255,255,255,1));
      }
      .oc-pdf-page::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at top right, rgba(59,130,246,0.12), transparent 32%),
          radial-gradient(circle at bottom left, rgba(245,158,11,0.10), transparent 30%);
        pointer-events: none;
      }
      .oc-pdf-page-cover { padding-top: 64px; }
      .oc-pdf-page-body { position: relative; z-index: 1; font-size: 15px; line-height: 1.7; }
      .oc-pdf-page-body h1 { font-size: 2.9rem; line-height: 1.05; margin: 0 0 18px; letter-spacing: -0.05em; }
      .oc-pdf-page-body h2 { font-size: 1.65rem; margin: 28px 0 14px; letter-spacing: -0.03em; }
      .oc-pdf-page-body h3 { font-size: 1.1rem; margin: 20px 0 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #1d4ed8; }
      .oc-pdf-page-body p { margin: 0 0 14px; }
      .oc-pdf-page-body ul, .oc-pdf-page-body ol { margin: 18px 0 0; padding-left: 0; display: grid; gap: 10px; list-style: none; }
      .oc-pdf-page-body li {
        margin: 0;
        padding: 12px 14px;
        border-radius: 16px;
        background: rgba(255,255,255,0.78);
        border: 1px solid rgba(148,163,184,0.20);
        box-shadow: 0 12px 28px rgba(15,23,42,0.05);
      }
      .oc-pdf-page-body ol { counter-reset: oc-pdf-ol; }
      .oc-pdf-page-body ol li::before {
        counter-increment: oc-pdf-ol;
        content: counter(oc-pdf-ol) ". ";
        font-weight: 700;
        color: #1d4ed8;
      }
      .oc-pdf-page-body ul li::before {
        content: "• ";
        font-weight: 700;
        color: #ea580c;
      }
      .oc-pdf-page-body table { margin-top: 18px; }
      .oc-pdf-page-body a { color: #1d4ed8; text-decoration: none; font-weight: 600; }
      .oc-pdf-gallery { position: relative; z-index: 1; display: grid; gap: 18px; margin-bottom: 28px; }
      .oc-pdf-figure {
        margin: 0;
        padding: 20px;
        border-radius: 24px;
        background: linear-gradient(135deg, rgba(255,251,235,0.95), rgba(239,246,255,0.95));
        border: 1px solid rgba(148,163,184,0.18);
        box-shadow: 0 20px 48px rgba(15,23,42,0.08);
      }
      .oc-pdf-image {
        display: block;
        width: 100%;
        max-width: 520px;
        margin: 0 auto;
        border-radius: 20px;
        box-shadow: 0 20px 50px rgba(15,23,42,0.14);
      }
      .oc-pdf-caption {
        margin-top: 10px;
        font-size: 0.88rem;
        color: #475569;
        text-align: center;
      }
    </style>
    <section class="oc-pdf-deck">
      <div class="oc-pdf-pages">${pageSections}</div>
    </section>
  `.trim();
}

export function buildPromptOnlyPdfMaterializationRequest(params: {
  filename?: string;
  title?: string;
  bodyHtml: string;
  outputDir: string;
}): MaterializationRequest {
  const baseFileName = path.parse(params.filename ?? "generated-pdf.pdf").name || "generated-pdf";
  const title = params.title?.trim() || baseFileName || "Generated PDF";
  return {
    artifactId: `pdf-tool-${baseFileName}`,
    label: title,
    sourceDomain: "document",
    renderKind: "pdf",
    documentInputKind: "html",
    rendererTarget: "pdf",
    outputTarget: "file",
    outputDir: params.outputDir,
    baseFileName,
    payload: {
      title,
      html: params.bodyHtml,
    },
  };
}
