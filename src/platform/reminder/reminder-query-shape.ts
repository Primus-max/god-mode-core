import { z } from "zod";

import { asIdentityId, isIdentityId, type IdentityId } from "../identity/identity-id.js";
import {
  asMemoryEntryId,
  isMemoryEntryId,
  type MemoryEntryId,
} from "../memory/memory-entry-id.js";

/**
 * Slice K — Reminder query consumer (Phase 2, types only).
 *
 * Pure-types module for the operator-facing reminder query —
 * «какой PDF я делал на прошлой неделе?» / «какую ветку создавал в
 * проекте X?» — implemented as a CONSUMER over LIT episodic slots
 * (slice E P5 / slice F P5 / cutover-3 P5 / cutover-4 P5). Slice K is
 * read-only: it neither emits new episodic events nor extends
 * `EpisodicEffectFamily` (sub-plan §10 acceptance #11).
 *
 * Per invariant #8, this module imports ONLY from
 * `src/platform/identity/`, `src/platform/memory/` (type-only), Zod,
 * and the standard library. It does NOT import from
 * `src/platform/decision/`, does NOT touch `src/platform/commitment/`
 * (the 5-contract frozen layer), and does NOT widen the
 * `MemoryStore` interface (Phase 4 will use N parallel `list({
 * identityId, effectFamily })` calls — sub-plan §10).
 *
 * Per invariants #5/#6, this module never receives a `RawUserTurn` /
 * `UserPrompt`. The `textHint` slot is STRUCTURAL — the
 * `IntentContractor` LLM populates it from a structured prompt slot
 * during classification (it is the only sanctioned raw-text reader)
 * and slice K consumes the resulting structured value. The
 * date-range fields (`from` / `until`) are ISO-8601 strings produced
 * by the contractor's temporal-expression resolution, NOT regex'd
 * out of operator text.
 */

declare const ReminderQueryShapeBrand: unique symbol;

/**
 * Inline copy of the ISO-8601 regex from
 * `src/platform/memory/episodic-memory-event.ts:389`. Duplicated
 * verbatim (rather than re-exported) so slice K imposes ZERO
 * touch on the slice-E source — `EpisodicEffectFamily` and the
 * `MemoryStore` interface remain BYTE-IDENTICAL (acceptance
 * criteria #10 + #11 of the slice K sub-plan).
 *
 * Validation chain: `IntentContractor` LLM → Zod `ISO8601_PATTERN`
 * (this regex) → `ReminderQueryShape.recallWindow.{from,until}` →
 * `RecallReminderTool` (Phase 4) reads structured value.
 */
const ISO8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

const IsoTimestampSchema = z
  .string()
  .min(1)
  .regex(ISO8601_PATTERN, {
    message: "expected an ISO-8601 timestamp",
  });

const NonEmptyString = z.string().min(1);

/**
 * Zod schema for an `IdentityId`. Validates the format via the
 * upstream `isIdentityId` guard, then re-brands via `asIdentityId`.
 * Mirrors `episodic-memory-event.ts`'s discipline so slice K's
 * decode boundary surfaces a clean rejection rather than letting a
 * malformed string slip in as a branded value.
 */
const IdentityIdSchema = z
  .string()
  .refine(isIdentityId, {
    message: "expected an IdentityId of the form `identity:<slug>`",
  })
  .transform((value) => asIdentityId(value));

/**
 * Zod schema for a `MemoryEntryId`. Same pattern as `IdentityIdSchema`
 * — validate via the upstream `isMemoryEntryId` guard, then re-brand.
 * Used by `ReminderEntry.payloadRef` so reminder rows surface the
 * memory store row id without the rest of the platform losing the
 * brand.
 */
const MemoryEntryIdSchema = z
  .string()
  .refine(isMemoryEntryId, {
    message: "expected a MemoryEntryId of the form `mem:<slug>`",
  })
  .transform((value) => asMemoryEntryId(value));

/**
 * Closed-set discriminator for the LIT episodic effect families
 * the reminder query may filter on. Mirrors the corresponding
 * `EpisodicEffectFamily` literals from
 * `src/platform/memory/episodic-memory-event.ts:45-56` exactly —
 * the duplication is intentional: slice K is a CONSUMER and adds
 * NO new episodic family (acceptance #11), so it borrows the
 * literals through structural compatibility rather than importing
 * the value-level union (which is type-only). The Zod
 * `effectFamilyFilter` schema below uses `z.enum(...)` over the
 * same string literals so a value-level closed-set check is
 * possible at decode time.
 *
 * Phase 4 will default the `effectFamilyFilter` to the four
 * user-facing families (`persistent_session`, `task`, `artifact`,
 * `repo`); `policy_*` variants are excluded from the default
 * (sub-plan §6, audit §d) but accepted here at the type layer so
 * a future operator-facing surface can opt them in explicitly.
 */
