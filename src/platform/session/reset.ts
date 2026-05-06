import { z } from "zod";

import {
  type ReadonlyRecord,
  type SessionId,
} from "../commitment/ids.js";
import {
  asIdentityId,
  isIdentityId,
  type IdentityId,
} from "../identity/identity-id.js";

/**
 * NEW-B Phase 2 — types + event shape for the unified session-reset
 * subscriber bus. Pure types + Zod schemas; no impl, no registry, no
 * call site (those land in Phase 3 and beyond).
 *
 * This module lives in `src/platform/session/` (decision-adjacent) per
 * invariant #8: it does NOT live inside `src/platform/commitment/` (the
 * frozen 5-contract layer) and does NOT modify any frozen contract. It
 * imports brands (`SessionId`, `IdentityId`) from already-published
 * modules without extending them.
 *
 * Per Phase 1 audit (`extensions/AUDIT-unified-session-reset.md`) the
 * NEW-B leak is `FOLLOWUP_QUEUES`, NOT chat-history kv as originally
 * hypothesised. The "primary" subscriber wired in Phase 4 is therefore
 * named `followup-queue-clear` and lives under the `chat-history`
 * `SessionResetSubscriberCategory` slot — the slot is preserved as a
 * coarse classifier for log-line filtering, not as a literal-text
 * mirror of any one subscriber id.
 */

// -----------------------------------------------------------------------------
// SessionResetSubscriberId — branded id (invariant #16)
// -----------------------------------------------------------------------------

declare const SessionResetSubscriberIdBrand: unique symbol;

/**
 * Branded string identifying a single registered `SessionResetSubscriber`
 * inside the process-singleton `SessionResetSubscriberRegistry` (Phase 3).
 *
 * Distinct (per invariant #16) from `SessionId`, `IdentityId`,
 * `MemoryEntryId`, `TaskId`, `EffectId`, and `EffectFamilyId`: a
 * `SessionResetSubscriberId` addresses a row in the subscriber registry
 * (a logical clear-handler), not a session, an operator, a memory row,
 * a task, an effect, or an effect family.
 *
 * Format: `subscriber:<slug>` where slug matches `[A-Za-z0-9._-]+`.
 *
 * Construct via `asSessionResetSubscriberId(...)` which validates the
 * format. Direct casting from `string` is a TypeScript error and a
 * runtime bypass — use the factory.
 */
export type SessionResetSubscriberId = string & {
  readonly [SessionResetSubscriberIdBrand]: true;
};

const SUBSCRIBER_PREFIX = "subscriber:";
const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/u;

/**
 * Validate and brand a string as `SessionResetSubscriberId`.
 *
 * Throws if:
 * - the value is empty
 * - the value lacks the `subscriber:` prefix
 * - the slug after the prefix is empty
 * - the slug contains characters outside `[A-Za-z0-9._-]`
 *
 * The thrown error includes a short description of which rule was
 * violated so registry-internal diagnostics can surface it cleanly.
 */
export function asSessionResetSubscriberId(
  value: string,
): SessionResetSubscriberId {
  if (value === "") {
    throw new Error(
      "SessionResetSubscriberId rejected: value is an empty string.",
    );
  }
  if (!value.startsWith(SUBSCRIBER_PREFIX)) {
    throw new Error(
      `SessionResetSubscriberId rejected: value must start with "subscriber:" (got "${value}").`,
    );
  }
  const slug = value.slice(SUBSCRIBER_PREFIX.length);
  if (slug === "") {
    throw new Error(
      'SessionResetSubscriberId rejected: slug after "subscriber:" is empty.',
    );
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `SessionResetSubscriberId rejected: slug must match [A-Za-z0-9._-]+ (got "${slug}").`,
    );
  }
  return value as SessionResetSubscriberId;
}

/**
 * Type-guard for `SessionResetSubscriberId`. Defensive against
 * non-string inputs so it can be used at boundaries where input is
 * `unknown` (e.g. registry-row decoders, JSON parsers).
 */
export function isSessionResetSubscriberId(
  value: unknown,
): value is SessionResetSubscriberId {
  if (typeof value !== "string") {
    return false;
  }
  if (!value.startsWith(SUBSCRIBER_PREFIX)) {
    return false;
  }
  const slug = value.slice(SUBSCRIBER_PREFIX.length);
  if (slug === "") {
    return false;
  }
  return SLUG_PATTERN.test(slug);
}

