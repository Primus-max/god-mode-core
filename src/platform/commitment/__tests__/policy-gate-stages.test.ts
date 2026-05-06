import { describe, expect, it } from "vitest";

import { asIdentityId } from "../../identity/identity-id.js";
import {
  APPROVAL_POLICY_REASONS,
  ApprovalPolicyDecisionSchema,
  ApprovalPolicyEvaluateInputSchema,
  BUDGET_POLICY_REASONS,
  BudgetPolicyDecisionSchema,
  BudgetPolicyEvaluateInputSchema,
  ESCALATION_POLICY_REASONS,
  EscalationHookDecisionSchema,
  EscalationHookFireInputSchema,
  RETRY_POLICY_REASONS,
  ROLE_POLICY_REASONS,
  RetryPolicyDecisionSchema,
  RetryPolicyEvaluateInputSchema,
  RolePolicyDecisionSchema,
  RolePolicyEvaluateInputSchema,
  type ApprovalRequestId,
  type BudgetWindowId,
  type RoleId,
} from "../index.js";
import type { EffectId } from "../ids.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const POST_EFFECT = "external_effect.performed" as EffectId;

/* -------------------------------------------------------------------------- */
/*           Brand non-assignability — invariant #16 compile-checks            */
/* -------------------------------------------------------------------------- */

describe("policy-gate-stages — brand discipline (invariant #16)", () => {
  it("rejects a raw string passed where ApprovalRequestId is required", () => {
    // Brand non-assignability: a literal string MUST NOT pass for a
    // branded id. The cast through `unknown` is the only way to bypass
    // — without `as unknown as ApprovalRequestId` the line fails to
    // compile, which is the guarantee we want.
    const _raw: ApprovalRequestId = "approval:0001" as unknown as ApprovalRequestId;
    expect(typeof _raw).toBe("string");
    // @ts-expect-error - direct assignment of a raw string is rejected
    const _bad: ApprovalRequestId = "approval:0001";
    expect(typeof _bad).toBe("string");
  });

  it("rejects a raw string passed where BudgetWindowId is required", () => {
    const _raw: BudgetWindowId = "budget:user:vlad:2026-05" as unknown as BudgetWindowId;
    expect(typeof _raw).toBe("string");
    // @ts-expect-error - raw string cannot be assigned to BudgetWindowId
    const _bad: BudgetWindowId = "budget:user:vlad:2026-05";
    expect(typeof _bad).toBe("string");
  });

  it("rejects a raw string passed where RoleId is required", () => {
    const _raw: RoleId = "admin" as unknown as RoleId;
    expect(typeof _raw).toBe("string");
    // @ts-expect-error - raw string cannot be assigned to RoleId
    const _bad: RoleId = "admin";
    expect(typeof _bad).toBe("string");
  });

  it("does NOT allow EffectId to be assigned to ApprovalRequestId or vice versa", () => {
    // EffectId and ApprovalRequestId are distinct brands per the audit
    // §c brand-discipline note. Implicit conversion in either direction
    // is a TS error.
    const effect = POST_EFFECT;
    // @ts-expect-error - EffectId is not assignable to ApprovalRequestId
    const _bad1: ApprovalRequestId = effect;
    void _bad1;
    const approval = "approval:001" as unknown as ApprovalRequestId;
    // @ts-expect-error - ApprovalRequestId is not assignable to EffectId
    const _bad2: EffectId = approval;
    void _bad2;
    expect(typeof effect).toBe("string");
  });
});

/* -------------------------------------------------------------------------- */
/*           Frozen-set reverse-tests (5 stages × push-throws)                */
/* -------------------------------------------------------------------------- */

describe("APPROVAL_POLICY_REASONS — frozen reverse-test (Stage 2)", () => {
  it("exposes exactly one reason: requires_approval", () => {
    expect(APPROVAL_POLICY_REASONS).toEqual(["requires_approval"]);
  });

  it("freezes the reason set so silent extension fails", () => {
    expect(Object.isFrozen(APPROVAL_POLICY_REASONS)).toBe(true);
    expect(() => {
      (APPROVAL_POLICY_REASONS as unknown as string[]).push("requires_double_signoff");
    }).toThrow();
  });
});

