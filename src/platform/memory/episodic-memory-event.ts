import { z } from "zod";

import type { EffectId } from "../commitment/ids.js";
import {
  APPROVAL_POLICY_REASONS,
  BUDGET_POLICY_REASONS,
  RETRY_POLICY_REASONS,
  ROLE_POLICY_REASONS,
  type ApprovalPolicyReason,
  type ApprovalRequestId,
  type BudgetPolicyReason,
  type BudgetWindowId,
  type RetryPolicyReason,
  type RolePolicyReason,
  type RoleId,
} from "../commitment/policy-gate-stages.js";
import { asIdentityId, isIdentityId, type IdentityId } from "../identity/identity-id.js";
import { asTaskId, isTaskId, type TaskId } from "../task/task-id.js";

/**
 * Effect-family discriminator for episodic memory events.
 *
 * Slice E ships only `persistent_session.created` as a
 * payload-bearing event. The other variants — `subagent.created`,
 * `reminder.set`, `artifact.created`, and (slice F Phase 2) `task.*`
 * — are typed but inert: their payload shapes are defined here so
 * consumers (slices F / G / J / K) can wire them by adding emit
 * sites WITHOUT modifying this discriminated union. Until those
 * slices light their own emit sites, no production code path emits
 * them.
 *
 * Adding a new variant later is a discriminated-union extension,
 * NOT a breaking change for existing consumers; the exhaustiveness
 * compile check (`memory-store.contract.test.ts`) guarantees
 * `recall` / `storeEpisodic` callers cover every case.
 *
 * Slice F Phase 2 added the `task` variant — typed-but-inert until
 * slice F Phase 5 wires the `task-write-on-satisfied.ts` hook. The
 * task variant is multiplexed via a payload-level `kind`
 * discriminator (`created` / `completed` / `cancelled` / `failed`)
 * rather than four separate effect families, so the
 * discriminated-union surface stays compact and slices that filter
 * on `effectFamily` see one symbol.
 */
export type EpisodicEffectFamily =
  | "persistent_session"
  | "subagent"
  | "reminder"
  | "artifact"
  | "task"
  | "policy_approval"
  | "policy_budget"
  | "policy_role"
  | "policy_retry"
  | "policy_escalation";

/**
 * `persistent_session.created` — emitted when a commitment-runtime turn
 * settles successfully and a conversation message has been persisted to
 * the operator's session log. This is the only payload-emitting variant
 * in slice E; B1 ("memory across `/new`") is closed by recall over
 * these entries.
 *
 * Fields:
 * - `messageRole` — "user" | "assistant"; the originator of the message
 *   that was persisted. Operator-side, "user" is the operator and
 *   "assistant" is the agent reply that satisfied the commitment.
 * - `messageText` — the persisted text. NOTE: this is NOT raw user
 *   input on the way in (per invariants #5, #6); the writer is the
 *   commitment-runtime hook (slice E Phase 5) which only fires AFTER
 *   the contractor has classified the turn and the runtime has
 *   attested `commitmentSatisfied === true`. The text is then a
 *   downstream artefact, not a raw-text-read.
 * - `messageId` — opaque session-side message id (the persistent
 *   session log already assigns these); used for de-duplication when
 *   the same turn replays.
 * - `occurredAt` — ISO-8601 timestamp, captured at write time.
 */
export type PersistentSessionCreatedPayload = {
  readonly messageRole: "user" | "assistant";
  readonly messageText: string;
  readonly messageId: string;
  readonly occurredAt: string;
};

/**
 * `subagent.created` — STUB (slice G consumer). Reserved fields only;
 * slice G defines the canonical shape when it wires the emit site. The
 * shape here is a "minimum viable record" so the discriminated union
 * compiles and store impls can round-trip a marker entry; slice G may
 * extend the payload (additive — no breaking change) by adding optional
 * fields.
 */