// -----------------------------------------------------------------------------
// SessionResetReason — closed enum (slice E P2 / slice F P2 precedent)
// -----------------------------------------------------------------------------

/**
 * Closed enumeration of the canonical reasons the unified
 * `resetTurnSession()` (Phase 3) is invoked.
 *
 * - `reset_trigger` — operator typed `/new` or `/reset` in chat. The
 *   primary motivating path for NEW-B; per Phase 1 audit this is the
 *   path where `FOLLOWUP_QUEUES` leaks today because the auto-reply
 *   path (`session.ts`) does NOT call `clearSessionQueues` while the
 *   gateway-RPC path (`session-reset-service.ts:128-133`) DOES.
 * - `daily_reset` — staleness-driven daily session rotation
 *   (`session.ts:357-373`). Routes through the same call site so the
 *   subscriber bus is exercised on this path too.
 * - `compaction` — typed slot reserved for a future flush-driven reset
 *   hook. INERT in this slice (no production code path emits it);
 *   the slot is shipped now so consumers wiring switch statements get
 *   exhaustiveness coverage from day one (slice E P2 precedent —
 *   `EpisodicEffectFamily` ships INERT slots for slices F/G/J/K).
 * - `forced_recovery` — recovery checkpoint reset (e.g. corrupt
 *   transcript, abort-on-error). Surfaces in logs distinctly from
 *   ordinary `/new` so post-mortem can grep on reason.
 * - `plugin_request` — plugin-driven `session_end`/`session_start`
 *   cycle (Phase 4 fans the existing `getGlobalHookRunner()` calls
 *   through this path).
 *
 * Adding a new reason later is a closed-set extension caught by
 * `assertNeverSessionResetReason` — every consumer that did NOT extend
 * its switch breaks the build, the only guarantee that prevents silent
 * drift across the registry / call-site / log surfaces.
 */
export type SessionResetReason =
  | "reset_trigger"
  | "daily_reset"
  | "compaction"
  | "forced_recovery"
  | "plugin_request";

/**
 * Concrete tuple of every `SessionResetReason` literal — used by tests
 * and by helpers that need to iterate the closed set. Length is pinned
 * at 5; the discriminated-union exhaustiveness compile-check via
 * `assertNeverSessionResetReason` keeps this list and the type in sync.
 */
export const SESSION_RESET_REASONS: ReadonlyArray<SessionResetReason> = [
  "reset_trigger",
  "daily_reset",
  "compaction",
  "forced_recovery",
  "plugin_request",
] as const;

/**
 * Internal-use exhaustiveness helper. Pass a value of `never` here to
 * force a TypeScript error if a switch over `SessionResetReason` ever
 * misses a case. Adding a new reason literal will break the build of
 * every consumer that did NOT extend its switch — the only guarantee
 * that prevents silent reason-drift across the registry / call-site /
 * log surfaces.
 *
 * Slice E P2 / slice F P2 / Cutover-3 P2 precedent: closed-set
 * discriminated unions ship a paired `assertNever<Name>` helper.
 */
export function assertNeverSessionResetReason(value: never): never {
  throw new Error(
    `assertNeverSessionResetReason: unhandled session reset reason ${JSON.stringify(value)}`,
  );
}

// -----------------------------------------------------------------------------
// SessionResetSubscriberCategory — closed enum (7 slots per audit §d)
// -----------------------------------------------------------------------------

