import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth";
import { OPENAI_DEFAULT_IMAGE_MODEL as DEFAULT_OPENAI_IMAGE_MODEL } from "openclaw/plugin-sdk/provider-models";

const DEFAULT_OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_HYDRA_IMAGE_BASE_URL = "https://api-ru.hydraai.ru/v1";
const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_SIZE = "1024x1024";
const OPENAI_SUPPORTED_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;
const HYDRA_SUPPORTED_MODELS = ["hydra-banana", "hydra-banana-pro"] as const;
const HYDRA_SUPPORTED_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
const HYDRA_MARKDOWN_IMAGE_RE = /!\[[^\]]*]\((data:image\/[a-zA-Z0-9.+-]+;base64,[^)]+|https?:\/\/[^)\s]+)\)/g;

type OpenAIImageApiResponse = {
  data?: Array<{
    b64_json?: string;
    revised_prompt?: string;
  }>;
};

type OpenAIChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type OpenAICompatibleImageProviderOptions = {
  providerId?: "openai" | "hydra";
  label?: string;
  defaultModel?: string;
  models?: readonly string[];
  defaultBaseUrl?: string;
};

function resolveCompatibleBaseUrl(
  cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
  providerId: "openai" | "hydra",
  defaultBaseUrl: string,
): string {
  const direct = cfg?.models?.providers?.[providerId]?.baseUrl?.trim();
  return direct || defaultBaseUrl;
}

function buildOpenAICompatibleImageGenerationProvider(
  options: OpenAICompatibleImageProviderOptions = {},
): ImageGenerationProvider {
  const providerId = options.providerId ?? "openai";
  const defaultModel =
    options.defaultModel ??
    (providerId === "hydra" ? HYDRA_SUPPORTED_MODELS[0] : DEFAULT_OPENAI_IMAGE_MODEL);
  const defaultBaseUrl =
    options.defaultBaseUrl ??
    (providerId === "hydra" ? DEFAULT_HYDRA_IMAGE_BASE_URL : DEFAULT_OPENAI_IMAGE_BASE_URL);
  return {
    id: providerId,
    label: options.label ?? (providerId === "hydra" ? "Hydra" : "OpenAI"),
    defaultModel,
    models: options.models ? [...options.models] : [defaultModel],
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: false,
        maxCount: 0,
        maxInputImages: 0,
        supportsSize: false,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [...OPENAI_SUPPORTED_SIZES],
      },
    },
    async generateImage(req) {
      if ((req.inputImages?.length ?? 0) > 0) {
        throw new Error(
          `${providerId === "hydra" ? "Hydra" : "OpenAI"} image generation provider does not support reference-image edits`,
        );
      }
      const auth = await resolveApiKeyForProvider({
        provider: providerId,
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error(`${providerId === "hydra" ? "Hydra" : "OpenAI"} API key missing`);
      }

      const controller = new AbortController();
      const timeoutMs = req.timeoutMs;
      const timeout =
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? setTimeout(() => controller.abort(), timeoutMs)
          : undefined;

      const response = await fetch(
        `${resolveCompatibleBaseUrl(req.cfg, providerId, defaultBaseUrl)}/images/generations`,
        {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: req.model || defaultModel,
          prompt: req.prompt,
          n: req.count ?? 1,
          size: req.size ?? DEFAULT_SIZE,
        }),
        signal: controller.signal,
      },
      ).finally(() => {
        clearTimeout(timeout);
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `${providerId === "hydra" ? "Hydra" : "OpenAI"} image generation failed (${response.status}): ${text || response.statusText}`,
        );
      }

      const data = (await response.json()) as OpenAIImageApiResponse;
      const images = (data.data ?? [])
        .map((entry, index) => {
          if (!entry.b64_json) {
            return null;
          }
          return {
            buffer: Buffer.from(entry.b64_json, "base64"),
            mimeType: DEFAULT_OUTPUT_MIME,
            fileName: `image-${index + 1}.png`,
            ...(entry.revised_prompt ? { revisedPrompt: entry.revised_prompt } : {}),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

      return {
        images,
        model: req.model || defaultModel,
      };
    },
  };
}

export function buildOpenAIImageGenerationProvider(): ImageGenerationProvider {
  return buildOpenAICompatibleImageGenerationProvider();
}

