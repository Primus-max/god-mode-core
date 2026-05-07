import { z } from "zod";
import { isIdentityId, type IdentityId } from "../identity/identity-id.js";
import type {
  AgentId,
  ChannelId,
  EffectId,
  ISO8601,
  SessionId,
  SessionKey,
} from "./ids.js";

export type SessionRecord = {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  readonly parentSessionKey: SessionKey | null;
  readonly status: "active" | "paused" | "closed";
  readonly createdAt: ISO8601;
};

export type SessionWorldState = {
  readonly followupRegistry: readonly SessionRecord[];
};

export type DeliveryReceiptKind = "answer" | "clarification" | "external_effect";

export type DeliveryReceipt = {
  readonly deliveryContextKey: string;
  readonly messageId: string;
  readonly sentAt: number;
  readonly effect: EffectId;
  readonly kind: DeliveryReceiptKind;
};

export type DeliveryWorldState = {
  readonly receipts: Readonly<Record<string, readonly DeliveryReceipt[]>>;
};

/**
 * Read-only artifact record exposed via `WorldStateSnapshot.artifacts` for
 * cutover-3 done-predicates (`pdf.created`, `docx.created`,
 * `code_patch.applied`, `image.created`). Populated by the runtime adapter
 * (Phase 5) on successful tool execution; consumed by per-affordance
 * predicates that match a record's `artifactId` against the commitment's
 * `expectedDelta.artifacts.added` entries.
 *
 * `sourcePaths` carries the inbound media references used to produce the
 * artifact (e.g. img2img reference attachments) — required by the bug #2
 * audit trail (`extensions/AUDIT-cutover3-artifacts.md` §c).
 */
export type ArtifactRecord = {
  readonly artifactId: string;
  readonly kind: "pdf" | "docx" | "code_patch" | "image";
  readonly path: string;
  readonly mimeType: string;
  readonly sizeBytes?: number;
  readonly sourcePaths?: readonly string[];
  readonly producedAt: ISO8601;
};

export type ArtifactWorldState = {
  readonly records: readonly ArtifactRecord[];
};

export type WorkspaceWorldState = Record<string, never>;

/**
 * Read-only repo-operation record exposed via `WorldStateSnapshot.repo` for
 * cutover-4 done-predicates (`repo.branch_created`, `repo.commit_landed`,
 * `repo.merge_completed`, `repo.diff_observed`). Populated by the runtime
 * adapter (Phase 5) after a sanctioned `runRepoCommand(...)` returns
 * successfully; consumed by per-affordance predicates that match a record's
 * `repoOperationId` against the commitment's expected delta.
 *
 * Sibling slice to `ArtifactWorldState`: kept orthogonal to the empty
 * `WorkspaceWorldState` stub which is reserved for the future Slice K
 * workspace-tooling consumer (audit `extensions/AUDIT-cutover4-repo-operation.md`
 * §c). Cutover-3 added `artifacts` as a sibling at the same precedent.
 */
export type RepoOperationRecord = {
  readonly repoOperationId: string;
  readonly kind:
    | "branch_created"
    | "commit_landed"
    | "merge_completed"
    | "diff_observed";
  readonly branchName?: string;
  readonly commitSha?: string;
  readonly baseSha?: string;
  readonly mergeBaseSha?: string;
  readonly filesChanged?: number;
  readonly insertions?: number;
  readonly deletions?: number;
  readonly repoRoot?: string;
  readonly observedAt: ISO8601;
};

export type RepoWorldState = {
  readonly records: readonly RepoOperationRecord[];
};

export type WebEvidenceRecord = {
  readonly url: string;
  readonly snippet: string;
  readonly title?: string;
  readonly capturedAt: ISO8601;
};

export type WebEvidenceWorldState = {
  readonly records: readonly WebEvidenceRecord[];
};

/**
 * Slice K Phase 4 — `reminder` WorldState slice.
 *
 * Read-only descriptor of the most recent reminder query observed on
 * the active turn. Populated by the Phase 4 `ReminderWorldStateObserver`
 * (sibling of `ArtifactWorldStateObserver` / `RepoWorldStateObserver`
 * from Cutover-3 / Cutover-4 P3); consumed by `reminderDeliveredPredicate`
 * (Phase 3) which checks `lastQuery.queryId` against
 * `expectedDelta.reminder.queryId`.
 *
 * Per-turn limit is 1 (single-shot query per turn) — slice K is a pure
 * read-only consumer; multiple reminder queries on the same turn would
 * either be redundant (same operator question) or constitute a separate
 * commitment turn.
 *
 * `resultCount === 0` SATISFIES the predicate — operator was answered
 * with structurally correct «no entries in window» (sub-plan §3
 * acceptance #3).
 */
