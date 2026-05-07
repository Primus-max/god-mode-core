/**
 * Bug F (persistent-worker subsequent push) Phase 2 — types only.
 *
 * Pure-types module for the cron-driven daily push of a persistent
 * worker's output back to the operator's external channel. Phase 2
 * ships ONLY branded ids, the closed `WorkerReportRef` shape, the
 * effect/precondition id constants, and the Zod decode schema.
 * Phases 3-7 wire the affordance + done-predicate (P3), runtime
 * adapter (P4), cron-fire callback + WorldState slice + observer
 * (P5), `OutboundCoalescer` bypass-reason removal (P6), and acceptance
 * + live-verify runbook (P7).
 *
 * Per invariant #8, this module imports ONLY from
 * `src/platform/identity/`, `src/platform/commitment/ids.js` (for
 * the existing `EffectId` / `PreconditionId` / `ChannelId` brands),
 * Zod, and the standard library. It does NOT import from
 * `src/platform/decision/`, does NOT touch the 5-contract frozen
 * surface (`TaskContract` / `OutcomeContract` /
 * `QualificationExecutionContract` / `ResolutionContract` /
 * `RecipeRoutingHints`), and does NOT widen
 * `EpisodicEffectFamily` (sub-plan §3.1: REUSE
 * `COMMUNICATION_EFFECT_FAMILY`; audit §e: NEW effect, not STUB-light).
 *
 * Per invariants #5/#6, this module never receives a `RawUserTurn`
 * or `UserPrompt`. The `WorkerReportRef.content` field is sourced
 * from a persisted `WorkerRunRecord` (Phase 5) at the cron-fire
 * boundary — the cron callback runs OUTSIDE any user-text reading
 * context.
 *
 * Per invariant #16, `PersistentWorkerPushTriggerId` is a NEW brand
 * distinct from `EffectId` / `WorkerRunId`. The Phase 4 adapter
 * mints a fresh trigger-id per cron-fire invocation; it is the
 * idempotency key surfaced to the runtime collector.
 */

import { z } from "zod";

import { isIdentityId, type IdentityId } from "../identity/identity-id.js";
import type { ChannelId, EffectId, PreconditionId } from "../commitment/ids.js";

declare const PersistentWorkerPushTriggerIdBrand: unique symbol;

/**
 * Branded string identifying a single cron-fire invocation of the
 * persistent-worker subsequent-push adapter. Distinct from
 * `EffectId` (the affordance-registry effect literal) and from any
 * future `WorkerRunId` brand — Phase 5's cron-fire callback mints
 * a fresh `PersistentWorkerPushTriggerId` per invocation and
 * surfaces it as the runtime collector's idempotency key.
 *
 * Construct via the runtime adapter (Phase 4); validate inputs at
 * boundaries via `isPersistentWorkerPushTriggerId`. Direct casting
 * from `string` is a TypeScript error and a runtime bypass.
 */
export type PersistentWorkerPushTriggerId = string & {
  readonly [PersistentWorkerPushTriggerIdBrand]: true;
};

/**
 * Type-guard for `PersistentWorkerPushTriggerId`. The minimal
 * structural rule per the audit deliverable (§h Phase 2) is
 * non-empty string — Phase 4's adapter mints UUID-shaped values
 * (`crypto.randomUUID()` precedent from slice K Phase 6 sqlite
 * impl) but the type-system contract is intentionally loose so
 * test fixtures and future migration paths are unconstrained.
 */
export function isPersistentWorkerPushTriggerId(
  value: unknown,
): value is PersistentWorkerPushTriggerId {
  return typeof value === "string" && value.length > 0;
}

/**
 * `EffectId` constant for the persistent-worker subsequent-push
 * affordance. Mirrors the slice K Phase 2 / Cutover-4 Phase 2
 * precedent of casting a string literal at module init through the
 * brand. The literal value `'persistent_worker.subsequent_push'`
 * distinguishes this effect from `answer.delivered` (in-turn
 * user-facing reply, same `COMMUNICATION_EFFECT_FAMILY`) and from
 * slice K's `reminder.set` (different family entirely).
 *
 * Phase 3 registers this constant on the `AffordanceRegistry`
 * entry's `effect` field; Phase 7 acceptance grep asserts the log
 * line `[commitment] persistent_worker.subsequent_push
 * effectFamily=communication operationKind=push decision=kernel`.
 */
export const PERSISTENT_WORKER_SUBSEQUENT_PUSH_EFFECT =
  "persistent_worker.subsequent_push" as EffectId;

/**
 * `PreconditionId` constant for the structural precondition that
 * gates push dispatch on a persisted `WorkerRunRecord` whose
 * `subsequentPushStatus` is `'pending'`. Phase 5 introduces the
 * record + the predicate; Phase 3 references this constant in the
 * `requiredPreconditions` field of the affordance entry.
 *
 * Distinct from `IDENTITY_RESOLVED_PRECONDITION` (the canonical
 * anonymous-fail-closed gate) — both preconditions are required
 * by the Phase 3 affordance entry; the audit §h Phase 3 entry
 * spells out the dual gate.
 */
export const WORKER_REPORT_AVAILABLE_PRECONDITION =
  "worker.report.available" as PreconditionId;

/**
 * Soft cap on `WorkerReportRef.content` length. Mirrors the slice K
 * Phase 2 / Cron/Scheduler reminder-content cap
 * (`SCHEDULED_REMINDER_CONTENT_MAX_LENGTH = 4096`,
 * `src/platform/commitment/world-state.ts:191`). Prevents a
 * malformed or adversarial worker output from inflating the
 * push payload into a prompt-injection vector — the content is
 * reflected back to the operator on push so an oversize body could
 * carry instructions for downstream LLM turns.
 *
 * 4096 chars matches the cron `agentTurn` payload `message`
 * ceiling (slice F task ledger length-cap precedent referenced by
 * the Cron/Scheduler precedent).
 */
