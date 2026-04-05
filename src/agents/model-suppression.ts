import { resolveProviderBuiltInModelSuppression } from "../plugins/provider-runtime.js";
import { normalizeProviderId } from "./provider-id.js";

let _resolveProviderBuiltInModelSuppression: typeof resolveProviderBuiltInModelSuppression = (
  params,
) => resolveProviderBuiltInModelSuppression(params);

/** Reset provider-runtime hook references for model-suppression in isolated test workers.
 *  Pass no arguments to restore the original (real) function. */
export function resetModelSuppressionProviderRuntimeHooksForTest(hooks?: {
  resolveProviderBuiltInModelSuppression?: typeof resolveProviderBuiltInModelSuppression;
}): void {
  _resolveProviderBuiltInModelSuppression =
    hooks?.resolveProviderBuiltInModelSuppression ??
    ((params) => resolveProviderBuiltInModelSuppression(params));
}

function resolveBuiltInModelSuppression(params: { provider?: string | null; id?: string | null }) {
  const provider = normalizeProviderId(params.provider?.trim().toLowerCase() ?? "");
  const modelId = params.id?.trim().toLowerCase() ?? "";
  if (!provider || !modelId) {
    return undefined;
  }
  return _resolveProviderBuiltInModelSuppression({
    env: process.env,
    context: {
      env: process.env,
      provider,
      modelId,
    },
  });
}

export function shouldSuppressBuiltInModel(params: {
  provider?: string | null;
  id?: string | null;
}) {
  return resolveBuiltInModelSuppression(params)?.suppress ?? false;
}

export function buildSuppressedBuiltInModelError(params: {
  provider?: string | null;
  id?: string | null;
}): string | undefined {
  return resolveBuiltInModelSuppression(params)?.errorMessage;
}
