import type { DeliverableSpec } from "../produce/registry.js";

/**
 * P1.6.1 — Provider-scoped credentials preflight.
 *
 * Background. Before P1.6.1 the routing capability `needs_repo_execution`
 * carried a `requiredEnv` list of `BYBIT_API_KEY` / `OPENAI_API_KEY` /
 * `TELEGRAM_API_HASH`. Because that capability fires for almost every
 * code-execution turn (running a server, exec command, even unrelated
 * scaffold work), we ended up asking the user for Bybit / OpenAI / Telegram
 * keys on tasks that had no provider involvement (a quick `pnpm dev`, a
 * picture, a poem). The capability granularity was simply too coarse.
 *
 * Now the env requirement is attached to the *deliverable* instead. The
 * classifier may put a `provider` (or `integration`) string into
 * `deliverable.constraints` when the request is genuinely tied to a
 * specific external system; this module resolves that string into the
 * env keys we expect to find. Tasks without a provider signal raise
 * nothing — `pnpm dev` and "напиши стих" no longer trip the gate.
 *
 * Hard invariants (kept aligned with the P1.6 plan):
 *   - No new outcome / deliverable.kind / strategy. Extension is purely
 *     through free-form `deliverable.constraints` (the existing
 *     `record(string, unknown)` shape on the Zod schema).
 *   - The provider table lives in this single module — one JSON literal,
 *     not a scattered enum — so adding a new provider is a single PR.
 *   - Channel-agnostic: nothing here knows about Telegram / Max / webchat.
 *   - No prompt parsing. We only inspect structured fields the classifier
 *     already produced, which keeps `lint:routing:no-prompt-parsing` green.
 */

/**
 * Provider tag → required environment variables.
 *
 * Tags are normalized to lower-case before lookup so the classifier
 * can emit `"Bybit"` / `"BYBIT"` / `"bybit"` interchangeably without us
 * having to second-guess casing.
 *
 * Synonyms (e.g. `telegram` → `telegram_userbot`) are intentionally
 * limited to obvious aliases — the canonical key is what callers see in
 * `missing_credentials:*` ambiguities, so adding aliases never changes
 * the surface contract.
 */
export const PROVIDER_ENV_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = {
  bybit: ["BYBIT_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  telegram_userbot: ["TELEGRAM_API_HASH"],
};

const PROVIDER_TAG_ALIASES: Readonly<Record<string, string>> = {
  telegram: "telegram_userbot",
  tg: "telegram_userbot",
  tg_userbot: "telegram_userbot",
};

const PROVIDER_CONSTRAINT_KEYS = ["provider", "integration"] as const;

function normalizeProviderTag(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) {
    return undefined;
  }
  return PROVIDER_TAG_ALIASES[trimmed] ?? trimmed;
}

function readProviderTags(deliverable: DeliverableSpec | undefined): string[] {
  const constraints = deliverable?.constraints;
  if (!constraints) {
    return [];
  }
  const collected = new Set<string>();
  for (const key of PROVIDER_CONSTRAINT_KEYS) {
    const value = constraints[key];
    if (typeof value === "string") {
      const normalized = normalizeProviderTag(value);
      if (normalized) {
        collected.add(normalized);
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const normalized = normalizeProviderTag(entry);
        if (normalized) {
          collected.add(normalized);
        }
      }
    }
  }
  return Array.from(collected);
}

/**
 * Returns the env-var names declared by every provider tag advertised in
 * `deliverable.constraints`. Unknown tags resolve to no requirements
 * (so an experimental provider does not accidentally start fail-closing
 * users out of unrelated turns).
 */
export function listRequiredEnvForDeliverable(
  deliverable: DeliverableSpec | undefined,
): string[] {
  const tags = readProviderTags(deliverable);
  if (tags.length === 0) {
    return [];
  }
  const envNames = new Set<string>();
  for (const tag of tags) {
    const required = PROVIDER_ENV_REQUIREMENTS[tag];
    if (!required) {
      continue;
    }
    for (const envName of required) {
      envNames.add(envName);
    }
  }
  return Array.from(envNames).toSorted();
}

/**
 * Returns the env vars declared by the deliverable's provider tags that
 * are missing/blank in `envSnapshot` (defaulting to `process.env`).
 *
 * Mirrors `collectMissingRequiredEnvForCapabilities`'s shape so the
 * planner / classifier can consume both with the same union semantics.
 */
export function collectMissingRequiredEnvForDeliverable(params: {
  deliverable?: DeliverableSpec;
  envSnapshot?: NodeJS.ProcessEnv;
}): string[] {
  const required = listRequiredEnvForDeliverable(params.deliverable);
  if (required.length === 0) {
    return [];
  }
  const env = params.envSnapshot ?? process.env;
  const missing = new Set<string>();
  for (const envName of required) {
    const value = env[envName];
    if (typeof value !== "string" || value.trim().length === 0) {
      missing.add(envName);
    }
  }
  return Array.from(missing).toSorted();
}

/**
 * True when the deliverable contains any provider tag the table knows
 * about. Used by upstream callers (classifier + planner) to decide
 * whether the credentials gate should even be considered for a turn.
 */
export function deliverableHasKnownProvider(deliverable: DeliverableSpec | undefined): boolean {
  for (const tag of readProviderTags(deliverable)) {
    if (PROVIDER_ENV_REQUIREMENTS[tag]) {
      return true;
    }
  }
  return false;
}
