import { normalizeProviderId } from "../../agents/model-selection.js";

/** Normalized provider ids commonly used for cheap local inference (control-plane / routing hints). */
const CONTROL_PLANE_LOCAL_PROVIDER_IDS = new Set(["ollama", "vllm", "lmstudio"]);

/**
 * True when the provider is typically a local stack suitable for control-plane support
 * (routing hints, light classification). Primary agent reasoning should use the configured
 * main model unless the operator explicitly chooses a local primary.
 */
export function isLikelyControlPlaneLocalProvider(provider: string): boolean {
  return CONTROL_PLANE_LOCAL_PROVIDER_IDS.has(normalizeProviderId(provider));
}
