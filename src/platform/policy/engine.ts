import { DEFAULT_POLICY_RULES } from "./rules.js";
import type { PolicyContext, PolicyDecision, PolicyRule } from "./types.js";

function computeAutonomy(decision: PolicyDecision): PolicyDecision {
  if (decision.allowPublish || decision.allowCapabilityBootstrap || decision.allowPrivilegedTools) {
    return { ...decision, autonomy: "guarded" };
  }
  if (decision.allowArtifactPersistence || decision.requireExplicitApproval) {
    return { ...decision, autonomy: "assist" };
  }
  return { ...decision, autonomy: "chat" };
}

export function createInitialPolicyDecision(context: PolicyContext): PolicyDecision {
  return {
    profileId: context.activeProfileId,
    taskOverlay: context.activeStateTaskOverlay,
    allowExternalModel: !context.touchesSensitiveData,
    allowArtifactPersistence: false,
    allowPublish: false,
    allowCapabilityBootstrap: false,
    allowPrivilegedTools: false,
    requireExplicitApproval: false,
    autonomy: "chat",
    reasons: [],
    deniedReasons: [],
  };
}

export function evaluatePolicy(
  context: PolicyContext,
  rules: PolicyRule[] = DEFAULT_POLICY_RULES,
): PolicyDecision {
  const decision = rules.reduce(
    (current, rule) => rule.evaluate(context, current),
    createInitialPolicyDecision(context),
  );
  return computeAutonomy(decision);
}
