import type { DonePredicate, EvidenceFact } from "./affordance.js";

/**
 * Verifies that every expected persistent session record exists in observed state-after.
 *
 * @param ctx - Predicate context containing state snapshots, expected delta, receipts, and trace.
 * @returns Satisfaction result backed only by observed `SessionWorldState`.
 */
export const persistentSessionCreatedPredicate: DonePredicate = (ctx) => {
  const expectedAdded = ctx.expectedDelta.sessions?.followupRegistry?.added ?? [];
  if (expectedAdded.length === 0) {
    return { satisfied: false, missing: ["expected_delta_empty"] };
  }

  const afterIndex = new Map(
    (ctx.stateAfter.sessions?.followupRegistry ?? []).map((record) => [record.sessionId, record]),
  );

  const missing: string[] = [];
  const evidence: EvidenceFact[] = [];
  for (const ref of expectedAdded) {
    const matched = afterIndex.get(ref.sessionId);
    if (!matched) {
      missing.push(`session_record_missing:${ref.sessionId}`);
      continue;
    }
    if (matched.agentId !== ref.agentId) {
      missing.push(`session_record_agent_mismatch:${ref.sessionId}`);
      continue;
    }
    evidence.push({
      kind: "session_record.created",
      value: Object.freeze({
        sessionId: ref.sessionId,
        agentId: ref.agentId,
        observedAt: matched.createdAt,
      }),
    });
  }

  return missing.length === 0
    ? { satisfied: true, evidence: Object.freeze(evidence) }
    : { satisfied: false, missing: Object.freeze(missing) };
};
