import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { parseModelRef } from "../../agents/model-selection.js";
import { resolveModelAsync } from "../../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../../agents/simple-completion-transport.js";
import type {
  WebResearchComposerTransport,
  WebResearchSpecialistTransport,
} from "../../agents/pi-embedded-runner/run/web-research-runtime-adapter.js";
import type { OpenClawConfig } from "../../config/config.js";

const DEFAULT_SPECIALIST_MODEL = "hydra/sonar-pro";
const DEFAULT_SPECIALIST_TIMEOUT_MS = 30_000;
const DEFAULT_SPECIALIST_MAX_TOKENS = 2000;

const DEFAULT_COMPOSER_MODEL = "hydra/claude-opus-4.6";
const DEFAULT_COMPOSER_TIMEOUT_MS = 60_000;
const DEFAULT_COMPOSER_MAX_TOKENS = 4000;

function isTextContentBlock(block: unknown): block is TextContent {
  return Boolean(
    block && typeof block === "object" && (block as { type?: unknown }).type === "text",
  );
}

async function completeWithModel(params: {
  readonly cfg: OpenClawConfig;
  readonly agentDir?: string;
  readonly modelRef: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  /**
   * Optional JSON Schema injected into the upstream payload as
   * `response_format: { type: "json_schema", json_schema: { schema } }`.
   * Used by the specialist transport to force Perplexity sonar to return
   * structured JSON instead of markdown prose (live regression in turn
   * 5722d87c — sonar replied "### Последние новости..." breaking parse).
   * The hook mutates the payload via pi-ai's `onPayload` callback, which is
   * the supported extension point for OpenAI-compatible completions.
   */
  readonly responseJsonSchema?: Record<string, unknown>;
}): Promise<string> {
  const parsedRef = parseModelRef(params.modelRef, "openai");
  if (!parsedRef) {
    throw new Error(`invalid model ref "${params.modelRef}"`);
  }
  const resolved = await resolveModelAsync(
    parsedRef.provider,
    parsedRef.model,
    params.agentDir,
    params.cfg,
  );
  if (!resolved.model) {
    throw new Error(resolved.error ?? `model could not be resolved (ref="${params.modelRef}")`);
  }
  const model = prepareModelForSimpleCompletion({ model: resolved.model, cfg: params.cfg });
  const auth = await getApiKeyForModel({ model, cfg: params.cfg, agentDir: params.agentDir });
  const apiKey = requireApiKey(auth, model.provider);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  const schema = params.responseJsonSchema;
  try {
    const result = await completeSimple(
      model,
      {
        systemPrompt: params.systemPrompt,
        messages: [
          {
            role: "user",
            content: params.userPrompt,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        maxTokens: params.maxTokens,
        temperature: 0,
        signal: controller.signal,
        ...(schema
          ? {
              onPayload: (payload: unknown) => {
                if (!payload || typeof payload !== "object") {
                  return undefined;
                }
                return {
                  ...(payload as Record<string, unknown>),
                  response_format: {
                    type: "json_schema",
                    json_schema: { schema },
                  },
                };
              },
            }
          : {}),
      },
    );
    return result.content
      .filter(isTextContentBlock)
      .map((block) => block.text)
      .join("")
      .trim();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * JSON Schema injected into the Perplexity sonar payload to force a
 * structured envelope `{ records: WebEvidenceRecord[] }`. Wrapping the array
 * in an object root is the broadly-compatible Perplexity shape (top-level
 * arrays are rejected by some sonar tiers). The runtime adapter's parser
 * unwraps both shapes.
 */
const SPECIALIST_RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    records: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string", minLength: 1 },
          snippet: { type: "string" },
          title: { type: "string" },
          capturedAt: { type: "string" },
        },
        required: ["url", "snippet", "capturedAt"],
        additionalProperties: false,
      },
    },
  },
  required: ["records"],
  additionalProperties: false,
};

export type CreateWebResearchSpecialistTransportParams = {
  readonly cfg: OpenClawConfig;
  readonly agentDir?: string;
  /** Model ref override; defaults to `hydra/sonar-pro` per Phase 4 plan. */
  readonly modelRef?: string;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
};

export function createWebResearchSpecialistTransport(
  params: CreateWebResearchSpecialistTransportParams,
): WebResearchSpecialistTransport {
  const modelRef = params.modelRef ?? DEFAULT_SPECIALIST_MODEL;
  const timeoutMs = params.timeoutMs ?? DEFAULT_SPECIALIST_TIMEOUT_MS;
  const maxTokens = params.maxTokens ?? DEFAULT_SPECIALIST_MAX_TOKENS;
  return async ({ prompt, systemMessage }) => {
    const text = await completeWithModel({
      cfg: params.cfg,
      ...(params.agentDir ? { agentDir: params.agentDir } : {}),
      modelRef,
      systemPrompt: systemMessage,
      userPrompt: prompt,
      maxTokens,
      timeoutMs,
      responseJsonSchema: SPECIALIST_RESPONSE_JSON_SCHEMA,
    });
    return { text };
  };
}

export type CreateWebResearchComposerTransportParams = {
  readonly cfg: OpenClawConfig;
  readonly agentDir?: string;
  /** Model ref override; defaults to `hydra/claude-opus-4.6`. */
  readonly modelRef?: string;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
};

export function createWebResearchComposerTransport(
  params: CreateWebResearchComposerTransportParams,
): WebResearchComposerTransport {
  const modelRef = params.modelRef ?? DEFAULT_COMPOSER_MODEL;
  const timeoutMs = params.timeoutMs ?? DEFAULT_COMPOSER_TIMEOUT_MS;
  const maxTokens = params.maxTokens ?? DEFAULT_COMPOSER_MAX_TOKENS;
  return async ({ prompt, systemMessage }) => {
    const text = await completeWithModel({
      cfg: params.cfg,
      ...(params.agentDir ? { agentDir: params.agentDir } : {}),
      modelRef,
      systemPrompt: systemMessage,
      userPrompt: prompt,
      maxTokens,
      timeoutMs,
    });
    return { text };
  };
}
