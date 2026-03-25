import { evaluatePolicy } from "../policy/engine.js";
import type { PolicyContext, PolicyDecision } from "../policy/types.js";
import type { CapabilityRegistry } from "../registry/types.js";
import type { CapabilityDescriptor, CapabilityInstallMethod } from "../schemas/capability.js";
import {
  BootstrapLifecycleResultSchema,
  type BootstrapLifecycleResult,
  type BootstrapRequest,
} from "./contracts.js";
import { verifyCapabilityHealth } from "./health-check.js";
import { installCapabilityRequest, type BootstrapInstaller } from "./installers.js";

function resolveRequestedToolNames(method: CapabilityInstallMethod): string[] {
  return method === "builtin" ? [] : ["exec", "process"];
}

export function buildBootstrapPolicyContext(params: {
  base: PolicyContext;
  request: BootstrapRequest;
}): PolicyContext {
  return {
    ...params.base,
    requestedCapabilities: Array.from(
      new Set([...(params.base.requestedCapabilities ?? []), params.request.capabilityId]),
    ),
    requestedToolNames: Array.from(
      new Set([
        ...(params.base.requestedToolNames ?? []),
        ...resolveRequestedToolNames(params.request.installMethod),
      ]),
    ),
  };
}

export function evaluateBootstrapRequestPolicy(params: {
  context: PolicyContext;
  request: BootstrapRequest;
}): { context: PolicyContext; decision: PolicyDecision } {
  const context = buildBootstrapPolicyContext({
    base: params.context,
    request: params.request,
  });
  return {
    context,
    decision: evaluatePolicy(context),
  };
}

function resolveRollbackStatus(params: {
  request: BootstrapRequest;
  previous?: CapabilityDescriptor;
}): "restore_previous" | "disable" | "keep_failed" {
  if (params.request.rollbackStrategy === "restore_previous" && params.previous) {
    return "restore_previous";
  }
  if (params.request.rollbackStrategy === "disable") {
    return "disable";
  }
  return "keep_failed";
}

function buildRollbackCapability(params: {
  request: BootstrapRequest;
  previous?: CapabilityDescriptor;
  failedCapability: CapabilityDescriptor;
}): { capability: CapabilityDescriptor; rollbackStatus: "restore_previous" | "disable" | "keep_failed" } {
  const rollbackStatus = resolveRollbackStatus({
    request: params.request,
    previous: params.previous,
  });
  if (rollbackStatus === "restore_previous" && params.previous) {
    return { capability: params.previous, rollbackStatus };
  }
  if (rollbackStatus === "disable") {
    return {
      capability: {
        ...params.failedCapability,
        status: "disabled",
      },
      rollbackStatus,
    };
  }
  return { capability: params.failedCapability, rollbackStatus };
}

export async function runBootstrapLifecycle(params: {
  request: BootstrapRequest;
  policyContext: PolicyContext;
  registry: CapabilityRegistry;
  policyDecision?: PolicyDecision;
  installers?: Partial<Record<CapabilityInstallMethod, BootstrapInstaller>>;
  availableBins?: string[];
  availableEnv?: string[];
  runHealthCheckCommand?: (command: string) => Promise<boolean> | boolean;
}): Promise<BootstrapLifecycleResult> {
  const transitions: BootstrapLifecycleResult["transitions"] = ["requested"];
  const decision =
    params.policyDecision ??
    evaluateBootstrapRequestPolicy({
      context: params.policyContext,
      request: params.request,
    }).decision;
  const privilegedToolsNeeded = resolveRequestedToolNames(params.request.installMethod).length > 0;

  if (
    !decision.allowCapabilityBootstrap ||
    (privilegedToolsNeeded && !decision.allowPrivilegedTools)
  ) {
    transitions.push("denied", "degraded");
    return BootstrapLifecycleResultSchema.parse({
      capabilityId: params.request.capabilityId,
      installMethod: params.request.installMethod,
      rollbackStrategy: params.request.rollbackStrategy,
      verificationStatus: "not_run",
      rollbackStatus: "not_needed",
      status: "denied",
      transitions,
      reasons: decision.deniedReasons,
    });
  }

  transitions.push("approved", "installing");
  const previous = params.registry.get(params.request.capabilityId);
  const installed = await installCapabilityRequest({
    request: params.request,
    previous,
    installers: params.installers,
  });

  if (!installed.ok) {
    const failedCapability: CapabilityDescriptor = {
      ...installed.capability,
      status: "failed",
    };
    const rollback = buildRollbackCapability({
      request: params.request,
      previous,
      failedCapability,
    });
    params.registry.register(rollback.capability);
    transitions.push("failed", "rolled_back", "degraded");
    return BootstrapLifecycleResultSchema.parse({
      capabilityId: params.request.capabilityId,
      installMethod: params.request.installMethod,
      rollbackStrategy: params.request.rollbackStrategy,
      verificationStatus: "not_run",
      rollbackStatus: rollback.rollbackStatus,
      status: "degraded",
      transitions,
      capability: rollback.capability,
      reasons: installed.reasons,
    });
  }

  transitions.push("verifying");
  const verification = await verifyCapabilityHealth({
    capability: installed.capability,
    availableBins: params.availableBins,
    availableEnv: params.availableEnv,
    runHealthCheckCommand: params.runHealthCheckCommand,
  });

  if (!verification.ok) {
    const failedCapability: CapabilityDescriptor = {
      ...installed.capability,
      status: "failed",
    };
    const rollback = buildRollbackCapability({
      request: params.request,
      previous,
      failedCapability,
    });
    params.registry.register(rollback.capability);
    transitions.push("failed", "rolled_back", "degraded");
    return BootstrapLifecycleResultSchema.parse({
      capabilityId: params.request.capabilityId,
      installMethod: params.request.installMethod,
      rollbackStrategy: params.request.rollbackStrategy,
      verificationStatus: "failed",
      rollbackStatus: rollback.rollbackStatus,
      status: "degraded",
      transitions,
      capability: rollback.capability,
      reasons: [...installed.reasons, ...verification.reasons],
    });
  }

  params.registry.register(installed.capability);
  transitions.push("available");
  return BootstrapLifecycleResultSchema.parse({
    capabilityId: params.request.capabilityId,
    installMethod: params.request.installMethod,
    rollbackStrategy: params.request.rollbackStrategy,
    verificationStatus: "passed",
    rollbackStatus: "not_needed",
    status: "available",
    transitions,
    capability: installed.capability,
    reasons: installed.reasons,
  });
}