export type SubagentCreatedPayload = {
  readonly subagentId: string;
  readonly displayName: string;
  readonly occurredAt: string;
};

/**
 * `reminder.set` — STUB (slice F / J consumer). Same rationale as
 * `subagent.created`.
 */
export type ReminderSetPayload = {
  readonly reminderId: string;
  readonly fireAt: string;
  readonly occurredAt: string;
};

/**
 * `artifact.created` — STUB (slice K consumer). Same rationale as
 * `subagent.created`.
 */
export type ArtifactCreatedPayload = {
  readonly artifactId: string;
  readonly kind: string;
  readonly occurredAt: string;
};

/**
 * `task.created` — slice F Phase 2. Typed-but-INERT until slice F
 * Phase 5 wires the `task-write-on-satisfied.ts` hook. Carries the
 * full identifying triple (`taskId` × `ownerIdentityId` × `occurredAt`)
 * plus the operator-facing `label`. The `kind: "created"` literal is
 * the payload-level discriminator that lets the four task-lifecycle
 * payloads share the single `effectFamily: "task"` slot.
 */
export type TaskCreatedPayload = {
  readonly kind: "created";
  readonly taskId: TaskId;
  readonly ownerIdentityId: IdentityId;
  readonly label: string;
  readonly occurredAt: string;
};

/**
 * `task.completed` — slice F Phase 2. Typed-but-INERT until slice F
 * Phase 5. Optional `result` carries operator-facing summary text
 * (e.g. "Posted retrospective to #eng-leads"). The `ownerIdentityId`
 * is duplicated alongside the event's outer `identityId` because the
 * payload is the joinable record on the `(identityId × taskId)`
 * cross-reference between memory and the task ledger; carrying it
 * inside the payload keeps the JOIN closed even if a future
 * persistence layer denormalises the outer envelope.
 */
export type TaskCompletedPayload = {
  readonly kind: "completed";
  readonly taskId: TaskId;
  readonly ownerIdentityId: IdentityId;
  readonly result?: string;
  readonly occurredAt: string;
};

/**
 * `task.cancelled` — slice F Phase 2. Typed-but-INERT until slice F
 * Phase 5. No result field by design: cancellation reasons are
 * stored on the `TaskRecord.result` row at the ledger boundary, not
 * smuggled through the episodic stream (the episodic event is the
 * cross-reference marker, not the source of truth).
 */
export type TaskCancelledPayload = {
  readonly kind: "cancelled";
  readonly taskId: TaskId;
  readonly ownerIdentityId: IdentityId;
  readonly occurredAt: string;
};

/**
 * `task.failed` — slice F Phase 2. Typed-but-INERT until slice F
 * Phase 5. Optional `result` carries the operator-facing failure
 * summary (e.g. "Upstream API timed out").
 */
export type TaskFailedPayload = {
  readonly kind: "failed";
  readonly taskId: TaskId;
  readonly ownerIdentityId: IdentityId;
  readonly result?: string;
  readonly occurredAt: string;
};

/**
 * Discriminated union of every `task.*` lifecycle payload. Used as
 * the `payload` slot of the `EpisodicMemoryEvent` task variant —
 * the outer family is one symbol (`"task"`); the per-status
 * shape is multiplexed by `payload.kind`.
 */
export type TaskLifecyclePayload =
  | TaskCreatedPayload
  | TaskCompletedPayload
  | TaskCancelledPayload
  | TaskFailedPayload;

/**
 * `policy_approval` — sub-plan
 * `commitment_kernel_policy_gate_full.plan.md` Phase 2 (Stage 2 scaffolding).
 * Typed-but-INERT until Phase 3 wires the Stage 2 (Approvals) emit site.
 *
 * Recorded when the affordance allowlist requires an explicit approval
 * before the gated effect proceeds. Reads `approvalRequestId` so the
 * episodic record JOINs cleanly to the `ExecApprovalRequest` raised by
 * the same denial event.
 */
