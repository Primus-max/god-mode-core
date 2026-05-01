import path from "node:path";
import type { MaterializationRequest } from "../../platform/materialization/index.js";
import { escapeHtml, renderMarkdownToHtml } from "../../platform/materialization/index.js";

export type PromptOnlyPdfImageAsset = {
  fileName: string;
  mimeType: string;
  base64: string;
};

export type PromptOnlyPdfConstraints = {
  pageCount?: number;
  style?: "minimal" | "rich" | "infographic" | "presentation";
  needsManagedRenderer?: boolean;
};

/**
 * Whether the request needs the bootstrap-installed Playwright (vs. an ambient
 * `playwright-core` that may already be present). This is purely a renderer
 * sourcing concern — it does NOT affect templating/styling. Stays opt-in via
 * deliverable constraints so the simple "render this prompt to PDF" path keeps
 * working without forcing a bootstrap install.
 */
export function pdfNeedsManagedRendererFromConstraints(
  constraints: PromptOnlyPdfConstraints | undefined,
): boolean {
  if (!constraints) {
    return false;
  }
  if (constraints.needsManagedRenderer === true) {
    return true;
  }
  return constraints.style === "infographic" || constraints.style === "presentation";
}

/**
 * Always true: every prompt-only PDF goes through the LLM designer. We no longer
 * fork between a "minimal text dump" path and a "rich deck" path — that fork was
 * the whole point of the rigid template we removed.
 */
export function pdfWantsRichDraftFromConstraints(
  _constraints: PromptOnlyPdfConstraints | undefined,
): boolean {
  return true;
}

export function pdfRequestedPageCount(
  constraints: PromptOnlyPdfConstraints | undefined,
): number | null {
  const raw = constraints?.pageCount;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  if (raw <= 0 || raw > 12) {
    return null;
  }
  return Math.floor(raw);
}

/**
 * Whitespace-normalize raw body text for embedding in an HTML fallback page.
 * No language parsing — purely a text hygiene helper.
 */
export function normalizePdfBodyText(rawText: string): string {
  return rawText.replace(/\s+/gu, " ").trim().slice(0, 4000);
}

const COMPLETE_HTML_DOCUMENT_HEAD = /^\s*(?:<!doctype\b|<html\b)/iu;
const HTML_FRAGMENT_HINT =
  /<(?:html|head|body|style|main|article|section|h[1-6]|p|div|ul|ol|table|figure|img)\b/iu;

export function looksLikeCompletePdfHtmlDocument(html: string): boolean {
  return COMPLETE_HTML_DOCUMENT_HEAD.test(html);
}

export function looksLikePdfHtmlPayload(html: string): boolean {
  if (looksLikeCompletePdfHtmlDocument(html)) {
    return true;
  }
  return HTML_FRAGMENT_HINT.test(html);
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

/**
 * Inline `data:` URIs into an LLM-produced HTML fragment for any `<img src="...">`
 * that references one of the provided image assets by file name (or sandbox:// URL).
 * No styling decisions — purely substitution.
 */
export function inlinePdfImageAssets(
  html: string,
  images: PromptOnlyPdfImageAsset[],
): string {
  if (images.length === 0) {
    return html;
  }
  return html.replace(
    /<img\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/giu,
    (match, before: string, quote: string, src: string, after: string) => {
      if (/^data:/iu.test(src) || /^https?:\/\//iu.test(src)) {
        return match;
      }
      const asset = findPromptOnlyImageAsset(images, src);
      if (!asset) {
        return match;
      }
      return `<img${before}src=${quote}data:${asset.mimeType};base64,${asset.base64}${quote}${after}>`;
    },
  );
}

function renderMinimalImageFigure(image: PromptOnlyPdfImageAsset): string {
  const altText = escapeHtml(image.fileName);
  return [
    `<figure>`,
    `<img src="data:${image.mimeType};base64,${image.base64}" alt="${altText}" />`,
    `<figcaption>${altText}</figcaption>`,
    `</figure>`,
  ].join("");
}

/**
 * Minimal markdown → HTML body for the fallback path (used when the LLM did not
 * return HTML). Intentionally unopinionated: it just renders the markdown structure
 * and appends any provided images as plain `<figure>` blocks. NO color schemes, NO
 * gradients, NO layered "deck" template — every document gets to look like its own
 * thing once Playwright renders it.
 */
export function buildFallbackPdfHtmlBody(params: {
  bodyMarkdown: string;
  images: PromptOnlyPdfImageAsset[];
}): string {
  const markdown = params.bodyMarkdown.trim();
  const renderedMarkdown = markdown ? renderMarkdownToHtml(markdown) : "";
  const lowerMarkdown = renderedMarkdown.toLowerCase();
  const imageHtml = params.images
    .filter((image) => {
      const normalized = normalizePromptOnlyImageRef(image.fileName);
      if (!normalized) {
        return true;
      }
      if (lowerMarkdown.includes(normalized)) {
        return false;
      }
      const dataUriPrefix = `data:${image.mimeType};base64,${image.base64.slice(0, 16)}`;
      return !lowerMarkdown.includes(dataUriPrefix.toLowerCase());
    })
    .map((image) => renderMinimalImageFigure(image))
    .join("\n");
  return [renderedMarkdown, imageHtml].filter(Boolean).join("\n");
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
