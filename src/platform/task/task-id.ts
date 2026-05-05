declare const TaskIdBrand: unique symbol;

/**
 * Branded string identifying a single per-`IdentityId` task in the
 * commitment-runtime task ledger (slice F). Distinct from
 * `IdentityId`, `SessionId`, `EffectId`, `EffectFamilyId`, and
 * `MemoryEntryId` per invariant #16: a `TaskId` addresses a single
 * row inside the operator's TASK ledger (`src/platform/task/`),
 * NOT the operator (that's `IdentityId`), NOT a session, NOT a
 * runtime effect, NOT a memory entry.
 *
 * Format: `task:<slug>` where slug matches `[A-Za-z0-9._-]+`.
 *
 * The choice of slug is implementation-defined (UUID, ULID, monotonic
 * counter, hash of payload — all valid as long as they fit the slug
 * grammar). Phase 2 ships only the type and factory; Phase 3's
 * `InMemoryTaskLedger` will generate concrete ids.
 *
 * Construct via `asTaskId(...)` which validates the format. Direct
 * casting from `string` is a TypeScript error and a runtime bypass
 * — use the factory.
 *
 * `TaskId` is a SIBLING brand to `MemoryEntryId` — slice F's task
 * ledger and slice E's memory store live in adjacent modules under
 * `src/platform/`, are joined on `(IdentityId × TaskId)` from slice
 * F Phase 5 onwards, and intentionally use distinct brands so a
 * caller cannot accidentally pass one where the other is expected.
 */
export type TaskId = string & { readonly [TaskIdBrand]: true };

const TASK_PREFIX = "task:";
const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/u;

/**
 * Validate and brand a string as `TaskId`.
 *
 * Throws if:
 * - the value is empty
 * - the value lacks the `task:` prefix
 * - the slug after the prefix is empty
 * - the slug contains characters outside `[A-Za-z0-9._-]`
 *
 * The thrown error includes a short description of which rule was
 * violated so callers can surface it in store-internal diagnostics.
 */
export function asTaskId(value: string): TaskId {
  if (value === "") {
    throw new Error("TaskId rejected: value is an empty string.");
  }
  if (!value.startsWith(TASK_PREFIX)) {
    throw new Error(
      `TaskId rejected: value must start with "task:" (got "${value}").`,
    );
  }
  const slug = value.slice(TASK_PREFIX.length);
  if (slug === "") {
    throw new Error('TaskId rejected: slug after "task:" is empty.');
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `TaskId rejected: slug must match [A-Za-z0-9._-]+ (got "${slug}").`,
    );
  }
  return value as TaskId;
}

/**
 * Type-guard for `TaskId`. Defensive against non-string inputs so
 * it can be used at boundaries where input is `unknown` (e.g.
 * persisted-store row decoders, JSON parsers).
 */
export function isTaskId(value: unknown): value is TaskId {
  if (typeof value !== "string") {
    return false;
  }
  if (!value.startsWith(TASK_PREFIX)) {
    return false;
  }
  const slug = value.slice(TASK_PREFIX.length);
  if (slug === "") {
    return false;
  }
  return SLUG_PATTERN.test(slug);
}
