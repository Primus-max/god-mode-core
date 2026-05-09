/**
 * V1-CONTRACT-ONLY — Deterministic dispatcher.
 *
 * The single function `dispatchTurn` consumes a TurnContract and produces
 * a `DispatchResult` carrying the reply text + per-action outcomes.
 *
 * Critical invariants (per V1-CONTRACT-ONLY plan revision 2):
 *
 *   - Reply text is rendered ONLY from the fixed template catalog
 *     (`reply-templates.ts`) substituting REAL tool output. The LLM
 *     never emits the reply text on the tool_calls path.
 *
 *   - Conversation path delegates to a tool-less LLM call (caller's
 *     `runConversationLLM` callback) so the LLM physically cannot make
 *     side-effects to lie about. Caller passes the transport because
 *     the orchestrator stays infrastructure-agnostic.
 *
 *   - Refuse path renders a static template — zero LLM creativity.
 *
 *   - Multi-action sequencing: "sequential" halts at first failure;
 *     "parallel" runs all and reports per-action outcomes.
 *
 * Tool execution is ALSO injected by the caller (`runTool` callback) so
 * this module has zero direct dependencies on the production tool
 * registry. Unit tests stub the callback; production wires real tools.
 */

import type { ToolName, TurnAction, TurnContract } from "./contract.js";
import {
  lookupTemplate,
  multiTemplate,
  refuseTemplate,
  renderTemplate,
} from "./reply-templates.js";

export type ToolRunResult =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; error: string };

export type RunToolFn = (action: TurnAction) => Promise<ToolRunResult>;
export type RunConversationLLMFn = (userMessage: string) => Promise<string>;

export type DispatchInputs = {
  contract: TurnContract;
  userMessage: string;
  runTool: RunToolFn;
  runConversationLLM: RunConversationLLMFn;
};

export type DispatchActionOutcome = {
  tool: ToolName;
  ok: boolean;
  reply: string;
  error?: string;
};

export type DispatchResult = {
  /** Final reply text to send to the user. */
  reply: string;
  /** Set when the dispatched intent was tool_calls. */
  actions?: DispatchActionOutcome[];
  /** True when ALL dispatched actions succeeded (or single-action OK). */
  allOk: boolean;
};

/**
 * Extract `{var}` placeholder names from a template (without modifying it).
 * Used to verify all placeholders have values BEFORE substitution, so we
 * don't conflate "missing template variable" with "tool output containing
 * `{x}` literally" (red-team injection defence #4).
 */
