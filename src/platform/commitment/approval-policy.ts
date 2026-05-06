import { defaultRuntime } from "../../runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { IdentityId } from "../identity/identity-id.js";
import type { MemoryStore } from "../memory/memory-store.js";

import type { EffectId } from "./ids.js";
import {
  APPROVAL_POLICY_REASONS,
  type ApprovalPolicyDecision,
  type ApprovalPolicyEvaluateInput,
  type ApprovalPolicyReader,
  type ApprovalPolicyReason,
  type ApprovalRequestId,
} from "./policy-gate-stages.js";

/**
 * Phase 3 — Stage 2 (Approvals) implementation of the
 * `ApprovalPolicyReader` interface scaffolded in Phase 2
 * (`policy-gate-stages.ts`).
 *
 * Architectural notes:
 *
 *  1. **Orthogonal pattern preserved.** The reader consumes the frozen
 *     `APPROVAL_POLICY_REASONS = ['requires_approval']` tuple. The
 *     legacy `POLICY_GATE_REASONS` (`policy-gate.ts`) stays
 *     BYTE-IDENTICAL — see `policy-gate-stages.ts` block comment §1-§2.
 *  2. **Anonymous identity is fail-closed.** When `identityId` is
 *     undefined and the effect *is* listed in `policy.approvals`, the
 *     reader denies. When `identityId` is undefined and the effect is
 *     NOT listed, the reader passes (no approval was required for that
 *     effect in the first place — the gate is a denial gate, not an
 *     identification gate).
 *  3. **Sibling reuse for approval creation.** This module never
 *     constructs the long-lived `ExecApprovalManager` itself; instead
 *     callers inject an `ApprovalRequestCreator` (typically backed by
 *     `getSharedExecApprovalManager()` in production wiring). This keeps
 *     the commitment layer free of gateway-specific singletons and lets
 *     tests inject a deterministic creator without spying on globals.
 *  4. **Episodic event emission.** On `approved=false` the reader
 *     emits a `policy_approval` episodic event into the injected
 *     `MemoryStore` (when present). The store-write failure is
 *     contained — observability MUST NOT gate the calling commitment
 *     turn (invariant #15). When no store is injected (anonymous turn,
 *     pre-Phase-7 caller), the event is simply dropped — Phase 7
 *     escalation is the joinable record for those denials.
 *  5. **Log-line evidence (sub-plan §3 row Phase 3).** Two lines are
 *     emitted via `defaultRuntime.log`:
 *       - `[policy-gate] event=approval_checked stage=2 effect=<id>
 *          approved=<bool> reason=<r>`  on every evaluation
 *       - `[policy-gate] event=approval_request_created
 *          approval_id=<id>`  on every denial
 *     These are observable in `C:\\tmp\\openclaw\\openclaw-<date>.log`
 *     during live-verify (sub-plan §3, Phase 10 acceptance).
 */

/**
 * Config-driven entry describing one effect that requires approval before
 * the affordance allowlist (existing) lets the caller proceed.
 *
 * Field semantics:
 *  - `effectId` — the canonical effect id the gate matches against.
 *  - `requiredApprovals` — currently observability only (Phase 3 ships
 *    binary `approved | not approved`; Phase 7 escalation widens to
 *    multi-approver flows).
 *  - `approvers` — closed list of identities pre-approved for this
 *    effect. An identity not in the list (including anonymous) is
 *    denied.
 *
 * Note: this entry is config-shaped — it lives on
 * `OpenClawConfig.policy.approvals` and is *not* the runtime
 * `ApprovalRequest` raised on denial (those flow through
 * `ExecApprovalManager`).
 */
export type ApprovalPolicyConfigEntry = {
  readonly effectId: EffectId;
  readonly requiredApprovals: number;
  readonly approvers?: readonly IdentityId[];
};

/**
 * Minimum sibling-reuse surface this module needs from the gateway's
 * `ExecApprovalManager`. Production wiring binds this to
 * `getSharedExecApprovalManager().create(...)`; tests can inject any
 * deterministic creator that returns a record with an `id` slot.
 */
export type ApprovalRequestCreator = {
  create(payload: ApprovalRequestCreatePayload, id?: string): { readonly id: string };
};

/**
 * Reduced approval-request payload exposed at the commitment-policy
 * boundary. The full `ExecApprovalRequestPayload` type is defined in
 * `src/infra/exec-approvals.ts` and accepts everything below as a
 * structural subset; this type intentionally surfaces only the fields
 * the gate populates so the import boundary stays narrow (the
 * commitment layer must NOT import `infra/*`).
 */
export type ApprovalRequestCreatePayload = {
  readonly command: string;
  readonly commandPreview?: string | null;
  readonly agentId?: string | null;
  readonly sessionKey?: string | null;
  readonly blockedReason?: string | null;
};

/**
 * Subset of `OpenClawConfig` the approval policy reads. Defined locally
 * so callers do not need to plumb the full config when the rest of it
 * is irrelevant (especially in tests).
 */
