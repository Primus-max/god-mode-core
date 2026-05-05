import { z } from "zod";

import { asIdentityId, isIdentityId, type IdentityId } from "../identity/identity-id.js";

import { asTaskId, isTaskId, type TaskId } from "./task-id.js";

/**
 * Closed enumeration of task lifecycle states. The state-machine
 * canonical legal transitions per sub-plan §6 are:
 *   - `open → in_progress`, `open → cancelled`
 *   - `in_progress → completed`, `in_progress → cancelled`,
 *     `in_progress → failed`
 *   - `completed`, `cancelled`, `failed` are TERMINAL — no
 *     transition out is allowed.
 *
 * Slice F Phase 3+ enforces these transitions at the impl boundary;
 * Phase 2 enforces the same predicate at the Zod-schema boundary
 * via `TaskUpdatePatchSchema`'s refinement when a caller supplies
 * BOTH `currentStatus` and `status` fields on the patch.
 */
export type TaskStatus =
  | "open"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * Concrete tuple of every `TaskStatus` literal — used by tests and
 * by helpers that need to iterate the closed set. Length is
 * pinned at 5; the discriminated-union exhaustiveness compile-check
 * via `assertNeverTaskStatus` keeps this list and the type in sync.
 */
export const TASK_STATUSES: ReadonlyArray<TaskStatus> = [
  "open",
  "in_progress",
  "completed",
  "cancelled",
  "failed",
] as const;

/**
 * Internal-use exhaustiveness helper. Pass a value of `never` here
 * to force a TypeScript error if a switch over `TaskStatus` ever
 * misses a case. Adding a new status literal will break the build
 * of every consumer that did NOT extend their switch — the only
 * guarantee that prevents silent state drift across slice F's
 * ledger / hook / contractor layers.
 */
export function assertNeverTaskStatus(value: never): never {
  throw new Error(
    `assertNeverTaskStatus: unhandled task status ${JSON.stringify(value)}`,
  );
}

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

/**
 * `true` iff `status` is a terminal lifecycle state — no further
 * transition out is allowed.
 */
export function isTaskTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

const ALLOWED_TRANSITIONS: ReadonlyMap<TaskStatus, ReadonlySet<TaskStatus>> = new Map([
  ["open", new Set<TaskStatus>(["in_progress", "cancelled"])],
  ["in_progress", new Set<TaskStatus>(["completed", "cancelled", "failed"])],
  ["completed", new Set<TaskStatus>()],
  ["cancelled", new Set<TaskStatus>()],
  ["failed", new Set<TaskStatus>()],
]);

/**
 * State-machine guard. `true` iff a transition from `current` to
 * `next` is canonical per the sub-plan §6 table. Returns `false`
 * for same-status (`open → open`, etc.) and for ANY transition out
 * of a terminal state.
 *
 * The 5×5 transition matrix has exactly 5 allowed cells:
 *   - `open → in_progress`
 *   - `open → cancelled`
 *   - `in_progress → completed`
 *   - `in_progress → cancelled`
 *   - `in_progress → failed`
 * Every other cell (20) returns `false`.
 */
export function isTaskTransitionAllowed(current: TaskStatus, next: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS.get(current)?.has(next) ?? false;
}

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
 * Surfaces a clear rejection at decode time rather than letting a
 * malformed string slip in as a branded value.
 */
const IdentityIdSchema = z
  .string()
  .refine(isIdentityId, {
    message: "expected an IdentityId of the form `identity:<slug>`",
  })
  .transform((value) => asIdentityId(value));

/**
 * Zod schema for a `TaskId`. Mirrors `IdentityIdSchema` discipline:
 * validate via the upstream `isTaskId` guard, then re-brand via
 * `asTaskId`. Use at decode boundaries (e.g. when a persistent-store
 * row is read back from JSON, or when an LLM-built payload arrives).
 */
const TaskIdSchema = z
  .string()
  .refine(isTaskId, {
    message: "expected a TaskId of the form `task:<slug>`",
  })
  .transform((value) => asTaskId(value));

const TaskStatusSchema = z.enum(["open", "in_progress", "completed", "cancelled", "failed"]);

/**
 * A single task row in the commitment-runtime task ledger. Distinct
 * from the frozen `TaskContract` (`src/platform/decision/contracts.ts`)
 * — that is a planner-input shape; this is a cross-`/new` ledger
 * entry keyed by `IdentityId`. The two coexist; slice F never
 * imports `TaskContract`.
 *
 * Required fields are populated at create time. Optional fields:
 * - `completedAt` is set when status becomes a terminal state.
 * - `result` is operator-facing summary text on completion / failure
 *   (e.g. "Posted retrospective to #eng-leads", "Upstream API timed out").
 * - `sourceEffectFamily` / `sourceEffectId` link the row back to the
 *   commitment-runtime attestation that created it (slice F Phase 5).
 */
export type TaskRecord = {
  readonly id: TaskId;
  readonly ownerIdentityId: IdentityId;
  readonly label: string;
  readonly status: TaskStatus;
  readonly summary: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly result?: string;
  readonly sourceEffectFamily?: string;
  readonly sourceEffectId?: string;
};

