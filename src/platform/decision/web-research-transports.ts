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