export type ReminderQueryRecord = {
  readonly queryId: string;
  readonly resultCount: number;
  readonly observedAt: ISO8601;
};

export type ReminderWorldState = {
  readonly lastQuery?: ReminderQueryRecord;
};

/**
 * Cron/Scheduler Phase 3 — `scheduledReminders` WorldState slice.
 *
 * Read-only descriptor of a reminder scheduled for future delivery via the
 * existing `CronService`. Sibling of `ArtifactRecord` (Cutover-3 P3) and
 * `RepoOperationRecord` (Cutover-4 P3); orthogonal to slice K's
 * `WorldStateSnapshot.reminder?.lastQuery` (recall-side query result —
 * different shape, different lifecycle, different writer). Populated by the
 * Phase 5 `ScheduledReminderRuntimeAdapter`; consumed by the Phase 4
 * done-predicate which matches a record's `reminderId` against the
 * commitment's `expectedDelta.scheduledReminders.added`.
 *
 * `status` is a closed three-value lifecycle: `pending` (just scheduled, cron
 * callback registered), `fired` (cron callback ran + delivery attempted),
 * `cancelled` (operator cancelled before fire). The transition graph is
 * one-way pending → fired | cancelled (enforced at the SqliteReminderStore
 * Phase 6 schema-CHECK; the WorldState slice is read-only).
 *
 * `ownerIdentityId` is the identity scope under which the reminder was
 * scheduled — slice K precedent for identity-isolated reads. The cron-fire
 * callback (Phase 5) injects this into the wrapped scope on dispatch so
 * identity NEVER cross-leaks even from the non-interactive scheduler turn.
 */
export type ReminderStatus = "pending" | "fired" | "cancelled";

export type ScheduledReminderRecord = {
  readonly reminderId: string;
  readonly ownerIdentityId: IdentityId;
  readonly fireAt: ISO8601;
  readonly content: string;
  readonly deliveryChannel: ChannelId;
  readonly deliveryTo: string;
  readonly createdAt: ISO8601;
  readonly status: ReminderStatus;
};

export type ScheduledRemindersSlice = {
  readonly records: readonly ScheduledReminderRecord[];
};

/**
 * Bug F (persistent-worker subsequent push) Phase 5 — `persistentWorkerReports`
 * WorldState slice.
 *
 * Read-only descriptor of a persistent-worker daily-push delivery event
 * dispatched at the cron-fire boundary. Sibling of `ScheduledRemindersSlice`
 * (Cron/Scheduler P3) and `ArtifactRecord` (Cutover-3 P3); orthogonal to
 * `reminder?.lastQuery` (slice K recall surface). Populated by the Phase 5
 * `PersistentWorkerReportObserver` from records appended by the Phase 4
 * runtime adapter on dispatch success/failure; consumed by the Phase 3
 * `persistentWorkerPushDeliveredPredicate` which matches a delivered
 * record's `workerRunId` against the commitment's expected delta.
 *
 * Two record sub-shapes — `delivered` and `failed` — share the structural
 * fields (`workerRunId`, `ownerIdentityId`, `channel`, `to`, `recordedAt`)
 * but diverge on `status` (`pushed` vs `failed`) + whether `messageId` /
 * `reason` is carried. The slice is OPTIONAL — when no persistent-worker
 * push has run on the active turn the slice is `undefined` and the
 * predicate reports `persistent_worker_reports.slice_absent` (Cutover-3 /
 * Cutover-4 / slice K precedent for backward-compat invariant #11).
 *
 * `ownerIdentityId` is the identity scope under which the worker run was
 * spawned — sub-plan §1 audit §i NEW invariant. The cron-fire callback
 * (Phase 5) injects this into the wrapped scope on dispatch so identity
 * NEVER cross-leaks even from the non-interactive cron context.
 */
export type DeliveredWorkerReportRecord = {
  readonly workerRunId: string;
  readonly ownerIdentityId: IdentityId;
  readonly channel: ChannelId;
  readonly to: string;
  readonly status: "pushed";
  readonly recordedAt: ISO8601;
  readonly messageId?: string;
};

export type FailedWorkerReportRecord = {
  readonly workerRunId: string;
  readonly ownerIdentityId: IdentityId;
  readonly channel: ChannelId;
  readonly to: string;
  readonly status: "failed";
  readonly recordedAt: ISO8601;
  readonly reason: string;
};

export type PersistentWorkerReportsSlice = {
  readonly delivered: readonly DeliveredWorkerReportRecord[];
  readonly failed: readonly FailedWorkerReportRecord[];
};

const ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * Soft cap on `ScheduledReminderRecord.content` length. Prevents a malformed
 * or adversarial input from inflating the WorldState slice into a
 * prompt-injection vector — the content is reflected back to the operator on
 * fire so an oversize body could carry instructions for downstream LLM
 * turns. 4096 chars matches the cron `agentTurn` payload `message` ceiling
 * (slice F task ledger length-cap precedent).
 */
const SCHEDULED_REMINDER_CONTENT_MAX_LENGTH = 4096;

/**
 * Closed-shape regex matching git short-sha (7 hex) or full-sha (40 hex)
 * lower-case object names. Used by `repoOperationRecordSchema` to validate
 * `commitSha` / `baseSha` / `mergeBaseSha` when present. Upper-case is rejected
 * because git itself canonicalizes object names lower-case; rejecting upper-
 * case prevents accidental case-aliased duplicates in the WorldState bucket.
 */
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{7}|[0-9a-f]{40})$/u;

/**
 * Closed-shape schema for a single `WebEvidenceRecord` parsed from the search
 * specialist's structured-JSON reply (Phase 4a). Validation rejects empty URLs
 * and malformed ISO-8601 timestamps so the runtime adapter can fall through
 * to the legacy single-model path on parse failure (no regression).
 *
 * The schema does not validate the URL beyond non-emptiness: the search
 * specialist (sonar/sonar-pro) is the only writer, and it cites real URLs by
 * design; URL semantic validation is an out-of-scope adversarial concern.
 */
export const webEvidenceRecordSchema = z
  .object({
    url: z.string().min(1),
    snippet: z.string(),
    title: z.string().optional(),
    capturedAt: z.string().regex(ISO8601_PATTERN),
  })
  .strict();

/**
 * Closed-shape schema for a single `ArtifactRecord` written by the cutover-3
 * runtime adapter on tool-emit (Phase 5). Validation rejects empty
 * `artifactId` / `path` / `mimeType`, malformed ISO-8601 `producedAt`, and
 * `kind` outside the closed set; the in-memory collector's `record(...)`
 * method calls `parse(...)` so observer reads stay total.
 */
export const artifactRecordSchema = z
  .object({
    artifactId: z.string().min(1),
    kind: z.enum(["pdf", "docx", "code_patch", "image"]),
    path: z.string().min(1),
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative().optional(),
    sourcePaths: z.array(z.string().min(1)).readonly().optional(),
    producedAt: z.string().regex(ISO8601_PATTERN),
  })
  .strict();

/**
 * Closed-shape schema for a single `RepoOperationRecord` written by the
 * cutover-4 runtime adapter on tool-emit (Phase 5). Validation rejects empty
 * `repoOperationId`, `kind` outside the closed set, malformed sha fields
 * (`commitSha` / `baseSha` / `mergeBaseSha` must match `GIT_SHA_PATTERN` when
 * present), and malformed ISO-8601 `observedAt`; the in-memory collector's
 * `record(...)` method calls `parse(...)` on each call so observer reads stay
 * total.
 */
export const repoOperationRecordSchema = z
  .object({
    repoOperationId: z.string().min(1),
    kind: z.enum([
      "branch_created",
      "commit_landed",
      "merge_completed",
      "diff_observed",
    ]),
    branchName: z.string().min(1).optional(),
    commitSha: z.string().regex(GIT_SHA_PATTERN).optional(),
    baseSha: z.string().regex(GIT_SHA_PATTERN).optional(),
    mergeBaseSha: z.string().regex(GIT_SHA_PATTERN).optional(),
    filesChanged: z.number().int().nonnegative().optional(),
    insertions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
    repoRoot: z.string().min(1).optional(),
    observedAt: z.string().regex(ISO8601_PATTERN),
  })
  .strict();

/**
 * Closed-shape schema for a single `ReminderQueryRecord` written by the
 * slice K Phase 4 reminder runtime adapter on tool-emit. Validation
 * rejects empty `queryId`, negative `resultCount`, and malformed
 * ISO-8601 `observedAt`; the in-memory collector's `record(...)` method
 * calls `parse(...)` so observer reads stay total. `resultCount` is a
 * non-negative integer — zero IS a valid (and successful) outcome
 * (sub-plan §3 acceptance #3).
 */
export const reminderQueryRecordSchema = z
  .object({
    queryId: z.string().min(1),
    resultCount: z.number().int().nonnegative(),
    observedAt: z.string().regex(ISO8601_PATTERN),
  })
  .strict();

