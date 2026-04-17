import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPromptOnlyPdfHtml,
  buildPromptOnlyPdfMaterializationRequest,
  normalizePdfBodyText,
  pdfNeedsManagedRendererFromConstraints,
  pdfRequestedPageCount,
  pdfWantsRichDraftFromConstraints,
} from "./pdf-tool.prompt-only.js";

describe("pdf tool prompt-only helpers", () => {
  it("derives managed-renderer signal from deliverable constraints only", () => {
    expect(pdfNeedsManagedRendererFromConstraints(undefined)).toBe(false);
    expect(pdfNeedsManagedRendererFromConstraints({ style: "minimal" })).toBe(false);
    expect(pdfNeedsManagedRendererFromConstraints({ style: "infographic" })).toBe(true);
    expect(pdfNeedsManagedRendererFromConstraints({ needsManagedRenderer: true })).toBe(true);
  });

  it("derives rich-draft signal from deliverable constraints only", () => {
    expect(pdfWantsRichDraftFromConstraints(undefined)).toBe(false);
    expect(pdfWantsRichDraftFromConstraints({ style: "minimal" })).toBe(false);
    expect(pdfWantsRichDraftFromConstraints({ style: "rich" })).toBe(true);
    expect(pdfWantsRichDraftFromConstraints({ style: "presentation" })).toBe(true);
  });

  it("reads page count from constraints and clamps it to 1-12", () => {
    expect(pdfRequestedPageCount(undefined)).toBeNull();
    expect(pdfRequestedPageCount({ pageCount: 3 })).toBe(3);
    expect(pdfRequestedPageCount({ pageCount: 0 })).toBeNull();
    expect(pdfRequestedPageCount({ pageCount: 99 })).toBeNull();
    expect(pdfRequestedPageCount({ pageCount: Number.NaN })).toBeNull();
  });

  it("normalizes body text without parsing linguistic intent", () => {
    expect(normalizePdfBodyText("Create    a PDF    about routing   ")).toBe(
      "Create a PDF about routing",
    );
  });

  it("builds html pages with embedded images and page breaks", () => {
    const html = buildPromptOnlyPdfHtml({
      bodyMarkdown: "# Cover\n\nOne\n\n---\n\n# Page 2\n\nTwo",
      images: [
        {
          fileName: "chart.png",
          mimeType: "image/png",
          base64: "ZmFrZQ==",
        },
      ],
    });

    expect(html).toContain("data:image/png;base64,ZmFrZQ==");
    expect(html).toContain("break-before:page");
    expect(html).toContain("<h1>Cover</h1>");
    expect(html).toContain("oc-pdf-page");
  });

  it("normalizes collapsed rich markdown and resolves inline image references", () => {
    const html = buildPromptOnlyPdfHtml({
      bodyMarkdown:
        "# infographic_city_cat_life ## Стр. 1 ![Городской котик](sandbox:/media/city_cat_page1.png) ### Маршрут - Проснуться у окна - Проверить двор - Вернуться домой --- ## Стр. 2 ### Формула счастья - Тепло - Еда - Уют",
      images: [
        {
          fileName: "city_cat_page1.png",
          mimeType: "image/png",
          base64: "ZmFrZQ==",
        },
      ],
    });

    expect(html).toContain("<h1>infographic_city_cat_life</h1>");
    expect(html).toContain("<h2>Стр. 1</h2>");
    expect(html).toContain("<h3>Маршрут</h3>");
    expect(html).toContain("<li>Проснуться у окна</li>");
    expect(html).toContain("<li>Проверить двор</li>");
    expect(html).toContain("data:image/png;base64,ZmFrZQ==");
  });

  it("builds a canonical prompt-only pdf materialization request", () => {
    const request = buildPromptOnlyPdfMaterializationRequest({
      filename: "routing-report.pdf",
      title: "Routing Report",
      bodyHtml: "<h1>Routing</h1>",
      outputDir: path.join(os.tmpdir(), "openclaw-pdf-tool"),
    });

    expect(request).toMatchObject({
      artifactId: "pdf-tool-routing-report",
      renderKind: "pdf",
      documentInputKind: "html",
      rendererTarget: "pdf",
      baseFileName: "routing-report",
      payload: {
        html: "<h1>Routing</h1>",
      },
    });
  });
});
