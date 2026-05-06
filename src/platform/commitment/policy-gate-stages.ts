import { z } from "zod";

import type { IdentityId } from "../identity/identity-id.js";
import { isIdentityId, asIdentityId } from "../identity/identity-id.js";

import type { EffectId } from "./ids.js";

/**
 * Policy-gate stages — type + scaffolding surface for Stages 2-6 of
 * `commitment_kernel_policy_gate_full.plan.md`.
 *
 * **Architectural decisions (Phase 1 audit, `extensions/AUDIT-policy-gate-full.md`):**
 *
 * 1. **Orthogonal pattern.** Each stage carries its own frozen reasons
 *    tuple in this file (NOT an extension of `POLICY_GATE_REASONS` in
 *    `policy-gate.ts`). Stage 1 (`CLARIFICATION_POLICY_REASONS`) precedent
 *    — keeping reason registries separate makes scope creep visible at
 *    PR review (push to any tuple throws via `Object.freeze`).
 * 2. **Frozen-layer untouched.** `policy-gate.ts` reverse-test stays
 *    BYTE-IDENTICAL across all five stages; the file's `POLICY_GATE_REASONS`
 *    union remains `{"channel_disabled", "no_credentials"}`.
 * 3. **`EFFECT_FAMILY_REGISTRY` untouched.** That registry is the
 *    intent-contractor closed list (the families the model may pick from);
 *    policy-gate denials are NOT effect families a user asks for. Memory-side
 *    policy events flow through `EpisodicEffectFamily` extension only
 *    (`src/platform/memory/episodic-memory-event.ts`).
 * 4. **`RuntimeAttestation` untouched.** Observability flows through
 *    decision-trace + `policy_*` episodic events + per-axis log lines, not
 *    via a new optional `policyDenialReasons?` slot — that would create
 *    a ghost field on every actually-attested run (policy denials short-circuit
 *    upstream of the runtime).
 *
 * Phase 2 ships TYPES + SCAFFOLDING ONLY. Reader implementations
 * (`createApprovalPolicy`, `createBudgetPolicy`, etc.) land in Phases 3-7,
 * each with its own factory file under `src/platform/commitment/`.
 *
 * Brand discipline (invariant #16): `ApprovalRequestId`, `BudgetWindowId`,
 * and `RoleId` are distinct branded `string` types. `EffectId` and
 * `IdentityId` are imported untouched — never carry an `EffectId` directly
 * into a brand intended to identify a budget window or a role.
 */

/* -------------------------------------------------------------------------- */
/*                              Branded ID types                              */
/* -------------------------------------------------------------------------- */

declare const ApprovalRequestIdBrand: unique symbol;
/**
 * Branded id for a Stage 2 (Approvals) approval request. Distinct from
 * `EffectId` and `IdentityId` per invariant #16. Phase 2 ships the brand
 * symbol only; the validating constructor (e.g. `asApprovalRequestId`) lands
 * in Phase 3 with the format finalized at the same time.
 */
export type ApprovalRequestId = string & {
  readonly [ApprovalRequestIdBrand]: true;
};

declare const BudgetWindowIdBrand: unique symbol;
/**
 * Branded id for a Stage 3 (Budgets) accounting window. Distinct from
 * `EffectId` and `IdentityId` per invariant #16. Phase 2 brand only;
 * Phase 4 supplies the validating constructor and SQLite-backed lookup.
 */
export type BudgetWindowId = string & {
  readonly [BudgetWindowIdBrand]: true;
};

declare const RoleIdBrand: unique symbol;
/**
 * Branded id for a Stage 4 (Role-based) identity role. Distinct from
 * `IdentityId` per invariant #16: an identity is the operator; a role is
 * the capability bundle assigned to that operator. Phase 2 brand only;
 * Phase 5 supplies the validating constructor and the
 * config-driven `policy.roles[<role>].allowedEffects` registry.
 */
export type RoleId = string & {
  readonly [RoleIdBrand]: true;
};

/* -------------------------------------------------------------------------- */
/*                       Frozen reasons tuples (orthogonal)                   */
/* -------------------------------------------------------------------------- */

/**
 * Stage 2 — Approvals. Single reason: caller must obtain an explicit
 * positive acknowledgement before the gated effect proceeds. The
 * `ApprovalRequestId` is carried in the decision payload, NOT smuggled
 * through the reason enum (closed-set discipline).
 */
export const APPROVAL_POLICY_REASONS = Object.freeze([
  "requires_approval",
] as const);
export type ApprovalPolicyReason = (typeof APPROVAL_POLICY_REASONS)[number];

