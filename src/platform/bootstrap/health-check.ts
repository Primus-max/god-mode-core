import type { CapabilityDescriptor } from "../schemas/capability.js";

export async function verifyCapabilityHealth(params: {
  capability: CapabilityDescriptor;
  availableBins?: string[];
  availableEnv?: string[];
  runHealthCheckCommand?: (command: string) => Promise<boolean> | boolean;
}): Promise<{ ok: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  const bins = new Set((params.availableBins ?? []).map((value) => value.toLowerCase()));
  const env = new Set((params.availableEnv ?? []).map((value) => value.toUpperCase()));

  for (const bin of params.capability.requiredBins ?? []) {
    if (!bins.has(bin.toLowerCase())) {
      reasons.push(`required bin missing: ${bin}`);
    }
  }
  for (const envVar of params.capability.requiredEnv ?? []) {
    if (!env.has(envVar.toUpperCase())) {
      reasons.push(`required env missing: ${envVar}`);
    }
  }

  if (params.capability.healthCheckCommand) {
    if (!params.runHealthCheckCommand) {
      reasons.push("health check runner unavailable");
    } else {
      const ok = await params.runHealthCheckCommand(params.capability.healthCheckCommand);
      if (!ok) {
        reasons.push(`health check failed: ${params.capability.healthCheckCommand}`);
      }
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}
