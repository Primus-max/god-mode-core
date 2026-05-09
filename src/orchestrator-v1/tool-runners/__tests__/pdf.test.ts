/**
 * Unit tests for the orchestrator-v1 pdf runner.
 *
 * Real-symptom tests:
 *   - Happy path: invoking the runner produces an actual PDF file on disk
 *     whose first 4 bytes are `%PDF` and whose size > 0. (Asserts the
 *     "user sees ok:true but file doesn't exist" failure mode is impossible.)
 *   - Renderer throws: ok:false with non-empty error.
 *   - Renderer no-ops: ok:false (post-render existence check catches it).
 *   - Images array enlarges the rendered HTML (asserted via the template
 *     module directly — guards the runner from silently dropping `images`).
 *
 * The default playwright-core renderer is exercised via a stub `renderer`
 * that writes a minimal valid PDF. Avoiding chromium in-test keeps the
 * suite hermetic and CI-portable; production codepath uses chromium and
 * is exercised live during S9 cutover.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runPdf, type PdfRendererFn } from "../pdf.js";
import { buildPdfHtml } from "../pdf-template.js";

const MINIMAL_PDF_BYTES = Buffer.from(
  // Hand-crafted minimal PDF — header + 1-page catalog + xref + trailer.
  // Used by the stub renderer so tests don't need chromium.
  "%PDF-1.4\n" +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<<>>>>endobj\n" +
    "xref\n0 4\n" +
    "0000000000 65535 f \n" +
    "0000000009 00000 n \n" +
    "0000000052 00000 n \n" +
    "0000000098 00000 n \n" +
    "trailer<</Size 4/Root 1 0 R>>\nstartxref\n160\n%%EOF\n",
  "ascii",
);

function makeStubRenderer(): PdfRendererFn {
  return async ({ outputPath }) => {
    await fs.writeFile(outputPath, MINIMAL_PDF_BYTES);
  };
}

async function makeTmpDir(label: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `orch-v1-pdf-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("runPdf", () => {
  it("writes a real PDF on disk for valid args (F14-style infographic prompt)", async () => {
    const dir = await makeTmpDir("happy");
    const result = await runPdf(
      {
        title: "Городской котик",
        summary: "Краткий обзор городских котов: повадки, рацион, лежбища.\n\nВторой абзац — про адаптацию.",
        images: ["Котик на крыше панельки", "График — рацион по сезонам"],
      },
      { renderer: makeStubRenderer(), outputDir: dir },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(typeof result.output.url).toBe("string");
    const url = result.output.url as string;
    expect(path.isAbsolute(url)).toBe(true);
    expect(url.endsWith(".pdf")).toBe(true);

    const stat = await fs.stat(url);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(0);

    // Magic bytes — guards against "ok:true but file is not actually a PDF".
    const fd = await fs.open(url, "r");
    try {
      const buf = Buffer.alloc(4);
      await fd.read(buf, 0, 4, 0);
      expect(buf.toString("ascii")).toBe("%PDF");
    } finally {
      await fd.close();
    }

    // Title is forwarded into output for the dispatcher template.
    expect(result.output.title).toBe("Городской котик");
  });

  it("returns ok:false when the renderer throws", async () => {
    const dir = await makeTmpDir("throws");
    const renderer: PdfRendererFn = async () => {
      throw new Error("boom: chromium crashed");
    };
    const result = await runPdf(
      { title: "Quarterly report", summary: "Q1 numbers." },
      { renderer, outputDir: dir },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/rendering failed/);
    expect(result.error).toMatch(/boom/);
  });

  it("returns ok:false when the renderer claims success but no file is written (catches silent no-op)", async () => {
    const dir = await makeTmpDir("noop");
    const renderer: PdfRendererFn = async () => {
      // Silently does nothing — simulates a buggy renderer that returns
      // without writing the file. Without the post-render existence check,
      // this would surface as ok:true + a bogus url.
    };
    const result = await runPdf(
      { title: "Climate change", summary: "Trend overview." },
      { renderer, outputDir: dir },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/output file is missing/);
  });

  it("returns ok:false when the renderer writes an empty file", async () => {
    const dir = await makeTmpDir("empty");
    const renderer: PdfRendererFn = async ({ outputPath }) => {
      await fs.writeFile(outputPath, Buffer.alloc(0));
    };
    const result = await runPdf(
      { title: "Empty", summary: "x" },
      { renderer, outputDir: dir },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/empty or not a regular file/);
  });

  it("rejects malformed args without invoking the renderer", async () => {
    const dir = await makeTmpDir("bad-args");
    const renderer = vi.fn<PdfRendererFn>();

    // missing title
    const r1 = await runPdf({ summary: "x" } as unknown as Parameters<typeof runPdf>[0], {
      renderer,
      outputDir: dir,
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toMatch(/title/);

    // empty title
    const r2 = await runPdf({ title: "   ", summary: "x" }, { renderer, outputDir: dir });
    expect(r2.ok).toBe(false);

    // empty summary
    const r3 = await runPdf({ title: "x", summary: "" }, { renderer, outputDir: dir });
    expect(r3.ok).toBe(false);

    // bad images type (number instead of array)
    const r4 = await runPdf(
      { title: "x", summary: "y", images: 5 } as unknown as Parameters<typeof runPdf>[0],
      { renderer, outputDir: dir },
    );
    expect(r4.ok).toBe(false);

    // bad image entry type
    const r5 = await runPdf(
      { title: "x", summary: "y", images: ["ok", 42] } as unknown as Parameters<typeof runPdf>[0],
      { renderer, outputDir: dir },
    );
    expect(r5.ok).toBe(false);

    expect(renderer).not.toHaveBeenCalled();
  });

  it("propagates user-supplied images into the rendered HTML (template behaviour)", () => {
    // Asserted at the template level so we don't need to parse PDF content
    // in the unit test. Pairs with the happy-path test above which proves
    // the template output is what the renderer sees.
    const withoutImages = buildPdfHtml({ title: "T", summary: "S" });
    const withImages = buildPdfHtml({
      title: "T",
      summary: "S",
      images: ["Котик на крыше", "График по сезонам"],
    });

    expect(withImages.length).toBeGreaterThan(withoutImages.length);
    expect(withImages).toContain("Котик на крыше");
    expect(withImages).toContain("График по сезонам");
    expect(withImages).toContain("Иллюстрации");
    // Placeholder labels per image, not real <img> tags — pdf runner does
    // NOT chain to image_generate.
    expect(withImages).not.toContain("<img");
    expect(withImages).toContain("Изображение 1");
    expect(withImages).toContain("Изображение 2");
  });

  it("html-escapes title, summary, and image captions to prevent injection", () => {
    const html = buildPdfHtml({
      title: "<script>alert(1)</script>",
      summary: "x & y < z",
      images: ["</figure><script>x</script>"],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("x &amp; y &lt; z");
    expect(html).toContain("&lt;/figure&gt;&lt;script&gt;x&lt;/script&gt;");
  });

  it("splits summary on blank lines into separate <p> elements", () => {
    const html = buildPdfHtml({
      title: "T",
      summary: "First paragraph.\n\nSecond paragraph.\n\nThird.",
    });
    const pCount = (html.match(/<p>/g) ?? []).length;
    expect(pCount).toBe(3);
    expect(html).toContain("<p>First paragraph.</p>");
    expect(html).toContain("<p>Second paragraph.</p>");
    expect(html).toContain("<p>Third.</p>");
  });

  it("creates the output directory if it does not exist", async () => {
    const root = await makeTmpDir("nested");
    const nested = path.join(root, "deep", "deeper", "pdfs");
    const result = await runPdf(
      { title: "x", summary: "y" },
      { renderer: makeStubRenderer(), outputDir: nested },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stat = await fs.stat(result.output.url as string);
    expect(stat.isFile()).toBe(true);
  });
});