const EPISODIC_EFFECT_FAMILY_LITERALS = [
  "persistent_session",
  "subagent",
  "reminder",
  "artifact",
  "task",
  "policy_approval",
  "policy_budget",
  "policy_role",
  "policy_retry",
  "policy_escalation",
  "repo",
] as const;

type ReminderEffectFamilyLiteral = (typeof EPISODIC_EFFECT_FAMILY_LITERALS)[number];

const RecallWindowSchema = z
  .object({
    from: IsoTimestampSchema.optional(),
    until: IsoTimestampSchema.optional(),
  })
  .strict()
  .refine(
    (window) => {
      if (window.from === undefined || window.until === undefined) {
        return true;
      }
      // Both are validated ISO-8601 strings; lexicographic ordering
      // matches chronological ordering when timezone offsets agree.
      // Convert to Date for cross-timezone safety — the regex above
      // already guaranteed parseability.
      const fromMs = Date.parse(window.from);
      const untilMs = Date.parse(window.until);
      return fromMs <= untilMs;
    },
    {
      message: "recallWindow.from must be <= recallWindow.until",
    },
  );

/**
 * Closed structured query for the reminder consumer. Phase 4's
 * `RecallReminderTool` accepts this shape (and ONLY this shape) —
 * critically, it does NOT accept a free-form `query: string` field
 * (acceptance #4 + invariants #5/#6 reverse-test).
 *
 * Fields:
 * - `ownerIdentityId` — required. Reminder reads are identity-scoped;
 *   anonymous sessions fail-closed at the tool boundary (sub-plan
 *   acceptance #8). Phase 4 will inject this from the session context,
 *   NEVER from user input.
 * - `recallWindow.from` / `recallWindow.until` — optional ISO-8601
 *   strings produced by the `IntentContractor` LLM's
 *   temporal-expression resolution (sub-plan §2.6). When both are set,
 *   `from <= until` is enforced by Zod `.refine()`.
 * - `effectFamilyFilter` — optional closed-set list of episodic
 *   families to query. When set, MUST contain at least one entry
 *   (empty arrays are rejected — caller should OMIT the field to
 *   accept the Phase-4 default of the four user-facing families).
 *   Phase 4 issues N parallel `MemoryStore.list({identityId,
 *   effectFamily})` calls — one per family in this list.
 * - `textHint` — optional structural-only string. The contractor
 *   populates it from a closed prompt slot; slice K modules NEVER
 *   regex-match it. Phase 4 may UNION it into the result via
 *   `MemoryStore.recall({identityId, query})` — but that is a
 *   structured pass-through, not a phrase match.
 * - `limit` — optional positive integer cap on entries returned per
 *   family. Defaults applied at impl time (Phase 4).
 */
export type ReminderQueryShape = {
  readonly ownerIdentityId: IdentityId;
  readonly recallWindow?: {
    readonly from?: string;
    readonly until?: string;
  };
  readonly effectFamilyFilter?: readonly ReminderEffectFamilyLiteral[];
  readonly textHint?: string;
  readonly limit?: number;
  readonly [ReminderQueryShapeBrand]?: never;
};

/**
 * Closed-set unmatched reasons returned by `ReminderRecallResult`.
 * Phase 4 emits exactly one of these per failed sub-query in the
 * `unmatched` array. Closed-set discipline (#9 sentinel-proxy) so
 * downstream consumers can `switch` exhaustively.
 *
 * - `identity_unavailable` — anonymous session OR identity resolver
 *   failed. Phase 4 fails-closed before issuing any MemoryStore
 *   call (sub-plan acceptance #8).
 * - `recall_window_invalid` — the `IntentContractor` LLM produced a
 *   malformed temporal expression that failed Zod validation; Phase
 *   4 will fall through to a no-window query and emit this tag.
 * - `family_unavailable` — a single family's `list()` call rejected
 *   (e.g. backend transient failure). Per-family failure isolated;
 *   other families surface their entries (sub-plan §6
 *   defense-in-depth).
 * - `memory_store_unavailable` — the entire `MemoryStore` reference
 *   is missing (process startup ordering bug). Hard fault for the
 *   whole query.
 */
export const UNMATCHED_REASONS = [
  "identity_unavailable",
  "recall_window_invalid",
  "family_unavailable",
  "memory_store_unavailable",
] as const;

export type UnmatchedReason = (typeof UNMATCHED_REASONS)[number];

/**
 * One row in the reminder result set. Carries the originating
 * episodic family + ISO-8601 timestamp + a short structured
 * summary string, plus a `payloadRef` cross-reference back to the
 * underlying `EffectId` × `MemoryEntryId` row in the operator's
 * memory store. The tool layer (Phase 4) fills `summary` via closed
 * per-family reducers; the format is structured-text, not raw user
 * text, so #5/#6 hold.
 */
