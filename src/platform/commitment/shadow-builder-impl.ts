import { randomUUID } from "node:crypto";
import type { Affordance } from "./affordance.js";
import type { AffordanceRegistry, RegisteredAffordance } from "./affordance-registry.js";
import type { ExecutionCommitment, TerminalPolicy } from "./execution-commitment.js";
import type { CommitmentId, ReadonlyRecord } from "./ids.js";
import type { SemanticIntent } from "./semantic-intent.js";
import type { ShadowBuilder, ShadowBuildResult } from "./shadow-builder.js";

export type PolicyGateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason?: string };

export type PolicyGateReader = {
  /**
   * Checks whether a candidate affordance may be used for this semantic intent.
   *
   * @param params - Intent and candidate under consideration.
   * @returns Policy decision for this candidate.
   */
  canUseAffordance(params: {
    readonly intent: SemanticIntent;
    readonly affordance: RegisteredAffordance;
  }): PolicyGateDecision | Promise<PolicyGateDecision>;
};

export type ShadowBuilderLogger = {
  readonly trace?: (message: string, fields?: ReadonlyRecord<string, unknown>) => void;
  readonly debug?: (message: string, fields?: ReadonlyRecord<string, unknown>) => void;
};

export const allowAllPolicyGate: PolicyGateReader = {
  canUseAffordance: () => ({ allowed: true }),
};

/**
 * Creates the PR-2 ShadowBuilder implementation.
 *
 * @param deps - Registry, policy, logger, and confidence threshold.
 * @returns ShadowBuilder that resolves semantic intents into commitments or typed unsupported results.
 */
export function createShadowBuilder(deps: {
  readonly affordances: AffordanceRegistry;
  readonly policy: PolicyGateReader;
  readonly logger: ShadowBuilderLogger;
  readonly confidenceThreshold: number;
}): ShadowBuilder {
  return {
    async build(intent: SemanticIntent): Promise<ShadowBuildResult> {
      if (intent.confidence < deps.confidenceThreshold) {
        return { kind: "unsupported", reason: "low_confidence_intent" };
      }

      const candidates = deps.affordances.findByFamily(
        intent.desiredEffectFamily,
        intent.target,
        intent.operation,
      );
      logBranchingFactor(deps.logger, candidates.length);

      if (candidates.length === 0) {
        return { kind: "unsupported", reason: "no_matching_affordance" };
      }
      if (candidates.length > 1) {
        return {
          kind: "unsupported",
          reason: "no_matching_affordance",
          uncertainty: ["multiple_candidates"],
        };
      }

      const candidate = candidates[0]!;
      const policy = await deps.policy.canUseAffordance({ intent, affordance: candidate });
      if (!policy.allowed) {
        return { kind: "unsupported", reason: "policy_blocked" };
      }
      if (budgetExceeded(candidate)) {
        return { kind: "unsupported", reason: "budget_exceeded" };
      }

      return {
        kind: "commitment",
        value: {
          id: newCommitmentId(),
          effect: candidate.effect,
          target: intent.target,
          constraints: pickAllowedConstraints(intent.constraints, candidate),
          budgets: candidate.defaultBudgets,
          requiredEvidence: candidate.requiredEvidence,
          terminalPolicy: defaultTerminalPolicy(),
        },
      };
    },
  };
}

/**
 * Copies only affordance-approved constraint keys into a commitment.
 *
 * @param intentConstraints - Constraints produced by IntentContractor.
 * @param affordance - Candidate affordance with a closed constraint whitelist.
 * @returns Frozen constraint object containing approved keys only.
 */
export function pickAllowedConstraints(
  intentConstraints: ReadonlyRecord<string, unknown>,
  affordance: Affordance,
): ReadonlyRecord<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of affordance.allowedConstraintKeys) {
    if (key in intentConstraints) {
      out[key] = intentConstraints[key];
    }
  }
  return Object.freeze(out);
}

function newCommitmentId(): CommitmentId {
  return `commitment_${randomUUID()}` as CommitmentId;
}

function budgetExceeded(candidate: RegisteredAffordance): boolean {
  return candidate.defaultBudgets.maxLatencyMs <= 0 || candidate.defaultBudgets.maxRetries < 0;
}

function defaultTerminalPolicy(): TerminalPolicy {
  return {
    onTimeout: "unsupported",
    onPolicyDenial: "rejected",
    onUnsatisfiedSuccess: "rejected",
  };
}

function logBranchingFactor(logger: ShadowBuilderLogger, branchingFactor: number): void {
  const fields = { affordance_branching_factor: branchingFactor };
  if (logger.trace) {
    logger.trace("commitment.shadow_builder", fields);
    return;
  }
  logger.debug?.("commitment.shadow_builder", fields);
}
