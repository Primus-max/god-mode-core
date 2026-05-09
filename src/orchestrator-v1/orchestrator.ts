/**
 * V1-CONTRACT-ONLY — Public orchestrator entry.
 *
 * This is the single function the Telegram inbound handler calls. It:
 *
 *   1. Acquires the per-chat lock (so same-chat turns serialize).
 *   2. Runs Stage A → StageARouting (fallback to refuse on any error).
 *   3. If routing.intent === "tool_calls", runs Stage B for each tool
 *      to populate args. Any Stage-B failure on a sequential turn
 *      collapses the whole turn to refuse.
 *   4. Calls the dispatcher with the (now-validated) TurnContract.
 *   5. Returns the rendered reply text — caller sends to Telegram.
 *
 * The function takes `runTool` and `runConversationLLM` callbacks so it
 * stays infrastructure-agnostic. Production wires real tool-registry +
 * runEmbeddedPiAgent({ disableTools: true }). Tests stub them.
 *
 * Conversation system prompt:
 *   The caller's `runConversationLLM` MUST inject a system prompt that
 *   forbids first-person past-tense action claims. We export a helper
 *   `CONVERSATION_SYSTEM_PROMPT_GUARD` for the production wiring.
 */

import type { OpenClawConfig } from "../config/config.js";
import { withChatLock } from "./chat-lock.js";
import { classifyTurn, type ClassifyTurnResult, type StageAModelRef } from "./classifier-stage-a.js";
import { extractToolArgs } from "./classifier-stage-b.js";
import {
  refuseContract,
  toolCallsContract,
  conversationContract,
  type ToolName,
  type TurnAction,
  type TurnContract,
} from "./contract.js";
import {
  dispatchTurn,
  type DispatchResult,
  type RunConversationLLMFn,
  type RunToolFn,
} from "./dispatcher.js";
import { describeToolField } from "./tool-arg-schemas.js";

/**
 * Render a single Stage-B failure into refuse-text.
 *
 * For `missing_field` we substitute the raw field name with a human-
 * readable Russian label (per-tool table in `tool-arg-schemas.ts`),
 * so users see "не хватает: путь к файлу (write)" instead of the
 * internal "write (missing_field: path)". Other Stage-B error kinds
 * (`non_json`, `wrong_shape`, `exception`, `timeout`,
 * `model_unresolved`) are infra failures the user can't action — keep
 * the raw kind+detail so logs/diagnostics still surface.
 */
function renderStageBFailure(failure: {
  tool: ToolName;
  kind: string;
  detail: string;
}): string {
  if (failure.kind === "missing_field") {
    const label = describeToolField(failure.tool, failure.detail);
    return `не хватает: ${label} (${failure.tool})`;
  }
  return `${failure.tool} (${failure.kind}${failure.detail ? `: ${failure.detail}` : ""})`;
}

/** Suggested system-prompt addendum for the conversation LLM. */
export const CONVERSATION_SYSTEM_PROMPT_GUARD = `Ты не можешь использовать инструменты. Это значит, что ты не способен выполнять действия — не записывать файлы, не отправлять сообщения, не создавать воркеров, не запускать команды.

Если пользователь просит действие, которое ты не можешь выполнить, ОТКАЖИСЬ и предложи переформулировать.

КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО заявлять о выполненных тобой действиях. Не говори "я создал", "я записал", "я отправил", "я выполнил", "я добавил", "я сохранил", "я удалил", "я загрузил" и т.п. в прошедшем времени от первого лица. Не имитируй выполнение.

Можешь объяснять, рассуждать, давать советы, отвечать на вопросы по знаниям. Но НЕ ВРАТЬ о действиях.`;