export type PolicyApprovalPayload = {
  readonly approvalRequestId: ApprovalRequestId;
  readonly identityId: IdentityId;
  readonly effectId: EffectId;
  readonly reason: ApprovalPolicyReason;
};

/**
 * `policy_budget` — Phase 2 (Stage 3 scaffolding). Typed-but-INERT
 * until Phase 4 wires the Stage 3 (Budgets) emit site.
 *
 * Recorded on a budget window denial. The orthogonal three-reason
 * surface (`budget_exceeded_user` / `budget_exceeded_channel` /
 * `budget_exceeded_effect`) keeps the episodic stream filterable by
 * dimension without re-parsing the payload.
 */
export type PolicyBudgetPayload = {
  readonly windowId: BudgetWindowId;
  readonly identityId: IdentityId;
  readonly effectId: EffectId;
  readonly reason: BudgetPolicyReason;
  readonly used: number;
  readonly limit: number;
};

/**
 * `policy_role` — Phase 2 (Stage 4 scaffolding). Typed-but-INERT
 * until Phase 5 wires the Stage 4 (Role-based) emit site. The
 * `requiredRole` is carried in the payload (NOT in the reason enum)
 * so closed-set discipline holds.
 */
export type PolicyRolePayload = {
  readonly identityId: IdentityId;
  readonly effectId: EffectId;
  readonly reason: RolePolicyReason;
  readonly requiredRole: RoleId;
};

/**
 * `policy_retry` — Phase 2 (Stage 5 scaffolding). Typed-but-INERT
 * until Phase 6 wires the Stage 5 (Retry) emit site. Carries the
 * `(identityId × effectId × sessionId)` triple per-counter scoping —
 * a different session does not inherit the count (Phase 6 enforces this
 * in the in-memory LRU keying).
 */
export type PolicyRetryPayload = {
  readonly identityId: IdentityId;
  readonly effectId: EffectId;
  readonly sessionId: string;
  readonly reason: RetryPolicyReason;
  readonly attemptCount: number;
  readonly maxAttempts: number;
};

/**
 * `policy_escalation` — Phase 2 (Stage 6 scaffolding).
 * Typed-but-INERT until Phase 7 wires the Stage 6 (Escalation) emit
 * site. The `denialReason` is the originating reason that triggered the
 * escalation (one of `APPROVAL_/BUDGET_/ROLE_/RETRY_` reasons —
 * carried as the underlying string so the episodic stream can be
 * persisted/restored without dragging the cross-stage union shape into
 * a Zod-decoded row).
 */
export type PolicyEscalationPayload = {
  readonly denialReason: string;
  readonly identityId: IdentityId;
  readonly effectId: EffectId;
  readonly channel: string;
  readonly escalationId: string;
};

/**
 * Episodic memory event — the input shape for `MemoryStore.storeEpisodic`.
 *
 * Discriminated by `effectFamily`. The store is responsible for:
 * - assigning a `MemoryEntryId` (the input does NOT carry one — that is
 *   a write-time concern, not a caller concern);
 * - associating the event with the operator's `IdentityId`;
 * - persisting `payload` opaquely (JSON-serialised in the sqlite-vec
 *   impl, in-memory in the test impl).
 *
 * Per invariant #5/#6, the payload is structured at write time — the
 * store NEVER receives a `RawUserTurn` / `UserPrompt` and never does
 * regex/text-rule matching against operator text on the way in.
 */
