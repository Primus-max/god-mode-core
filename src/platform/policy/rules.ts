import type { PolicyDecision, PolicyRule } from "./types.js";

const PRIVILEGED_TOOLS = new Set(["exec", "process", "apply_patch", "write"]);

function withReason(decision: PolicyDecision, reason: string): PolicyDecision {
  return { ...decision, reasons: [...decision.reasons, reason] };
}

function withDeniedReason(decision: PolicyDecision, reason: string): PolicyDecision {
  return { ...decision, deniedReasons: [...decision.deniedReasons, reason] };
}

export const PROFILE_DOES_NOT_GRANT_HIDDEN_RIGHTS_RULE: PolicyRule = {
  id: "profile-does-not-grant-hidden-rights",
  evaluate(context, decision) {
    const requestedTools = context.requestedToolNames ?? [];
    const needsPrivilegedTools = requestedTools.some((tool) => PRIVILEGED_TOOLS.has(tool));
    if (needsPrivilegedTools && !context.explicitApproval) {
      return withDeniedReason(
        { ...decision, allowPrivilegedTools: false, requireExplicitApproval: true },
        "privileged tools require explicit approval; profile preference alone is not enough",
      );
    }
    if (needsPrivilegedTools && context.explicitApproval) {
      return withReason(
        { ...decision, allowPrivilegedTools: true },
        "explicit approval granted for privileged tools",
      );
    }
    return decision;
  },
};

export const SENSITIVE_DATA_RULE: PolicyRule = {
  id: "sensitive-data-boundary",
  evaluate(context, decision) {
    if (!context.touchesSensitiveData) {
      return decision;
    }
    if (context.explicitApproval) {
      return withReason(
        { ...decision, allowExternalModel: true, requireExplicitApproval: true },
        "sensitive data allowed because explicit approval was provided",
      );
    }
    return withDeniedReason(
      { ...decision, allowExternalModel: false, requireExplicitApproval: true },
      "sensitive data blocks external model use until explicit approval is given",
    );
  },
};

export const PUBLISH_RULE: PolicyRule = {
  id: "publish-requires-intent-and-approval",
  evaluate(context, decision) {
    const targets = context.publishTargets ?? [];
    if (targets.length === 0) {
      return decision;
    }
    if (!context.explicitApproval) {
      return withDeniedReason(
        { ...decision, allowPublish: false, requireExplicitApproval: true },
        "publishing requires explicit approval and an explicit target",
      );
    }
    return withReason(
      { ...decision, allowPublish: true },
      "explicit approval granted for publish targets",
    );
  },
};

export const BOOTSTRAP_RULE: PolicyRule = {
  id: "bootstrap-requires-approval",
  evaluate(context, decision) {
    const capabilities = context.requestedCapabilities ?? [];
    if (capabilities.length === 0) {
      return decision;
    }
    if (!context.explicitApproval) {
      return withDeniedReason(
        { ...decision, allowCapabilityBootstrap: false, requireExplicitApproval: true },
        "capability bootstrap/install requires explicit approval",
      );
    }
    return withReason(
      { ...decision, allowCapabilityBootstrap: true },
      "explicit approval granted for capability bootstrap",
    );
  },
};

export const MACHINE_CONTROL_RULE: PolicyRule = {
  id: "machine-control-requires-link-and-approval",
  evaluate(context, decision) {
    if (!context.requestedMachineControl) {
      return decision;
    }
    if (context.machineControlKillSwitchEnabled) {
      return withDeniedReason(
        { ...decision, allowMachineControl: false, requireExplicitApproval: true },
        "machine control is disabled by kill switch",
      );
    }
    if (!context.machineControlLinked) {
      return withDeniedReason(
        { ...decision, allowMachineControl: false, requireExplicitApproval: true },
        "machine control requires explicit device binding",
      );
    }
    if (!context.explicitApproval) {
      return withDeniedReason(
        { ...decision, allowMachineControl: false, requireExplicitApproval: true },
        "machine control requires explicit approval even for linked devices",
      );
    }
    return withReason(
      {
        ...decision,
        allowMachineControl: true,
      },
      "explicit approval granted for machine control on linked device",
    );
  },
};

export const ARTIFACT_PERSISTENCE_RULE: PolicyRule = {
  id: "artifact-persistence-follows-intent",
  evaluate(context, decision) {
    const wantsArtifacts =
      (context.artifactKinds?.length ?? 0) > 0 ||
      context.intent === "document" ||
      (context.publishTargets?.length ?? 0) > 0;
    if (!wantsArtifacts) {
      return decision;
    }
    return withReason(
      { ...decision, allowArtifactPersistence: true },
      "artifact persistence enabled for document/publish intent",
    );
  },
};

export const GENERAL_CHAT_OVERLAY_RULE: PolicyRule = {
  id: "general-chat-overlay-stays-lightweight",
  evaluate(context, decision) {
    if (context.activeStateTaskOverlay !== "general_chat") {
      return decision;
    }
    return withReason(
      {
        ...decision,
        allowPublish: false,
        allowCapabilityBootstrap: false,
        allowPrivilegedTools: false,
        allowMachineControl: false,
      },
      "general chat overlay keeps execution lightweight unless explicitly approved",
    );
  },
};

export const DEFAULT_POLICY_RULES: PolicyRule[] = [
  PROFILE_DOES_NOT_GRANT_HIDDEN_RIGHTS_RULE,
  SENSITIVE_DATA_RULE,
  PUBLISH_RULE,
  BOOTSTRAP_RULE,
  MACHINE_CONTROL_RULE,
  ARTIFACT_PERSISTENCE_RULE,
  GENERAL_CHAT_OVERLAY_RULE,
];
