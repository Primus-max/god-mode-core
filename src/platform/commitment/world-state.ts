import { z } from "zod";
import type { AgentId, EffectId, ISO8601, SessionId, SessionKey } from "./ids.js";

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

const ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

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

export type WorldStateSnapshot = {
  readonly sessions?: SessionWorldState;
  readonly artifacts?: ArtifactWorldState;
  readonly workspace?: WorkspaceWorldState;
  readonly repo?: RepoWorldState;
  readonly reminder?: ReminderWorldState;
  readonly deliveries?: DeliveryWorldState;
  readonly webEvidence?: WebEvidenceWorldState;
};
