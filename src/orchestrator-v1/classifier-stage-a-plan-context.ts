/**
 * V1-CONTRACT-ONLY — Stage-A variant: plan-aware (re)classification.
 *
 * Sibling of `classifier-stage-a.ts`, NOT a new layer. Used ONLY when a
 * `PendingTurn` exists for the current chat: the orchestrator routes the
 * incoming user message through this prompt instead of vanilla
 * `classifyTurn`, so the LLM can decide whether the user is:
 *
 *   - ADD_ARGS:     supplying the missing fields for the existing plan
 *   - EDIT_PLAN:    asking to swap one tool for another (e.g. "не генери
 *                   картинку, скачай файл" → image_generate → web_fetch)
 *   - REPLACE_PLAN: pivoting to a wholly new plan
 *   - ABANDON:      dropping the plan to chat / refuse
 *
 * Why a separate prompt: the vanilla classifier sees user text in
 * isolation and can't tell "Надо скачать, а не генерировать" is a plan
 * correction (kind=EDIT_PLAN) vs a fresh request. This file renders the
 * pending plan into the prompt so the LLM has the necessary context.
 *
 * Frozen-layer note: `contract.ts` is frozen, so `PlanContextRouting` is
 * defined here and stays internal to orchestrator-v1's multi-turn flow.
 *
 * Failure discipline mirrors `classifier-stage-a.ts`: any non-JSON,
 * schema mismatch, exception, or timeout returns `{ kind: "abandon",
 * intent: "refuse" }` so callers always get a well-formed routing.
 */

import { completeSimple, type Api, type Model, type TextContent } from "@mariozechner/pi-ai";
import { z } from "zod";
import { getApiKeyForModel, requireApiKey } from "../agents/model-auth.js";
import { resolveModelAsync } from "../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../agents/simple-completion-transport.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { DEFAULT_STAGE_A_MODEL, type StageAModelRef } from "./classifier-stage-a.js";
import { ToolNameSchema, TOOL_NAMES, type ToolName } from "./contract.js";
import type { PartialAction } from "./turn-state/index.js";

const STAGE_A_PLAN_CTX_TIMEOUT_MS = 15_000;
const STAGE_A_PLAN_CTX_MAX_TOKENS = 250;

/**
 * Sibling 1-line tool descriptions for the plan-context classifier.
 * Kept inline (not imported from classifier-stage-a) to avoid coupling
 * the two prompts: a future tweak in one shouldn't silently change the
 * other.
 */
const TOOL_DESCRIPTIONS_SHORT: Record<(typeof TOOL_NAMES)[number], string> = {
  write: "создать/перезаписать файл",
  edit: "поправить кусок существующего файла",
  read: "прочитать файл",
  image_generate: "сгенерировать картинку из описания",
  pdf: "сверстать PDF-документ",
  web_search: "поиск в интернете по ключевым словам",
  web_fetch: "скачать страницу по конкретному URL",
  sessions_send: "отправить сообщение в указанный чат/сессию",
  persistent_worker_push: "повторяющийся push сообщений по расписанию",
  cron: "одноразовое/повторяющееся отложенное напоминание",
  exec: "выполнить shell-команду",
};

/**
 * Plan-context routing. ABSENT from `contract.ts` on purpose — the
 * frozen layer must not learn about multi-turn variants. Lives here as
 * an internal type co-located with its consumer.
 */
export type PlanContextRouting =
  | { kind: "add_args" }
  | {
      kind: "edit_plan";
      tool_names: ToolName[];
      sequencing: "sequential" | "parallel";
    }
  | {
      kind: "replace_plan";
      tool_names: ToolName[];
      sequencing: "sequential" | "parallel";
    }
  | {
      kind: "abandon";
      intent: "conversation" | "refuse";
      refusal_reason?: string;
    };

const PlanContextRoutingSchema: z.ZodType<PlanContextRouting> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add_args") }),
  z.object({
    kind: z.literal("edit_plan"),
    tool_names: z.array(ToolNameSchema).min(1),
    sequencing: z.enum(["sequential", "parallel"]).default("sequential"),
  }),
  z.object({
    kind: z.literal("replace_plan"),
    tool_names: z.array(ToolNameSchema).min(1),
    sequencing: z.enum(["sequential", "parallel"]).default("sequential"),
  }),
  z.object({
    kind: z.literal("abandon"),
    intent: z.enum(["conversation", "refuse"]),
    refusal_reason: z.string().min(1).optional(),
  }),
]);

/**
 * Build the plan-context system prompt.
 *
 * The pending plan is rendered as a numbered list with each tool's
 * `argsSoFar` (so the LLM sees what's already filled) and
 * `missingFields` (so the LLM can decide ADD_ARGS when the new message
 * supplies them).
 */
