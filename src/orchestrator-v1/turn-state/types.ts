/**
 * V1-CONTRACT-ONLY — Turn-state service types.
 *
 * The orchestrator-v1 hot path is "1 inbound message = 1 decision". This
 * module adds OPT-IN multi-turn state so a Stage-B `missing_field` failure
 * can become a "uточни в следующем сообщении" prompt, with the partial
 * plan stashed for the next turn.
 *
 * Design constraints (operator-set):
 *   - Service approach (interface + impl) — drop-in for LangGraph or a
 *     persisted KV later without touching the orchestrator.
 *   - No regex / pattern parsing of user text. State decisions are made
 *     by Stage A/B LLM calls, not text rules.
 *   - In-memory impl is process-scoped and OK for v1; per-chat lock
 *     already serializes turns for the same `chatKey`.
 */

import type { ToolName } from "../contract.js";

/**
 * One pending action — same shape Stage B would emit if it succeeded,
 * but with `argsSoFar` partial and `missingFields` listing what still
 * needs to come from the user.
 */
export type PartialAction = {
  tool: ToolName;
  /** Args extracted across all prior turns; new turn merges into this. */
  argsSoFar: Record<string, unknown>;
  /** Field names Stage B last reported as missing for this tool. */
  missingFields: string[];
};

/**
 * The pending plan stashed for one chat between turns.
 *
 * `tool_calls` order matches the original Stage-A `tool_names` order so
 * sequencing is preserved when we resume.
 */
export type PendingTurn = {
  tool_calls: PartialAction[];
  createdAt: number;
  expiresAt: number;
};

/**
 * Storage interface for pending turns. All methods return Promises so an
 * eventual SQLite / Redis impl drops in without touching callers.
 *
 * Implementations MUST treat reads of expired entries as absent (callers
 * should not have to filter on `Date.now()` themselves).
 */
export type TurnStateStore = {
  get(chatKey: string): Promise<PendingTurn | undefined>;
  put(chatKey: string, state: PendingTurn): Promise<void>;
  clear(chatKey: string): Promise<void>;
};