export type EpisodicMemoryEvent =
  | {
      readonly identityId: IdentityId;
      readonly effectFamily: "persistent_session";
      readonly effectId: string;
      readonly payload: PersistentSessionCreatedPayload;
    }
  | {
      readonly identityId: IdentityId;
      readonly effectFamily: "subagent";
      readonly effectId: string;
      readonly payload: SubagentCreatedPayload;
    }
  | {
      readonly identityId: IdentityId;
      readonly effectFamily: "reminder";
      readonly effectId: string;
      readonly payload: ReminderSetPayload;
    }
  | {
      readonly identityId: IdentityId;
      readonly effectFamily: "artifact";
      readonly effectId: string;
      readonly payload: ArtifactCreatedPayload;
    }
  | {
      readonly identityId: IdentityId;
      readonly effectFamily: "task";
      readonly effectId: string;
      readonly payload: TaskLifecyclePayload;
    }
  | {
      readonly identityId: IdentityId;
      readonly effectFamily: "policy_approval";
      readonly effectId: string;
      readonly payload: PolicyApprovalPayload;
    }
  | {
      readonly identityId: IdentityId;
      readonly effectFamily: "policy_budget";
      readonly effectId: string;
      readonly payload: PolicyBudgetPayload;
    }
  | {
      readonly identityId: IdentityId;
      readonly effectFamily: "policy_role";
      readonly effectId: string;
      readonly payload: PolicyRolePayload;
    }
  | {
      readonly identityId: IdentityId;
      readonly effectFamily: "policy_retry";
      readonly effectId: string;
      readonly payload: PolicyRetryPayload;
    }
  | {
      readonly identityId: IdentityId;
      readonly effectFamily: "policy_escalation";
      readonly effectId: string;
      readonly payload: PolicyEscalationPayload;
    };

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

export const PersistentSessionCreatedPayloadSchema = z.object({
  messageRole: z.enum(["user", "assistant"]),
  messageText: NonEmptyString,
  messageId: NonEmptyString,
  occurredAt: IsoTimestampSchema,
});

export const SubagentCreatedPayloadSchema = z.object({
  subagentId: NonEmptyString,
  displayName: NonEmptyString,
  occurredAt: IsoTimestampSchema,
});

export const ReminderSetPayloadSchema = z.object({
  reminderId: NonEmptyString,
  fireAt: IsoTimestampSchema,
  occurredAt: IsoTimestampSchema,
});

export const ArtifactCreatedPayloadSchema = z.object({
  artifactId: NonEmptyString,
  kind: NonEmptyString,
  occurredAt: IsoTimestampSchema,
});

/**
 * Zod schema for a `TaskId`. Mirrors `IdentityIdSchema` discipline:
 * validate via the upstream `isTaskId` guard, then re-brand via
 * `asTaskId`. Use at decode boundaries (e.g. when a persistent
 * store row carrying a task lifecycle event is read back from JSON).
 *
 * Defined here (rather than imported from `../task/task-record.js`)
 * to keep this file's import surface narrow — only the brand factory
 * is needed, not the heavier `TaskRecord` schema, and the dependency
 * direction stays `memory → task-id` only (the task module does NOT
 * import from memory in Phase 2).
 */
const TaskIdSchema = z
  .string()
  .refine(isTaskId, {
    message: "expected a TaskId of the form `task:<slug>`",
  })
  .transform((value) => asTaskId(value));

// Internal raw `ZodObject` definitions for the four task-lifecycle
// payloads. These are NOT annotated with `z.ZodType<...>` because the
// discriminated-union construction below needs the stricter `ZodObject`
// shape that carries the discriminant metadata Zod 4 reads. They are
// kept un-exported; the exported, brand-typed surface is the four
// `Task*PayloadSchema` constants below them, each annotated as
// `z.ZodType<T>` to prevent TS4023 (the brand symbols are private).
const RawTaskCreatedPayload = z.object({
  kind: z.literal("created"),
  taskId: TaskIdSchema,
  ownerIdentityId: IdentityIdSchema,
  label: NonEmptyString,
  occurredAt: IsoTimestampSchema,
});

const RawTaskCompletedPayload = z.object({
  kind: z.literal("completed"),
  taskId: TaskIdSchema,
  ownerIdentityId: IdentityIdSchema,
  result: NonEmptyString.optional(),
  occurredAt: IsoTimestampSchema,
});