type ApprovalPolicyConfigShape = {
  readonly policy?: {
    readonly approvals?: readonly ApprovalPolicyConfigEntry[];
  };
};

export type CreateApprovalPolicyOptions = {
  readonly cfg: OpenClawConfig;
  readonly approvalCreator: ApprovalRequestCreator;
  readonly memoryStore?: MemoryStore;
  /**
   * Optional override for the approval-request timeout (ms) passed to
   * `ApprovalRequestCreator.create`. Phase 3 default is 15 minutes —
   * matches the existing `ExecApprovalManager` operator-window for
   * pending approvals; Phase 7 escalation is the long-tail handler.
   */
  readonly approvalTimeoutMs?: number;
};

const DEFAULT_APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Creates the Stage 2 (Approvals) policy reader.
 *
 * The returned reader is sync — Phase 3 only consults the in-memory
 * config-derived table and a synchronous approval-record creator. The
 * `evaluate(...)` signature still returns
 * `ApprovalPolicyDecision | Promise<ApprovalPolicyDecision>` per the
 * Phase 2 interface so a future remote-approval-server impl can
 * `await` without breaking callers.
 *
 * @param options - Config + approval-record creator (sibling reuse) +
 *   optional memory store for episodic event emission.
 * @returns Frozen `ApprovalPolicyReader`.
 */
export function createApprovalPolicy(
  options: CreateApprovalPolicyOptions,
): ApprovalPolicyReader {
  const cfg = options.cfg as ApprovalPolicyConfigShape;
  const entries = cfg.policy?.approvals ?? [];
  const creator = options.approvalCreator;
  const memoryStore = options.memoryStore;
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  const byEffectId = new Map<EffectId, ApprovalPolicyConfigEntry>();
  for (const entry of entries) {
    byEffectId.set(entry.effectId, entry);
  }

  const reader: ApprovalPolicyReader = {
    evaluate(params: ApprovalPolicyEvaluateInput): ApprovalPolicyDecision {
      const entry = byEffectId.get(params.effectId);
      // Path 1: effect not listed → no approval required, identity
      // (anonymous or otherwise) is irrelevant.
      if (!entry) {
        emitChecked({ approved: true, effectId: params.effectId, reason: undefined });
        return { approved: true };
      }

      // Path 2: effect listed AND identity is in approvers (and identity
      // is non-anonymous) → pass. An empty `approvers` array means
      // nobody is pre-approved → deny everyone, including the listed
      // owner of the rule.
      const approvers = entry.approvers ?? [];
      const identityId = params.identityId;
      const isApprover =
        identityId !== undefined &&
        approvers.length > 0 &&
        approvers.includes(identityId);
      if (isApprover) {
        emitChecked({ approved: true, effectId: params.effectId, reason: undefined });
        return { approved: true };
      }

      // Path 3: denial (effect listed, identity not in approvers OR
      // identity anonymous OR approvers empty). Create the approval
      // request, optionally emit episodic, log, and return.
      const reason: ApprovalPolicyReason = APPROVAL_POLICY_REASONS[0];
      const record = creator.create(
        {
          command: `policy-gate:approval:${String(params.effectId)}`,
          commandPreview: `effect=${String(params.effectId)} reason=${reason}`,
          blockedReason: reason,
        },
        undefined,
      );
      const approvalRequestId = record.id as ApprovalRequestId;
      emitChecked({
        approved: false,
        effectId: params.effectId,
        reason,
      });
      emitRequestCreated(approvalRequestId);
      void approvalTimeoutMs; // reserved — Phase 7 wires register(...)
      // Episodic event emission — failure is contained per invariant #15.
      if (memoryStore && identityId !== undefined) {
        // Memory write is observability-only. A reject is logged and
        // swallowed: the calling commitment turn proceeds with the
        // denial decision regardless of memory-layer health.
        void memoryStore
          .storeEpisodic({
            identityId,
            effectFamily: "policy_approval",
            effectId: String(params.effectId),
            payload: {
              approvalRequestId,
              identityId,
              effectId: params.effectId,
              reason,
            },
          })
          .catch((error: unknown) => {
            defaultRuntime.log(
              `[policy-gate] event=approval_episodic_write_failed ` +
                `error=${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
      return {
        approved: false,
        reason,
        approvalRequestId,
      };
    },
  };
  return Object.freeze(reader);
}

function emitChecked(params: {
  readonly approved: boolean;
  readonly effectId: EffectId;
  readonly reason: ApprovalPolicyReason | undefined;
}): void {
  const parts = [
    "[policy-gate] event=approval_checked stage=2",
    `effect=${String(params.effectId)}`,
    `approved=${String(params.approved)}`,
  ];
  if (params.reason) {
    parts.push(`reason=${params.reason}`);
  }
  defaultRuntime.log(parts.join(" "));
}

function emitRequestCreated(approvalRequestId: ApprovalRequestId): void {
  defaultRuntime.log(
    `[policy-gate] event=approval_request_created approval_id=${String(approvalRequestId)}`,
  );
}
