/**
 * V1-CONTRACT-ONLY — Stage B classifier (per-tool argument extraction).
 *
 * Given a user message + a Stage-A-selected tool name, builds a small
 * tool-specific prompt with ONLY that one tool's arg description, calls
 * the cheap classifier model, parses + Zod-validates the args, and
 * returns a typed TurnAction.
 *
 * If validation fails, returns an error so the dispatcher can refuse
 * the whole turn (or partial multi-action sequence) rather than calling
 * a tool with bad args.
 *
 * Anti-bloat: same model as Stage A, same `completeSimple` boundary,
 * same fallback discipline. No streaming, no retries-on-failure
 * (caller's job to log + refuse).
 */

import { completeSimple, type Api, type Model, type TextContent } from "@mariozechner/pi-ai";
import { getApiKeyForModel, requireApiKey } from "../agents/model-auth.js";
import { resolveModelAsync } from "../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../agents/simple-completion-transport.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { TurnActionSchema, type ToolName, type TurnAction } from "./contract.js";
import {
  TOOL_ARG_SCHEMAS,
  TOOL_ARG_DESCRIPTIONS,
} from "./tool-arg-schemas.js";
import { DEFAULT_STAGE_A_MODEL, type StageAModelRef } from "./classifier-stage-a.js";

const STAGE_B_TIMEOUT_MS = 15_000;
const STAGE_B_MAX_TOKENS = 600;

function isTextBlock(b: { type: string }): b is TextContent {
  return b.type === "text";
}

function stripWrappers(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  }
  return cleaned;
}

export function buildStageBPrompt(tool: ToolName): string {
  const description = TOOL_ARG_DESCRIPTIONS[tool];
  return `Ты извлекаешь аргументы для одного инструмента.

Инструмент: ${tool}
${description}

Из сообщения пользователя извлеки ВСЕ обязательные поля. Опциональные поля включай ТОЛЬКО если пользователь их явно указал.

ОТВЕЧАЙ СТРОГИМ JSON-объектом с полями инструмента. Без markdown, без префиксов, без объяснений.

Если в сообщении не хватает информации для обязательных полей — верни {"_error":"missing","_field":"<имя поля>"} и НИЧЕГО ДРУГОГО.

Сообщение пользователя:`;
}

export type ExtractToolArgsDeps = {
  cfg?: OpenClawConfig;
  model?: StageAModelRef;
  agentDir?: string;
};

export type ExtractToolArgsResult = {
  /** Set when extraction succeeded and Zod validated. */
  action?: TurnAction;
  /** Set when extraction failed at any step. */
  error?: {
    kind: "missing_field" | "non_json" | "wrong_shape" | "exception" | "timeout" | "model_unresolved";
    detail: string;
  };
  latencyMs: number;
  rawResponse?: string;
};

/**
 * Run Stage-B for a single tool. Always resolves; failures are reported
 * via `error` instead of throwing, so callers can decide whether to
 * refuse the entire multi-action turn or only the failing action.
 */
export async function extractToolArgs(
  tool: ToolName,
  userMessage: string,
  deps: ExtractToolArgsDeps = {},
): Promise<ExtractToolArgsResult> {
  const startedAt = Date.now();
  const cfg = deps.cfg ?? loadConfig();
  const modelRef = deps.model ?? DEFAULT_STAGE_A_MODEL;
  const resolved = await resolveModelAsync(modelRef.provider, modelRef.modelId, deps.agentDir, cfg);
  if (!resolved.model) {
    logVerbose(
      `[stage-b] model unresolved: ${modelRef.provider}/${modelRef.modelId} — ${resolved.error ?? "(no error)"}`,
    );
    return {
      error: {
        kind: "model_unresolved",
        detail: resolved.error ?? "unknown model",
      },
      latencyMs: Date.now() - startedAt,
    };
  }
  const completionModel = prepareModelForSimpleCompletion({ model: resolved.model, cfg });
  const apiKey = requireApiKey(
    await getApiKeyForModel({ model: completionModel, cfg, agentDir: deps.agentDir }),
    modelRef.provider,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STAGE_B_TIMEOUT_MS);
  let raw = "";
  let exceptionFallback: ExtractToolArgsResult["error"];
  try {
    const result = await completeSimple(
      completionModel as Model<Api>,
      {
        messages: [
          {
            role: "user",
            content: `${buildStageBPrompt(tool)}\n\n${userMessage}`,
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey, maxTokens: STAGE_B_MAX_TOKENS, temperature: 0.1, signal: controller.signal },
    );
    raw = result.content.filter(isTextBlock).map((b) => b.text).join("").trim();
  } catch (err) {
    const name = (err as Error).name;
    exceptionFallback = {
      kind: name === "AbortError" ? "timeout" : "exception",
      detail: (err as Error).message,
    };
  } finally {
    clearTimeout(timeout);
  }
  const latencyMs = Date.now() - startedAt;
  if (exceptionFallback) {
    return { error: exceptionFallback, latencyMs, rawResponse: raw };
  }

  const cleaned = stripWrappers(raw);
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(cleaned);
  } catch {
    return {
      error: { kind: "non_json", detail: raw.slice(0, 200) },
      latencyMs,
      rawResponse: raw,
    };
  }

  // Stage-B sentinel: model declares missing field
  if (
    typeof parsedUnknown === "object" &&
    parsedUnknown !== null &&
    "_error" in parsedUnknown &&
    (parsedUnknown as { _error?: unknown })._error === "missing"
  ) {
    const field = (parsedUnknown as { _field?: unknown })._field;
    return {
      error: {
        kind: "missing_field",
        detail: typeof field === "string" ? field : "(unknown field)",
      },
      latencyMs,
      rawResponse: raw,
    };
  }

  const argSchema = TOOL_ARG_SCHEMAS[tool];
  const argValidation = argSchema.safeParse(parsedUnknown);
  if (!argValidation.success) {
    const issues = argValidation.error.issues;
    const firstPath = issues[0]?.path.join(".") ?? "(unknown)";
    return {
      error: { kind: "wrong_shape", detail: `field=${firstPath}` },
      latencyMs,
      rawResponse: raw,
    };
  }

  const action: TurnAction = {
    tool,
    args: argValidation.data as Record<string, unknown>,
  };
  // sanity-check via TurnActionSchema (cheap, catches type drift)
  const finalCheck = TurnActionSchema.safeParse(action);
  if (!finalCheck.success) {
    return {
      error: { kind: "wrong_shape", detail: "TurnActionSchema mismatch" },
      latencyMs,
      rawResponse: raw,
    };
  }
  return { action: finalCheck.data, latencyMs, rawResponse: raw };
}