export function buildStageAPlanContextPrompt(pendingPlan: ReadonlyArray<PartialAction>): string {
  const toolMenu = TOOL_NAMES.map((tool) => `  - ${tool}: ${TOOL_DESCRIPTIONS_SHORT[tool]}`).join("\n");
  const planLines = pendingPlan
    .map((pa, i) => {
      const argsJson = JSON.stringify(pa.argsSoFar ?? {});
      const missing = pa.missingFields.length > 0 ? pa.missingFields.join(", ") : "(нет)";
      return `  ${i + 1}. ${pa.tool} — argsSoFar=${argsJson}, missingFields=${missing}`;
    })
    .join("\n");

  return `Ты классификатор многократного диалога. У бота уже есть НЕЗАВЕРШЁННЫЙ план из прошлых сообщений (нет некоторых аргументов). Сейчас пользователь прислал НОВОЕ сообщение. Твоя задача — посмотреть на план + новое сообщение и выбрать ОДИН из четырёх вариантов.

Текущий незавершённый план:
${planLines}

Доступные инструменты:
${toolMenu}

Варианты ответа (СТРОГИЙ JSON, БЕЗ markdown / префиксов / объяснений):

1. Пользователь сообщает недостающие аргументы для ТЕКУЩЕГО плана (тот же набор инструментов, тот же порядок). Никаких изменений плана:
{"kind":"add_args"}

2. Пользователь хочет ИЗМЕНИТЬ план (заменить или добавить/убрать инструменты, но задача та же). Верни новый набор tool_names в правильном порядке:
{"kind":"edit_plan","tool_names":["<tool1>","<tool2>"],"sequencing":"sequential"|"parallel"}

3. Пользователь полностью переключился на ДРУГУЮ задачу. Старый план дропни, верни новый:
{"kind":"replace_plan","tool_names":["<tool1>",...],"sequencing":"sequential"|"parallel"}

4. Пользователь не хочет продолжать (бросил тему / поговорить / непонятно):
{"kind":"abandon","intent":"conversation"}                      // болтовня / новый вопрос без действия
{"kind":"abandon","intent":"refuse","refusal_reason":"<кратко>"}  // запрос неоднозначен / нет смысла продолжать

КАК РАЗЛИЧАТЬ:
- Если пользователь говорит "не X, а Y" в контексте инструментов плана (например "не генерируй картинку, скачай файл") — это EDIT_PLAN: поменяй один инструмент на другой, оставь остальные.
- Если пользователь просто даёт значения недостающих полей (путь, текст, URL) — это ADD_ARGS.
- Если пользователь сменил тему или просит совсем другое действие — это REPLACE_PLAN.
- Если "забей", "забудь", "ладно", "ок", "поговорим о другом", вопрос про знания — это ABANDON.

ОТВЕЧАЙ ТОЛЬКО JSON.

Сообщение пользователя:`;
}

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

export type ClassifyTurnWithPendingContextDeps = {
  cfg?: OpenClawConfig;
  model?: StageAModelRef;
  agentDir?: string;
};

export type ClassifyTurnWithPendingContextResult = {
  routing: PlanContextRouting;
  latencyMs: number;
  rawResponse?: string;
  fallbackReason?:
    | "non_json"
    | "wrong_shape"
    | "wrong_enum"
    | "exception"
    | "timeout"
    | "model_unresolved";
};

/**
 * Plan-aware Stage A. Always resolves; on any failure routes to
 * `abandon/refuse` so the orchestrator can clear the stale plan.
 */
export async function classifyTurnWithPendingContext(
  userMessage: string,
  pendingPlan: ReadonlyArray<PartialAction>,
  deps: ClassifyTurnWithPendingContextDeps = {},
): Promise<ClassifyTurnWithPendingContextResult> {
  const startedAt = Date.now();
  const cfg = deps.cfg ?? loadConfig();
  const modelRef = deps.model ?? DEFAULT_STAGE_A_MODEL;
  const resolved = await resolveModelAsync(modelRef.provider, modelRef.modelId, deps.agentDir, cfg);
  if (!resolved.model) {
    logVerbose(
      `[stage-a-planctx] model unresolved: ${modelRef.provider}/${modelRef.modelId} — ${resolved.error ?? "(no error)"}`,
    );
    return {
      routing: {
        kind: "abandon",
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
  const timeout = setTimeout(() => controller.abort(), STAGE_A_PLAN_CTX_TIMEOUT_MS);
  let raw = "";
  let exceptionFallback: ClassifyTurnWithPendingContextResult["fallbackReason"];
  try {
    const result = await completeSimple(
      completionModel as Model<Api>,
      {
        messages: [
          {
            role: "user",
            content: `${buildStageAPlanContextPrompt(pendingPlan)}\n\n${userMessage}`,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        maxTokens: STAGE_A_PLAN_CTX_MAX_TOKENS,
        temperature: 0.1,
        signal: controller.signal,
      },
    );
    raw = result.content.filter(isTextBlock).map((b) => b.text).join("").trim();
  } catch (err) {
    const name = (err as Error).name;
    exceptionFallback = name === "AbortError" ? "timeout" : "exception";
    logVerbose(`[stage-a-planctx] LLM call failed: ${name}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
  const latencyMs = Date.now() - startedAt;

  if (exceptionFallback) {
    return {
      routing: {
        kind: "abandon",
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
        kind: "abandon",
        intent: "refuse",
        refusal_reason: "Не могу разобрать ответ классификатора.",
      },
      latencyMs,
      rawResponse: raw,
      fallbackReason: "non_json",
    };
  }

  const validation = PlanContextRoutingSchema.safeParse(parsedUnknown);
  if (!validation.success) {
    const issues = validation.error.issues;
    const firstPath = issues[0]?.path.join(".") ?? "(unknown)";
    const firstCode = issues[0]?.code ?? "unknown";
    const fallbackReason: ClassifyTurnWithPendingContextResult["fallbackReason"] =
      firstCode === "invalid_value" ? "wrong_enum" : "wrong_shape";
    logVerbose(`[stage-a-planctx] schema validation failed at ${firstPath}: ${firstCode}`);
    return {
      routing: {
        kind: "abandon",
        intent: "refuse",
        refusal_reason: "Не могу разобрать ответ классификатора.",
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
