import type { AgentId, SessionId } from "./ids.js";
import type { DeliveryReceiptKind } from "./world-state.js";

export type SessionRecordRef = {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
};

export type SessionExpectedDelta = {
  readonly followupRegistry?: {
    readonly added?: readonly SessionRecordRef[];
    readonly removed?: readonly { readonly sessionId: SessionId }[];
  };
};

export type DeliveryReceiptRef = {
  readonly deliveryContextKey: string;
  readonly kind: DeliveryReceiptKind;
};

export type DeliveryExpectedDelta = {
  readonly receipts?: {
    readonly added?: readonly DeliveryReceiptRef[];
  };
};

/**
 * Cutover-3 Phase 5 — additive widening of the artifacts slice. Phase 4
 * shipped done-predicates that read `delta.artifacts.added` via a
 * forward-compat structural cast; Phase 5 lights this up by extending
 * the type itself. `added` is the closed list of `artifactId` values
 * the runtime adapter (`artifact-runtime-adapter.ts`) emitted during
 * the turn — the predicates JOIN against
 * `WorldStateSnapshot.artifacts.records[*].artifactId`.
 *
 * Pure additive extension (cutover-2 PR-#104 / slice E P6 precedent):
 * existing `ArtifactExpectedDelta` consumers expected `Record<string,
 * never>`; the new shape is structurally assignable from the empty
 * object, so callers that did not populate `added` continue to compile
 * and behave byte-identical.
 */
export type ArtifactExpectedDelta = {
  readonly added?: readonly string[];
};
export type WorkspaceExpectedDelta = Record<string, never>;

export type ExpectedDelta = {
  readonly sessions?: SessionExpectedDelta;
  readonly artifacts?: ArtifactExpectedDelta;
  readonly workspace?: WorkspaceExpectedDelta;
  readonly deliveries?: DeliveryExpectedDelta;
};
