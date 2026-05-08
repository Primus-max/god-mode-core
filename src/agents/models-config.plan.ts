import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isRecord } from "../utils.js";
import { applyCanonicalModelDefaults } from "./models-config.canonical-modalities.js";
import {
  mergeProviders,
  mergeWithExistingProviderSecrets,
  type ExistingProviderConfig,
} from "./models-config.merge.js";
import {
  applyNativeStreamingUsageCompat,
  enforceSourceManagedProviderSecrets,
  normalizeProviders,
  resolveImplicitProviders,
  type ProviderConfig,
} from "./models-config.providers.js";

const log = createSubsystemLogger("models-config");

// Boot-log: only emit the canonical-defaults summary line ONCE per process per
// distinct "summary signature" (count + sorted keys). Without this guard a hot
// loop of `ensureOpenClawModelsJson` calls would spam the log on every cache
// miss. The signature key includes the keys themselves so a genuinely new fill
// (e.g. user added a new canonical model) re-emits.
const CANONICAL_DEFAULTS_LOGGED_SIGNATURES = new Set<string>();

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;

export type ModelsJsonPlan =
  | {
      action: "skip";
    }
  | {
      action: "noop";
    }
  | {
      action: "write";
      contents: string;
    };

async function resolveProvidersForModelsJson(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<Record<string, ProviderConfig>> {
  const { cfg, agentDir, env } = params;
  const explicitProviders = cfg.models?.providers ?? {};
  const implicitProviders = await resolveImplicitProviders({
    agentDir,
    config: cfg,
    env,
    explicitProviders,
  });
  return mergeProviders({
    implicit: implicitProviders,
    explicit: explicitProviders,
  });
}

function resolveExplicitBaseUrlProviders(
  providers: OpenClawConfig["models"] | undefined,
): ReadonlySet<string> {
  return new Set(
    Object.entries(providers?.providers ?? {})
      .map(([key, provider]) => [key.trim(), provider] as const)
      .filter(
        ([key, provider]) =>
          Boolean(key) && typeof provider?.baseUrl === "string" && provider.baseUrl.trim(),
      )
      .map(([key]) => key),
  );
}

async function resolveProvidersForMode(params: {
  mode: NonNullable<ModelsConfig["mode"]>;
  existingParsed: unknown;
  providers: Record<string, ProviderConfig>;
  secretRefManagedProviders: ReadonlySet<string>;
  explicitBaseUrlProviders: ReadonlySet<string>;
}): Promise<Record<string, ProviderConfig>> {
  if (params.mode !== "merge") {
    return params.providers;
  }
  const existing = params.existingParsed;
  if (!isRecord(existing) || !isRecord(existing.providers)) {
    return params.providers;
  }
  const existingProviders = existing.providers as Record<
    string,
    NonNullable<ModelsConfig["providers"]>[string]
  >;
  return mergeWithExistingProviderSecrets({
    nextProviders: params.providers,
    existingProviders: existingProviders as Record<string, ExistingProviderConfig>,
    secretRefManagedProviders: params.secretRefManagedProviders,
    explicitBaseUrlProviders: params.explicitBaseUrlProviders,
  });
}

export async function planOpenClawModelsJson(params: {
  cfg: OpenClawConfig;
  sourceConfigForSecrets?: OpenClawConfig;
  agentDir: string;
  env: NodeJS.ProcessEnv;
  existingRaw: string;
  existingParsed: unknown;
}): Promise<ModelsJsonPlan> {
  const { cfg, agentDir, env } = params;
  const providers = await resolveProvidersForModelsJson({ cfg, agentDir, env });

  if (Object.keys(providers).length === 0) {
    return { action: "skip" };
  }

  const mode = cfg.models?.mode ?? "merge";
  const secretRefManagedProviders = new Set<string>();
  const normalizedProviders =
    normalizeProviders({
      providers,
      agentDir,
      env,
      secretDefaults: cfg.secrets?.defaults,
      sourceProviders: params.sourceConfigForSecrets?.models?.providers,
      sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
      secretRefManagedProviders,
    }) ?? providers;
  const mergedProviders = await resolveProvidersForMode({
    mode,
    existingParsed: params.existingParsed,
    providers: normalizedProviders,
    secretRefManagedProviders,
    explicitBaseUrlProviders: resolveExplicitBaseUrlProviders(cfg.models),
  });
  const secretEnforcedProviders =
    enforceSourceManagedProviderSecrets({
      providers: mergedProviders,
      sourceProviders: params.sourceConfigForSecrets?.models?.providers,
      sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
      secretRefManagedProviders,
    }) ?? mergedProviders;
  const compatProviders = applyNativeStreamingUsageCompat(secretEnforcedProviders);
  // V1-CLOSE T6 — canonical modality defaults from `config/models.default.json`
  // (mirrored as `CANONICAL_MODEL_DEFAULTS` in `src/config/models.config.schema.ts`).
  // Fills `input` only on entries whose `id` matches a canonical record AND
  // whose existing `input` is missing/empty. Existing user / pi-ai upstream
  // declarations are preserved verbatim — see the module header for rationale.
  const canonical = applyCanonicalModelDefaults({ providers: compatProviders });
  if (canonical.applied > 0) {
    const signature = `${canonical.applied}|${canonical.appliedKeys.join(",")}`;
    if (!CANONICAL_DEFAULTS_LOGGED_SIGNATURES.has(signature)) {
      CANONICAL_DEFAULTS_LOGGED_SIGNATURES.add(signature);
      log.info(
        `[canonical-modalities] applied=${canonical.applied} entries=${canonical.appliedKeys.join(",")}`,
      );
    }
  }
  const finalProviders = canonical.providers;
  const nextContents = `${JSON.stringify({ providers: finalProviders }, null, 2)}\n`;

  if (params.existingRaw === nextContents) {
    return { action: "noop" };
  }

  return {
    action: "write",
    contents: nextContents,
  };
}

/**
 * Test-only: clear the per-process boot-log dedupe set. Production code never
 * calls this; tests use it to assert log emission across multiple plan calls.
 */
export function __resetCanonicalDefaultsLogDedupeForTest(): void {
  CANONICAL_DEFAULTS_LOGGED_SIGNATURES.clear();
}
