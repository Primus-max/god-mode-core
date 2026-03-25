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

export async function runBootstrapLifecycle(params: {
  request: BootstrapRequest;
  policyContext: PolicyContext;
  registry: CapabilityRegistry;
  installers?: Partial<Record<CapabilityInstallMethod, BootstrapInstaller>>;
  availableBins?: string[];
  availableEnv?: string[];
  runHealthCheckCommand?: (command: string) => Promise<boolean> | boolean;
}): Promise<BootstrapLifecycleResult> {
  const transitions: BootstrapLifecycleResult["transitions"] = ["requested"];
  const { decision } = evaluateBootstrapRequestPolicy({
    context: params.policyContext,
    request: params.request,
  });
  const privilegedToolsNeeded = resolveRequestedToolNames(params.request.installMethod).length > 0;

  if (
    !decision.allowCapabilityBootstrap ||
    (privilegedToolsNeeded && !decision.allowPrivilegedTools)
  ) {
    transitions.push("denied", "degraded");
    return BootstrapLifecycleResultSchema.parse({
      capabilityId: params.request.capabilityId,
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
    if (params.request.catalogEntry.rollbackStrategy === "restore_previous" && previous) {
      params.registry.register(previous);
    } else {
      params.registry.register(failedCapability);
    }
    transitions.push("failed", "rolled_back", "degraded");
    return BootstrapLifecycleResultSchema.parse({
      capabilityId: params.request.capabilityId,
      status: "degraded",
      transitions,
      capability: previous ?? failedCapability,
      reasons: [...installed.reasons, ...verification.reasons],
    });
  }

  params.registry.register(installed.capability);
  transitions.push("available");
  return BootstrapLifecycleResultSchema.parse({
    capabilityId: params.request.capabilityId,
    status: "available",
    transitions,
    capability: installed.capability,
    reasons: installed.reasons,
  });
}