export type ReminderEntry = {
  readonly effectFamily: ReminderEffectFamilyLiteral;
  readonly occurredAt: string;
  readonly summary: string;
  readonly payloadRef: {
    readonly effectId: string;
    readonly memoryEntryId: MemoryEntryId;
  };
};

/**
 * Reminder recall result — the closed return shape from Phase 4's
 * `RecallReminderTool`. `entries` may be empty (acceptance #3 — empty
 * IS success: operator was answered with structurally correct «no
 * entries in window»). `unmatched` carries closed-set reasons for
 * any sub-query that did not contribute entries; this lets the
 * outbound coalescer (NEW-C) format a partial-result message
 * without losing observability of the failure mode.
 */
export type ReminderRecallResult = {
  readonly entries: readonly ReminderEntry[];
  readonly unmatched: readonly UnmatchedReason[];
};

const ReminderQueryShapeRawSchema = z
  .object({
    ownerIdentityId: IdentityIdSchema,
    recallWindow: RecallWindowSchema.optional(),
    effectFamilyFilter: z
      .array(z.enum(EPISODIC_EFFECT_FAMILY_LITERALS))
      .min(1, {
        message:
          "effectFamilyFilter must contain at least one entry (omit the field to accept the Phase-4 default)",
      })
      .readonly()
      .optional(),
    textHint: NonEmptyString.optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Zod schema for a `ReminderQueryShape`. Strict-mode (rejects
 * unknown keys) per closed-shape discipline. Annotated as
 * `z.ZodType<ReminderQueryShape>` so the emitted `.d.ts` does not
 * inline the private brand symbols of `IdentityId` / `MemoryEntryId`
 * (TS4023). The output object is frozen by an explicit `.transform()`
 * so callers cannot mutate the parsed result; this is the same
 * defense-in-depth pattern slice E uses for its `MemoryListQuery`
 * decode path.
 */
export const ReminderQueryShapeSchema: z.ZodType<ReminderQueryShape> =
  ReminderQueryShapeRawSchema.transform((value) => {
    const frozen: ReminderQueryShape = Object.freeze({
      ownerIdentityId: value.ownerIdentityId,
      ...(value.recallWindow !== undefined
        ? { recallWindow: Object.freeze({ ...value.recallWindow }) }
        : {}),
      ...(value.effectFamilyFilter !== undefined
        ? {
            effectFamilyFilter: Object.freeze([...value.effectFamilyFilter]),
          }
        : {}),
      ...(value.textHint !== undefined ? { textHint: value.textHint } : {}),
      ...(value.limit !== undefined ? { limit: value.limit } : {}),
    });
    return frozen;
  });

const ReminderEntryRawSchema = z
  .object({
    effectFamily: z.enum(EPISODIC_EFFECT_FAMILY_LITERALS),
    occurredAt: IsoTimestampSchema,
    summary: NonEmptyString,
    payloadRef: z
      .object({
        effectId: NonEmptyString,
        memoryEntryId: MemoryEntryIdSchema,
      })
      .strict(),
  })
  .strict();

export const ReminderEntrySchema: z.ZodType<ReminderEntry> =
  ReminderEntryRawSchema.transform((value) =>
    Object.freeze({
      effectFamily: value.effectFamily,
      occurredAt: value.occurredAt,
      summary: value.summary,
      payloadRef: Object.freeze({
        effectId: value.payloadRef.effectId,
        memoryEntryId: value.payloadRef.memoryEntryId,
      }),
    }),
  );

const ReminderRecallResultRawSchema = z
  .object({
    entries: z.array(ReminderEntryRawSchema).readonly(),
    unmatched: z.array(z.enum(UNMATCHED_REASONS)).readonly(),
  })
  .strict();

export const ReminderRecallResultSchema: z.ZodType<ReminderRecallResult> =
  ReminderRecallResultRawSchema.transform((value) =>
    Object.freeze({
      entries: Object.freeze(
        value.entries.map((entry) =>
          Object.freeze({
            effectFamily: entry.effectFamily,
            occurredAt: entry.occurredAt,
            summary: entry.summary,
            payloadRef: Object.freeze({
              effectId: entry.payloadRef.effectId,
              memoryEntryId: entry.payloadRef.memoryEntryId,
            }),
          }),
        ),
      ),
      unmatched: Object.freeze([...value.unmatched]),
    }),
  );

/**
 * Internal-use exhaustiveness helper for `UnmatchedReason`. Mirrors
 * the `assertNeverEpisodic` discipline from
 * `src/platform/memory/episodic-memory-event.ts` — a closed-set
 * `switch` over `UnmatchedReason` calls this in the default arm so
 * adding a new variant breaks the build of every consumer that did
 * NOT extend their switch.
 */
export function assertNeverUnmatchedReason(value: never): never {
  throw new Error(
    `assertNeverUnmatchedReason: unhandled UnmatchedReason variant ${JSON.stringify(value)}`,
  );
}
