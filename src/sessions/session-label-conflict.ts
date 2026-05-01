import type { SessionEntry } from "../config/sessions.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "./session-key-utils.js";

export type LabelConflictResolution =
  | { readonly kind: "none" }
  | { readonly kind: "same_logical_session"; readonly conflictKey: string }
  | { readonly kind: "conflict"; readonly conflictKey: string };

/**
 * Classifies a label-collision in the gateway session store for the
 * `sessions.patch` label-set path. Pure function over the loaded snapshot.
 *
 * Extends the PR-4a `findLivePersistentSessionByLabel` idempotency guard
 * (`subagent-persistent-session-query.ts`, see
 * `commitment_kernel_idempotency_fix.plan.md`) to the patch path, which is
 * reached when the spawn-time fast path does not find a match (e.g. cross-turn
 * origin drift).
 *
 * Same-logical detection is broader here than at spawn-time on purpose:
 * `applySessionsPatchToStore` does not have access to the requester's
 * `DeliveryContext`, so origin matching is unavailable. The criterion is
 * therefore "both keys are subagent keys under the same lowercased agentId" —
 * sufficient for the Telegram regression
 * (`b857...` terminal subagent vs new `c123...` subagent under
 * `agent:dev:subagent:*`) without widening the surface to cross-agent
 * collisions, where the patch must still fail.
 */
export function classifyLabelConflict(params: {
  readonly store: Readonly<Record<string, SessionEntry>>;
  readonly storeKey: string;
  readonly label: string;
}): LabelConflictResolution {
  const trimmedLabel = params.label.trim();
  if (!trimmedLabel) {
    return { kind: "none" };
  }
  const targetIsSubagent = isSubagentSessionKey(params.storeKey);
  const targetAgentId = parseAgentSessionKey(params.storeKey)?.agentId.toLowerCase();

  for (const [key, entry] of Object.entries(params.store)) {
    if (key === params.storeKey || !entry) {
      continue;
    }
    if (entry.label?.trim() !== trimmedLabel) {
      continue;
    }
    if (targetIsSubagent && targetAgentId && isSubagentSessionKey(key)) {
      const conflictAgentId = parseAgentSessionKey(key)?.agentId.toLowerCase();
      if (conflictAgentId && conflictAgentId === targetAgentId) {
        return { kind: "same_logical_session", conflictKey: key };
      }
    }
    return { kind: "conflict", conflictKey: key };
  }
  return { kind: "none" };
}
