import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Context, complete } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import {
  getApprovedCapabilityCatalogEntry,
  resolvePlatformBootstrapNodeCapabilityInstallDir,
  resolvePlatformBootstrapDownloadCapabilityInstallDir,
  verifyCapabilityHealth,
} from "../../platform/bootstrap/index.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { extractOriginalFilename, getMediaDir, saveMediaBuffer } from "../../media/store.js";
import { extractPdfContent, type PdfExtractedContent } from "../../media/pdf-extract.js";
import { loadWebMediaRaw } from "../../media/web-media.js";
import {
  materializeArtifact,
  resolveHtmlBody,
} from "../../platform/materialization/index.js";
import { resolveUserPath } from "../../utils.js";
import {
  coerceImageModelConfig,
  type ImageModelConfig,
  resolveProviderVisionModelFromConfig,
} from "./image-tool.helpers.js";
import {
  applyImageModelConfigDefaults,
  buildTextToolResult,
  resolveModelFromRegistry,
  resolveMediaToolLocalRoots,
  resolveModelRuntimeApiKey,
  resolvePromptAndModelOverride,
} from "./media-tool-shared.js";
import { hasAuthForProvider, resolveDefaultModelRef } from "./model-config.helpers.js";
import { anthropicAnalyzePdf, geminiAnalyzePdf } from "./pdf-native-providers.js";
import {
  coercePdfAssistantText,
  coercePdfModelConfig,
  parsePageRange,
  providerSupportsNativePdf,
  resolvePdfToolMaxTokens,
} from "./pdf-tool.helpers.js";
import {
  createSandboxBridgeReadFile,
  discoverAuthStorage,
  discoverModels,
  ensureOpenClawModelsJson,
  resolveSandboxedBridgeMediaPath,
  runWithImageModelFallback,
  type AnyAgentTool,
  type SandboxedBridgeMediaPathConfig,
  type SandboxFsBridge,
  type ToolFsPolicy,
} from "./tool-runtime.helpers.js";

const DEFAULT_PROMPT = "Analyze this PDF document.";
const DEFAULT_MAX_PDFS = 10;
const DEFAULT_MAX_BYTES_MB = 10;
const DEFAULT_MAX_PAGES = 20;
const ANTHROPIC_PDF_PRIMARY = "anthropic/claude-opus-4-6";
const ANTHROPIC_PDF_FALLBACK = "anthropic/claude-opus-4-5";
const HYDRA_PDF_PRIMARY = "hydra/gpt-4o";

const PDF_MIN_TEXT_CHARS = 200;
const PDF_MAX_PIXELS = 4_000_000;

function promptOnlyPdfNeedsManagedRenderer(prompt: string): boolean {
  return /(?:\b(?:report|table|invoice|formatted|layout|spreadsheet|save|html|infographic|presentation|slides|chart|graph|visual)\b|\.html?\b|html[-\s]?file|html[-\s]?файл|отч[её]т|таблиц|сохрани|сохранить|инфограф|презентац|слайд|график|диаграм|визуал)/iu.test(
    prompt,
  );
}

function promptOnlyPdfWantsRichDraft(prompt: string): boolean {
  return /(?:\b(?:infographic|presentation|slides|magazine|brochure|visual|chart|graph)\b|инфограф|презентац|слайд|журнал|брошюр|визуал|график|диаграм)/iu.test(
    prompt,
  );
}

