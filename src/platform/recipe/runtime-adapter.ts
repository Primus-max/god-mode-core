import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { parseModelRef } from "../../agents/model-selection.js";
import type { PluginHookPlatformExecutionContext } from "../../plugins/types.js";
import type { BootstrapResolution } from "../bootstrap/contracts.js";
import { TRUSTED_CAPABILITY_CATALOG } from "../bootstrap/defaults.js";
import { resolveBootstrapRequests } from "../bootstrap/resolver.js";
import type {
  PlatformExecutionContextSnapshot,
  PlatformExecutionContextReadinessStatus,
  PlatformExecutionContextUnattendedBoundary,
} from "../decision/contracts.js";
import { evaluatePolicy } from "../policy/engine.js";
import type { PolicyContext, PolicyDecision } from "../policy/types.js";
import { getInitialProfile, getTaskOverlay } from "../profile/defaults.js";
import { applyTaskOverlay } from "../profile/overlay.js";
import { createCapabilityRegistry } from "../registry/capability-registry.js";
import type { CapabilityRegistry } from "../registry/types.js";
import {
  PlatformRuntimeExecutionSurfaceSchema,
  type PlatformRuntimeExecutionSurface,
} from "../runtime/index.js";
import type { CapabilityCatalogEntry } from "../schemas/capability.js";
import type { ProfileId } from "../schemas/profile.js";
import type { RecipePlannerInput } from "./planner.js";
import { planExecutionRecipe, type ExecutionPlan } from "./planner.js";

export type RecipeRuntimePlan = {
  selectedRecipeId: string;
  selectedProfileId: ProfileId;
  taskOverlayId?: string;
  plannerReasoning?: string;
  intent?: PolicyContext["intent"];
  providerOverride?: string;
  modelOverride?: string;
  fallbackModels?: string[];
  timeoutSeconds?: number;
  requestedToolNames?: string[];
  publishTargets?: string[];
  requiredCapabilities?: string[];
  bootstrapRequiredCapabilities?: string[];
  requireExplicitApproval?: boolean;
  policyAutonomy?: PolicyDecision["autonomy"];
  readinessStatus?: PlatformExecutionContextReadinessStatus;
  readinessReasons?: string[];
  unattendedBoundary?: PlatformExecutionContextUnattendedBoundary;
  prependSystemContext?: string;
  prependContext?: string;
};

export type PlatformCapabilityRequirement = {
  capabilityId: string;
  capabilityLabel?: string;
  status: BootstrapResolution["status"];
  requiresBootstrap: boolean;
  reasons?: string[];
};

export type PlatformCapabilitySummary = {
  requiredCapabilities: string[];
  bootstrapRequiredCapabilities: string[];
  unresolvedCapabilities: string[];
  requirements: PlatformCapabilityRequirement[];
  bootstrapResolutions: BootstrapResolution[];
};

export type ResolvedPlatformExecutionDecision = ExecutionPlan & {
  runtime: RecipeRuntimePlan;
  policyContext: PolicyContext;
  policyPreview: PolicyDecision;
  capabilitySummary: PlatformCapabilitySummary;
};

export type ResolvedPlatformRuntimePlan = ResolvedPlatformExecutionDecision;

export type ResolvePlatformExecutionDecisionOptions = {
  explicitApproval?: boolean;
  capabilityRegistry?: CapabilityRegistry;
  capabilityCatalog?: CapabilityCatalogEntry[];
  policyContextOverrides?: Pick<
    PolicyContext,
    | "explicitApproval"
    | "requestedMachineControl"
    | "machineControlLinked"
    | "machineControlKillSwitchEnabled"
    | "machineControlDeviceId"
    | "touchesSensitiveData"
  >;
};

export type PlatformExecutionReadiness = {
  status: PlatformExecutionContextReadinessStatus;
  reasons: string[];
  unattendedBoundary?: PlatformExecutionContextUnattendedBoundary;
};

