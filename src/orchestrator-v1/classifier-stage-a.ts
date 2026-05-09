/**
 * V1-CONTRACT-ONLY — Stage A classifier (intent + tool routing).
 *
 * Calls the cheap classifier model (default `hydra/gpt-5-mini` — bench winner)
 * with the user's message and a fixed system prompt that lists tool names
 * + 1-line descriptions. Output is parsed and Zod-validated into a
 * StageARouting discriminated union.
 *
 * On any failure (non-JSON, schema mismatch, exception, timeout), returns
 * `{ intent: "refuse", refusal_reason: ... }` so callers always receive
 * a well-formed StageARouting and never need to special-case errors.
 *
 * The Stage-A prompt is INTENTIONALLY minimal: tool names + 1-line
 * descriptions only. We do NOT ship a 30+ example block (the legacy
 * task-classifier did that and still drifted on minute-interval prompts —
 * see Bug F / T8 / 2026-05-08 T1 evidence).
 */

import { completeSimple, type Api, type Model, type TextContent } from "@mariozechner/pi-ai";
import { getApiKeyForModel, requireApiKey } from "../agents/model-auth.js";
import { resolveModelAsync } from "../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../agents/simple-completion-transport.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { StageARoutingSchema, TOOL_NAMES, type StageARouting } from "./contract.js";

const STAGE_A_TIMEOUT_MS = 15_000;
const STAGE_A_MAX_TOKENS = 200;

/** One-line descriptions for every tool name in TOOL_NAMES. */
const TOOL_DESCRIPTIONS: Record<(typeof TOOL_NAMES)[number], string> = {
  write: "Создать или перезаписать файл с заданным содержимым.",
  edit: "Изменить существующий файл (поиск+замена или append).",
  read: "Прочитать содержимое файла.",
  image_generate: "Сгенерировать изображение из текстового описания.",
  web_search: "Найти страницы в интернете по поисковому запросу.",
  web_fetch: "Скачать содержимое страницы по конкретному URL.",
  sessions_send: "Отправить сообщение в указанный чат / сессию.",
  persistent_worker_push:
    "Создать постоянного работника, который периодически выполняет действие (cron-расписание + push в чат).",
  cron: "Установить отложенное напоминание / разовое или повторяющееся действие по расписанию.",
  exec: "Выполнить shell-команду (только когда явно нужно вычисление, не для манипуляции файлами).",
};

export type StageAModelRef = {
  provider: string;
  modelId: string;
};

/** Default classifier model — bench winner 2026-05-09. */
export const DEFAULT_STAGE_A_MODEL: StageAModelRef = {
  provider: "hydra",
  modelId: "gpt-5-mini",
};

/** Build the Stage-A system prompt (deterministic — no per-call template params yet). */
export function buildStageAPrompt(): string {
  const toolMenu = TOOL_NAMES.map((tool) => `  - ${tool}: ${TOOL_DESCRIPTIONS[tool]}`).join("\n");

  return `Ты классификатор намерений. Твоя ЕДИНСТВЕННАЯ задача — посмотреть на сообщение пользователя и выдать СТРОГИЙ JSON в одном из трёх форматов:

1. Если пользователь просит выполнить действие(я):
{"intent":"tool_calls","tool_names":["<name1>","<name2>",...],"sequencing":"sequential"|"parallel"}

2. Если пользователь хочет поговорить, задаёт вопрос, здоровается:
{"intent":"conversation"}

3. Если запрос неоднозначен, не хватает информации, нет конкретного объекта действия:
{"intent":"refuse","refusal_reason":"<кратко на русском почему>"}

Доступные инструменты:
${toolMenu}

ПРАВИЛА:
- Если в сообщении два действия через "и потом", "затем", "после этого" — sequencing="sequential", оба tool_names в массиве в правильном порядке.
- Если действия независимы и могут идти параллельно — sequencing="parallel".
- Для одиночного действия sequencing="sequential" (default).
- Если пользователь говорит "сделай это", "сохрани это", "отправь это" БЕЗ конкретного объекта в текущем сообщении — intent="refuse".
- Не выдумывай инструменты вне списка. Если ни один не подходит — intent="refuse".
- Не задавай уточняющих вопросов в JSON — это работа другого слоя. Просто классифицируй.
- ОТВЕЧАЙ ТОЛЬКО JSON. Без markdown, без префиксов, без объяснений.

Сообщение пользователя:`;
}