function inferRequestedPageCount(prompt: string): number | null {
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

async function isPdfRendererAvailable(options?: { requireManagedInstall?: boolean }): Promise<boolean> {
  const entry = getApprovedCapabilityCatalogEntry("pdf-renderer");
  const capability = entry?.capability;
  if (!capability) {
    return false;
  }
  if (options?.requireManagedInstall) {
    const installDir =
      entry.install?.method === "node"
        ? resolvePlatformBootstrapNodeCapabilityInstallDir({
            capabilityId: "pdf-renderer",
            stateDir: resolveStateDir(process.env),
          })
        : resolvePlatformBootstrapDownloadCapabilityInstallDir({
            capabilityId: "pdf-renderer",
            stateDir: resolveStateDir(process.env),
          });
    const healthCheckScript = path.join(installDir, ".openclaw-bootstrap-healthcheck.cjs");
    const requiredBins =
      entry.install?.method === "node"
        ? ["node"]
        : ["node", path.join(installDir, capability.requiredBins?.[0] ?? "playwright")];
    try {
      await fs.access(healthCheckScript);
      for (const requiredBin of requiredBins) {
        if (requiredBin === "node") {
          continue;
        }
        await fs.access(requiredBin);
      }
    } catch {
      return false;
    }
    const managedHealth = await verifyCapabilityHealth({
      capability: {
        ...capability,
        status: "available",
        requiredBins,
        healthCheckCommand: `node ${healthCheckScript}`,
      },
    });
    return managedHealth.ok;
  }
  const health = await verifyCapabilityHealth({ capability });
  return health.ok;
}

function buildGeneratedPdfText(prompt: string): string {
  return prompt
    .replace(/\s+/gu, " ")
    .replace(/^(create|generate|make|создай|сгенерируй|сделай)\s+/iu, "")
    .trim()
    .slice(0, 4000);
}

function looksLikePdfReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/^data:application\/pdf(?:;|,)/i.test(trimmed)) {
    return true;
  }
  if (/^https?:\/\//i.test(trimmed) || /^file:/i.test(trimmed)) {
    return /\.pdf(?:[?#].*)?$/iu.test(trimmed);
  }
  if (
    /^[a-zA-Z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~\\") ||
    trimmed.startsWith("~/") ||
    /[\\/]/.test(trimmed)
  ) {
    return /\.pdf$/iu.test(trimmed);
  }
  return /\.pdf(?:[?#].*)?$/iu.test(trimmed);
}

function looksLikeImageReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("sandbox://")) {
    return true;
  }
  if (/^data:image\/[a-z0-9.+-]+(?:;|,)/iu.test(trimmed)) {
    return true;
  }
  if (/^https?:\/\//i.test(trimmed) || /^file:/i.test(trimmed)) {
    return /\.(png|jpe?g|webp|gif|svg)(?:[?#].*)?$/iu.test(trimmed);
  }
  if (
    /^[a-zA-Z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~\\") ||
    trimmed.startsWith("~/") ||
    /[\\/]/.test(trimmed)
  ) {
    return /\.(png|jpe?g|webp|gif|svg)$/iu.test(trimmed);
  }
  return /^[^\\/\r\n]+\.(png|jpe?g|webp|gif|svg)$/iu.test(trimmed);
}

type PromptOnlyPdfImageAsset = {
  fileName: string;
  mimeType: string;
  base64: string;
};

function extractImageReferencesFromText(text: string): string[] {
  const refs = text.match(
    /sandbox:\/\/[^\s)"'`]+|(?:https?:\/\/|file:\/\/)[^\s)"'`]+\.(?:png|jpe?g|webp|gif|svg)(?:[?#][^\s)"'`]*)?/giu,
  );
  return refs ? Array.from(new Set(refs)) : [];
}

async function findMediaFileByOriginalName(originalName: string): Promise<string | null> {
  const mediaDir = getMediaDir();
  const stack = [mediaDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (extractOriginalFilename(fullPath) === originalName) {
        return fullPath;
      }
    }
  }
  return null;
}

async function loadPromptOnlyPdfImageAsset(params: {
  ref: string;
  maxBytes: number;
  localRoots: string[];
  sandboxConfig: SandboxedBridgeMediaPathConfig | null;
}): Promise<PromptOnlyPdfImageAsset> {
  const trimmed = params.ref.trim();
  const isHttpUrl = /^https?:\/\//i.test(trimmed);
  const resolvedRef = (() => {
    if (trimmed.startsWith("sandbox://")) {
      return trimmed;
    }
    if (/^[^\\/\r\n]+\.(png|jpe?g|webp|gif|svg)$/iu.test(trimmed)) {
      return trimmed;
    }
    if (params.sandboxConfig) {
      return trimmed;
    }
    if (trimmed.startsWith("~")) {
      return resolveUserPath(trimmed);
    }
    return trimmed;
  })();

  const resolvedPathInfo =
    (trimmed.startsWith("sandbox://") ||
      /^[^\\/\r\n]+\.(png|jpe?g|webp|gif|svg)$/iu.test(trimmed)) &&
    !params.sandboxConfig
      ? {
          resolved: await findMediaFileByOriginalName(
            trimmed.startsWith("sandbox://") ? trimmed.slice("sandbox://".length) : trimmed,
          ),
        }
      : params.sandboxConfig
        ? await resolveSandboxedBridgeMediaPath({
            sandbox: params.sandboxConfig,
            mediaPath: resolvedRef,
            inboundFallbackDir: "media/inbound",
          })
        : {
            resolved: resolvedRef.startsWith("file://")
              ? resolvedRef.slice("file://".length)
              : resolvedRef,
          };

  if (!resolvedPathInfo?.resolved) {
    throw new Error(`Unable to resolve prompt-only image reference: ${trimmed}`);
  }

  const media = params.sandboxConfig
    ? await loadWebMediaRaw(resolvedPathInfo.resolved, {
        maxBytes: params.maxBytes,
        sandboxValidated: true,
        readFile: createSandboxBridgeReadFile({ sandbox: params.sandboxConfig }),
      })
    : await loadWebMediaRaw(resolvedPathInfo.resolved, {
        maxBytes: params.maxBytes,
        localRoots: params.localRoots,
      });

  if (media.kind !== "image") {
    throw new Error(`Expected image but got ${media.contentType ?? media.kind}: ${trimmed}`);
  }

  const fileName =
    media.fileName ??
    (isHttpUrl
      ? (new URL(trimmed).pathname.split("/").pop() ?? "image.png")
      : path.basename(resolvedPathInfo.resolved));
  return {
    fileName,
    mimeType: media.contentType ?? "image/png",
    base64: media.buffer.toString("base64"),
  };
}

function buildPromptOnlyPdfHtml(params: {
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

async function draftPromptOnlyPdfMarkdown(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  pdfModelConfig: ImageModelConfig;
  modelOverride?: string;
  prompt: string;
  images: PromptOnlyPdfImageAsset[];
}): Promise<{
  text: string;
  provider: string;
  model: string;
}> {
  const effectiveCfg = applyImageModelConfigDefaults(params.cfg, params.pdfModelConfig);
  await ensureOpenClawModelsJson(effectiveCfg, params.agentDir);
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);
  const requestedPageCount = inferRequestedPageCount(params.prompt);

  const result = await runWithImageModelFallback({
    cfg: effectiveCfg,
    modelOverride: params.modelOverride,
    run: async (provider, modelId) => {
      const model = resolveModelFromRegistry({ modelRegistry, provider, modelId });
      const apiKey = await resolveModelRuntimeApiKey({
        model,
        cfg: effectiveCfg,
        agentDir: params.agentDir,
        authStorage,
      });
      const context: Context = {
        messages: [
          {
            role: "user",
            content: [
              ...params.images.map((image) => ({
                type: "image" as const,
                data: image.base64,
                mimeType: image.mimeType,
              })),
              {
                type: "text" as const,
                text: [
                  "Create polished PDF-ready markdown for the user's requested document.",
                  "Return markdown only, no code fences, no explanations.",
                  "If reference images are attached, treat them as the main visual already available for layout.",
                  "If the user asks for multiple pages/slides, separate them with a standalone line containing ---.",
                  "Prefer visually structured sections, compact tables, punchy labels, KPI strips, comparison grids, and infographic-style callouts over long prose.",
                  "Open with a strong cover page, then keep each following page dense but scannable.",
                  "Use short sections and concrete data points; avoid filler paragraphs and generic motivational text.",
                  "When relevant, include markdown tables or compact metric blocks instead of plain bullet dumps.",
                  requestedPageCount
                    ? `Target exactly ${requestedPageCount} page(s)/slide(s), separated with --- between pages.`
                    : "If the user implies a deck or infographic, create a multi-page structure instead of a single wall of text.",
                  "Use the user's requested language and formatting intent.",
                  "",
                  `User request:\n${params.prompt}`,
                ].join("\n"),
              },
            ],
            timestamp: Date.now(),
          },
        ],
      };
      const message = await complete(model, context, {
        apiKey,
        maxTokens: resolvePdfToolMaxTokens(model.maxTokens),
      });
      const text = coercePdfAssistantText({ message, provider, model: modelId });
      return { text, provider, model: modelId };
    },
  });

  return {
    text: result.result.text,
    provider: result.result.provider,
    model: result.result.model,
  };
}

// ---------------------------------------------------------------------------
// Model resolution (mirrors image tool pattern)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective PDF model config.
 * Falls back to the image model config, then to provider-specific defaults.
 */
export function resolvePdfModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
}): ImageModelConfig | null {
  // Check for explicit PDF model config first
  const explicitPdf = coercePdfModelConfig(params.cfg);
  if (explicitPdf.primary?.trim() || (explicitPdf.fallbacks?.length ?? 0) > 0) {
    return explicitPdf;
  }

  // Fall back to the image model config
  const explicitImage = coerceImageModelConfig(params.cfg);
  if (explicitImage.primary?.trim() || (explicitImage.fallbacks?.length ?? 0) > 0) {
    return explicitImage;
  }

  // Auto-detect from available providers
  const primary = resolveDefaultModelRef(params.cfg);
  const anthropicOk = hasAuthForProvider({ provider: "anthropic", agentDir: params.agentDir });
  const googleOk = hasAuthForProvider({ provider: "google", agentDir: params.agentDir });
  const hydraOk = hasAuthForProvider({ provider: "hydra", agentDir: params.agentDir });
  const openaiOk = hasAuthForProvider({ provider: "openai", agentDir: params.agentDir });

  const fallbacks: string[] = [];
  const addFallback = (ref: string) => {
    const trimmed = ref.trim();
    if (trimmed && !fallbacks.includes(trimmed)) {
      fallbacks.push(trimmed);
    }
  };

  // Prefer providers with native PDF support
  let preferred: string | null = null;

  const providerOk = hasAuthForProvider({ provider: primary.provider, agentDir: params.agentDir });
  const providerVision = resolveProviderVisionModelFromConfig({
    cfg: params.cfg,
    provider: primary.provider,
  });

  const primaryRef = `${primary.provider}/${primary.model}`;

  if (primary.provider === "anthropic" && anthropicOk) {
    preferred = ANTHROPIC_PDF_PRIMARY;
  } else if (primary.provider === "hydra" && hydraOk) {
    preferred = primaryRef;
  } else if (primary.provider === "google" && googleOk && providerVision) {
    preferred = providerVision;
  } else if (providerOk && providerVision) {
    preferred = providerVision;
  } else if (anthropicOk) {
    preferred = ANTHROPIC_PDF_PRIMARY;
  } else if (googleOk) {
    preferred = "google/gemini-2.5-pro";
  } else if (hydraOk) {
    preferred = HYDRA_PDF_PRIMARY;
  } else if (openaiOk) {
    preferred = "openai/gpt-5-mini";
  }

  if (preferred?.trim()) {
    if (anthropicOk && preferred !== ANTHROPIC_PDF_PRIMARY) {
      addFallback(ANTHROPIC_PDF_PRIMARY);
    }
    if (hydraOk && preferred !== HYDRA_PDF_PRIMARY) {
      addFallback(HYDRA_PDF_PRIMARY);
    }
    if (anthropicOk) {
      addFallback(ANTHROPIC_PDF_FALLBACK);
    }
    if (openaiOk) {
      addFallback("openai/gpt-5-mini");
    }
    const pruned = fallbacks.filter((ref) => ref !== preferred);
    return { primary: preferred, ...(pruned.length > 0 ? { fallbacks: pruned } : {}) };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Build context for extraction fallback path
// ---------------------------------------------------------------------------

function buildPdfExtractionContext(prompt: string, extractions: PdfExtractedContent[]): Context {
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [];

  // Add extracted text and images
  for (let i = 0; i < extractions.length; i++) {
    const extraction = extractions[i];
    if (extraction.text.trim()) {
      const label = extractions.length > 1 ? `[PDF ${i + 1} text]\n` : "[PDF text]\n";
      content.push({ type: "text", text: label + extraction.text });
    }
    for (const img of extraction.images) {
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
  }

  // Add the user prompt
  content.push({ type: "text", text: prompt });

  return {
    messages: [{ role: "user", content, timestamp: Date.now() }],
  };
}

// ---------------------------------------------------------------------------
// Run PDF prompt with model fallback
// ---------------------------------------------------------------------------

type PdfSandboxConfig = {
  root: string;
  bridge: SandboxFsBridge;
};

async function runPdfPrompt(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
  pdfModelConfig: ImageModelConfig;
  modelOverride?: string;
  prompt: string;
  pdfBuffers: Array<{ base64: string; filename: string }>;
  pageNumbers?: number[];
  getExtractions: () => Promise<PdfExtractedContent[]>;
}): Promise<{
  text: string;
  provider: string;
  model: string;
  native: boolean;
  attempts: Array<{ provider: string; model: string; error: string }>;
}> {
  const effectiveCfg = applyImageModelConfigDefaults(params.cfg, params.pdfModelConfig);

  await ensureOpenClawModelsJson(effectiveCfg, params.agentDir);
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);

  let extractionCache: PdfExtractedContent[] | null = null;
  const getExtractions = async (): Promise<PdfExtractedContent[]> => {
    if (!extractionCache) {
      extractionCache = await params.getExtractions();
    }
    return extractionCache;
  };

  const result = await runWithImageModelFallback({
    cfg: effectiveCfg,
    modelOverride: params.modelOverride,
    run: async (provider, modelId) => {
      const model = resolveModelFromRegistry({ modelRegistry, provider, modelId });
      const apiKey = await resolveModelRuntimeApiKey({
        model,
        cfg: effectiveCfg,
        agentDir: params.agentDir,
        authStorage,
      });

      if (providerSupportsNativePdf(provider)) {
        if (params.pageNumbers && params.pageNumbers.length > 0) {
          throw new Error(
            `pages is not supported with native PDF providers (${provider}/${modelId}). Remove pages, or use a non-native model for page filtering.`,
          );
        }

        const pdfs = params.pdfBuffers.map((p) => ({
          base64: p.base64,
          filename: p.filename,
        }));

        if (provider === "anthropic") {
          const text = await anthropicAnalyzePdf({
            apiKey,
            modelId,
            prompt: params.prompt,
            pdfs,
            maxTokens: resolvePdfToolMaxTokens(model.maxTokens),
            baseUrl: model.baseUrl,
          });
          return { text, provider, model: modelId, native: true };
        }

        if (provider === "google") {
          const text = await geminiAnalyzePdf({
            apiKey,
            modelId,
            prompt: params.prompt,
            pdfs,
            baseUrl: model.baseUrl,
          });
          return { text, provider, model: modelId, native: true };
        }
      }

      const extractions = await getExtractions();
      const hasImages = extractions.some((e) => e.images.length > 0);
      if (hasImages && !model.input?.includes("image")) {
        const hasText = extractions.some((e) => e.text.trim().length > 0);
        if (!hasText) {
          throw new Error(
            `Model ${provider}/${modelId} does not support images and PDF has no extractable text.`,
          );
        }
        const textOnlyExtractions: PdfExtractedContent[] = extractions.map((e) => ({
          text: e.text,
          images: [],
        }));
        const context = buildPdfExtractionContext(params.prompt, textOnlyExtractions);
        const message = await complete(model, context, {
          apiKey,
          maxTokens: resolvePdfToolMaxTokens(model.maxTokens),
        });
        const text = coercePdfAssistantText({ message, provider, model: modelId });
        return { text, provider, model: modelId, native: false };
      }

      const context = buildPdfExtractionContext(params.prompt, extractions);
      const message = await complete(model, context, {
        apiKey,
        maxTokens: resolvePdfToolMaxTokens(model.maxTokens),
      });
      const text = coercePdfAssistantText({ message, provider, model: modelId });
      return { text, provider, model: modelId, native: false };
    },
  });

  return {
    text: result.result.text,
    provider: result.result.provider,
    model: result.result.model,
    native: result.result.native,
    attempts: result.attempts.map((a) => ({
      provider: a.provider,
      model: a.model,
      error: a.error,
    })),
  };
}

// ---------------------------------------------------------------------------
// PDF tool factory
// ---------------------------------------------------------------------------

export function createPdfTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  runId?: string;
  onYield?: (message: string) => Promise<void> | void;
  workspaceDir?: string;
  sandbox?: PdfSandboxConfig;
  fsPolicy?: ToolFsPolicy;
}): AnyAgentTool | null {
  const agentDir = options?.agentDir?.trim();
  if (!agentDir) {
    const explicit = coercePdfModelConfig(options?.config);
    if (explicit.primary?.trim() || (explicit.fallbacks?.length ?? 0) > 0) {
      throw new Error("createPdfTool requires agentDir when enabled");
    }
    return null;
  }

  const pdfModelConfig = resolvePdfModelConfigForTool({ cfg: options?.config, agentDir });
  if (!pdfModelConfig) {
    return null;
  }

  const maxBytesMbDefault = (
    options?.config?.agents?.defaults as Record<string, unknown> | undefined
  )?.pdfMaxBytesMb;
  const maxPagesDefault = (options?.config?.agents?.defaults as Record<string, unknown> | undefined)
    ?.pdfMaxPages;
  const configuredMaxBytesMb =
    typeof maxBytesMbDefault === "number" && Number.isFinite(maxBytesMbDefault)
      ? maxBytesMbDefault
      : DEFAULT_MAX_BYTES_MB;
  const configuredMaxPages =
    typeof maxPagesDefault === "number" && Number.isFinite(maxPagesDefault)
      ? Math.floor(maxPagesDefault)
      : DEFAULT_MAX_PAGES;

  const localRoots = resolveMediaToolLocalRoots(options?.workspaceDir, {
    workspaceOnly: options?.fsPolicy?.workspaceOnly === true,
  });

  const description =
    "Analyze one or more PDF documents with a model. Supports native PDF analysis for Anthropic and Google models, with text/image extraction fallback for other providers. If no source PDF is provided, the tool can render a prompt-only PDF; richer infographic/presentation prompts first attempt a model-drafted markdown layout before rendering. Use pdf for a single path/URL, or pdfs for multiple (up to 10).";

  return {
    label: "PDF",
    name: "pdf",
    description,
    parameters: Type.Object({
      prompt: Type.Optional(
        Type.String({
          description:
            "Prompt text to analyze against the PDFs, or the full document content to render when generating a PDF without a source file.",
        }),
      ),
      pdf: Type.Optional(Type.String({ description: "Single PDF path or URL." })),
      pdfs: Type.Optional(
        Type.Array(Type.String(), {
          description: "Multiple PDF paths or URLs (up to 10).",
        }),
      ),
      pages: Type.Optional(
        Type.String({
          description: 'Page range to process, e.g. "1-5", "1,3,5-7". Defaults to all pages.',
        }),
      ),
      filename: Type.Optional(
        Type.String({
          description:
            "Optional output filename for prompt-only PDF generation or saved PDF deliverables.",
        }),
      ),
      model: Type.Optional(Type.String()),
      maxBytesMb: Type.Optional(Type.Number()),
    }),
    execute: async (_toolCallId, args) => {
      const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      const { prompt: promptRaw, modelOverride } = resolvePromptAndModelOverride(
        record,
        DEFAULT_PROMPT,
      );
      const maxBytesMbRaw = typeof record.maxBytesMb === "number" ? record.maxBytesMb : undefined;
      const maxBytesMb =
        typeof maxBytesMbRaw === "number" && Number.isFinite(maxBytesMbRaw) && maxBytesMbRaw > 0
          ? maxBytesMbRaw
          : configuredMaxBytesMb;
      const maxBytes = Math.floor(maxBytesMb * 1024 * 1024);
      const sandboxConfig: SandboxedBridgeMediaPathConfig | null =
        options?.sandbox && options.sandbox.root.trim()
          ? {
              root: options.sandbox.root.trim(),
              bridge: options.sandbox.bridge,
              workspaceOnly: options.fsPolicy?.workspaceOnly === true,
            }
          : null;

      // MARK: - Normalize pdf + pdfs input
      const pdfCandidates: string[] = [];
      if (typeof record.pdf === "string") {
        pdfCandidates.push(record.pdf);
      }
      if (Array.isArray(record.pdfs)) {
        pdfCandidates.push(...record.pdfs.filter((v): v is string => typeof v === "string"));
      }

      const seenPdfs = new Set<string>();
      const pdfInputs: string[] = [];
      const promptOnlyFallbackParts: string[] = [];
      const promptOnlyImageRefs: string[] = [];
      if (typeof record.prompt === "string" && record.prompt.trim()) {
        promptOnlyFallbackParts.push(record.prompt.trim());
        promptOnlyImageRefs.push(...extractImageReferencesFromText(record.prompt));
      }
      for (const candidate of pdfCandidates) {
        const trimmed = candidate.trim();
        if (!trimmed || seenPdfs.has(trimmed)) {
          continue;
        }
        seenPdfs.add(trimmed);
        if (looksLikePdfReference(trimmed)) {
          pdfInputs.push(trimmed);
          continue;
        }
        if (looksLikeImageReference(trimmed)) {
          if (!promptOnlyImageRefs.includes(trimmed)) {
            promptOnlyImageRefs.push(trimmed);
          }
          continue;
        }
        promptOnlyFallbackParts.push(trimmed);
      }
      if (pdfInputs.length === 0) {
        const fallbackPrompt = promptOnlyFallbackParts.join("\n\n").trim();
        if (!fallbackPrompt) {
          throw new Error("pdf required: provide a path or URL to a PDF document");
        }
        const generatedText = buildGeneratedPdfText(fallbackPrompt);
        const filename =
          typeof record.filename === "string" && record.filename.trim()
            ? record.filename
            : "generated-pdf.pdf";
        const imageAssets = await Promise.all(
          promptOnlyImageRefs.map((ref) =>
            loadPromptOnlyPdfImageAsset({
              ref,
              maxBytes,
              localRoots,
              sandboxConfig,
            }),
          ),
        );
        const drafted =
          imageAssets.length > 0 || promptOnlyPdfWantsRichDraft(fallbackPrompt)
            ? await draftPromptOnlyPdfMarkdown({
                cfg: options?.config ?? {},
                agentDir,
                pdfModelConfig,
                modelOverride: typeof record.model === "string" ? record.model : undefined,
                prompt: fallbackPrompt,
                images: imageAssets,
              }).catch(() => null)
            : null;
        const baseFileName = path.parse(filename).name || "generated-pdf";
        const title = path.parse(filename).name || "Generated PDF";
        const bodyHtml =
          drafted || imageAssets.length > 0
            ? buildPromptOnlyPdfHtml({
                bodyMarkdown: drafted?.text || generatedText,
                images: imageAssets,
              })
            : resolveHtmlBody({ text: generatedText });
        const materializationRequest = {
          artifactId: `pdf-tool-${baseFileName}`,
          label: title,
          sourceDomain: "document" as const,
          renderKind: "pdf" as const,
          outputTarget: "file" as const,
          outputDir: path.join(os.tmpdir(), "openclaw-pdf-tool"),
          baseFileName,
          payload: {
            title,
            html: bodyHtml,
          },
        };
        const rendererAvailable = await isPdfRendererAvailable({
          requireManagedInstall: promptOnlyPdfNeedsManagedRenderer(fallbackPrompt),
        });
        let materialization = rendererAvailable
          ? materializeArtifact(materializationRequest, { runId: options?.runId })
          : materializeArtifact(materializationRequest, {
              pdfRendererAvailable: false,
              runId: options?.runId,
            });
        if (rendererAvailable && materialization.primary.renderKind !== "pdf") {
          materialization = materializeArtifact(materializationRequest, {
            pdfRendererAvailable: false,
            runId: options?.runId,
          });
        }
        if (materialization.primary.renderKind !== "pdf") {
          await options?.onYield?.(
            'Waiting for "pdf-renderer" approval and install before the PDF task can continue.',
          );
          return {
            content: [
              {
                type: "text",
                text:
                  imageAssets.length > 0
                    ? "PDF renderer unavailable; created 1 HTML draft with embedded image assets and requested bootstrap for PDF output."
                    : "PDF renderer unavailable; created 1 HTML draft from the prompt text and requested bootstrap for PDF output.",
              },
            ],
            details: {
              provider: drafted?.provider ?? "local",
              model: drafted?.model ?? "minimal-pdf",
              renderKind: materialization.primary.renderKind,
              html: materialization.primary.path,
              paths: [materialization.primary.path],
              degraded: materialization.degraded ?? true,
              warnings: materialization.warnings ?? [],
              bootstrapRequest: materialization.bootstrapRequest,
              media: {
                mediaUrls: [materialization.primary.path],
              },
            },
          };
        }
        const renderedBuffer = await fs.readFile(materialization.primary.path);
        const saved = await saveMediaBuffer(
          renderedBuffer,
          "application/pdf",
          "tool-pdf-generation",
          undefined,
          filename,
        );
        return {
          content: [
            {
              type: "text",
              text:
                imageAssets.length > 0
                  ? "Generated 1 PDF with embedded image assets."
                  : "Generated 1 PDF locally from the prompt text.",
            },
          ],
          details: {
            provider: drafted?.provider ?? "local",
            model: drafted?.model ?? "pdf-renderer",
            pdf: saved.path,
            paths: [saved.path],
            renderKind: materialization.primary.renderKind,
            media: {
              mediaUrls: [saved.path],
            },
          },
        };
      }

      // Enforce max PDFs cap
      if (pdfInputs.length > DEFAULT_MAX_PDFS) {
        return {
          content: [
            {
              type: "text",
              text: `Too many PDFs: ${pdfInputs.length} provided, maximum is ${DEFAULT_MAX_PDFS}. Please reduce the number.`,
            },
          ],
          details: { error: "too_many_pdfs", count: pdfInputs.length, max: DEFAULT_MAX_PDFS },
        };
      }

      // Parse page range
      const pagesRaw =
        typeof record.pages === "string" && record.pages.trim() ? record.pages.trim() : undefined;

      // MARK: - Load each PDF
      const loadedPdfs: Array<{
        base64: string;
        buffer: Buffer;
        filename: string;
        resolvedPath: string;
        rewrittenFrom?: string;
      }> = [];

      for (const pdfRaw of pdfInputs) {
        const trimmed = pdfRaw.trim();
        const isHttpUrl = /^https?:\/\//i.test(trimmed);
        const isFileUrl = /^file:/i.test(trimmed);
        const isDataUrl = /^data:/i.test(trimmed);
        const looksLikeWindowsDrive = /^[a-zA-Z]:[\\/]/.test(trimmed);
        const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);

        if (hasScheme && !looksLikeWindowsDrive && !isFileUrl && !isHttpUrl && !isDataUrl) {
          return {
            content: [
              {
                type: "text",
                text: `Unsupported PDF reference: ${pdfRaw}. Use a file path, file:// URL, or http(s) URL.`,
              },
            ],
            details: { error: "unsupported_pdf_reference", pdf: pdfRaw },
          };
        }

        if (sandboxConfig && isHttpUrl) {
          throw new Error("Sandboxed PDF tool does not allow remote URLs.");
        }

        const resolvedPdf = (() => {
          if (sandboxConfig) {
            return trimmed;
          }
          if (trimmed.startsWith("~")) {
            return resolveUserPath(trimmed);
          }
          return trimmed;
        })();

        const resolvedPathInfo: { resolved: string; rewrittenFrom?: string } = sandboxConfig
          ? await resolveSandboxedBridgeMediaPath({
              sandbox: sandboxConfig,
              mediaPath: resolvedPdf,
              inboundFallbackDir: "media/inbound",
            })
          : {
              resolved: resolvedPdf.startsWith("file://")
                ? resolvedPdf.slice("file://".length)
                : resolvedPdf,
            };

        const media = sandboxConfig
          ? await loadWebMediaRaw(resolvedPathInfo.resolved, {
              maxBytes,
              sandboxValidated: true,
              readFile: createSandboxBridgeReadFile({ sandbox: sandboxConfig }),
            })
          : await loadWebMediaRaw(resolvedPathInfo.resolved, {
              maxBytes,
              localRoots,
            });

        if (media.kind !== "document") {
          // Check MIME type more specifically
          const ct = (media.contentType ?? "").toLowerCase();
          if (!ct.includes("pdf") && !ct.includes("application/pdf")) {
            throw new Error(`Expected PDF but got ${media.contentType ?? media.kind}: ${pdfRaw}`);
          }
        }

        const base64 = media.buffer.toString("base64");
        const filename =
          media.fileName ??
          (isHttpUrl
            ? (new URL(trimmed).pathname.split("/").pop() ?? "document.pdf")
            : "document.pdf");

        loadedPdfs.push({
          base64,
          buffer: media.buffer,
          filename,
          resolvedPath: resolvedPathInfo.resolved,
          ...(resolvedPathInfo.rewrittenFrom
            ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom }
            : {}),
        });
      }

      const pageNumbers = pagesRaw ? parsePageRange(pagesRaw, configuredMaxPages) : undefined;

      const getExtractions = async (): Promise<PdfExtractedContent[]> => {
        const extractedAll: PdfExtractedContent[] = [];
        for (const pdf of loadedPdfs) {
          const extracted = await extractPdfContent({
            buffer: pdf.buffer,
            maxPages: configuredMaxPages,
            maxPixels: PDF_MAX_PIXELS,
            minTextChars: PDF_MIN_TEXT_CHARS,
            pageNumbers,
          });
          extractedAll.push(extracted);
        }
        return extractedAll;
      };

      const result = await runPdfPrompt({
        cfg: options?.config,
        agentDir,
        pdfModelConfig,
        modelOverride,
        prompt: promptRaw,
        pdfBuffers: loadedPdfs.map((p) => ({ base64: p.base64, filename: p.filename })),
        pageNumbers,
        getExtractions,
      });

      const pdfDetails =
        loadedPdfs.length === 1
          ? {
              pdf: loadedPdfs[0].resolvedPath,
              ...(loadedPdfs[0].rewrittenFrom
                ? { rewrittenFrom: loadedPdfs[0].rewrittenFrom }
                : {}),
            }
          : {
              pdfs: loadedPdfs.map((p) => ({
                pdf: p.resolvedPath,
                ...(p.rewrittenFrom ? { rewrittenFrom: p.rewrittenFrom } : {}),
              })),
            };

      return buildTextToolResult(result, { native: result.native, ...pdfDetails });
    },
  };
}
