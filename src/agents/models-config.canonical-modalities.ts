// V1-CLOSE T6 — apply canonical modality defaults to resolved provider model
// entries before serialisation to `~/.openclaw/agents/main/agent/models.json`.
// Charter row §4 T6.
//
// Why this seam exists:
// `~/.openclaw/agents/main/agent/models.json` declared 7 v1-fleet models with
// `input: ["text"]` despite vision support, which made the NEW-A modality
// filter (`src/agents/model-fallback-modality.ts:filterCandidatesByModality`)
// fail-open on every image-required turn. Pi-ai's upstream catalog already
// declares correct `input` modalities, but those declarations only flow into
// the written file when the provider's *implicit* discovery fires — which
// requires an env-key/profile that may not be configured locally. When the
// implicit catalog does NOT fire and the user's `cfg.models.providers` is the
// only source, missing-or-wrong `input` propagates straight through to disk.
//
// This module fills the gap conservatively:
// 1. Iterates every `provider.models[]` entry.
// 2. For entries whose `id` matches a canonical-default record:
//    - If `input` is missing/empty, fill from the canonical default.
// 3. If `input` is already declared (non-empty) the existing declaration
//    wins — user / pi-ai upstream remain authoritative on overlapping keys
//    (per charter "user file wins on overlapping keys").
// 4. Returns a `{ providers, applied: number }` tuple so the caller can emit
//    a one-line boot log naming how many entries were patched.
//
// `output` is intentionally NOT applied to runtime provider model entries —
// `ModelDefinitionSchema` in `src/config/zod-schema.core.ts` is `.strict()`
// and does not declare `output`, so attaching it would fail any downstream
// re-validation pass. The repo defaults still record `output` for each
// canonical entry as documentation + a future hook (the modality filter
// reads `input` only — see `src/agents/model-fallback-modality.ts:130`).
//
// The module is pure: no fs reads, no logging side effects, no clock reads.
// All configuration is supplied by the caller (the canonical defaults
// themselves are imported from `src/config/models.config.schema.ts`).

import {
  CANONICAL_MODEL_DEFAULTS,
  type CanonicalModelDefault,
  type CanonicalModelDefaultsFile,
} from "../config/models.config.schema.js";
import type { ProviderConfig } from "./models-config.providers.js";

type ProviderModel = NonNullable<ProviderConfig["models"]>[number];

/**
 * Index canonical defaults by lower-cased trimmed `id` for case-tolerant
 * lookup. Catalog entries in the wild use mixed casing
 * (`GPT-5.4` vs `gpt-5.4`); we normalise on lookup so a mis-cased user entry
 * still benefits from the canonical default.
 */
function indexCanonicalDefaults(
  defaults: CanonicalModelDefaultsFile,
): Map<string, CanonicalModelDefault> {
  const index = new Map<string, CanonicalModelDefault>();
  for (const entry of defaults.models) {
    const key = entry.id.toLowerCase().trim();
    if (!index.has(key)) {
      index.set(key, entry);
    }
  }
  return index;
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")
  );
}

function getModelId(model: ProviderModel | unknown): string {
  if (!model || typeof model !== "object") {
    return "";
  }
  const id = (model as { id?: unknown }).id;
  return typeof id === "string" ? id.trim().toLowerCase() : "";
}

export type ApplyCanonicalModelDefaultsResult = {
  /** Providers record with canonical defaults filled into gaps. */
  readonly providers: Record<string, ProviderConfig>;
  /**
   * Count of `provider.models[]` entries whose `input` and/or `output` was
   * filled in this pass. Includes BOTH `input`-only and `output`-only fills
   * (a single entry that had both filled counts as 1, not 2).
   */
  readonly applied: number;
  /**
   * Sorted list of `provider/model-id` pairs that received a fill. Used by
   * the caller's boot log so observability stays accurate.
   */
  readonly appliedKeys: readonly string[];
};

/**
 * Pure functional fill: returns a new providers record (input is not
 * mutated). Caller decides logging + write semantics.
 */
export function applyCanonicalModelDefaults(params: {
  readonly providers: Record<string, ProviderConfig>;
  readonly defaults?: CanonicalModelDefaultsFile;
}): ApplyCanonicalModelDefaultsResult {
  const defaults = params.defaults ?? CANONICAL_MODEL_DEFAULTS;
  const index = indexCanonicalDefaults(defaults);

  let applied = 0;
  const appliedKeys: string[] = [];
  const nextProviders: Record<string, ProviderConfig> = {};
  let providersChanged = false;

  for (const [providerKey, provider] of Object.entries(params.providers)) {
    const models = Array.isArray(provider.models) ? provider.models : null;
    if (!models || models.length === 0) {
      nextProviders[providerKey] = provider;
      continue;
    }

    let providerChanged = false;
    const nextModels = models.map((model) => {
      const lookupKey = getModelId(model);
      if (!lookupKey) {
        return model;
      }
      const canonical = index.get(lookupKey);
      if (!canonical) {
        return model;
      }

      const existingInput = (model as { input?: unknown }).input;
      const inputFilled = !isNonEmptyStringArray(existingInput);

      if (!inputFilled) {
        // User / upstream already declared a non-empty `input` — leave it.
        return model;
      }

      providerChanged = true;
      applied += 1;
      appliedKeys.push(`${providerKey}/${canonical.id}`);

      const next: ProviderModel = {
        ...model,
        input: [...canonical.input],
      };
      return next;
    });

    if (providerChanged) {
      providersChanged = true;
      nextProviders[providerKey] = { ...provider, models: nextModels };
    } else {
      nextProviders[providerKey] = provider;
    }
  }

  appliedKeys.sort();

  return {
    providers: providersChanged ? nextProviders : params.providers,
    applied,
    appliedKeys,
  };
}