const RawTaskCancelledPayload = z.object({
  kind: z.literal("cancelled"),
  taskId: TaskIdSchema,
  ownerIdentityId: IdentityIdSchema,
  occurredAt: IsoTimestampSchema,
});

const RawTaskFailedPayload = z.object({
  kind: z.literal("failed"),
  taskId: TaskIdSchema,
  ownerIdentityId: IdentityIdSchema,
  result: NonEmptyString.optional(),
  occurredAt: IsoTimestampSchema,
});

/**
 * Public, brand-typed schemas for the four task-lifecycle payloads.
 * Annotated as `z.ZodType<T>` so the emitted `.d.ts` does NOT inline
 * the private `TaskIdBrand` / `IdentityIdBrand` symbols (TS4023).
 */
export const TaskCreatedPayloadSchema: z.ZodType<TaskCreatedPayload> =
  RawTaskCreatedPayload;
export const TaskCompletedPayloadSchema: z.ZodType<TaskCompletedPayload> =
  RawTaskCompletedPayload;
export const TaskCancelledPayloadSchema: z.ZodType<TaskCancelledPayload> =
  RawTaskCancelledPayload;
export const TaskFailedPayloadSchema: z.ZodType<TaskFailedPayload> =
  RawTaskFailedPayload;

/**
 * Discriminated union of every task-lifecycle payload. Matches the
 * `TaskLifecyclePayload` type's payload-level `kind` discriminator
 * so callers building events via Zod parse get the same compile-time
 * narrowing they would get if the type were authored directly.
 */
export const TaskLifecyclePayloadSchema: z.ZodType<TaskLifecyclePayload> =
  z.discriminatedUnion("kind", [
    RawTaskCreatedPayload,
    RawTaskCompletedPayload,
    RawTaskCancelledPayload,
    RawTaskFailedPayload,
  ]);

/**
 * Branded-id Zod schemas for the policy-gate-stages ID brands. Phase 2
 * accepts any non-empty string and re-brands at decode time; Phases 3-7
 * tighten the format with a dedicated guard once finalised.
 */
const ApprovalRequestIdSchema = NonEmptyString.transform(
  (value) => value as ApprovalRequestId,
);
const BudgetWindowIdSchema = NonEmptyString.transform(
  (value) => value as BudgetWindowId,
);
const RoleIdSchema = NonEmptyString.transform((value) => value as RoleId);
const EffectIdSchema = NonEmptyString.transform((value) => value as EffectId);

/**
 * Public, brand-typed schemas for the five `policy_*` payloads.
 * Annotated as `z.ZodType<T>` so the emitted `.d.ts` does NOT inline
 * the private brand symbols (TS4023). Phase 2 ships INERT — no
 * production code path emits these events until Phases 3-7 light their
 * respective stage hooks.
 */
export const PolicyApprovalPayloadSchema: z.ZodType<PolicyApprovalPayload> =
  z.object({
    approvalRequestId: ApprovalRequestIdSchema,
    identityId: IdentityIdSchema,
    effectId: EffectIdSchema,
    reason: z.enum(APPROVAL_POLICY_REASONS),
  });

export const PolicyBudgetPayloadSchema: z.ZodType<PolicyBudgetPayload> =
  z.object({
    windowId: BudgetWindowIdSchema,
    identityId: IdentityIdSchema,
    effectId: EffectIdSchema,
    reason: z.enum(BUDGET_POLICY_REASONS),
    used: z.number().nonnegative(),
    limit: z.number().nonnegative(),
  });

export const PolicyRolePayloadSchema: z.ZodType<PolicyRolePayload> = z.object({
  identityId: IdentityIdSchema,
  effectId: EffectIdSchema,
  reason: z.enum(ROLE_POLICY_REASONS),
  requiredRole: RoleIdSchema,
});

