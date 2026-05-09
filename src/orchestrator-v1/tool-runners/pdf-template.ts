/**
 * V1-CONTRACT-ONLY — pdf runner HTML template helper.
 *
 * Builds a minimal HTML document the playwright-core renderer turns into a PDF.
 * The template is intentionally bare: title (h1), one or more paragraphs from
 * `summary` (split on blank lines), and an optional `images` section that
 * renders each item as a labelled `<figure>` PLACEHOLDER. We do NOT embed real
 * image data here — Stage B passes textual descriptions of infographics; the
 * pdf runner only labels placeholders so the user sees what was requested.
 *
 * Why a separate file: the template is data, not architecture. Keeping it in
 * its own module lets the runner stay focused on FS + browser orchestration,
 * and lets the test assert against the rendered HTML before PDF conversion.
 */

const STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a;
    line-height: 1.55;
    padding: 32px 40px;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1 {
    font-size: 28px;
    margin: 0 0 24px;
    color: #0d2c54;
    border-bottom: 2px solid #0d2c54;
    padding-bottom: 8px;
  }
  p {
    font-size: 13px;
    margin: 0 0 12px;
    text-align: justify;
  }
  section.images { margin-top: 24px; }
  section.images h2 {
    font-size: 16px;
    color: #0d2c54;
    margin: 0 0 12px;
  }
  figure.placeholder {
    border: 1px dashed #888;
    background: #f7f7fa;
    padding: 16px;
    margin: 0 0 12px;
    border-radius: 4px;
  }
  figure.placeholder .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #555;
    margin-bottom: 6px;
  }
  figure.placeholder figcaption {
    font-size: 13px;
    color: #1a1a1a;
  }
  @page { size: A4; margin: 18mm; }
`;

function escapeHtml(s: string): string {
  // Standard XML/HTML escape — no markdown / no embedded HTML rendering.
  // Tool args are LLM-extracted content; we treat them as untrusted text.
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function paragraphsFromSummary(summary: string): string[] {
  // Split on blank lines (one or more). Trim each. Drop empties.
  // Single-line summaries become one paragraph.
  return summary
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export type PdfTemplateInput = {
  title: string;
  summary: string;
  images?: string[];
};

/** Build the HTML document body that playwright will render to PDF. */
export function buildPdfHtml(input: PdfTemplateInput): string {
  const titleHtml = `<h1>${escapeHtml(input.title)}</h1>`;
  const paragraphs = paragraphsFromSummary(input.summary);
  const summaryHtml = paragraphs.length
    ? paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n")
    : `<p>${escapeHtml(input.summary)}</p>`;

  const imagesHtml =
    input.images && input.images.length > 0
      ? [
          `<section class="images">`,
          `<h2>Иллюстрации</h2>`,
          ...input.images.map(
            (desc, i) =>
              `<figure class="placeholder"><div class="label">Изображение ${i + 1}</div><figcaption>${escapeHtml(desc)}</figcaption></figure>`,
          ),
          `</section>`,
        ].join("\n")
      : "";

  return [
    `<!doctype html>`,
    `<html lang="ru">`,
    `<head>`,
    `<meta charset="utf-8" />`,
    `<title>${escapeHtml(input.title)}</title>`,
    `<style>${STYLES}</style>`,
    `</head>`,
    `<body>`,
    titleHtml,
    summaryHtml,
    imagesHtml,
    `</body>`,
    `</html>`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
