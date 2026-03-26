import type { PolicyContext } from "../policy/types.js";
import type { CapabilityRegistry } from "../registry/types.js";
import type { CapabilityInstallMethod } from "../schemas/capability.js";
import {
  BootstrapOrchestrationResultSchema,
  type BootstrapOrchestrationResult,
  type BootstrapRequest,
} from "./contracts.js";
import type { BootstrapInstaller } from "./installers.js";
import { evaluateBootstrapRequestPolicy, runBootstrapLifecycle } from "./runtime.js";

export async function orchestrateBootstrapRequest(params: {
  request: BootstrapRequest;
  policyContext: PolicyContext;
  registry: CapabilityRegistry;
  stateDir?: string;
  installers?: Partial<Record<CapabilityInstallMethod, BootstrapInstaller>>;
  availableBins?: string[];
  availableEnv?: string[];
  runHealthCheckCommand?: (command: string) => Promise<boolean> | boolean;
}): Promise<BootstrapOrchestrationResult> {
  const { decision } = evaluateBootstrapRequestPolicy({
    context: params.policyContext,
    request: params.request,
  });
  const policy = {
    allowCapabilityBootstrap: decision.allowCapabilityBootstrap,
    allowPrivilegedTools: decision.allowPrivilegedTools,
    requireExplicitApproval: decision.requireExplicitApproval,
    reasons: decision.reasons,
    deniedReasons: decision.deniedReasons,
  };

  if (
    !decision.allowCapabilityBootstrap ||
    (params.request.installMethod !== "builtin" && !decision.allowPrivilegedTools)
  ) {
    const capability = params.registry.get(params.request.capabilityId);
    return BootstrapOrchestrationResultSchema.parse({
      capabilityId: params.request.capabilityId,
      status: "denied",
      request: params.request,
      policy,
      ...(capability ? { capability } : {}),
      reasons: decision.deniedReasons,
    });
  }

  const lifecycle = await runBootstrapLifecycle({
    request: params.request,
    policyContext: params.policyContext,
    policyDecision: decision,
    registry: params.registry,
    stateDir: params.stateDir,
    installers: params.installers,
    availableBins: params.availableBins,
    availableEnv: params.availableEnv,
    runHealthCheckCommand: params.runHealthCheckCommand,
  });

  return BootstrapOrchestrationResultSchema.parse({
    capabilityId: params.request.capabilityId,
    status: lifecycle.status === "available" ? "bootstrapped" : "degraded",
    request: params.request,
    policy,
    lifecycle,
    ...(lifecycle.capability ? { capability: lifecycle.capability } : {}),
    reasons: lifecycle.reasons,
  });
}