export const PolicyRetryPayloadSchema: z.ZodType<PolicyRetryPayload> = z.object({
  identityId: IdentityIdSchema,
  effectId: EffectIdSchema,
  sessionId: NonEmptyString,
  reason: z.enum(RETRY_POLICY_REASONS),
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
});

export const PolicyEscalationPayloadSchema: z.ZodType<PolicyEscalationPayload> =
  z.object({
    denialReason: NonEmptyString,
    identityId: IdentityIdSchema,
    effectId: EffectIdSchema,
    channel: NonEmptyString,
    escalationId: NonEmptyString,
  });

/**
 * Zod schema for an `EpisodicMemoryEvent`. Discriminated on
 * `effectFamily`. Use at decode boundaries (e.g. when a persistent
 * store row is read back from JSON) to assert the payload matches its
 * effect-family slot at runtime, not just at compile time.
 *
 * The explicit `z.ZodType<EpisodicMemoryEvent>` annotation prevents
 * TS4023 — without it the emitted `.d.ts` would try to inline the
 * private `IdentityIdBrand` symbol from `identity-id.ts`, which is
 * not exported.
 */
export const EpisodicMemoryEventSchema: z.ZodType<EpisodicMemoryEvent> =
  z.discriminatedUnion("effectFamily", [
    z.object({
      identityId: IdentityIdSchema,
      effectFamily: z.literal("persistent_session"),
      effectId: NonEmptyString,
      payload: PersistentSessionCreatedPayloadSchema,
    }),
    z.object({
      identityId: IdentityIdSchema,
      effectFamily: z.literal("subagent"),
      effectId: NonEmptyString,
      payload: SubagentCreatedPayloadSchema,
    }),
    z.object({
      identityId: IdentityIdSchema,
      effectFamily: z.literal("reminder"),
      effectId: NonEmptyString,
      payload: ReminderSetPayloadSchema,
    }),
    z.object({
      identityId: IdentityIdSchema,
      effectFamily: z.literal("artifact"),
      effectId: NonEmptyString,
      payload: ArtifactCreatedPayloadSchema,
    }),
    z.object({
      identityId: IdentityIdSchema,
      effectFamily: z.literal("task"),
      effectId: NonEmptyString,
      payload: TaskLifecyclePayloadSchema,
    }),
    z.object({
      identityId: IdentityIdSchema,
      effectFamily: z.literal("policy_approval"),
      effectId: NonEmptyString,
      payload: PolicyApprovalPayloadSchema,
    }),
    z.object({
      identityId: IdentityIdSchema,
      effectFamily: z.literal("policy_budget"),
      effectId: NonEmptyString,
      payload: PolicyBudgetPayloadSchema,
    }),
    z.object({
      identityId: IdentityIdSchema,
      effectFamily: z.literal("policy_role"),
      effectId: NonEmptyString,
      payload: PolicyRolePayloadSchema,
    }),
    z.object({
      identityId: IdentityIdSchema,
      effectFamily: z.literal("policy_retry"),
      effectId: NonEmptyString,
      payload: PolicyRetryPayloadSchema,
    }),
    z.object({
      identityId: IdentityIdSchema,
      effectFamily: z.literal("policy_escalation"),
      effectId: NonEmptyString,
      payload: PolicyEscalationPayloadSchema,
    }),
  ]);

/**
 * Internal-use exhaustiveness helper. Pass a value of `never` here to
 * force a TypeScript error if a switch over `EpisodicMemoryEvent` (or
 * over `EpisodicEffectFamily`) ever misses a case. The
 * `memory-store.contract.test.ts` file uses this to enforce that
 * adding a new variant breaks the build of every consumer that did
 * NOT extend their switch — the only guarantee that prevents silent
 * payload drift across slices F / G / J / K.
 */
export function assertNeverEpisodic(value: never): never {
  throw new Error(
    `assertNeverEpisodic: unhandled episodic memory event variant ${JSON.stringify(value)}`,
  );
}
