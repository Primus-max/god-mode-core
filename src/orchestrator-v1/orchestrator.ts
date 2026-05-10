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
 *   message we route through `classifyTurnWithPendingContext` (a sibling
 *   Stage-A prompt that sees the pending plan + new message together)
 *   and switch on its 4-way verdict:
 *
 *     - add_args     — same plan, user supplied missing fields → re-run
 *                      Stage B per pending tool with `priorByTool` so it
 *                      only fills the still-missing fields.
 *     - edit_plan    — user is morphing the plan (e.g. "не генерируй
 *                      картинку, скачай файл" — image_generate →
 *                      web_fetch). We keep argsSoFar for tools that
 *                      survive the morph, fresh argsSoFar={} for newly
 *                      added tools, and run Stage B over the NEW tool
 *                      list.
 *     - replace_plan — wholly new task → drop pending, run Stage B
 *                      against the new tool list with empty argsSoFar.
 *     - abandon      — drop pending, route to conversation or refuse
 *                      template.
 *
 *   On the FIRST turn (no pending) we use vanilla `classifyTurn`. The
 *   plan-context Stage A is engaged ONLY when `turnState && pending`.
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
import {
  classifyTurnWithPendingContext,
  type PlanContextRouting,
} from "./classifier-stage-a-plan-context.js";
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

/**
 * Synthesize a `ClassifyTurnResult` from the plan-context routing so the
 * `result.stageA` field of `runOrchestratorTurn` stays a single shape
 * regardless of which Stage-A variant ran. We map the 4-way kind back to
 * the 3-way intent purely for telemetry — callers that care about the
 * plan-context decision can read it from telemetry logs (`logVerbose`)
 * or rely on `contract` directly.
 */
function planCtxResultToStageA(
  pcRouting: PlanContextRouting,
  latencyMs: number,
  rawResponse: string | undefined,
  fallbackReason: ClassifyTurnResult["fallbackReason"],
  resolvedToolNames: ToolName[] | undefined,
): ClassifyTurnResult {
  if (pcRouting.kind === "abandon") {
    if (pcRouting.intent === "conversation") {
      return {
        routing: { intent: "conversation" },
        latencyMs,
        rawResponse,
        fallbackReason,
      };
    }
    return {
      routing: {
        intent: "refuse",
        refusal_reason: pcRouting.refusal_reason ?? "Запрос неоднозначен.",
      },
      latencyMs,
      rawResponse,
      fallbackReason,
    };
  }
  // add_args / edit_plan / replace_plan all dispatch tool_calls; pick
  // whichever tool_names + sequencing actually got used downstream.
  const tool_names =
    resolvedToolNames ??
    (pcRouting.kind === "add_args" ? [] : pcRouting.tool_names);
  const sequencing =
    pcRouting.kind === "add_args" ? "sequential" : pcRouting.sequencing;
  return {
    routing: {
      intent: "tool_calls",
      tool_names,
      sequencing,
    },
    latencyMs,
    rawResponse,
    fallbackReason,
  };
}

/**
 * Run Stage B over a tool list, then build the contract + perform the
 * pending-state side effects. Shared by both the no-pending path and the
 * pending-context dispatch paths (add_args / edit_plan / replace_plan).
 *
 * `priorByTool` carries argsSoFar from the previous pending entry per
 * tool — empty map when starting fresh.
 */
async function runStageBAndBuildContract(
  tool_names: ToolName[],
  sequencing: "sequential" | "parallel",
  priorByTool: Record<string, PartialAction | undefined>,
  ctx: ExtractionContext,
  multiTurnEnabled: boolean,
): Promise<ContractBuildResult> {
  const extractions = await runStageBPerTool(tool_names, ctx, priorByTool);
  return buildContractFromExtractions(
    { intent: "tool_calls", tool_names, sequencing },
    extractions,
    multiTurnEnabled,
  );
}

/**
 * Persist (or clear) pending state after a Stage-B build. Identical
 * policy to the original implementation: `refuse_missing` stashes,
 * everything else clears. Caller is responsible for whether to call this
 * at all (e.g. `abandon` paths clear directly, no Stage B).
 */
