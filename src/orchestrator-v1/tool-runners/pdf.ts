/**
 * V1-CONTRACT-ONLY — pdf tool runner (HTML → PDF via playwright-core).
 *
 * Stage B extracts `{title, summary, images?}` from the user's prompt. This
 * runner turns those fields into a real on-disk PDF and returns its absolute
 * path as `output.url`, matching the `pdf:success` template
 * "Сгенерировал PDF «{title}»: {url}".
 *
 * NEW slice (S5 of V1-CUTOVER) — no prior pdf tool runner existed in
 * orchestrator-v1. The legacy `src/agents/tools/pdf-tool.ts` is too heavy
 * (multi-provider analyze + materialization pipeline + native PDF apis); this
 * runner is intentionally thin: HTML template → playwright → file path.
 *
 * Hard invariants from V1-CUTOVER plan:
 *   - No regex parsing of user input. Args are pre-validated by Stage B.
 *   - Reply text comes from the dispatcher template, NOT from the runner.
 *     The runner returns only `{ok, output}` (or `{ok:false, error}`).
 *   - Frozen modules untouched: contract.ts, dispatcher.ts, reply-templates.ts.
 *
 * Design notes:
 *   - Output path: `${os.tmpdir()}/orchestrator-v1-pdf/${uuid}.pdf`. Dir
 *     created lazily; collisions impossible thanks to randomUUID.
 *   - Renderer is injectable via `renderer` parameter so unit tests can
 *     simulate failures and assert ok:false plumbing without spinning up
 *     chromium. Production callers pass nothing → default playwright-core
 *     renderer is used.
 *   - We do NOT chain to image_generate even when `images` is non-empty.
 *     Stage A would emit a multi-tool contract (e.g. F43-multi-search-pdf
 *     pattern) if real images were wanted; the pdf runner's job is to
 *     produce the PDF document only.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ToolRunResult } from "../dispatcher.js";
import { buildPdfHtml, type PdfTemplateInput } from "./pdf-template.js";

export type PdfRendererFn = (input: { html: string; outputPath: string }) => Promise<void>;

export type PdfRunnerArgs = {
  title: string;
  summary: string;
  images?: string[];
};

export type PdfRunnerOptions = {
  /**
   * Override the HTML→PDF renderer. Defaults to a playwright-core renderer
   * that launches a headless chromium and prints to PDF. Tests inject a stub
   * to simulate failure or to skip the chromium dependency.
   */
  renderer?: PdfRendererFn;
  /**
   * Override the output directory root. Defaults to
   * `${os.tmpdir()}/orchestrator-v1-pdf`. Tests use a per-test tmp dir so
   * artifacts don't bleed between cases.
   */
  outputDir?: string;
};

const DEFAULT_OUTPUT_DIR = path.join(os.tmpdir(), "orchestrator-v1-pdf");

async function defaultPlaywrightRenderer(input: { html: string; outputPath: string }): Promise<void> {
  // Lazy-import so the module can be used in environments where
  // playwright-core isn't initialised yet (or its browser binary isn't
  // installed) — the failure surfaces as ok:false through the runner instead
  // of crashing module load.
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.setContent(input.html, { waitUntil: "load" });
    await page.pdf({
      path: input.outputPath,
      format: "A4",
      printBackground: true,
      margin: { top: "18mm", bottom: "18mm", left: "18mm", right: "18mm" },
    });
    await ctx.close();
  } finally {
    await browser.close();
  }
}

function validateArgs(args: unknown): { ok: true; value: PdfRunnerArgs } | { ok: false; error: string } {
  if (!args || typeof args !== "object") {
    return { ok: false, error: "pdf runner: args is not an object" };
  }
  const rec = args as Record<string, unknown>;
  if (typeof rec.title !== "string" || rec.title.trim().length === 0) {
    return { ok: false, error: "pdf runner: title must be a non-empty string" };
  }
  if (typeof rec.summary !== "string" || rec.summary.trim().length === 0) {
    return { ok: false, error: "pdf runner: summary must be a non-empty string" };
  }
  let images: string[] | undefined;
  if (rec.images !== undefined) {
    if (!Array.isArray(rec.images)) {
      return { ok: false, error: "pdf runner: images must be an array of strings" };
    }
    images = [];
    for (const item of rec.images) {
      if (typeof item !== "string") {
        return { ok: false, error: "pdf runner: images entries must be strings" };
      }
      const trimmed = item.trim();
      if (trimmed.length === 0) continue;
      images.push(trimmed);
    }
    if (images.length === 0) images = undefined;
  }
  return {
    ok: true,
    value: {
      title: rec.title,
      summary: rec.summary,
      ...(images ? { images } : {}),
    },
  };
}

/**
 * Run the pdf tool: render HTML built from `args` to a PDF file on disk and
 * return its absolute path.
 *
 * The dispatcher renders the user-facing reply via the `pdf:success` /
 * `pdf:failure` template; this function MUST NOT produce user-facing strings.
 */
export async function runPdf(
  args: PdfRunnerArgs | Record<string, unknown>,
  options: PdfRunnerOptions = {},
): Promise<ToolRunResult> {
  const validated = validateArgs(args);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  const { title, summary, images } = validated.value;
  const html = buildPdfHtml({ title, summary, ...(images ? { images } : {}) } satisfies PdfTemplateInput);
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  let outputPath: string;
  try {
    await fs.mkdir(outputDir, { recursive: true });
    outputPath = path.join(outputDir, `${randomUUID()}.pdf`);
  } catch (err) {
    return { ok: false, error: `pdf runner: failed to prepare output dir: ${(err as Error).message}` };
  }

  const renderer = options.renderer ?? defaultPlaywrightRenderer;
  try {
    await renderer({ html, outputPath });
  } catch (err) {
    return { ok: false, error: `pdf runner: rendering failed: ${(err as Error).message}` };
  }

  // Belt-and-braces: confirm the file actually exists and is non-empty
  // before reporting success. Without this check, a renderer that silently
  // no-ops would produce ok:true + a bogus path, and the user would see
  // "Сгенерировал PDF: /tmp/xyz.pdf" pointing at nothing.
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(outputPath);
  } catch (err) {
    return {
      ok: false,
      error: `pdf runner: renderer reported success but output file is missing: ${(err as Error).message}`,
    };
  }
  if (!stat.isFile() || stat.size === 0) {
    return {
      ok: false,
      error: `pdf runner: output file is empty or not a regular file: ${outputPath}`,
    };
  }

  return {
    ok: true,
    output: {
      url: outputPath,
      title,
    },
  };
}