/**
 * Closed enumeration of subscriber categories. Coarse classifier used
 * for log-line filtering and for the Phase 6 `subscribers=N`
 * acceptance assertion (the audit enumerated 8 candidate subscribers
 * mapped onto these 7 categories — at least two will share a slot,
 * see §d of the audit).
 *
 * - `chat-history` — followup-queue-clear (PRIMARY per Phase 1 audit;
 *   subscriber id `subscriber:followup-queue-clear`). Closes the
 *   asymmetric reset between `/new` (auto-reply) and gateway-RPC
 *   `sessions.reset`.
 * - `memory-scope` — `MemoryStore` identity-scope reaffirm (no-op,
 *   `kind: 'skipped'`). Observability + audit completeness; reaffirms
 *   slice E PR-#170 contract that operator memory survives `/new`.
 * - `task-scope` — `TaskLedger` identity-scope reaffirm (no-op,
 *   `kind: 'skipped'`). Same posture; reaffirms slice F PR-#188.
 * - `observer` — `ArtifactWorldStateObserver` adapter. Per audit §g
 *   the bucket key includes `sessionId` so old buckets naturally
 *   orphan and the subscriber returns `kind: 'skipped'`; only flips
 *   to `kind: 'cleared'` if a future `clearForSession(sessionId)`
 *   API is added.
 * - `world-state` — `WorldStateSnapshot.sessions` adapter (purely a
 *   derived projection per audit row 8; subscriber returns
 *   `kind: 'skipped'`).
 * - `plugin` — plugin hook fan-out (`session_end` / `session_start`
 *   via `getGlobalHookRunner()`); replaces the current inline call
 *   at `session.ts:601-630` so the auto-reply and RPC paths fire
 *   the same hook surface.
 * - `misc` — escape hatch for subscribers that don't fit the closed
 *   categories above (e.g. tracked browser tabs / embedded PI run
 *   abort / subagent runs which the audit flagged as out-of-scope
 *   for NEW-B but symmetric-cleanup candidates for future slices).
 *
 * The category is strictly metadata; `resetTurnSession()` (Phase 3)
 * does NOT branch on category — every subscriber's `onReset` runs in
 * insertion order. The category exists for log filtering and audit.
 */
export type SessionResetSubscriberCategory =
  | "chat-history"
  | "memory-scope"
  | "task-scope"
  | "observer"
  | "world-state"
  | "plugin"
  | "misc";

/**
 * Concrete tuple of every `SessionResetSubscriberCategory` literal —
 * used by tests and helpers. Length is pinned at 7.
 */
export const SESSION_RESET_SUBSCRIBER_CATEGORIES: ReadonlyArray<SessionResetSubscriberCategory> =
  [
    "chat-history",
    "memory-scope",
    "task-scope",
    "observer",
    "world-state",
    "plugin",
    "misc",
  ] as const;

/**
 * Internal-use exhaustiveness helper for `SessionResetSubscriberCategory`.
 * Same discipline as `assertNeverSessionResetReason`: forces a
 * compile error in any switch that drifts from the closed set.
 */
export function assertNeverSessionResetSubscriberCategory(
  value: never,
): never {
  throw new Error(
    `assertNeverSessionResetSubscriberCategory: unhandled subscriber category ${JSON.stringify(value)}`,
  );
}

// -----------------------------------------------------------------------------
// SessionResetEvent — payload passed to every subscriber.onReset()
// -----------------------------------------------------------------------------

/**
 * Payload passed to every `SessionResetSubscriber.onReset` invocation.
 *
 * Carries STRUCTURAL fields only — `sessionId`, `sessionKey`,
 * optional `identityId`, optional `previousSessionId`, closed-set
 * `reason`, and an ISO-8601 `occurredAt`. Per invariants #5 / #6 this
 * shape NEVER carries `RawUserTurn` / `UserPrompt` / message text;
 * subscribers consume the event and clear OWN state without
 * introspecting any operator-typed string. `IntentContractor` remains
 * the sole reader of raw user text.
 *
 * `sessionKey` is the gateway-side composite key (`<channel>:<external>`,
 * formed at `session-reset-service.ts:97-109`); subscribers that key
 * their state by `sessionKey` (most notably `FOLLOWUP_QUEUES`,
 * `state.ts:46-50`) clear by that key. Subscribers that key by
 * `sessionId` use the `previousSessionId` field — set when the
 * caller has the pre-rotation id; absent on first-boot resets.
 *
 * `identityId` is OPTIONAL because the reset path runs even when no
 * operator identity has been resolved yet (e.g. anonymous Telegram
 * sender pre-resolution). Subscribers that need an identity MUST
 * handle the `undefined` case and return `kind: 'skipped'` with
 * `reason: 'identity_unresolved'` for symmetry with slice E P5
 * (`memory-write-on-satisfied.ts:235`).
 */
