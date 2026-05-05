declare const MemoryEntryIdBrand: unique symbol;

/**
 * Branded string identifying a single entry in the operator's memory
 * store. Distinct from `IdentityId`, `SessionId`, `EffectId`, and
 * `EffectFamilyId` per invariant #16: a `MemoryEntryId` addresses a
 * single row inside an operator's memory (one episodic event or one
 * semantic entry), where the operator is identified by `IdentityId`
 * and the row is opaque to the rest of the platform.
 *
 * Format: `mem:<slug>` where slug matches `[A-Za-z0-9._-]+`.
 *
 * The choice of slug is implementation-defined (UUID, ULID, monotonic
 * counter, hash of payload — all valid as long as they fit the slug
 * grammar). Phase 1 ships only the type and factory; Phase 2's
 * `InMemoryMemoryStore` will generate concrete ids.
 *
 * Construct via `asMemoryEntryId(...)` which validates the format.
 * Direct casting from `string` is a TypeScript error and a runtime
 * bypass — use the factory.
 */
export type MemoryEntryId = string & { readonly [MemoryEntryIdBrand]: true };

const MEMORY_ENTRY_PREFIX = "mem:";
const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/u;

/**
 * Validate and brand a string as `MemoryEntryId`.
 *
 * Throws if:
 * - the value is empty
 * - the value lacks the `mem:` prefix
 * - the slug after the prefix is empty
 * - the slug contains characters outside `[A-Za-z0-9._-]`
 *
 * The thrown error includes a short description of which rule was
 * violated so callers can surface it in store-internal diagnostics.
 */
export function asMemoryEntryId(value: string): MemoryEntryId {
  if (value === "") {
    throw new Error("MemoryEntryId rejected: value is an empty string.");
  }
  if (!value.startsWith(MEMORY_ENTRY_PREFIX)) {
    throw new Error(
      `MemoryEntryId rejected: value must start with "mem:" (got "${value}").`,
    );
  }
  const slug = value.slice(MEMORY_ENTRY_PREFIX.length);
  if (slug === "") {
    throw new Error('MemoryEntryId rejected: slug after "mem:" is empty.');
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `MemoryEntryId rejected: slug must match [A-Za-z0-9._-]+ (got "${slug}").`,
    );
  }
  return value as MemoryEntryId;
}

/**
 * Type-guard for `MemoryEntryId`. Defensive against non-string inputs
 * so it can be used at boundaries where input is `unknown` (e.g.
 * persisted-store row decoders, JSON parsers).
 */
export function isMemoryEntryId(value: unknown): value is MemoryEntryId {
  if (typeof value !== "string") {
    return false;
  }
  if (!value.startsWith(MEMORY_ENTRY_PREFIX)) {
    return false;
  }
  const slug = value.slice(MEMORY_ENTRY_PREFIX.length);
  if (slug === "") {
    return false;
  }
  return SLUG_PATTERN.test(slug);
}
