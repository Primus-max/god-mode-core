import path from "node:path";
import type { MaterializationRequest } from "../../platform/materialization/index.js";
import { resolveHtmlBody } from "../../platform/materialization/index.js";

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

export function buildPromptOnlyPdfHtml(params: {
  bodyMarkdown: string;
  images: PromptOnlyPdfImageAsset[];
}): string {
  const imagesHtml = params.images
    .map(
      (image) => `
        <figure style="margin:0 0 24px 0;padding:24px;border-radius:28px;background:linear-gradient(135deg,#fffbe8,#eef8ff);border:1px solid rgba(17,24,39,.08);">
          <img src="data:${image.mimeType};base64,${image.base64}" alt="${image.fileName}" style="display:block;width:100%;max-width:520px;margin:0 auto;border-radius:24px;box-shadow:0 20px 50px rgba(15,23,42,.15);" />
        </figure>
      `,
    )
    .join("\n");
  const pages = params.bodyMarkdown
    .split(/\n\s*---+\s*\n/iu)
    .map((pageMarkdown) => pageMarkdown.trim())
    .filter(Boolean);
  const pageSections = (pages.length > 0 ? pages : [params.bodyMarkdown.trim()])
    .map((pageMarkdown, index) => {
      const bodyHtml = resolveHtmlBody({ markdown: pageMarkdown });
      return `
        <section style="min-height:960px;padding:40px 44px;border-radius:32px;background:${index % 2 === 0 ? "linear-gradient(180deg,#fffdf5,#ffffff)" : "linear-gradient(180deg,#f7fbff,#ffffff)"};border:1px solid rgba(17,24,39,.08);box-shadow:0 24px 60px rgba(15,23,42,.08);${index > 0 ? "break-before:page;page-break-before:always;" : ""}">
          ${index === 0 && imagesHtml ? `<div style="margin-bottom:28px;">${imagesHtml}</div>` : ""}
          <div style="font-size:15px;line-height:1.65;">${bodyHtml}</div>
        </section>
      `.trim();
    })
    .join("\n");
  return `
    <section style="font-family:'Open Sans',Arial,sans-serif;color:#111827;">
      <div style="display:grid;gap:28px;">${pageSections}</div>
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