/**
 * Stage 3 — Budgets. Three orthogonal sub-reasons (per Phase 1 audit §b):
 * the dimension matters for observability (`event=budget_exceeded
 * dimension=…`) and for escalation routing. A single
 * `'budget_exceeded'` reason with a structured payload would force callers
 * to read the payload to know which axis tripped, defeating the closed-set
 * guarantee.
 */
export const BUDGET_POLICY_REASONS = Object.freeze([
  "budget_exceeded_user",
  "budget_exceeded_channel",
  "budget_exceeded_effect",
] as const);
export type BudgetPolicyReason = (typeof BUDGET_POLICY_REASONS)[number];

/**
 * Stage 4 — Role-based. Single reason: identity lacks the role required
 * for the effect. The `requiredRole` is data carried in the decision
 * payload, never part of the reasons enum (mirrors Stage 1 discipline).
 */
export const ROLE_POLICY_REASONS = Object.freeze(["role_denied"] as const);
export type RolePolicyReason = (typeof ROLE_POLICY_REASONS)[number];

/**
 * Stage 5 — Retry. Single terminal reason: the per-(identity × effect ×
 * session) attempt counter has reached the configured limit. Backoff
 * progression is observability (logged per attempt), NOT a reason code —
 * the temporal `{ retry: true, backoffMs }` arm of the decision lives on
 * the discriminated union below.
 */
export const RETRY_POLICY_REASONS = Object.freeze([
  "retry_limit_exceeded",
] as const);
export type RetryPolicyReason = (typeof RETRY_POLICY_REASONS)[number];

/**
 * Stage 6 — Escalation. The hook is observability, not a gate (per
 * sub-plan §10 invariant #3 footnote: "escalation = observability, не
 * gating"). The single reason `'escalation_failed'` exists only for the
 * failure-isolation telemetry path: when the escalation hook itself
 * throws, the calling commitment STILL satisfies — the escalation failure
 * is logged with this reason and the originating denial reason is carried
 * via the episodic-event payload (`originReason`).
 */
export const ESCALATION_POLICY_REASONS = Object.freeze([
  "escalation_failed",
] as const);
export type EscalationPolicyReason =
  (typeof ESCALATION_POLICY_REASONS)[number];

/* -------------------------------------------------------------------------- */
/*                       Per-stage decision unions                            */
/* -------------------------------------------------------------------------- */

/**
 * Stage 2 — Approvals decision. On `approved=false` the caller MUST
 * surface the `approvalRequestId` so downstream observability and the
 * approval manager can join on the same id.
 */
export type ApprovalPolicyDecision =
  | { readonly approved: true }
  | {
      readonly approved: false;
      readonly reason: ApprovalPolicyReason;
      readonly approvalRequestId: ApprovalRequestId;
    };

/**
 * Stage 3 — Budgets decision. On `within=true` the caller may consult
 * `remaining` for soft-warning telemetry. On `within=false` the
 * `windowId` is mandatory so the same window can be reset / re-checked
 * across turns.
 */
export type BudgetPolicyDecision =
  | { readonly within: true; readonly remaining: number }
  | {
      readonly within: false;
      readonly reason: BudgetPolicyReason;
      readonly windowId: BudgetWindowId;
      readonly used: number;
      readonly limit: number;
    };

/**
 * Stage 4 — Role-based decision. The granted role is surfaced on
 * `allowed=true` for downstream telemetry; `requiredRole` is surfaced on
 * `allowed=false` so the caller (or escalation hook) can route the denial
 * to whoever holds that role.
 */
export type RolePolicyDecision =
  | { readonly allowed: true; readonly role: RoleId }
  | {
      readonly allowed: false;
      readonly reason: RolePolicyReason;
      readonly requiredRole: RoleId;
    };

/**
 * Stage 5 — Retry decision. The temporal arm carries `backoffMs`; the
 * terminal arm carries the `attemptCount` / `maxAttempts` pair so
 * observability can render `[policy-gate] event=retry_exhausted
 * attempt=<n>/<max>` without a separate lookup.
 */
export type RetryPolicyDecision =
  | { readonly retry: true; readonly backoffMs: number }
  | {
      readonly retry: false;
      readonly reason: RetryPolicyReason;
      readonly attemptCount: number;
      readonly maxAttempts: number;
    };

/**
 * Stage 6 — Escalation hook decision. The hook is observability and
 * does NOT gate the calling commitment (a `false` here never short-circuits
 * the affordance — `policy-gate.ts` already settled allow/deny upstream).
 */