function extractPlaceholders(template: string): string[] {
  const names: string[] = [];
  const regex = /\{(\w+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    names.push(match[1]!);
  }
  return names;
}

function allPlaceholdersPresent(template: string, values: Record<string, unknown>): boolean {
  const names = extractPlaceholders(template);
  for (const n of names) {
    const v = values[n];
    if (v === null || v === undefined) return false;
  }
  return true;
}

/** Build the per-action reply by rendering its (tool, outcome) template. */
function renderActionReply(
  action: TurnAction,
  result: ToolRunResult,
): { reply: string; ok: boolean } {
  if (result.ok) {
    const template = lookupTemplate(action.tool, "success");
    const values = mergeArgsAndOutput(action.args, result.output);
    if (allPlaceholdersPresent(template, values)) {
      return { reply: renderTemplate(template, values), ok: true };
    }
    // Fallback: degraded but truthful — show raw output JSON tail.
    const summary = jsonTrunc(result.output, 600);
    return { reply: `Готово (${action.tool}): ${summary}`, ok: true };
  }
  const template = lookupTemplate(action.tool, "failure");
  const values: Record<string, unknown> = { ...action.args, error: result.error };
  if (allPlaceholdersPresent(template, values)) {
    return { reply: renderTemplate(template, values), ok: false };
  }
  return { reply: `Не получилось (${action.tool}): ${result.error}`, ok: false };
}

function mergeArgsAndOutput(
  args: Record<string, unknown>,
  output: Record<string, unknown>,
): Record<string, unknown> {
  // Tool output wins on conflict — output is the SOURCE OF TRUTH for
  // what actually happened. Args are the user-asked-for shape.
  return { ...args, ...output };
}

function jsonTrunc(obj: unknown, max: number): string {
  let s: string;
  try {
    s = JSON.stringify(obj);
  } catch {
    s = String(obj);
  }
  if (s.length > max) s = s.slice(0, max) + "…";
  return s;
}

async function dispatchToolCalls(
  contract: Extract<TurnContract, { intent: "tool_calls" }>,
  runTool: RunToolFn,
): Promise<DispatchResult> {
  const outcomes: DispatchActionOutcome[] = [];
  const planned = contract.tool_calls.length;
  if (contract.sequencing === "parallel") {
    const settled = await Promise.all(
      contract.tool_calls.map(async (action) => {
        try {
          const r = await runTool(action);
          const rendered = renderActionReply(action, r);
          return { action, result: r, rendered };
        } catch (err) {
          const r: ToolRunResult = { ok: false, error: (err as Error).message };
          const rendered = renderActionReply(action, r);
          return { action, result: r, rendered };
        }
      }),
    );
    for (const s of settled) {
      outcomes.push({
        tool: s.action.tool,
        ok: s.rendered.ok,
        reply: s.rendered.reply,
        error: s.result.ok ? undefined : s.result.error,
      });
    }
  } else {
    // sequential — halt at first failure
    for (const action of contract.tool_calls) {
      let result: ToolRunResult;
      try {
        result = await runTool(action);
      } catch (err) {
        result = { ok: false, error: (err as Error).message };
      }
      const rendered = renderActionReply(action, result);
      outcomes.push({
        tool: action.tool,
        ok: rendered.ok,
        reply: rendered.reply,
        error: result.ok ? undefined : result.error,
      });
      if (!rendered.ok) break;
    }
  }
  return assembleMultiReply(outcomes, planned);
}

function assembleMultiReply(
  outcomes: DispatchActionOutcome[],
  plannedCount: number,
): DispatchResult {
  const allOk = outcomes.every((o) => o.ok);
  // Single planned action AND single outcome → use the single-action reply directly.
  if (plannedCount === 1 && outcomes.length === 1) {
    return { reply: outcomes[0]!.reply, actions: outcomes, allOk };
  }
  // Multi planned (whether all ran or halted partway) → wrap with multi template.
  const summary = outcomes.map((o, i) => `${i + 1}. ${o.reply}`).join("\n");
  const halted = outcomes.length < plannedCount;
  const template = multiTemplate(allOk && !halted);
  return {
    reply: renderTemplate(template, { summary }),
    actions: outcomes,
    allOk: allOk && !halted,
  };
}

async function dispatchConversation(
  userMessage: string,
  runConversationLLM: RunConversationLLMFn,
): Promise<DispatchResult> {
  // The conversation LLM is called with disableTools:true (caller's
  // responsibility). It can ONLY produce text. The system prompt
  // (also caller's responsibility) forbids first-person past-tense
  // action claims.
  let reply: string;
  try {
    reply = await runConversationLLM(userMessage);
  } catch (err) {
    reply = `Сервис временно недоступен: ${(err as Error).message}`;
  }
  return { reply, allOk: true };
}

function dispatchRefuse(
  contract: Extract<TurnContract, { intent: "refuse" }>,
): DispatchResult {
  const template = refuseTemplate();
  const reply = renderTemplate(template, { refusal_reason: contract.refusal_reason });
  return { reply, allOk: false };
}

/**
 * Main entry. Always resolves; failures are encoded into reply text
 * via the appropriate template.
 */
export async function dispatchTurn(inputs: DispatchInputs): Promise<DispatchResult> {
  const { contract } = inputs;
  switch (contract.intent) {
    case "tool_calls":
      return dispatchToolCalls(contract, inputs.runTool);
    case "conversation":
      return dispatchConversation(inputs.userMessage, inputs.runConversationLLM);
    case "refuse":
      return dispatchRefuse(contract);
  }
}