export function buildExecutionSurfaceSnapshot(params: {
  readiness: PlatformExecutionReadiness;
  capabilitySummary: PlatformCapabilitySummary;
  checkedAtMs?: number;
  cacheTtlMs?: number;
  modelFallbackActive?: boolean;
}): PlatformRuntimeExecutionSurface {
  const status =
    params.readiness.status === "ready"
      ? "ready"
      : params.readiness.status === "bootstrap_required"
        ? "bootstrap_required"
        : params.readiness.status === "approval_required"
          ? "approval_required"
          : "degraded";
  return PlatformRuntimeExecutionSurfaceSchema.parse({
    status,
    ready: status === "ready",
    checkedAtMs: params.checkedAtMs ?? Date.now(),
    cacheTtlMs: params.cacheTtlMs,
    reasons: params.readiness.reasons,
    bootstrapRequiredCapabilities: params.capabilitySummary.bootstrapRequiredCapabilities,
    unresolvedCapabilities: params.capabilitySummary.unresolvedCapabilities,
    modelFallbackActive: params.modelFallbackActive,
    approvalRequired: status === "approval_required",
  });
}

function buildSystemContext(
  plan: ExecutionPlan,
  capabilitySummary?: PlatformCapabilitySummary,
): string {
  return [
    `Execution recipe: ${plan.recipe.id}.`,
    plan.recipe.summary ? `Recipe summary: ${plan.recipe.summary}` : undefined,
    capabilitySummary?.requiredCapabilities.length
      ? `Required capabilities: ${capabilitySummary.requiredCapabilities.join(", ")}.`
      : undefined,
    plan.recipe.systemPrompt,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPrependContext(
  plan: ExecutionPlan,
  params?: {
    capabilitySummary?: PlatformCapabilitySummary;
    policyPreview?: PolicyDecision;
    readiness?: PlatformExecutionReadiness;
  },
): string {
  return [
    `Profile: ${plan.profile.selectedProfile.label}.`,
    plan.profile.effective.taskOverlay?.label
      ? `Task overlay: ${plan.profile.effective.taskOverlay.label}.`
      : undefined,
    plan.plannerOutput.reasoning ? `Planner reasoning: ${plan.plannerOutput.reasoning}` : undefined,
    params?.capabilitySummary?.bootstrapRequiredCapabilities.length
      ? `Bootstrap required: ${params.capabilitySummary.bootstrapRequiredCapabilities.join(", ")}.`
      : undefined,
    params?.policyPreview?.requireExplicitApproval
      ? `Policy posture: explicit approval required (${params.policyPreview.autonomy}).`
      : undefined,
    params?.readiness && params.readiness.status !== "ready"
      ? `Preflight readiness: ${params.readiness.status.replaceAll("_", " ")}. ${params.readiness.reasons.join(" ")}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildExecutionReadiness(params: {
  input: RecipePlannerInput;
  capabilitySummary: PlatformCapabilitySummary;
  policyPreview: PolicyDecision;
}): PlatformExecutionReadiness {
  const reasons: string[] = [];
  if (params.capabilitySummary.bootstrapRequiredCapabilities.length > 0) {
    reasons.push(
      `Bootstrap required for capabilities: ${params.capabilitySummary.bootstrapRequiredCapabilities.join(", ")}.`,
    );
    const canAutoContinueBootstrap =
      params.policyPreview.autonomy === "assist" &&
      (params.input.intent === "document" || params.input.intent === "code");
    return {
      status: "bootstrap_required",
      reasons,
      ...(canAutoContinueBootstrap ? { unattendedBoundary: "bootstrap" } : {}),
    };
  }
  const requestsPrivilegedAction =
    (params.input.requestedTools?.some((tool) => tool === "exec" || tool === "process") ?? false) ||
    (params.input.publishTargets?.length ?? 0) > 0;
  if (params.policyPreview.requireExplicitApproval && requestsPrivilegedAction) {
    reasons.push("Explicit approval is required before privileged execution can continue.");
    return {
      status: "approval_required",
      reasons,
    };
  }
  return {
    status: "ready",
    reasons: [],
  };
}

function resolveBootstrapSourceDomain(
  intent: PolicyContext["intent"],
): "document" | "developer" | "platform" {
  if (intent === "document") {
    return "document";
  }
  if (intent === "code" || intent === "publish") {
    return "developer";
  }
  return "platform";
}

function buildCapabilitySummary(params: {
  plan: ExecutionPlan;
  input: RecipePlannerInput;
  capabilityRegistry?: CapabilityRegistry;
  capabilityCatalog?: CapabilityCatalogEntry[];
}): PlatformCapabilitySummary {
  const requiredCapabilities = params.plan.recipe.requiredCapabilities ?? [];
  if (requiredCapabilities.length === 0) {
    return {
      requiredCapabilities: [],
      bootstrapRequiredCapabilities: [],
      unresolvedCapabilities: [],
      requirements: [],
      bootstrapResolutions: [],
    };
  }
  const registry =
    params.capabilityRegistry ??
    createCapabilityRegistry([], params.capabilityCatalog ?? TRUSTED_CAPABILITY_CATALOG);
  const bootstrapResolutions = resolveBootstrapRequests({
    capabilityIds: requiredCapabilities,
    registry,
    catalog: params.capabilityCatalog ?? TRUSTED_CAPABILITY_CATALOG,
    reason: "recipe_requirement",
    sourceDomain: resolveBootstrapSourceDomain(params.input.intent),
    sourceRecipeId: params.plan.recipe.id,
  });
  const requirements = bootstrapResolutions.map((resolution, index) => {
    const capabilityId =
      resolution.request?.capabilityId ??
      resolution.capability?.id ??
      requiredCapabilities[index] ??
      "unknown-capability";
    return {
      capabilityId,
      capabilityLabel:
        resolution.request?.catalogEntry.capability.label ?? resolution.capability?.label,
      status: resolution.status,
      requiresBootstrap: resolution.status === "request",
      ...(resolution.reasons?.length ? { reasons: resolution.reasons } : {}),
    } satisfies PlatformCapabilityRequirement;
  });
  return {
    requiredCapabilities,
    bootstrapRequiredCapabilities: requirements
      .filter((requirement) => requirement.requiresBootstrap)
      .map((requirement) => requirement.capabilityId),
    unresolvedCapabilities: requirements
      .filter((requirement) => requirement.status !== "available")
      .map((requirement) => requirement.capabilityId),
    requirements,
    bootstrapResolutions,
  };
}

function attachExecutionContextToCapabilitySummary(
  summary: PlatformCapabilitySummary,
  executionContext: PluginHookPlatformExecutionContext,
): PlatformCapabilitySummary {
  return {
    ...summary,
    bootstrapResolutions: summary.bootstrapResolutions.map((resolution) =>
      resolution.request
        ? {
            ...resolution,
            request: {
              ...resolution.request,
              executionContext,
            },
          }
        : resolution,
    ),
  };
}

export function buildPolicyContextFromRuntimePlan(
  runtimePlan: Pick<
    RecipeRuntimePlan,
    | "selectedProfileId"
    | "taskOverlayId"
    | "intent"
    | "requestedToolNames"
    | "publishTargets"
    | "requiredCapabilities"
  >,
  overrides: Pick<
    PolicyContext,
    | "explicitApproval"
    | "requestedMachineControl"
    | "machineControlLinked"
    | "machineControlKillSwitchEnabled"
    | "machineControlDeviceId"
    | "touchesSensitiveData"
  > = {},
): PolicyContext | undefined {
  const profile = getInitialProfile(runtimePlan.selectedProfileId);
  if (!profile) {
    return undefined;
  }
  const overlay =
    runtimePlan.taskOverlayId && profile
      ? (getTaskOverlay(profile, runtimePlan.taskOverlayId) ?? undefined)
      : undefined;
  return {
    activeProfileId: profile.id,
    activeProfile: profile,
    activeStateTaskOverlay: overlay?.id,
    effective: applyTaskOverlay(profile, overlay),
    ...(runtimePlan.intent ? { intent: runtimePlan.intent } : {}),
    ...(runtimePlan.requestedToolNames?.length
      ? { requestedToolNames: runtimePlan.requestedToolNames }
      : {}),
    ...(runtimePlan.publishTargets?.length ? { publishTargets: runtimePlan.publishTargets } : {}),
    ...(runtimePlan.requiredCapabilities?.length
      ? { requestedCapabilities: runtimePlan.requiredCapabilities }
      : {}),
    ...overrides,
  };
}

export function buildPolicyContextFromExecutionContext(
  execution: Pick<
    PlatformExecutionContextSnapshot,
    | "profileId"
    | "taskOverlayId"
    | "intent"
    | "requestedToolNames"
    | "publishTargets"
    | "requiredCapabilities"
  >,
  overrides: Pick<
    PolicyContext,
    | "explicitApproval"
    | "requestedMachineControl"
    | "machineControlLinked"
    | "machineControlKillSwitchEnabled"
    | "machineControlDeviceId"
    | "touchesSensitiveData"
    | "artifactKinds"
  > = {},
): PolicyContext | undefined {
  return buildPolicyContextFromRuntimePlan(
    {
      selectedProfileId: execution.profileId as ProfileId,
      taskOverlayId: execution.taskOverlayId,
      intent: execution.intent,
      requestedToolNames: execution.requestedToolNames,
      publishTargets: execution.publishTargets,
      requiredCapabilities: execution.requiredCapabilities,
    },
    overrides,
  );
}

export function toPluginHookPlatformExecutionContext(
  runtimePlan: RecipeRuntimePlan,
): PluginHookPlatformExecutionContext {
  return {
    profileId: runtimePlan.selectedProfileId,
    recipeId: runtimePlan.selectedRecipeId,
    ...(runtimePlan.taskOverlayId ? { taskOverlayId: runtimePlan.taskOverlayId } : {}),
    ...(runtimePlan.plannerReasoning ? { plannerReasoning: runtimePlan.plannerReasoning } : {}),
    ...(runtimePlan.intent ? { intent: runtimePlan.intent } : {}),
    ...(runtimePlan.providerOverride ? { providerOverride: runtimePlan.providerOverride } : {}),
    ...(runtimePlan.modelOverride ? { modelOverride: runtimePlan.modelOverride } : {}),
    ...(runtimePlan.timeoutSeconds ? { timeoutSeconds: runtimePlan.timeoutSeconds } : {}),
    ...(runtimePlan.fallbackModels?.length ? { fallbackModels: runtimePlan.fallbackModels } : {}),
    ...(runtimePlan.requestedToolNames?.length
      ? { requestedToolNames: runtimePlan.requestedToolNames }
      : {}),
    ...(runtimePlan.publishTargets?.length ? { publishTargets: runtimePlan.publishTargets } : {}),
    ...(runtimePlan.requiredCapabilities?.length
      ? { requiredCapabilities: runtimePlan.requiredCapabilities }
      : {}),
    ...(runtimePlan.bootstrapRequiredCapabilities?.length
      ? { bootstrapRequiredCapabilities: runtimePlan.bootstrapRequiredCapabilities }
      : {}),
    ...(runtimePlan.requireExplicitApproval !== undefined
      ? { requireExplicitApproval: runtimePlan.requireExplicitApproval }
      : {}),
    ...(runtimePlan.policyAutonomy ? { policyAutonomy: runtimePlan.policyAutonomy } : {}),
    ...(runtimePlan.readinessStatus ? { readinessStatus: runtimePlan.readinessStatus } : {}),
    ...(runtimePlan.readinessReasons?.length
      ? { readinessReasons: runtimePlan.readinessReasons }
      : {}),
    ...(runtimePlan.unattendedBoundary
      ? { unattendedBoundary: runtimePlan.unattendedBoundary }
      : {}),
  };
}

export function adaptExecutionPlanToRuntime(
  plan: ExecutionPlan,
  params?: {
    input?: RecipePlannerInput;
    capabilitySummary?: PlatformCapabilitySummary;
    policyPreview?: PolicyDecision;
    readiness?: PlatformExecutionReadiness;
  },
): RecipeRuntimePlan {
  const overrideModel = plan.plannerOutput.overrides?.model;
  const parsedModel = overrideModel ? parseModelRef(overrideModel, DEFAULT_PROVIDER) : null;
  const prependSystemContext = buildSystemContext(plan, params?.capabilitySummary);
  const prependContext = buildPrependContext(plan, {
    capabilitySummary: params?.capabilitySummary,
    policyPreview: params?.policyPreview,
    readiness: params?.readiness,
  });

  return {
    selectedRecipeId: plan.recipe.id,
    selectedProfileId: plan.profile.selectedProfile.id,
    ...(plan.profile.activeProfile.taskOverlay
      ? { taskOverlayId: plan.profile.activeProfile.taskOverlay }
      : {}),
    ...(plan.plannerOutput.reasoning ? { plannerReasoning: plan.plannerOutput.reasoning } : {}),
    ...(params?.input?.intent ? { intent: params.input.intent } : {}),
    ...(parsedModel?.provider ? { providerOverride: parsedModel.provider } : {}),
    ...(parsedModel?.model ? { modelOverride: parsedModel.model } : {}),
    ...(plan.recipe.fallbackModels?.length ? { fallbackModels: plan.recipe.fallbackModels } : {}),
    ...(plan.plannerOutput.overrides?.timeoutSeconds
      ? { timeoutSeconds: plan.plannerOutput.overrides.timeoutSeconds }
      : {}),
    ...(params?.input?.requestedTools?.length
      ? { requestedToolNames: params.input.requestedTools }
      : {}),
    ...(params?.input?.publishTargets?.length
      ? { publishTargets: params.input.publishTargets }
      : {}),
    ...(params?.capabilitySummary?.requiredCapabilities.length
      ? { requiredCapabilities: params.capabilitySummary.requiredCapabilities }
      : {}),
    ...(params?.capabilitySummary?.bootstrapRequiredCapabilities.length
      ? { bootstrapRequiredCapabilities: params.capabilitySummary.bootstrapRequiredCapabilities }
      : {}),
    ...(params?.policyPreview
      ? {
          requireExplicitApproval: params.policyPreview.requireExplicitApproval,
          policyAutonomy: params.policyPreview.autonomy,
        }
      : {}),
    ...(params?.readiness
      ? {
          readinessStatus: params.readiness.status,
          ...(params.readiness.reasons.length
            ? { readinessReasons: params.readiness.reasons }
            : {}),
          ...(params.readiness.unattendedBoundary
            ? { unattendedBoundary: params.readiness.unattendedBoundary }
            : {}),
        }
      : {}),
    ...(prependSystemContext ? { prependSystemContext } : {}),
    ...(prependContext ? { prependContext } : {}),
  };
}

export function resolvePlatformExecutionDecision(
  input: RecipePlannerInput,
  options: ResolvePlatformExecutionDecisionOptions = {},
): ResolvedPlatformExecutionDecision {
  const plan = planExecutionRecipe(input);
  const baseCapabilitySummary = buildCapabilitySummary({
    plan,
    input,
    capabilityRegistry: options.capabilityRegistry,
    capabilityCatalog: options.capabilityCatalog,
  });
  const policyContext = {
    ...(buildPolicyContextFromRuntimePlan(
      {
        selectedProfileId: plan.profile.selectedProfile.id,
        taskOverlayId: plan.profile.activeProfile.taskOverlay,
        intent: input.intent,
        requestedToolNames: input.requestedTools,
        publishTargets: input.publishTargets,
        requiredCapabilities: baseCapabilitySummary.requiredCapabilities,
      },
      {
        explicitApproval: options.explicitApproval,
        ...options.policyContextOverrides,
      },
    ) ?? {
      activeProfileId: plan.profile.selectedProfile.id,
      activeProfile: plan.profile.selectedProfile,
      effective: plan.profile.effective,
    }),
  } satisfies PolicyContext;
  const policyPreview = evaluatePolicy(policyContext);
  const readiness = buildExecutionReadiness({
    input,
    capabilitySummary: baseCapabilitySummary,
    policyPreview,
  });
  const runtime = adaptExecutionPlanToRuntime(plan, {
    input,
    capabilitySummary: baseCapabilitySummary,
    policyPreview,
    readiness,
  });
  const executionContext = toPluginHookPlatformExecutionContext(runtime);
  const capabilitySummary = attachExecutionContextToCapabilitySummary(
    baseCapabilitySummary,
    executionContext,
  );
  return {
    ...plan,
    capabilitySummary,
    policyContext,
    policyPreview,
    runtime,
  };
}

export function resolvePlatformRuntimePlan(
  input: RecipePlannerInput,
  options: ResolvePlatformExecutionDecisionOptions = {},
): ResolvedPlatformRuntimePlan {
  return resolvePlatformExecutionDecision(input, options);
}