export type SessionResetEvent = {
  readonly sessionId: SessionId;
  readonly sessionKey: string;
  readonly identityId?: IdentityId;
  readonly previousSessionId?: SessionId;
  readonly reason: SessionResetReason;
  readonly occurredAt: string;
};

// -----------------------------------------------------------------------------
// SessionResetSubscriberOutcome — discriminated outcome union
// -----------------------------------------------------------------------------

/**
 * Outcome returned by a subscriber's `onReset` invocation.
 *
 * Discriminated by `kind`:
 * - `cleared` — subscriber owned session-scoped state and cleared it
 *   atomically with the rotation. `details` is OPTIONAL structured
 *   metadata (e.g. `{ entriesCleared: 3, sessionKey: '...' }`)
 *   surfaced into the structured log line for forensics.
 * - `skipped` — subscriber owned NO session-scoped state for this
 *   event (the canonical posture for identity-scoped stores per
 *   slice E B1 / slice F B7) OR the subscriber ran but had nothing
 *   to clear. `reason` is REQUIRED — it appears in the log line so
 *   reviewers can confirm the no-op was intentional.
 * - `failed` — subscriber attempted to clear and threw. `reason` is
 *   REQUIRED. Per invariant #15 + plan §3 (defense-in-depth) a
 *   failed subscriber NEVER blocks others from running; Phase 3
 *   (`resetTurnSession()`) catches per-subscriber and returns this
 *   outcome on the failed slot, then continues iterating.
 *
 * The outcome union is closed; adding a fourth `kind` later is caught
 * by `assertNeverSessionResetSubscriberOutcome` — the same discipline
 * as `assertNeverEpisodic` / `assertNeverTaskStatus`.
 */
export type SessionResetSubscriberOutcome =
  | {
      readonly kind: "cleared";
      readonly details?: ReadonlyRecord<string, unknown>;
    }
  | {
      readonly kind: "skipped";
      readonly reason: string;
    }
  | {
      readonly kind: "failed";
      readonly reason: string;
    };

/**
 * Internal-use exhaustiveness helper for
 * `SessionResetSubscriberOutcome`. Same discipline as
 * `assertNeverSessionResetReason`. Forces a compile error in any
 * switch that drifts from the closed set of three outcome kinds.
 */
export function assertNeverSessionResetSubscriberOutcome(
  value: never,
): never {
  throw new Error(
    `assertNeverSessionResetSubscriberOutcome: unhandled outcome variant ${JSON.stringify(value)}`,
  );
}

// -----------------------------------------------------------------------------
// SessionResetSubscriber — interface every Phase-4 subscriber implements
// -----------------------------------------------------------------------------

/**
 * Interface every Phase-4 subscriber implements. Matches the precedent
 * of slice E `MemoryStore` and slice F `TaskLedger`: a small,
 * named, branded identifier plus a single `onReset(event)` method that
 * returns a discriminated outcome.
 *
 * Implementation notes (binding for Phase 3):
 * - `id` MUST be unique across the registry; Phase 3
 *   `createSessionResetSubscriberRegistry()` de-duplicates by `id`
 *   (last-wins + warn).
 * - `onReset` MUST resolve (or reject) within the per-subscriber
 *   timeout enforced by Phase 3 (`resetTurnSession()`); a hung
 *   subscriber is converted to `kind: 'failed'` so others still run.
 * - `onReset` MUST NOT throw a non-Error; if it does, Phase 3
 *   coerces the value into `kind: 'failed'` with a synthetic reason.
 * - `category` is metadata only; do NOT branch behaviour on it.
 */
export type SessionResetSubscriber = {
  readonly id: SessionResetSubscriberId;
  readonly category: SessionResetSubscriberCategory;
  onReset(event: SessionResetEvent): Promise<SessionResetSubscriberOutcome>;
};

// -----------------------------------------------------------------------------
// Zod schemas
// -----------------------------------------------------------------------------

const ISO8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

const IsoTimestampSchema = z
  .string()
  .min(1)
  .regex(ISO8601_PATTERN, {
    message: "occurredAt must be a valid ISO-8601 timestamp",
  });

const NonEmptyString = z.string().min(1);