/**
 * Closed-shape schema for a single `ScheduledReminderRecord` written by the
 * Cron/Scheduler Phase 5 runtime adapter on `RecordReminderTool` invocation.
 * Validation rejects empty `reminderId` / `deliveryChannel` / `deliveryTo`,
 * unbranded `ownerIdentityId` (delegated to `isIdentityId`), malformed
 * ISO-8601 timestamps, content exceeding the 4096-char cap, and `status`
 * outside the closed `pending | fired | cancelled` set; the in-memory
 * collector's `record(...)` method calls `parse(...)` on each call so
 * observer reads stay total.
 */
export const scheduledReminderRecordSchema = z
  .object({
    reminderId: z.string().min(1),
    ownerIdentityId: z
      .string()
      .refine((v) => isIdentityId(v), {
        message: "ownerIdentityId must be a branded IdentityId (identity:<slug>)",
      }),
    fireAt: z.string().regex(ISO8601_PATTERN),
    content: z.string().max(SCHEDULED_REMINDER_CONTENT_MAX_LENGTH),
    deliveryChannel: z.string().min(1),
    deliveryTo: z.string().min(1),
    createdAt: z.string().regex(ISO8601_PATTERN),
    status: z.enum(["pending", "fired", "cancelled"]),
  })
  .strict();

/**
 * Closed-shape schema for a single `DeliveredWorkerReportRecord` written by
 * the Bug F Phase 4 runtime adapter on dispatch success. Validation rejects
 * empty `workerRunId` / `channel` / `to`, unbranded `ownerIdentityId`
 * (delegated to `isIdentityId`), and malformed ISO-8601 `recordedAt`; the
 * in-memory observer's `record(...)` method calls `parse(...)` on each call
 * so observer reads stay total. `messageId` is OPTIONAL — present on
 * dispatch success, absent when the runtime adapter could not mint one.
 */
export const deliveredWorkerReportRecordSchema = z
  .object({
    workerRunId: z.string().min(1),
    ownerIdentityId: z
      .string()
      .refine((v) => isIdentityId(v), {
        message: "ownerIdentityId must be a branded IdentityId (identity:<slug>)",
      }),
    channel: z.string().min(1),
    to: z.string().min(1),
    status: z.literal("pushed"),
    recordedAt: z.string().regex(ISO8601_PATTERN),
    messageId: z.string().min(1).optional(),
  })
  .strict();

/**
 * Closed-shape schema for a single `FailedWorkerReportRecord` written by
 * the Phase 5 cron-fire callback when the runtime adapter returns
 * `kind:'fail'`. The callback records the failure on the observer slice so
 * the done-predicate can surface a structural absence-of-delivery rather
 * than silently leave the slice empty (sub-plan §3.2 last-writer-wins
 * semantics on `workerRunId`). `reason` is the closed-shape
 * `PersistentWorkerPushFailReason` literal from the runtime adapter — the
 * schema accepts any non-empty string so future failure-reason additions
 * do not require a schema bump.
 */
export const failedWorkerReportRecordSchema = z
  .object({
    workerRunId: z.string().min(1),
    ownerIdentityId: z
      .string()
      .refine((v) => isIdentityId(v), {
        message: "ownerIdentityId must be a branded IdentityId (identity:<slug>)",
      }),
    channel: z.string().min(1),
    to: z.string().min(1),
    status: z.literal("failed"),
    recordedAt: z.string().regex(ISO8601_PATTERN),
    reason: z.string().min(1),
  })
  .strict();

export type WorldStateSnapshot = {
  readonly sessions?: SessionWorldState;
  readonly artifacts?: ArtifactWorldState;
  readonly workspace?: WorkspaceWorldState;
  readonly repo?: RepoWorldState;
  readonly reminder?: ReminderWorldState;
  /**
   * Cron/Scheduler Phase 3 — write-side reminder slice. Orthogonal to
   * `reminder?.lastQuery` (slice K recall surface). Populated by the
   * Phase 5 runtime adapter on `RecordReminderTool` invocation; consumed
   * by the Phase 4 `done-predicate-reminder-set` predicate.
   */
  readonly scheduledReminders?: ScheduledRemindersSlice;
  /**
   * Bug F Phase 5 — `persistentWorkerReports` slice. ADDITIVE optional
   * slot — backward-compat invariant #11 preserved (slice K precedent;
   * Cutover-3 / Cutover-4 also added optional slots). Populated by the
   * Phase 5 `PersistentWorkerReportObserver` from records written at the
   * cron-fire boundary by the Phase 4 runtime adapter (success path) +
   * Phase 5 cron-fire callback (failure path); consumed by the Phase 3
   * `persistentWorkerPushDeliveredPredicate`.
   */
  readonly persistentWorkerReports?: PersistentWorkerReportsSlice;
  readonly deliveries?: DeliveryWorldState;
  readonly webEvidence?: WebEvidenceWorldState;
};