async function applyPendingSideEffect(
  built: ContractBuildResult,
  turnState: TurnStateStore,
  chatKey: string,
  hadExistingPending: boolean,
  ttlMs: number,
): Promise<void> {
  if (built.kind === "refuse_missing") {
    const now = Date.now();
    const fresh: PendingTurn = {
      tool_calls: built.pending,
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    await turnState.put(chatKey, fresh);
    return;
  }
  // ok / refuse_other → clear prior pending so we don't resume a stale plan.
  if (hadExistingPending) await turnState.clear(chatKey);
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

    const ctx: ExtractionContext = {
      userMessage: inputs.userMessage,
      classifierModel: inputs.classifierModel,
      cfg: inputs.cfg,
      agentDir: inputs.agentDir,
    };

    let contract: TurnContract;
    let stageA: ClassifyTurnResult;

    if (turnState && existingPending) {
      // Plan-context Stage A: 4-way decision over the pending plan.
      const pc = await classifyTurnWithPendingContext(
        inputs.userMessage,
        existingPending.tool_calls,
        {
          model: inputs.classifierModel,
          cfg: inputs.cfg,
          agentDir: inputs.agentDir,
        },
      );
      const pcRouting = pc.routing;

      if (pcRouting.kind === "abandon") {
        // Drop pending unconditionally; route to conversation or refuse.
        await turnState.clear(inputs.chatKey);
        if (pcRouting.intent === "conversation") {
          contract = conversationContract();
        } else {
          contract = refuseContract(
            pcRouting.refusal_reason ?? "Запрос неоднозначен.",
          );
        }
        stageA = planCtxResultToStageA(
          pcRouting,
          pc.latencyMs,
          pc.rawResponse,
          pc.fallbackReason,
          undefined,
        );
      } else if (pcRouting.kind === "add_args") {
        // Same ordered tool list as pending; carry argsSoFar verbatim.
        const tool_names = existingPending.tool_calls.map((pa) => pa.tool);
        const sequencing: "sequential" | "parallel" = "sequential";
        const priorByTool: Record<string, PartialAction | undefined> = {};
        for (const pa of existingPending.tool_calls) priorByTool[pa.tool] = pa;
        const built = await runStageBAndBuildContract(
          tool_names,
          sequencing,
          priorByTool,
          ctx,
          true,
        );
        await applyPendingSideEffect(built, turnState, inputs.chatKey, true, ttlMs);
        contract = built.contract;
        stageA = planCtxResultToStageA(
          pcRouting,
          pc.latencyMs,
          pc.rawResponse,
          pc.fallbackReason,
          tool_names,
        );
      } else if (pcRouting.kind === "edit_plan") {
        // Morph the plan: tools that survive keep their argsSoFar; new
        // tools start fresh. Stage B re-runs over the NEW ordered list.
        const tool_names = pcRouting.tool_names;
        const priorByTool: Record<string, PartialAction | undefined> = {};
        for (const pa of existingPending.tool_calls) priorByTool[pa.tool] = pa;
        // priorByTool naturally yields `undefined` for tools added by the
        // edit (not present in the prior plan) — equivalent to fresh.
        const built = await runStageBAndBuildContract(
          tool_names,
          pcRouting.sequencing,
          priorByTool,
          ctx,
          true,
        );
        await applyPendingSideEffect(built, turnState, inputs.chatKey, true, ttlMs);
        contract = built.contract;
        stageA = planCtxResultToStageA(
          pcRouting,
          pc.latencyMs,
          pc.rawResponse,
          pc.fallbackReason,
          tool_names,
        );
      } else {
        // replace_plan: drop pending args entirely and run fresh Stage B
        // over the new tool list with empty argsSoFar.
        await turnState.clear(inputs.chatKey);
        const tool_names = pcRouting.tool_names;
        const built = await runStageBAndBuildContract(
          tool_names,
          pcRouting.sequencing,
          {},
          ctx,
          true,
        );
        // Note: hadExistingPending=false here because we just cleared it
        // above; applyPendingSideEffect will only re-stash on refuse_missing.
        await applyPendingSideEffect(built, turnState, inputs.chatKey, false, ttlMs);
        contract = built.contract;
        stageA = planCtxResultToStageA(
          pcRouting,
          pc.latencyMs,
          pc.rawResponse,
          pc.fallbackReason,
          tool_names,
        );
      }
    } else {
      // No pending plan — vanilla Stage A.
      stageA = await classifyTurn(inputs.userMessage, {
        model: inputs.classifierModel,
        cfg: inputs.cfg,
        agentDir: inputs.agentDir,
      });

      if (stageA.routing.intent === "conversation") {
        contract = conversationContract();
      } else if (stageA.routing.intent === "refuse") {
        contract = refuseContract(stageA.routing.refusal_reason);
      } else {
        const routing = stageA.routing;
        const built = await runStageBAndBuildContract(
          routing.tool_names,
          routing.sequencing,
          {},
          ctx,
          !!turnState,
        );
        if (turnState) {
          await applyPendingSideEffect(built, turnState, inputs.chatKey, false, ttlMs);
        }
        contract = built.contract;
      }
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
