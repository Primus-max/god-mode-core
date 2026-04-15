import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGeneratedPdfText,
  buildPromptOnlyPdfHtml,
  buildPromptOnlyPdfMaterializationRequest,
  inferRequestedPageCount,
  promptOnlyPdfNeedsManagedRenderer,
  promptOnlyPdfWantsRichDraft,
} from "./pdf-tool.prompt-only.js";

describe("pdf tool prompt-only helpers", () => {
  it("detects prompts that require managed renderer bootstrap", () => {
    expect(promptOnlyPdfNeedsManagedRenderer("Сгенерируй PDF отчет с таблицей и сохрани на диск.")).toBe(
      true,
    );
    expect(promptOnlyPdfNeedsManagedRenderer("Create a PDF with plain text hello world.")).toBe(false);
  });

  it("detects prompts that benefit from rich drafting", () => {
    expect(promptOnlyPdfWantsRichDraft("Create a 3-slide infographic brochure about bananas.")).toBe(
      true,
    );
    expect(promptOnlyPdfWantsRichDraft("Create a PDF with one short paragraph.")).toBe(false);
  });

  it("extracts requested page count and trims generated text", () => {
    expect(inferRequestedPageCount("Make 3 slides about routing.")).toBe(3);
    expect(buildGeneratedPdfText("Create    a PDF    about routing   ")).toBe("a PDF about routing");
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