describe("BUDGET_POLICY_REASONS — frozen reverse-test (Stage 3)", () => {
  it("exposes exactly three orthogonal dimension reasons", () => {
    expect(BUDGET_POLICY_REASONS).toEqual([
      "budget_exceeded_user",
      "budget_exceeded_channel",
      "budget_exceeded_effect",
    ]);
  });

  it("freezes the reason set so silent extension fails", () => {
    expect(Object.isFrozen(BUDGET_POLICY_REASONS)).toBe(true);
    expect(() => {
      (BUDGET_POLICY_REASONS as unknown as string[]).push("budget_exceeded_session");
    }).toThrow();
  });
});

describe("ROLE_POLICY_REASONS — frozen reverse-test (Stage 4)", () => {
  it("exposes exactly one reason: role_denied", () => {
    expect(ROLE_POLICY_REASONS).toEqual(["role_denied"]);
  });

  it("freezes the reason set so silent extension fails", () => {
    expect(Object.isFrozen(ROLE_POLICY_REASONS)).toBe(true);
    expect(() => {
      (ROLE_POLICY_REASONS as unknown as string[]).push("role_revoked");
    }).toThrow();
  });
});

describe("RETRY_POLICY_REASONS — frozen reverse-test (Stage 5)", () => {
  it("exposes exactly one reason: retry_limit_exceeded", () => {
    expect(RETRY_POLICY_REASONS).toEqual(["retry_limit_exceeded"]);
  });

  it("freezes the reason set so silent extension fails", () => {
    expect(Object.isFrozen(RETRY_POLICY_REASONS)).toBe(true);
    expect(() => {
      (RETRY_POLICY_REASONS as unknown as string[]).push("retry_disallowed");
    }).toThrow();
  });
});