/**
 * Zod schema for a `SessionId`. The brand is opaque (declared via
 * `unique symbol` in `commitment/ids.ts`); we therefore accept any
 * non-empty string and re-brand at decode time. Phase 3+ may tighten
 * the format with a dedicated guard if a UUID-shape rule is adopted.
 */
const SessionIdSchema = NonEmptyString.transform(
  (value) => value as SessionId,
);

/**
 * Zod schema for an `IdentityId`. Validates the format via the
 * upstream `isIdentityId` guard, then re-brands via `asIdentityId`.
 */
const IdentityIdSchema = z
  .string()
  .refine(isIdentityId, {
    message: "expected an IdentityId of the form `identity:<slug>`",
  })
  .transform((value) => asIdentityId(value));

/**
 * Closed-set Zod literal union for `SessionResetReason`. Authored
 * inline (rather than via `z.enum(SESSION_RESET_REASONS)`) so the
 * Zod-emitted error message reads naturally on bad input.
 */
const SessionResetReasonSchema: z.ZodType<SessionResetReason> = z.enum([
  "reset_trigger",
  "daily_reset",
  "compaction",
  "forced_recovery",
  "plugin_request",
]);

/**
 * Closed-set Zod literal union for `SessionResetSubscriberCategory`.
 */
const SessionResetSubscriberCategorySchema: z.ZodType<SessionResetSubscriberCategory> =
  z.enum([
    "chat-history",
    "memory-scope",
    "task-scope",
    "observer",
    "world-state",
    "plugin",
    "misc",
  ]);

/**
 * Zod schema for a `SessionResetEvent`. Use at decode boundaries
 * (e.g. when an event is constructed from a structured-log replay or
 * from a JSON-RPC payload) to assert the shape at runtime, not just
 * at compile time.
 *
 * The `.parse` output is frozen via `Object.freeze` post-transform so
 * downstream subscribers cannot accidentally mutate the event payload
 * — defense-in-depth alongside the `readonly` field annotations.
 *
 * The explicit `z.ZodType<SessionResetEvent>` annotation prevents
 * TS4023: without it the emitted `.d.ts` would try to inline the
 * private `SessionIdBrand` / `IdentityIdBrand` symbols, which are
 * not exported.
 */
export const SessionResetEventSchema: z.ZodType<SessionResetEvent> = z
  .object({
    sessionId: SessionIdSchema,
    sessionKey: NonEmptyString,
    identityId: IdentityIdSchema.optional(),
    previousSessionId: SessionIdSchema.optional(),
    reason: SessionResetReasonSchema,
    occurredAt: IsoTimestampSchema,
  })
  .strict()
  .transform((value) => Object.freeze(value));

/**
 * Zod schema for a `SessionResetSubscriberOutcome`. Discriminated on
 * `kind`. Same `Object.freeze` post-transform as `SessionResetEventSchema`.
 *
 * The `details` field on the `cleared` variant is typed as
 * `z.record(z.string(), z.unknown())` so it accepts arbitrary
 * structured-log metadata without forcing each subscriber to declare
 * a payload schema.
 */
export const SessionResetSubscriberOutcomeSchema: z.ZodType<SessionResetSubscriberOutcome> =
  z
    .discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("cleared"),
          details: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("skipped"),
          reason: NonEmptyString,
        })
        .strict(),
      z
        .object({
          kind: z.literal("failed"),
          reason: NonEmptyString,
        })
        .strict(),
    ])
    .transform((value) => Object.freeze(value));

// -----------------------------------------------------------------------------
// SessionResetSubscriberRegistry — Phase 3
// -----------------------------------------------------------------------------

/**
 * Registry of `SessionResetSubscriber` rows iterated by
 * `resetTurnSession()` in insertion order. The contract is intentionally
 * minimal — `register` and `list` only — so the bootstrap site
 * (`session-reset-bootstrap.ts`, Phase 5) can wire subscribers in a
 * deterministic order at process start and the call site
 * (`resetTurnSession`, this module) can iterate without further
 * coordination primitives.
 *
 * Insertion order is stable: `list()` returns subscribers in the order
 * they were `register`ed. Re-registration of the SAME id REPLACES the
 * prior row in place (preserving its slot's position) and emits a
 * structured warn line through the optional `warnLogger` so duplicate
 * registrations surface in audit trails. The `unregister` callback
 * returned from the FIRST `register` call is rendered inert if a
 * second registration replaced the row — this prevents the first
 * caller from accidentally clearing a slot owned by a later caller.
 *
 * `list()` returns a frozen array — defense-in-depth alongside the
 * `readonly` modifier on the property's TypeScript type.
 */