export const WORKER_REPORT_CONTENT_MAX_LENGTH = 4096;

/**
 * Inline copy of the ISO-8601 regex from
 * `src/platform/memory/episodic-memory-event.ts` /
 * `src/platform/commitment/world-state.ts:181`. Duplicated verbatim
 * (rather than re-exported) so this module imposes ZERO touch on
 * either the slice-E source or the commitment-layer source — the
 * 5 frozen contracts and `EpisodicEffectFamily` remain
 * BYTE-IDENTICAL (sub-plan §2 invariant #11).
 *
 * Validation chain: persisted `WorkerRunRecord` (Phase 5) →
 * cron-fire callback (Phase 5) → Zod `ISO8601_PATTERN` (this regex)
 * → `WorkerReportRef.completedAt` → `runPersistentWorkerSubsequentPush`
 * adapter (Phase 4).
 */
const ISO8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * Closed-shape reference to a single completed persistent-worker run
 * carrying every field the Phase 4 runtime adapter needs to dispatch
 * the subsequent push.
 *
 * Fields:
 * - `workerRunId` — opaque non-empty string identifying the
 *   `WorkerRunRecord` (Phase 5). The record's `ownerIdentityId`
 *   field is the canonical identity scope; cross-identity reads
 *   from the store predicate on this id × identity pair return
 *   `undefined` (slice K Phase 6 SQLite impl precedent).
 * - `ownerIdentityId` — branded `IdentityId` of the operator who
 *   spawned the worker. Phase 5's cron-fire callback re-injects
 *   this from the persisted `WorkerRunRecord.ownerIdentityId`,
 *   NEVER caller-supplied (slice K Phase 5 precedent —
 *   `wrappedScopeIdentityId = record.ownerIdentityId`).
 * - `completedAt` — ISO-8601 timestamp of the worker-completion
 *   event (`subagent_ended` plugin hook, `src/agents/subagent-
 *   registry-completion.ts:44-96`).
 * - `channel` — branded `ChannelId` of the destination external
 *   channel (Telegram / Slack / etc.). REUSED via the existing
 *   channel-resolver in Phase 4; no fork.
 * - `to` — non-empty trimmed string identifying the channel
 *   address (chat id / dm handle / room id). Phase 4 passes
 *   through to `deliveryDispatch` opaquely.
 * - `content` — operator-facing message body, capped at
 *   `WORKER_REPORT_CONTENT_MAX_LENGTH` chars.
 */
export type WorkerReportRef = {
  readonly workerRunId: string;
  readonly ownerIdentityId: IdentityId;
  readonly completedAt: string;
  readonly channel: ChannelId;
  readonly to: string;
  readonly content: string;
};

/**
 * Zod schema for a `WorkerReportRef`. Strict-mode (rejects unknown
 * keys) per closed-shape discipline. The output object is frozen by
 * an explicit `.transform()` so callers cannot mutate the parsed
 * result; this is the same defense-in-depth pattern slice K /
 * Cutover-3 / Cutover-4 use for their decode boundaries.
 *
 * Validation rules:
 * - `workerRunId` — non-empty trimmed string. Phase 5's cron-fire
 *   callback mints UUID-shaped values; the schema does not enforce
 *   the UUID shape so test fixtures and future migration paths are
 *   unconstrained.
 * - `ownerIdentityId` — validated via the upstream `isIdentityId`
 *   guard (`src/platform/identity/identity-id.ts`). Cross-identity
 *   anonymous strings are rejected at decode.
 * - `completedAt` — ISO-8601 (`ISO8601_PATTERN` regex). Calendar
 *   semantics are out-of-scope (shape check only — slice K Phase 2
 *   precedent).
 * - `channel` — non-empty string, re-cast to `ChannelId`. The repo
 *   does not ship an `isChannelId` runtime guard (the brand is
 *   asserted at production wiring sites; the world-state slice
 *   uses the same `z.string().min(1)` shape — `world-state.ts:307`).
 * - `to` — non-empty trimmed string. Phase 4 passes through opaquely.
 * - `content` — string with length ≤ `WORKER_REPORT_CONTENT_MAX_LENGTH`.
 *   Empty content is permitted (a worker run that completed with no
 *   output is structurally legal — the operator still sees the
 *   completion notification).
 */
const WorkerReportRefRawSchema = z
  .object({
    workerRunId: z.string().trim().min(1),
    ownerIdentityId: z.string().refine((v) => isIdentityId(v), {
      message:
        "ownerIdentityId must be a branded IdentityId (identity:<slug>)",
    }),
    completedAt: z.string().regex(ISO8601_PATTERN, {
      message: "expected an ISO-8601 timestamp",
    }),
    channel: z.string().min(1),
    to: z.string().trim().min(1),
    content: z.string().max(WORKER_REPORT_CONTENT_MAX_LENGTH),
  })
  .strict();

export const WorkerReportRefSchema: z.ZodType<WorkerReportRef> =
  WorkerReportRefRawSchema.transform((value) =>
    Object.freeze({
      workerRunId: value.workerRunId,
      ownerIdentityId: value.ownerIdentityId as IdentityId,
      completedAt: value.completedAt,
      channel: value.channel as ChannelId,
      to: value.to,
      content: value.content,
    } satisfies WorkerReportRef),
  );