export type EscalationHookDecision =
  | { readonly fired: true; readonly escalationId: string }
  | {
      readonly fired: false;
      readonly reason: EscalationPolicyReason;
      readonly error: Error;
    };

/* -------------------------------------------------------------------------- */
/*                       Reader interfaces (signatures only)                   */
/* -------------------------------------------------------------------------- */

/**
 * Stage 2 — Approvals reader. Phase 3 supplies the implementation
 * (`createApprovalPolicy({cfg, approvalLookup})`); Phase 2 only freezes
 * the shape so wiring + tests can compile.
 *
 * Phase 3 amendment: `identityId` is optional. An undefined identity
 * marks an anonymous turn — the gate fail-closes when the effect is
 * listed in `policy.approvals`, and passes (default-allow) when it is
 * not (`createApprovalPolicy` is a denial gate, not an identification
 * gate).
 */
export type ApprovalPolicyEvaluateInput = {
  readonly identityId?: IdentityId;
  readonly effectId: EffectId;
};

export interface ApprovalPolicyReader {
  /**
   * Evaluate whether the given `(identityId, effectId)` requires an
   * explicit approval. Returns synchronously OR via a Promise — the
   * concrete impl (Phase 3) may consult an in-memory config-derived table
   * synchronously, while a future remote-approval-server impl may need
   * `await`.
   */
  evaluate(
    params: ApprovalPolicyEvaluateInput,
  ): ApprovalPolicyDecision | Promise<ApprovalPolicyDecision>;
}

/**
 * Stage 3 — Budgets reader. Phase 4 supplies the SQLite-backed
 * implementation (`createBudgetPolicy({cfg, budgetStore})`).
 */
export type BudgetPolicyEvaluateInput = {
  readonly identityId: IdentityId;
  readonly effectId: EffectId;
  readonly channel: string;
};

export interface BudgetPolicyReader {
  evaluate(
    params: BudgetPolicyEvaluateInput,
  ): BudgetPolicyDecision | Promise<BudgetPolicyDecision>;
}

/**
 * Stage 4 — Role-based reader. Phase 5 supplies the implementation
 * (`createRolePolicy({cfg, roleResolver})`).
 */
export type RolePolicyEvaluateInput = {
  readonly identityId: IdentityId;
  readonly effectId: EffectId;
};

export interface RolePolicyReader {
  evaluate(
    params: RolePolicyEvaluateInput,
  ): RolePolicyDecision | Promise<RolePolicyDecision>;
}

/**
 * Stage 5 — Retry reader. Phase 6 supplies the in-memory LRU-backed
 * implementation (`createRetryPolicy({cfg})`); the counter is intentionally
 * non-persistent (resets across `/new`).
 */
export type RetryPolicyEvaluateInput = {
  readonly identityId: IdentityId;
  readonly effectId: EffectId;
  readonly sessionId: string;
  readonly attemptCount: number;
};

export interface RetryPolicyReader {
  evaluate(
    params: RetryPolicyEvaluateInput,
  ): RetryPolicyDecision | Promise<RetryPolicyDecision>;
}

/**
 * Stage 6 — Escalation hook. Phase 7 supplies the implementation
 * (`createEscalationHook({cfg, approvalManager, memoryStore})`). The hook
 * NEVER gates: a thrown error returns `{fired: false, reason:
 * 'escalation_failed'}` and the calling commitment proceeds.
 */
export type EscalationHookFireInput = {
  readonly identityId: IdentityId;
  readonly effectId: EffectId;
  readonly denialReason:
    | ApprovalPolicyReason
    | BudgetPolicyReason
    | RolePolicyReason
    | RetryPolicyReason;
  readonly channel: string;
};

export interface EscalationHook {
  fire(
    params: EscalationHookFireInput,
  ): EscalationHookDecision | Promise<EscalationHookDecision>;
}

/* -------------------------------------------------------------------------- */
/*                       Zod schemas (input / output)                         */
/* -------------------------------------------------------------------------- */

/**
 * Branded-id Zod schema with a permissive runtime guard — Phase 2 ships
 * the schema shape only. Phases 3-7 will replace `BrandedNonEmptyString`
 * with a tighter `refine(isApprovalRequestId)` etc. once the format is
 * pinned.
 */
const BrandedNonEmptyString = z.string().min(1);

const IdentityIdSchema = z
  .string()
  .refine(isIdentityId, {
    message: 'expected an IdentityId of the form "identity:<slug>"',
  })
  .transform((value) => asIdentityId(value));

const EffectIdSchema = z.string().min(1).transform((value) => value as EffectId);