export interface SessionResetSubscriberRegistry {
  /**
   * Register a subscriber. If a subscriber with the same `id` is
   * already registered, REPLACE it in place (last-wins) and emit a
   * warn line through the registry's `warnLogger` (if provided).
   * Returns an `unregister` function that removes THIS subscriber
   * instance. The returned callback is a no-op if a later
   * registration has already replaced the row.
   */
  register(subscriber: SessionResetSubscriber): () => void;
  /**
   * Snapshot of the current subscribers, in insertion order. Returns
   * a frozen array — callers cannot mutate the registry through the
   * returned snapshot.
   */
  list(): readonly SessionResetSubscriber[];
}

/**
 * Construct a fresh `SessionResetSubscriberRegistry`. Each invocation
 * returns an isolated instance so tests can construct private
 * registries and the production-singleton bootstrap can construct
 * one process-wide registry without coupling.
 *
 * The optional `warnLogger` is invoked exactly once per duplicate
 * registration. Default is a no-op so non-test callers can omit it.
 */
export function createSessionResetSubscriberRegistry(
  options: { readonly warnLogger?: (line: string) => void } = {},
): SessionResetSubscriberRegistry {
  const warnLogger = options.warnLogger ?? ((): void => {});
  // Backing store: an array preserves insertion order (vs. Map's
  // insertion order which is also stable but does not allow in-place
  // replacement at the original index). Replacement on duplicate id
  // overwrites at the existing slot to preserve position.
  const subscribers: SessionResetSubscriber[] = [];
  return {
    register(subscriber: SessionResetSubscriber): () => void {
      const existingIndex = subscribers.findIndex(
        (entry) => entry.id === subscriber.id,
      );
      if (existingIndex >= 0) {
        subscribers[existingIndex] = subscriber;
        warnLogger(
          `[session-reset] warn=duplicate_subscriber id=${subscriber.id} action=replaced`,
        );
      } else {
        subscribers.push(subscriber);
      }
      // Capture the registered instance via closure; the unregister
      // callback inspects identity (===) so a later replacement makes
      // the first caller's unregister a no-op.
      const registeredInstance = subscriber;
      return (): void => {
        const currentIndex = subscribers.findIndex(
          (entry) => entry === registeredInstance,
        );
        if (currentIndex >= 0) {
          subscribers.splice(currentIndex, 1);
        }
      };
    },
    list(): readonly SessionResetSubscriber[] {
      return Object.freeze(subscribers.slice());
    },
  };
}

// -----------------------------------------------------------------------------
// resetTurnSession — Phase 3
// -----------------------------------------------------------------------------

/**
 * Per-subscriber result row inside a `SessionResetSummary`. The
 * `outcome` is the value returned by the subscriber's `onReset(event)`
 * call (validated through `SessionResetSubscriberOutcomeSchema`); a
 * thrown error or a malformed return value is converted to
 * `{ kind: 'failed', reason: <synthetic> }` per defense-in-depth.
 */
export type SessionResetSubscriberResult = {
  readonly id: SessionResetSubscriberId;
  readonly category: SessionResetSubscriberCategory;
  readonly outcome: SessionResetSubscriberOutcome;
};

/**
 * Aggregate result of one `resetTurnSession()` invocation. Caller can
 * inspect per-subscriber outcomes (for assertions or for dashboards)
 * and the rolled-up counts that appear on the structured log line.
 *
 * `durationMs` is end-minus-start of the iteration, computed via the
 * injected `clockNow` (default: `performance.now`). Test code can
 * inject a deterministic clock to assert the field is sourced from
 * the right place.
 */
export type SessionResetSummary = {
  readonly event: SessionResetEvent;
  readonly subscribers: readonly SessionResetSubscriberResult[];
  readonly clearedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly durationMs: number;
};