export function buildHydraImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "hydra",
    label: "Hydra",
    defaultModel: HYDRA_SUPPORTED_MODELS[0],
    models: [...HYDRA_SUPPORTED_MODELS],
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: false,
      },
      edit: {
        enabled: false,
        maxCount: 0,
        maxInputImages: 0,
        supportsSize: false,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        aspectRatios: [...HYDRA_SUPPORTED_ASPECT_RATIOS],
      },
    },
    async generateImage(req) {
      if ((req.inputImages?.length ?? 0) > 0) {
        throw new Error("Hydra image generation provider does not support reference-image edits");
      }
      const auth = await resolveApiKeyForProvider({
        provider: "hydra",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Hydra API key missing");
      }

      const controller = new AbortController();
      const timeoutMs = req.timeoutMs;
      const timeout =
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? setTimeout(() => controller.abort(), timeoutMs)
          : undefined;

      const requestedGeometry = resolveHydraRequestedGeometry({
        size: req.size,
        aspectRatio: req.aspectRatio,
      });
      const response = await fetch(
        `${resolveCompatibleBaseUrl(req.cfg, "hydra", DEFAULT_HYDRA_IMAGE_BASE_URL)}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: req.model || HYDRA_SUPPORTED_MODELS[0],
            messages: [
              {
                role: "user",
                content: buildHydraImagePrompt(req.prompt, req.count ?? 1, requestedGeometry),
              },
            ],
          }),
          signal: controller.signal,
        },
      ).finally(() => {
        clearTimeout(timeout);
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Hydra image generation failed (${response.status}): ${text || response.statusText}`,
        );
      }

      const data = (await response.json()) as OpenAIChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content ?? "";
      const images = await parseHydraMarkdownImages(content);
      if (images.length === 0) {
        throw new Error("Hydra image generation returned no markdown images.");
      }
      return {
        images,
        model: req.model || HYDRA_SUPPORTED_MODELS[0],
        metadata: {
          rawContent: content,
        },
      };
    },
  };
}

function resolveHydraRequestedGeometry(params: {
  size?: string;
  aspectRatio?: string;
}): { size: string; aspectRatio?: string } {
  const aspectRatio = params.aspectRatio?.trim();
  if (params.size?.trim()) {
    return {
      size: params.size.trim(),
      ...(aspectRatio ? { aspectRatio } : {}),
    };
  }
  if (!aspectRatio) {
    return { size: DEFAULT_SIZE };
  }
  switch (aspectRatio) {
    case "1:1":
      return { size: "1024x1024", aspectRatio };
    case "9:16":
    case "3:4":
    case "2:3":
      return { size: "1024x1536", aspectRatio };
    default:
      return { size: "1536x1024", aspectRatio };
  }
}

function buildHydraImagePrompt(
  prompt: string,
  count: number,
  geometry: { size: string; aspectRatio?: string },
): string {
  return [
    prompt.trim(),
    "",
    `Generate exactly ${String(count)} image${count === 1 ? "" : "s"}.`,
    `Requested size: ${geometry.size}.`,
    ...(geometry.aspectRatio ? [`Requested aspect ratio: ${geometry.aspectRatio}.`] : []),
    "Return the generated image result directly.",
  ].join("\n");
}

async function parseHydraMarkdownImages(content: string) {
  const matches = Array.from(content.matchAll(HYDRA_MARKDOWN_IMAGE_RE));
  const images = await Promise.all(
    matches.map(async (match, index) => {
      const source = match[1];
      if (!source) {
        return null;
      }
      if (source.startsWith("data:image/")) {
        const commaIndex = source.indexOf(",");
        if (commaIndex < 0) {
          return null;
        }
        const mimeType = source.slice("data:".length, source.indexOf(";base64"));
        const payload = source.slice(commaIndex + 1);
        return {
          buffer: Buffer.from(payload, "base64"),
          mimeType,
          fileName: `image-${index + 1}.${mimeType.split("/")[1] || "png"}`,
        };
      }
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`Hydra image URL fetch failed (${response.status}): ${source}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const mimeType = response.headers.get("content-type") || DEFAULT_OUTPUT_MIME;
      return {
        buffer: Buffer.from(arrayBuffer),
        mimeType,
        fileName: `image-${index + 1}.${mimeType.split("/")[1] || "png"}`,
      };
    }),
  );
  return images.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}