const ApprovalRequestIdSchema = BrandedNonEmptyString.transform(
  (value) => value as ApprovalRequestId,
);
const BudgetWindowIdSchema = BrandedNonEmptyString.transform(
  (value) => value as BudgetWindowId,
);
const RoleIdSchema = BrandedNonEmptyString.transform(
  (value) => value as RoleId,
);

/* ----- Stage 2 — Approvals schemas ---------------------------------------- */

export const ApprovalPolicyEvaluateInputSchema: z.ZodType<ApprovalPolicyEvaluateInput> =
  z.object({
    identityId: IdentityIdSchema.optional(),
    effectId: EffectIdSchema,
  });

export const ApprovalPolicyDecisionSchema: z.ZodType<ApprovalPolicyDecision> =
  z.discriminatedUnion("approved", [
    z.object({ approved: z.literal(true) }),
    z.object({
      approved: z.literal(false),
      reason: z.enum(APPROVAL_POLICY_REASONS),
      approvalRequestId: ApprovalRequestIdSchema,
    }),
  ]);

/* ----- Stage 3 — Budgets schemas ------------------------------------------ */

export const BudgetPolicyEvaluateInputSchema: z.ZodType<BudgetPolicyEvaluateInput> =
  z.object({
    identityId: IdentityIdSchema,
    effectId: EffectIdSchema,
    channel: z.string().min(1),
  });

export const BudgetPolicyDecisionSchema: z.ZodType<BudgetPolicyDecision> =
  z.discriminatedUnion("within", [
    z.object({ within: z.literal(true), remaining: z.number().nonnegative() }),
    z.object({
      within: z.literal(false),
      reason: z.enum(BUDGET_POLICY_REASONS),
      windowId: BudgetWindowIdSchema,
      used: z.number().nonnegative(),
      limit: z.number().nonnegative(),
    }),
  ]);

/* ----- Stage 4 — Role-based schemas --------------------------------------- */

export const RolePolicyEvaluateInputSchema: z.ZodType<RolePolicyEvaluateInput> =
  z.object({
    identityId: IdentityIdSchema,
    effectId: EffectIdSchema,
  });

export const RolePolicyDecisionSchema: z.ZodType<RolePolicyDecision> =
  z.discriminatedUnion("allowed", [
    z.object({ allowed: z.literal(true), role: RoleIdSchema }),
    z.object({
      allowed: z.literal(false),
      reason: z.enum(ROLE_POLICY_REASONS),
      requiredRole: RoleIdSchema,
    }),
  ]);

/* ----- Stage 5 — Retry schemas -------------------------------------------- */

export const RetryPolicyEvaluateInputSchema: z.ZodType<RetryPolicyEvaluateInput> =
  z.object({
    identityId: IdentityIdSchema,
    effectId: EffectIdSchema,
    sessionId: z.string().min(1),
    attemptCount: z.number().int().nonnegative(),
  });

export const RetryPolicyDecisionSchema: z.ZodType<RetryPolicyDecision> =
  z.discriminatedUnion("retry", [
    z.object({ retry: z.literal(true), backoffMs: z.number().nonnegative() }),
    z.object({
      retry: z.literal(false),
      reason: z.enum(RETRY_POLICY_REASONS),
      attemptCount: z.number().int().nonnegative(),
      maxAttempts: z.number().int().positive(),
    }),
  ]);

/* ----- Stage 6 — Escalation schemas --------------------------------------- */

const DenialReasonSchema = z.union([
  z.enum(APPROVAL_POLICY_REASONS),
  z.enum(BUDGET_POLICY_REASONS),
  z.enum(ROLE_POLICY_REASONS),
  z.enum(RETRY_POLICY_REASONS),
]);

export const EscalationHookFireInputSchema: z.ZodType<EscalationHookFireInput> =
  z.object({
    identityId: IdentityIdSchema,
    effectId: EffectIdSchema,
    denialReason: DenialReasonSchema,
    channel: z.string().min(1),
  });

// `Error` is not directly representable with Zod's stock schema set; the
// hook decision schema validates the `fired=false` shape via an `instanceof`
// refinement so the round-trip remains tight without forcing callers to
// pre-serialise the error.
export const EscalationHookDecisionSchema: z.ZodType<EscalationHookDecision> =
  z.discriminatedUnion("fired", [
    z.object({ fired: z.literal(true), escalationId: z.string().min(1) }),
    z.object({
      fired: z.literal(false),
      reason: z.enum(ESCALATION_POLICY_REASONS),
      error: z.custom<Error>((value) => value instanceof Error, {
        message: "expected an Error instance",
      }),
    }),
  ]);
