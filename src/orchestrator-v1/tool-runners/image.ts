/**
 * V1-CUTOVER S4 — image_generate tool runner.
 *
 * Thin wrapper around the existing image-generation pipeline:
 *   src/image-generation/runtime.ts -> generateImage()
 *   src/media/store.ts              -> saveMediaBuffer()
 *
 * The runner accepts the Stage-B-validated args ({prompt, size?, style?}),
 * calls the production generator, persists the first returned image to
 * the managed media directory, and returns `{ ok: true, output: { url } }`
 * where `url` is the absolute file path the inbound handler can upload.
 *
 * The dispatcher renders the success template "Сгенерировал: {url}" — so
 * `output.url` MUST be a non-empty string. If we forgot to await the
 * upstream call, `output.url` would be `undefined` and the user would see
 * "Сгенерировал: undefined" (the regression guard test enforces this).
 *
 * Contract: this module is a `RunToolFn` body for the `image_generate`
 * tool only. It does NOT compose with the registry switch — that's S8.
 *
 * Output URL semantics: this returns a local absolute file path (e.g.
 * `C:/state/media/tool-image-generation/<uuid>.png`). The Telegram inbound
 * handler is expected to upload this path as a photo attachment. If a
 * future deployment needs an HTTPS URL instead, the saver layer would be
 * the place to add signed-URL logic — not this runner.
 */

import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig as defaultLoadConfig } from "../../config/config.js";
import {
  generateImage as defaultGenerateImage,
  type GenerateImageParams,
  type GenerateImageRuntimeResult,
} from "../../image-generation/runtime.js";
import { saveMediaBuffer as defaultSaveMediaBuffer } from "../../media/store.js";
import type { ToolRunResult } from "../dispatcher.js";

export type RunImageGenerateAction = {
  tool: "image_generate";
  args: {
    prompt: string;
    size?: string;
    style?: string;
  };
};

/**
 * Test-seam dependencies. Same shape as `pdf.ts`'s `renderer`/`outputDir`
 * pattern: production callers omit `deps`, unit tests pass deterministic
 * stubs. We avoid `vi.mock` because (a) the rest of this directory uses
 * DI for the same reason and (b) `vi.mock` from the `__tests__/` subdir
 * has a path-matching quirk that silently bypasses the factory — the
 * runner ends up calling the real `generateImage` which then throws
 * "No image-generation model configured" (no provider in test config).
 */
export type RunImageGenerateDeps = {
  loadConfig?: () => OpenClawConfig;
  generateImage?: (
    params: GenerateImageParams,
  ) => Promise<GenerateImageRuntimeResult>;
  saveMediaBuffer?: typeof defaultSaveMediaBuffer;
};

/**
 * Stage-B validates `prompt` is non-empty and `size` / `style` are strings,
 * so we trust those types here. Defensive type-narrow only on dynamic fields.
 */
function buildPromptWithStyle(prompt: string, style: string | undefined): string {
  if (!style || !style.trim()) return prompt;
  // No `style` parameter on the upstream `generateImage` API — we forward
  // the hint by appending to the prompt. This is the common convention
  // used by the legacy `image-generate-tool.ts` and matches what providers
  // like OpenAI / Google expect (style baked into prompt).
  return `${prompt} (style: ${style.trim()})`;
}

export async function runImageGenerate(
  action: RunImageGenerateAction,
  deps: RunImageGenerateDeps = {},
): Promise<ToolRunResult> {
  const loadConfig = deps.loadConfig ?? defaultLoadConfig;
  const generateImage = deps.generateImage ?? defaultGenerateImage;
  const saveMediaBuffer = deps.saveMediaBuffer ?? defaultSaveMediaBuffer;

  const { prompt, size, style } = action.args;
  try {
    const cfg = loadConfig();
    const finalPrompt = buildPromptWithStyle(prompt, style);
    const result = await generateImage({
      cfg,
      prompt: finalPrompt,
      ...(size ? { size } : {}),
    });
    const first = result.images[0];
    if (!first) {
      return {
        ok: false,
        error: "Image generation returned no images.",
      };
    }
    const saved = await saveMediaBuffer(
      first.buffer,
      first.mimeType,
      "tool-image-generation",
      undefined,
      first.fileName,
    );
    if (!saved.path || typeof saved.path !== "string") {
      return {
        ok: false,
        error: "Image generation succeeded but media saver returned no path.",
      };
    }
    return {
      ok: true,
      output: { url: saved.path },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
