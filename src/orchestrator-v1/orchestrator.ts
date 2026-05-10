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
 * Multi-turn state (opt-in via `inputs.turnState`):
 *   When Stage B reports `missing_field` for any tool, the orchestrator
 *   stashes a `PendingTurn` keyed by chatKey and surfaces a refuse with
 *   "Допиши в следующем сообщении что именно". On the next inbound
 *   message Stage A runs first; if it picks the SAME ordered set of
 *   tool_names the orchestrator passes the prior `argsSoFar` to Stage B
 *   so it only has to extract the still-missing fields. Any other
 *   Stage-A outcome (conversation, refuse, different tool_names) clears
 *   the pending state — we treat that as the user pivoting. When all
 *   args fill, dispatch runs and pending is cleared. State is
 *   process-scoped + TTL'd; see `turn-state/`.
 *
 *   Backwards compat: when `turnState` is omitted, behaviour is byte-
 *   identical to single-turn.
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
import { extractToolArgs, type ExtractToolArgsResult } from "./classifier-stage-b.js";
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
import {
  DEFAULT_TURN_STATE_TTL_MS,
  type PartialAction,
  type PendingTurn,
  type TurnStateStore,
} from "./turn-state/index.js";

type StageBFailure = {
  tool: ToolName;
  kind: string;
  detail: string;
};

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
function renderStageBFailure(failure: StageBFailure): string {
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
  /**
   * Multi-turn state store. When omitted, the orchestrator behaves
   * exactly as single-turn (Stage-B failure → refuse, no resume). When
   * provided, partial plans are stashed across turns; see file header.
   */
  turnState?: TurnStateStore;
  /** Override TTL for newly-stashed pending turns (default 10 min). */
  turnStateTtlMs?: number;
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

type ExtractionContext = {
  userMessage: string;
  classifierModel?: StageAModelRef;
  cfg?: OpenClawConfig;
  agentDir?: string;
};

type PerToolExtraction = {
  tool: ToolName;
  result: ExtractToolArgsResult;
  argsSoFar: Record<string, unknown>;
};

/**
 * Run Stage B for every tool in `tool_names` in order. When
 * `priorByTool` is non-empty for a tool, its `argsSoFar` is passed in
 * so Stage B only re-asks for still-missing fields.
 */
async function runStageBPerTool(
  tool_names: ToolName[],
  ctx: ExtractionContext,
  priorByTool: Record<string, PartialAction | undefined>,
): Promise<PerToolExtraction[]> {
  const out: PerToolExtraction[] = [];
  for (const tool of tool_names) {
    const prior = priorByTool[tool];
    const argsSoFar = prior?.argsSoFar ?? {};
    const result = await extractToolArgs(tool, ctx.userMessage, {
      model: ctx.classifierModel,
      cfg: ctx.cfg,
      agentDir: ctx.agentDir,
      argsSoFar,
    });
    out.push({ tool, result, argsSoFar });
  }
  return out;
}

/**
 * Build the final TurnContract from a Stage-A tool_calls routing.
 *
 * Returns a discriminated tuple so the caller can persist `pending` (if
 * any tool's Stage B reported missing_field) without parsing reply text.
 */
type ContractBuildResult =
  | { kind: "ok"; contract: TurnContract }
  | {
      kind: "refuse_missing";
      contract: TurnContract;
      pending: PartialAction[];
      failures: StageBFailure[];
    }
  | {
      kind: "refuse_other";
      contract: TurnContract;
      failures: StageBFailure[];
    };

function buildContractFromExtractions(
  routing: { intent: "tool_calls"; tool_names: ToolName[]; sequencing: "sequential" | "parallel" },
  extractions: PerToolExtraction[],
  multiTurnEnabled: boolean,
): ContractBuildResult {
  const actions: TurnAction[] = [];
  const failures: StageBFailure[] = [];
  const pending: PartialAction[] = [];
  for (const ex of extractions) {
    if (ex.result.action) {
      actions.push(ex.result.action);
      continue;
    }
    const failure: StageBFailure = {
      tool: ex.tool,
      kind: ex.result.error?.kind ?? "unknown",
      detail: ex.result.error?.detail ?? "",
    };
    failures.push(failure);
    if (failure.kind === "missing_field") {
      // For multi-turn we record argsSoFar (what we already have) plus
      // the field that's still missing. Other Stage-B error kinds are
      // infra failures, not user-actionable, so we don't stash those.
      pending.push({
        tool: ex.tool,
        argsSoFar: ex.argsSoFar,
        missingFields: failure.detail ? [failure.detail] : [],
      });
    }
  }

  if (failures.length === 0) {
    return { kind: "ok", contract: toolCallsContract(actions, routing.sequencing) };
  }

  // Sequential: any failure collapses to refuse. Parallel: only refuse
  // if ALL failed (preserve the pre-existing partial-progress contract
  // from buildContractFromRouting).
  const wholeRefuse =
    routing.sequencing === "sequential" || actions.length === 0;

  if (!wholeRefuse) {
    return { kind: "ok", contract: toolCallsContract(actions, routing.sequencing) };
  }

  // Multi-turn: if every failure is missing_field, present the "уточни"
  // refuse and let the caller stash pending. Mixed bag (some
  // missing_field, some infra) — fall through to plain refuse and DO
  // NOT stash, because the user can't fix a non_json/timeout by typing
  // more text.
  const allMissing =
    multiTurnEnabled && failures.length > 0 && failures.every((f) => f.kind === "missing_field");
  if (allMissing) {
    const reasonList = failures.map(renderStageBFailure).join("; ");
    return {
      kind: "refuse_missing",
      contract: refuseContract(`${reasonList}. Допиши в следующем сообщении что именно.`),
      pending,
      failures,
    };
  }

  const reasonList = failures.map(renderStageBFailure).join("; ");
  // Preserve historical phrasing (existing tests assert on it).
  const prefix =
    actions.length === 0
      ? "не удалось извлечь аргументы для инструментов:"
      : "не удалось извлечь аргументы для шага:";
  return {
    kind: "refuse_other",
    contract: refuseContract(`${prefix} ${reasonList}`),
    failures,
  };
}

/** Same set of tools, in the same order, between pending and new routing. */
function pendingMatchesRouting(
  pending: PendingTurn,
  tool_names: ToolName[],
): boolean {
  if (pending.tool_calls.length !== tool_names.length) return false;
  for (let i = 0; i < tool_names.length; i++) {
    if (pending.tool_calls[i]?.tool !== tool_names[i]) return false;
  }
  return true;
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
    const turnState = inputs.turnState;
    const ttlMs = inputs.turnStateTtlMs ?? DEFAULT_TURN_STATE_TTL_MS;

    // Look up any pending plan for this chat. Stale entries are filtered
    // by the store (TTL-aware get).
    const existingPending = turnState ? await turnState.get(inputs.chatKey) : undefined;

    // Stage A
    const stageA = await classifyTurn(inputs.userMessage, {
      model: inputs.classifierModel,
      cfg: inputs.cfg,
      agentDir: inputs.agentDir,
    });

    const ctx: ExtractionContext = {
      userMessage: inputs.userMessage,
      classifierModel: inputs.classifierModel,
      cfg: inputs.cfg,
      agentDir: inputs.agentDir,
    };

    let contract: TurnContract;

    if (stageA.routing.intent === "conversation") {
      // User changed topic / chitchat — drop any pending plan.
      if (turnState && existingPending) await turnState.clear(inputs.chatKey);
      contract = conversationContract();
    } else if (stageA.routing.intent === "refuse") {
      if (turnState && existingPending) await turnState.clear(inputs.chatKey);
      contract = refuseContract(stageA.routing.refusal_reason);
    } else {
      // tool_calls path
      const routing = stageA.routing;

      // Decide whether to resume the pending plan or start fresh:
      //   resume only when Stage A picked the SAME ordered set of tools.
      //   Any mismatch (extra/missing/reorder) is treated as a pivot.
      const resume = !!existingPending && pendingMatchesRouting(existingPending, routing.tool_names);

      const priorByTool: Record<string, PartialAction | undefined> = {};
      if (resume && existingPending) {
        for (const pa of existingPending.tool_calls) {
          priorByTool[pa.tool] = pa;
        }
      }

      const extractions = await runStageBPerTool(routing.tool_names, ctx, priorByTool);
      const built = buildContractFromExtractions(routing, extractions, !!turnState);

      if (turnState) {
        if (built.kind === "refuse_missing") {
          const now = Date.now();
          const fresh: PendingTurn = {
            tool_calls: built.pending,
            createdAt: now,
            expiresAt: now + ttlMs,
          };
          await turnState.put(inputs.chatKey, fresh);
        } else {
          // Successful dispatch (`ok`) or non-recoverable refuse
          // (`refuse_other`) — clear any prior pending so we don't
          // resume the wrong plan next turn.
          if (existingPending) await turnState.clear(inputs.chatKey);
        }
      }

      contract = built.contract;
    }

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