describe("ESCALATION_POLICY_REASONS — frozen reverse-test (Stage 6)", () => {
  it("exposes exactly one reason: escalation_failed", () => {
    expect(ESCALATION_POLICY_REASONS).toEqual(["escalation_failed"]);
  });

  it("freezes the reason set so silent extension fails", () => {
    expect(Object.isFrozen(ESCALATION_POLICY_REASONS)).toBe(true);
    expect(() => {
      (ESCALATION_POLICY_REASONS as unknown as string[]).push("escalation_throttled");
    }).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/*                       Zod round-trip per stage                              */
/* -------------------------------------------------------------------------- */

describe("ApprovalPolicy — Zod round-trip (Stage 2)", () => {
  it("parses a valid evaluate-input shape", () => {
    const parsed = ApprovalPolicyEvaluateInputSchema.parse({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
    });
    expect(parsed.identityId).toBe(VLADIMIR);
    expect(parsed.effectId).toBe(POST_EFFECT);
  });

  it("parses both branches of the decision union", () => {
    expect(ApprovalPolicyDecisionSchema.parse({ approved: true })).toEqual({
      approved: true,
    });
    const denial = ApprovalPolicyDecisionSchema.parse({
      approved: false,
      reason: "requires_approval",
      approvalRequestId: "approval:0001",
    });
    expect(denial.approved).toBe(false);
    if (denial.approved === false) {
      expect(denial.reason).toBe("requires_approval");
      expect(denial.approvalRequestId).toBe("approval:0001");
    }
  });

  it("rejects an unknown denial reason", () => {
    expect(() =>
      ApprovalPolicyDecisionSchema.parse({
        approved: false,
        reason: "made_up",
        approvalRequestId: "approval:0001",
      }),
    ).toThrow();
  });
});

describe("BudgetPolicy — Zod round-trip (Stage 3)", () => {
  it("parses a valid evaluate-input shape", () => {
    const parsed = BudgetPolicyEvaluateInputSchema.parse({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      channel: "telegram",
    });
    expect(parsed.channel).toBe("telegram");
  });

  it("parses both branches of the decision union", () => {
    const within = BudgetPolicyDecisionSchema.parse({
      within: true,
      remaining: 7,
    });
    expect(within.within).toBe(true);
    if (within.within) {
      expect(within.remaining).toBe(7);
    }
    const exceeded = BudgetPolicyDecisionSchema.parse({
      within: false,
      reason: "budget_exceeded_user",
      windowId: "budget:vlad:2026-05",
      used: 10,
      limit: 10,
    });
    expect(exceeded.within).toBe(false);
    if (exceeded.within === false) {
      expect(exceeded.reason).toBe("budget_exceeded_user");
    }
  });

  it("rejects an unknown denial reason", () => {
    expect(() =>
      BudgetPolicyDecisionSchema.parse({
        within: false,
        reason: "budget_exceeded_session",
        windowId: "w",
        used: 1,
        limit: 1,
      }),
    ).toThrow();
  });
});

describe("RolePolicy — Zod round-trip (Stage 4)", () => {
  it("parses a valid evaluate-input shape", () => {
    const parsed = RolePolicyEvaluateInputSchema.parse({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
    });
    expect(parsed.effectId).toBe(POST_EFFECT);
  });

  it("parses both branches of the decision union", () => {
    const allowed = RolePolicyDecisionSchema.parse({
      allowed: true,
      role: "admin",
    });
    expect(allowed.allowed).toBe(true);
    const denied = RolePolicyDecisionSchema.parse({
      allowed: false,
      reason: "role_denied",
      requiredRole: "admin",
    });
    expect(denied.allowed).toBe(false);
    if (denied.allowed === false) {
      expect(denied.reason).toBe("role_denied");
      expect(denied.requiredRole).toBe("admin");
    }
  });

  it("rejects an unknown denial reason", () => {
    expect(() =>
      RolePolicyDecisionSchema.parse({
        allowed: false,
        reason: "role_revoked",
        requiredRole: "admin",
      }),
    ).toThrow();
  });
});

describe("RetryPolicy — Zod round-trip (Stage 5)", () => {
  it("parses a valid evaluate-input shape", () => {
    const parsed = RetryPolicyEvaluateInputSchema.parse({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      sessionId: "session-abc",
      attemptCount: 2,
    });
    expect(parsed.attemptCount).toBe(2);
  });

  it("parses both branches of the decision union", () => {
    const retry = RetryPolicyDecisionSchema.parse({
      retry: true,
      backoffMs: 200,
    });
    expect(retry.retry).toBe(true);
    if (retry.retry) {
      expect(retry.backoffMs).toBe(200);
    }
    const exhausted = RetryPolicyDecisionSchema.parse({
      retry: false,
      reason: "retry_limit_exceeded",
      attemptCount: 3,
      maxAttempts: 3,
    });
    expect(exhausted.retry).toBe(false);
  });

  it("rejects a negative attemptCount", () => {
    expect(() =>
      RetryPolicyEvaluateInputSchema.parse({
        identityId: VLADIMIR,
        effectId: POST_EFFECT,
        sessionId: "s",
        attemptCount: -1,
      }),
    ).toThrow();
  });
});

describe("EscalationHook — Zod round-trip (Stage 6)", () => {
  it("parses a valid fire-input shape", () => {
    const parsed = EscalationHookFireInputSchema.parse({
      identityId: VLADIMIR,
      effectId: POST_EFFECT,
      denialReason: "requires_approval",
      channel: "memory",
    });
    expect(parsed.denialReason).toBe("requires_approval");
  });

  it("parses both branches of the decision union", () => {
    const fired = EscalationHookDecisionSchema.parse({
      fired: true,
      escalationId: "escalation-001",
    });
    expect(fired.fired).toBe(true);
    const failed = EscalationHookDecisionSchema.parse({
      fired: false,
      reason: "escalation_failed",
      error: new Error("downstream channel unavailable"),
    });
    expect(failed.fired).toBe(false);
    if (failed.fired === false) {
      expect(failed.reason).toBe("escalation_failed");
      expect(failed.error).toBeInstanceOf(Error);
    }
  });

  it("rejects a denial reason that is not one of the four denial-stage enums", () => {
    expect(() =>
      EscalationHookFireInputSchema.parse({
        identityId: VLADIMIR,
        effectId: POST_EFFECT,
        denialReason: "not_a_real_reason",
        channel: "memory",
      }),
    ).toThrow();
  });

  it("rejects a non-Error error slot on the failed decision", () => {
    expect(() =>
      EscalationHookDecisionSchema.parse({
        fired: false,
        reason: "escalation_failed",
        error: "string is not an Error",
      }),
    ).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/*           POLICY_GATE_REASONS reverse-test integrity (BYTE-IDENTICAL)       */
/* -------------------------------------------------------------------------- */

describe("POLICY_GATE_REASONS — frozen reverse-test stays untouched", () => {
  it("imports cleanly alongside the new orthogonal stage tuples", async () => {
    // Soft cross-check that the orthogonal-pattern audit decision held
    // — the existing `POLICY_GATE_REASONS` reverse-test in
    // `policy-gate.test.ts:40-51` remains the source of truth; this
    // assertion only verifies the import surface coexists with the
    // five new tuples added in this slice.
    const mod = await import("../policy-gate.js");
    expect(mod.POLICY_GATE_REASONS).toEqual(["channel_disabled", "no_credentials"]);
    expect(Object.isFrozen(mod.POLICY_GATE_REASONS)).toBe(true);
  });
});