/**
 * Zod schema for `TaskRecord`. The explicit `z.ZodType<TaskRecord>`
 * annotation prevents TS4023 — without it the emitted `.d.ts` would
 * try to inline the private brand symbols from `task-id.ts` /
 * `identity-id.ts`, which are not exported.
 */
export const TaskRecordSchema: z.ZodType<TaskRecord> = z
  .object({
    id: TaskIdSchema,
    ownerIdentityId: IdentityIdSchema,
    label: NonEmptyString,
    status: TaskStatusSchema,
    summary: NonEmptyString,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema.optional(),
    result: NonEmptyString.optional(),
    sourceEffectFamily: NonEmptyString.optional(),
    sourceEffectId: NonEmptyString.optional(),
  })
  .strict();

/**
 * Subset of `TaskRecord` accepted by `TaskLedger.create`. The ledger
 * (NOT the caller) assigns `id`, `status` (always `open` at create
 * time), `createdAt`, `updatedAt`. A caller cannot smuggle those in
 * — the schema is `.strict()` and rejects unknown / disallowed keys.
 */
export type TaskCreateInput = {
  readonly ownerIdentityId: IdentityId;
  readonly label: string;
  readonly summary: string;
  readonly sourceEffectFamily?: string;
  readonly sourceEffectId?: string;
};

export const TaskCreateInputSchema: z.ZodType<TaskCreateInput> = z
  .object({
    ownerIdentityId: IdentityIdSchema,
    label: NonEmptyString,
    summary: NonEmptyString,
    sourceEffectFamily: NonEmptyString.optional(),
    sourceEffectId: NonEmptyString.optional(),
  })
  .strict();

/**
 * Patch shape for `TaskLedger.update`. Every field is optional but
 * the patch must carry at least one mutable field — an empty patch
 * is rejected (an update with nothing to update is a caller bug).
 *
 * `currentStatus` is OPTIONAL: when supplied alongside `status`, the
 * schema-level state-machine refinement rejects illegal transitions
 * at decode time (defense-in-depth ahead of the impl-layer guard).
 * When omitted, the schema cannot decide and the impl layer (Phase
 * 3) is the sole authority on transition validity.
 *
 * The schema is `.strict()` so unknown keys (including `id`,
 * `ownerIdentityId`, `createdAt`, `updatedAt`, `completedAt`) are
 * rejected — those are ledger-controlled, not caller-controlled.
 */
export type TaskUpdatePatch = {
  readonly status?: TaskStatus;
  readonly currentStatus?: TaskStatus;
  readonly label?: string;
  readonly summary?: string;
  readonly result?: string;
};

export const TaskUpdatePatchSchema: z.ZodType<TaskUpdatePatch> = z
  .object({
    status: TaskStatusSchema.optional(),
    currentStatus: TaskStatusSchema.optional(),
    label: NonEmptyString.optional(),
    summary: NonEmptyString.optional(),
    result: NonEmptyString.optional(),
  })
  .strict()
  .refine(
    (patch) =>
      patch.status !== undefined ||
      patch.label !== undefined ||
      patch.summary !== undefined ||
      patch.result !== undefined,
    {
      message: "TaskUpdatePatch must carry at least one mutable field",
    },
  )
  .refine(
    (patch) => {
      if (patch.currentStatus === undefined || patch.status === undefined) {
        return true;
      }
      return isTaskTransitionAllowed(patch.currentStatus, patch.status);
    },
    {
      message:
        "Illegal task status transition (see sub-plan §6 state-machine table)",
    },
  );

/**
 * Filter shape for `TaskLedger.list`. `ownerIdentityId` is
 * required — every ledger read predicates on identity (invariant
 * #16; per-`IdentityId` isolation per slice E precedent).
 *
 * `statuses`, when set, narrows to a non-empty subset of the closed
 * status enum. `limit` caps the result; `since` filters to entries
 * with `updatedAt >= since` (ISO-8601).
 */
export type TaskListQuery = {
  readonly ownerIdentityId: IdentityId;
  readonly statuses?: ReadonlyArray<TaskStatus>;
  readonly limit?: number;
  readonly since?: string;
};

export const TaskListQuerySchema: z.ZodType<TaskListQuery> = z
  .object({
    ownerIdentityId: IdentityIdSchema,
    statuses: z.array(TaskStatusSchema).min(1).optional(),
    limit: z.number().int().positive().optional(),
    since: IsoTimestampSchema.optional(),
  })
  .strict();

/**
 * Result shape for `TaskLedger.list`. `tasks` is always present
 * (never `undefined`); empty means "no entries match the query"
 * — same no-op contract as `MemoryRecallResult.entries`.
 */
export type TaskListResult = {
  readonly tasks: ReadonlyArray<TaskRecord>;
};

export const TaskListResultSchema: z.ZodType<TaskListResult> = z
  .object({
    tasks: z.array(TaskRecordSchema),
  })
  .strict();
