/**
 * V1-CONTRACT-ONLY — Diagnostic / dry-run entry.
 *
 * For live operator testing in Telegram (or any channel) WITHOUT
 * actually executing tools. Classifies the user's message via the
 * full Stage A + Stage B pipeline and returns a human-readable text
 * showing what the orchestrator decided. Tool execution is replaced
 * with a textual readout — bot cannot make false action claims because
 * it doesn't claim any actions; it shows the contract instead.
 *
 * For conversation intent: makes a real cheap-LLM call (gpt-5-mini) with
 * `CONVERSATION_SYSTEM_PROMPT_GUARD` so the operator can also test the
 * tool-less chat path's behaviour.
 *
 * Use case: env-gated short-circuit in extensions/* inbound handlers
 * (e.g. OPENCLAW_USE_V1_ORCHESTRATOR=1). Native flow stays unchanged
 * when the env var is unset.
 */

import { completeSimple, type Api, type Model, type TextContent } from "@mariozechner/pi-ai";
import { getApiKeyForModel, requireApiKey } from "../agents/model-auth.js";
import { resolveModelAsync } from "../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../agents/simple-completion-transport.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { classifyTurn, DEFAULT_STAGE_A_MODEL, type StageAModelRef } from "./classifier-stage-a.js";
import { extractToolArgs } from "./classifier-stage-b.js";
import { CONVERSATION_SYSTEM_PROMPT_GUARD } from "./orchestrator.js";

function isTextBlock(b: { type: string }): b is TextContent {
  return b.type === "text";
}

const CONVERSATION_TIMEOUT_MS = 30_000;
const CONVERSATION_MAX_TOKENS = 2000;

export type DiagnoseTurnDeps = {
  cfg?: OpenClawConfig;
  classifierModel?: StageAModelRef;
  conversationModel?: StageAModelRef;
  agentDir?: string;
};

export type DiagnoseTurnResult = {
  reply: string;
  routing: Awaited<ReturnType<typeof classifyTurn>>["routing"];
  contract:
    | { intent: "tool_calls"; actions: Array<{ tool: string; args?: Record<string, unknown>; error?: string }>; sequencing: "sequential" | "parallel" }
    | { intent: "conversation" }
    | { intent: "refuse"; reason: string };
  latencyMs: number;
};

async function callConversationLLM(
  userMessage: string,
  modelRef: StageAModelRef,
  deps: DiagnoseTurnDeps,
): Promise<string> {
  const cfg = deps.cfg ?? loadConfig();
  const resolved = await resolveModelAsync(modelRef.provider, modelRef.modelId, deps.agentDir, cfg);
  if (!resolved.model) {
    return `(сервис временно недоступен: ${resolved.error ?? "модель не загружена"})`;
  }
  const completionModel = prepareModelForSimpleCompletion({ model: resolved.model, cfg });
  const apiKey = requireApiKey(
    await getApiKeyForModel({ model: completionModel, cfg, agentDir: deps.agentDir }),
    modelRef.provider,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONVERSATION_TIMEOUT_MS);
  try {
    const result = await completeSimple(
      completionModel as Model<Api>,
      {
        messages: [
          {
            role: "user",
            content: `${CONVERSATION_SYSTEM_PROMPT_GUARD}\n\n${userMessage}`,
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey, maxTokens: CONVERSATION_MAX_TOKENS, temperature: 0.4, signal: controller.signal },
    );
    return result.content.filter(isTextBlock).map((b) => b.text).join("").trim();
  } catch (err) {
    return `(сбой conversation LLM: ${(err as Error).message})`;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Run the full orchestrator-v1 pipeline in DIAGNOSTIC mode (no tool
 * execution). Returns a reply text suitable for sending back to the
 * user via any channel.
 */
export async function diagnoseTurn(
  userMessage: string,
  deps: DiagnoseTurnDeps = {},
): Promise<DiagnoseTurnResult> {
  const startedAt = Date.now();
  const classifierModel = deps.classifierModel ?? DEFAULT_STAGE_A_MODEL;
  process.stderr.write(`[orch-v1-debug] diagnose start, classifierModel=${classifierModel.provider}/${classifierModel.modelId}\n`);
  const stageA = await classifyTurn(userMessage, {
    model: classifierModel,
    cfg: deps.cfg,
    agentDir: deps.agentDir,
  });
  process.stderr.write(`[orch-v1-debug] stageA done intent=${stageA.routing.intent} fallback=${stageA.fallbackReason ?? "(none)"} latency=${stageA.latencyMs}ms\n`);

  if (stageA.routing.intent === "refuse") {
    return {
      reply: `🚫 Не могу: ${stageA.routing.refusal_reason}\n\n_(orchestrator-v1 diagnostic — Stage A: refuse)_`,
      routing: stageA.routing,
      contract: { intent: "refuse", reason: stageA.routing.refusal_reason },
      latencyMs: Date.now() - startedAt,
    };
  }

  if (stageA.routing.intent === "conversation") {
    const conversationModel = deps.conversationModel ?? DEFAULT_STAGE_A_MODEL;
    const llmReply = await callConversationLLM(userMessage, conversationModel, deps);
    let reply = `${llmReply}\n\n_(orchestrator-v1 diagnostic — Stage A: conversation, no tools)_`;
    const TELEGRAM_MAX_CHARS = 3800;
    if (reply.length > TELEGRAM_MAX_CHARS) {
      reply = `${reply.slice(0, TELEGRAM_MAX_CHARS)}\n\n…(обрезано)`;
    }
    return {
      reply,
      routing: stageA.routing,
      contract: { intent: "conversation" },
      latencyMs: Date.now() - startedAt,
    };
  }

  // tool_calls — run Stage B per tool but don't execute
  const actions: Array<{ tool: string; args?: Record<string, unknown>; error?: string }> = [];
  for (const tool of stageA.routing.tool_names) {
    const r = await extractToolArgs(tool, userMessage, {
      model: classifierModel,
      cfg: deps.cfg,
      agentDir: deps.agentDir,
    });
    if (r.action) {
      actions.push({ tool: r.action.tool, args: r.action.args });
    } else {
      actions.push({
        tool,
        error: `${r.error?.kind ?? "unknown"}${r.error?.detail ? `: ${r.error.detail}` : ""}`,
      });
    }
  }

  const lines: string[] = [];
  lines.push(`🔧 Контракт (sequencing: ${stageA.routing.sequencing}):`);
  lines.push("");
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    lines.push(`${i + 1}. **${a.tool}**`);
    if (a.error) {
      lines.push(`   ⚠️ извлечение аргументов: ${a.error}`);
    } else if (a.args) {
      lines.push("```json");
      lines.push(JSON.stringify(a.args, null, 2));
      lines.push("```");
    }
    if (i < actions.length - 1) lines.push("");
  }
  lines.push("");
  lines.push("_(orchestrator-v1 diagnostic — DRY-RUN; инструменты не вызывались)_");

  let reply = lines.join("\n");
  // Telegram caps messages at 4096 chars. Truncate diagnostic output
  // safely so the short-circuit doesn't fail with "message is too long".
  const TELEGRAM_MAX_CHARS = 3800;
  if (reply.length > TELEGRAM_MAX_CHARS) {
    reply = `${reply.slice(0, TELEGRAM_MAX_CHARS)}\n\n…(обрезано: вывод длиннее ${TELEGRAM_MAX_CHARS} символов)`;
  }
  return {
    reply,
    routing: stageA.routing,
    contract: {
      intent: "tool_calls",
      actions,
      sequencing: stageA.routing.sequencing,
    },
    latencyMs: Date.now() - startedAt,
  };
}