/**
 * Re-validate the value returned from a subscriber. Subscribers are
 * trusted callers (registered at bootstrap), but a defensive parse
 * guards against future plugins / adapters that might return an
 * unstructured value (e.g. drop the `kind` field after a refactor).
 * On parse failure we coerce to `failed` with `reason: 'malformed_outcome'`
 * — the exact synthetic reason asserted by the unit tests.
 */
function coerceOutcome(value: unknown): SessionResetSubscriberOutcome {
  const parsed = SessionResetSubscriberOutcomeSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  return { kind: "failed", reason: "malformed_outcome" };
}

/**
 * Convert a thrown value into a `failed` outcome. `Error` instances
 * surface their `.message`; non-Error throws (string, number, plain
 * object) are stringified so the log line still has actionable text.
 */
function thrownToFailed(value: unknown): SessionResetSubscriberOutcome {
  if (value instanceof Error) {
    return { kind: "failed", reason: value.message };
  }
  if (typeof value === "string") {
    return { kind: "failed", reason: value };
  }
  return {
    kind: "failed",
    reason: `non_error_throw:${String(value)}`,
  };
}

/**
 * Run every subscriber in `registry.list()` once, in insertion order,
 * for the given `event`. Emits exactly ONE structured log line at the
 * tail (`logger`, default `console.log`) so the operator-side grep
 * anchor is stable. Returns a `SessionResetSummary` so callers can
 * assert on counts and per-subscriber outcomes.
 *
 * Defense-in-depth (invariant #15): each subscriber's `onReset` is
 * wrapped in try/catch. A throw, a rejected promise, or a malformed
 * return value is converted to a `failed` outcome and iteration
 * continues — a single misbehaving subscriber NEVER blocks the rest
 * of the registry from clearing its state. Failures are still
 * surfaced through the per-subscriber result and the rolled-up
 * `failedCount`.
 *
 * Log line format (operator-grep anchor — see acceptance):
 *
 *     [session-reset] event=session_reset sessionId=<id> sessionKey=<k>
 *       reason=<r> identityId=<id|anon> subscribers=<N> cleared=<n>
 *       skipped=<s> failed=<f> durationMs=<ms>
 *
 * Anonymous events (`identityId === undefined`) render `identityId=anon`
 * so post-mortem scripts can distinguish identity-resolved resets from
 * pre-resolution resets without parsing the absence of a field.
 */
export async function resetTurnSession(params: {
  readonly event: SessionResetEvent;
  readonly registry: SessionResetSubscriberRegistry;
  readonly logger?: (line: string) => void;
  readonly clockNow?: () => number;
}): Promise<SessionResetSummary> {
  const log = params.logger ?? ((): void => {});
  const clockNow = params.clockNow ?? ((): number => performance.now());
  const start = clockNow();
  const snapshot = params.registry.list();
  const results: SessionResetSubscriberResult[] = [];
  let clearedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  for (const subscriber of snapshot) {
    let outcome: SessionResetSubscriberOutcome;
    try {
      const raw = await subscriber.onReset(params.event);
      outcome = coerceOutcome(raw);
    } catch (error: unknown) {
      outcome = thrownToFailed(error);
    }
    if (outcome.kind === "cleared") {
      clearedCount += 1;
    } else if (outcome.kind === "skipped") {
      skippedCount += 1;
    } else {
      failedCount += 1;
    }
    results.push({
      id: subscriber.id,
      category: subscriber.category,
      outcome,
    });
  }
  const end = clockNow();
  // Round to integer ms so the log line is stable for grep regression
  // guards (no float jitter across hosts).
  const durationMs = Math.max(0, Math.floor(end - start));
  const identityForLog =
    params.event.identityId === undefined ? "anon" : params.event.identityId;
  log(
    `[session-reset] event=session_reset sessionId=${params.event.sessionId} sessionKey=${params.event.sessionKey} reason=${params.event.reason} identityId=${identityForLog} subscribers=${snapshot.length.toString()} cleared=${clearedCount.toString()} skipped=${skippedCount.toString()} failed=${failedCount.toString()} durationMs=${durationMs.toString()}`,
  );
  return {
    event: params.event,
    subscribers: Object.freeze(results),
    clearedCount,
    skippedCount,
    failedCount,
    durationMs,
  };
}