function isTextBlock(b: { type: string }): b is TextContent {
  return b.type === "text";
}

/** Strip common LLM wrappers (code fences, leading/trailing whitespace) before JSON.parse. */
function stripWrappers(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  }
  return cleaned;
}

export type ClassifyTurnDeps = {
  cfg?: OpenClawConfig;
  /** Override model (for tests / opt-in cohort). */
  model?: StageAModelRef;
  /** Override agent dir. */
  agentDir?: string;
};

export type ClassifyTurnResult = {
  routing: StageARouting;
  /** Latency of the LLM call in ms. */
  latencyMs: number;
  /** Raw response text from the model (for telemetry / logs). */
  rawResponse?: string;
  /** Set when classification fell back to refuse due to error. */
  fallbackReason?: "non_json" | "wrong_shape" | "wrong_enum" | "exception" | "timeout" | "model_unresolved";
};

/**
 * Classify a user turn into a StageARouting.
 *
 * Always returns a valid StageARouting — failures fall back to a refuse
 * contract with the failure mode in `fallbackReason`. Caller logs the
 * failure mode and surfaces a generic "Не могу разобрать запрос" reply.
 */
export async function classifyTurn(
  userMessage: string,
  deps: ClassifyTurnDeps = {},
): Promise<ClassifyTurnResult> {
  const startedAt = Date.now();
  const cfg = deps.cfg ?? loadConfig();
  const modelRef = deps.model ?? DEFAULT_STAGE_A_MODEL;
  const resolved = await resolveModelAsync(modelRef.provider, modelRef.modelId, deps.agentDir, cfg);
  if (!resolved.model) {
    logVerbose(
      `[stage-a] model unresolved: ${modelRef.provider}/${modelRef.modelId} — ${resolved.error ?? "(no error)"}`,
    );
    return {
      routing: {
        intent: "refuse",
        refusal_reason: "Сервис временно недоступен (классификатор не загружен).",
      },
      latencyMs: Date.now() - startedAt,
      fallbackReason: "model_unresolved",
    };
  }

  const completionModel = prepareModelForSimpleCompletion({ model: resolved.model, cfg });
  const apiKey = requireApiKey(
    await getApiKeyForModel({ model: completionModel, cfg, agentDir: deps.agentDir }),
    modelRef.provider,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STAGE_A_TIMEOUT_MS);
  let raw = "";
  let exceptionFallback: ClassifyTurnResult["fallbackReason"];
  try {
    const result = await completeSimple(
      completionModel as Model<Api>,
      {
        messages: [
          {
            role: "user",
            content: `${buildStageAPrompt()}\n\n${userMessage}`,
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey, maxTokens: STAGE_A_MAX_TOKENS, temperature: 0.1, signal: controller.signal },
    );
    raw = result.content.filter(isTextBlock).map((b) => b.text).join("").trim();
  } catch (err) {
    const name = (err as Error).name;
    exceptionFallback = name === "AbortError" ? "timeout" : "exception";
    logVerbose(`[stage-a] LLM call failed: ${name}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
  const latencyMs = Date.now() - startedAt;

  if (exceptionFallback) {
    return {
      routing: {
        intent: "refuse",
        refusal_reason: "Сервис временно недоступен (таймаут классификатора).",
      },
      latencyMs,
      rawResponse: raw,
      fallbackReason: exceptionFallback,
    };
  }

  const cleaned = stripWrappers(raw);
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(cleaned);
  } catch {
    return {
      routing: {
        intent: "refuse",
        refusal_reason: "Не могу разобрать запрос.",
      },
      latencyMs,
      rawResponse: raw,
      fallbackReason: "non_json",
    };
  }

  const validation = StageARoutingSchema.safeParse(parsedUnknown);
  if (!validation.success) {
    const issues = validation.error.issues;
    const firstPath = issues[0]?.path.join(".") ?? "(unknown)";
    const firstCode = issues[0]?.code ?? "unknown";
    const fallbackReason: ClassifyTurnResult["fallbackReason"] =
      firstCode === "invalid_value" ? "wrong_enum" : "wrong_shape";
    logVerbose(`[stage-a] schema validation failed at ${firstPath}: ${firstCode}`);
    return {
      routing: {
        intent: "refuse",
        refusal_reason: "Не могу разобрать запрос.",
      },
      latencyMs,
      rawResponse: raw,
      fallbackReason,
    };
  }

  return {
    routing: validation.data,
    latencyMs,
    rawResponse: raw,
  };
}
