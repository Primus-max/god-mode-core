declare const IdentityIdBrand: unique symbol;

/**
 * Branded string identifying a single operator (or future tenant) across
 * channels. Distinct from `SessionId` per invariant #16: a `SessionId`
 * scopes a single conversation on a single channel; an `IdentityId`
 * groups one or more sessions under a single operator's memory + tasks.
 *
 * Format: `identity:<slug>` where slug matches `[A-Za-z0-9._-]+`.
 *
 * Construct via `asIdentityId(...)` which validates the format. Direct
 * casting from `string` is a TypeScript error and a runtime bypass — use
 * the factory.
 */
export type IdentityId = string & { readonly [IdentityIdBrand]: true };

const IDENTITY_PREFIX = "identity:";
const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/u;

/**
 * Validate and brand a string as `IdentityId`.
 *
 * Throws if:
 * - the value is empty
 * - the value lacks the `identity:` prefix
 * - the slug after the prefix is empty
 * - the slug contains characters outside `[A-Za-z0-9._-]`
 *
 * The thrown error includes a short description of which rule was
 * violated so callers can surface it in config-loading diagnostics.
 */
export function asIdentityId(value: string): IdentityId {
  if (value === "") {
    throw new Error("IdentityId rejected: value is an empty string.");
  }
  if (!value.startsWith(IDENTITY_PREFIX)) {
    throw new Error(
      `IdentityId rejected: value must start with "identity:" (got "${value}").`,
    );
  }
  const slug = value.slice(IDENTITY_PREFIX.length);
  if (slug === "") {
    throw new Error('IdentityId rejected: slug after "identity:" is empty.');
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `IdentityId rejected: slug must match [A-Za-z0-9._-]+ (got "${slug}").`,
    );
  }
  return value as IdentityId;
}

/**
 * Type-guard for `IdentityId`. Defensive against non-string inputs so it
 * can be used at boundaries where input is `unknown` (e.g. config
 * loaders, JSON parsers).
 */
export function isIdentityId(value: unknown): value is IdentityId {
  if (typeof value !== "string") {
    return false;
  }
  if (!value.startsWith(IDENTITY_PREFIX)) {
    return false;
  }
  const slug = value.slice(IDENTITY_PREFIX.length);
  if (slug === "") {
    return false;
  }
  return SLUG_PATTERN.test(slug);
}