export type RunOrchestratorTurnInputs = {
  /** The user's message text. */
  userMessage: string;
  /** Stable identifier for the chat (Telegram chat id, session id, etc.). */
  chatKey: string;
  /** Per-tool execution (production: wires to existing tool registry). */
  runTool: RunToolFn;
  /** Tool-less LLM call (production: runEmbeddedPiAgent({ disableTools: true })). */
  runConversationLLM: RunConversationLLMFn;
  /** Optional Stage-A/B model override (default: hydra/gpt-5-mini). */
  classifierModel?: StageAModelRef;
  /**
   * OpenClaw config for classifier model resolution. When omitted,
   * classifier falls back to a globally-loaded config which may not
   * have the agent-scoped provider entries (the bug seen in S9 live-
   * verify: `hydra/gpt-5-mini` resolvable in agent context but not in
   * orphan global config). Caller (Telegram dispatch / inbound-reply
   * dispatch) MUST pass the same `cfg` it uses for everything else.
   */
  cfg?: OpenClawConfig;
  /**
   * Agent directory for resolving agent-scoped model providers.
   * Same rationale as `cfg` — the gateway has it; threading it through
   * here keeps the classifier looking at the same provider table the
   * legacy task-classifier uses.
   */
  agentDir?: string;
};

export type RunOrchestratorTurnResult = {
  /** Final reply text to send to the user. */
  reply: string;
  /** The contract that was dispatched (or the refuse contract on failure). */
  contract: TurnContract;
  /** Stage-A telemetry. */
  stageA: ClassifyTurnResult;
  /** The dispatcher's structured outcome. */
  dispatch: DispatchResult;
};

/**
 * Build the final TurnContract from a Stage-A routing by running
 * Stage-B for each tool. On any Stage-B failure for sequential
 * turns, returns a refuse contract. For parallel turns, drops the
 * failing actions and proceeds with the rest (caller will see the
 * loss in the reply summary).
 */
async function buildContractFromRouting(
  routing:
    | { intent: "tool_calls"; tool_names: ToolName[]; sequencing: "sequential" | "parallel" }
    | { intent: "conversation" }
    | { intent: "refuse"; refusal_reason: string },
  userMessage: string,
  classifierModel?: StageAModelRef,
  cfg?: OpenClawConfig,
  agentDir?: string,
): Promise<TurnContract> {
  if (routing.intent === "conversation") {
    return conversationContract();
  }
  if (routing.intent === "refuse") {
    return refuseContract(routing.refusal_reason);
  }
  // tool_calls: run Stage-B per tool
  const actions: TurnAction[] = [];
  const failures: { tool: ToolName; kind: string; detail: string }[] = [];
  for (const tool of routing.tool_names) {
    const r = await extractToolArgs(tool, userMessage, { model: classifierModel, cfg, agentDir });
    if (r.action) {
      actions.push(r.action);
    } else {
      failures.push({
        tool,
        kind: r.error?.kind ?? "unknown",
        detail: r.error?.detail ?? "",
      });
    }
  }
  if (actions.length === 0) {
    const reasonList = failures.map(renderStageBFailure).join("; ");
    return refuseContract(`не удалось извлечь аргументы для инструментов: ${reasonList}`);
  }
  if (routing.sequencing === "sequential" && failures.length > 0) {
    // Sequential semantics — if any link in the chain fails to extract args,
    // refuse the whole turn rather than partial-execute.
    const reasonList = failures.map(renderStageBFailure).join("; ");
    return refuseContract(`не удалось извлечь аргументы для шага: ${reasonList}`);
  }
  return toolCallsContract(actions, routing.sequencing);
}

/**
 * Main entry point — call once per inbound user message.
 *
 * Always resolves; failures are encoded into the reply text via the
 * appropriate refuse / failure template. Caller sends `result.reply`
 * to Telegram.
 */
export async function runOrchestratorTurn(
  inputs: RunOrchestratorTurnInputs,
): Promise<RunOrchestratorTurnResult> {
  return withChatLock(inputs.chatKey, async () => {
    // Stage A
    const stageA = await classifyTurn(inputs.userMessage, {
      model: inputs.classifierModel,
      cfg: inputs.cfg,
      agentDir: inputs.agentDir,
    });
    // Stage B (only matters for tool_calls)
    const contract = await buildContractFromRouting(
      stageA.routing,
      inputs.userMessage,
      inputs.classifierModel,
      inputs.cfg,
      inputs.agentDir,
    );
    // Dispatcher
    const dispatch = await dispatchTurn({
      contract,
      userMessage: inputs.userMessage,
      runTool: inputs.runTool,
      runConversationLLM: inputs.runConversationLLM,
    });
    return {
      reply: dispatch.reply,
      contract,
      stageA,
      dispatch,
    };
  });
}
