import type { IdentitiesConfig } from "../../config/zod-schema.identities.js";
import { asIdentityId, type IdentityId } from "./identity-id.js";
import type { IdentityRecord } from "./identity-registry.js";
import { StaticIdentityRegistry } from "./static-identity-registry.js";

/**
 * Convert the validated `identities` section of `openclaw.json` into
 * an array of `IdentityRecord`s suitable for `StaticIdentityRegistry`.
 *
 * Each map key is validated through `asIdentityId(...)` — config errors
 * surface here at startup with a clear message rather than silently
 * passing through and breaking lookups later.
 *
 * Returns an empty array when the input is `undefined` (config has no
 * `identities` section); the registry then resolves nothing, which is
 * the correct anonymous-default for an unconfigured deploy.
 */
export function buildIdentityRecordsFromConfig(
  identities: IdentitiesConfig | undefined,
): IdentityRecord[] {
  if (!identities) {
    return [];
  }
  const records: IdentityRecord[] = [];
  for (const [rawId, value] of Object.entries(identities)) {
    let identityId: IdentityId;
    try {
      identityId = asIdentityId(rawId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `openclaw.json identities: key "${rawId}" is not a valid IdentityId — ${detail}`,
      );
    }
    records.push({
      identityId,
      displayName: value.displayName,
      mappings: value.mappings,
      // Phase 5 — Stage 4 (Role-based access). The schema defaults
      // `roles` to `[]`, so this property is always present after
      // Zod validation; threading it through keeps the
      // `RolePolicyReader` `roleResolver` wiring unbroken.
      roles: value.roles,
    });
  }
  return records;
}

/**
 * One-call helper: build a registry directly from the config section.
 * Throws if any identity-id key is malformed (per `asIdentityId`) or
 * the registry's own validation rejects the records (duplicate
 * mappings, empty externalIds — see `StaticIdentityRegistry`).
 */
export function loadIdentityRegistryFromConfig(
  identities: IdentitiesConfig | undefined,
): StaticIdentityRegistry {
  return new StaticIdentityRegistry({ records: buildIdentityRecordsFromConfig(identities) });
}
