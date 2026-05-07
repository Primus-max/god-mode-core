import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

/**
 * Cron/Scheduler Phase 7 — `policy.*` config-schema tests for the
 * `reminder.set` write effect.
 *
 * Phase 7 of `commitment_kernel_cron_scheduler.plan.md` is config-only:
 * the existing PolicyGate Full readers (`createApprovalPolicy`,
 * `createBudgetPolicy`, `createRolePolicy`, `createRetryPolicy`,
 * `createEscalationHook`) accept arbitrary `effectId` strings, so the
 * Phase 7 work consists of (a) extending the mutation-idempotency
 * `superRefine` with `reminder.set` in the locked-to-zero list and
 * (b) pinning the per-stage acceptance shapes for
 * `policy.approvals[]` / `policy.budgets[]` / `policy.roles.*` /
 * `policy.retry.perEffect[*]` so future schema tightening cannot
 * silently regress reminder.set support.
 *
 * The most load-bearing assertion in this file is the reverse-test
 * for the mutation-idempotency lock — sub-plan §1 todo for Phase 7
 * fixes the rule "no config can override `maxAttempts=0` for
 * `reminder.set`" because re-running `RecordReminderTool` would
 * register a duplicate `at`-fire CronService callback (double-push
 * at fire-time).
 *
 * Acceptance log lines (verified end-to-end in the cron-scheduler
 * acceptance fixture, not here):
 *   - `[policy-gate] event=role_checked stage=4 effect=reminder.set allowed=<bool>`
 *   - `[policy-gate] event=budget_exceeded effect=reminder.set window_id=<...>`
 *   - `[policy-gate] event=approval_checked stage=2 effect=reminder.set approved=<bool>`
 *   - `[policy-gate] event=retry_exhausted effect=reminder.set` (only fires when reverse-test BREAKS — must NEVER appear in production)
 *   - `[policy-gate] event=escalation_fired reason=<r> origin=reminder-set-policy-denial`
 */

describe("zod-schema policy.retry slot — reminder.set mutation lock (Cron/Scheduler Phase 7)", () => {
  it("accepts maxAttempts=0 for reminder.set (canonical mutation-idempotency-locked value)", () => {
    const res = validateConfigObject({
      policy: {
        retry: {
          perEffect: {
            "reminder.set": { maxAttempts: 0 },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("REVERSE-TEST: rejects maxAttempts=1 for reminder.set (mutation idempotency lock — duplicate cron callback ⇒ double-push)", () => {
    const res = validateConfigObject({
      policy: {
        retry: {
          perEffect: {
            "reminder.set": { maxAttempts: 1 },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
    const issues = res.ok ? [] : res.issues;
    const matched = issues.find(
      (issue) =>
        issue.path.includes("reminder.set") && /maxAttempts/i.test(issue.message),
    );
    expect(matched).toBeDefined();
  });

  it("REVERSE-TEST: rejects maxAttempts=2 for reminder.set", () => {
    const res = validateConfigObject({
      policy: {
        retry: {
          perEffect: {
            "reminder.set": { maxAttempts: 2 },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
    const issues = res.ok ? [] : res.issues;
    expect(
      issues.some(
        (issue) =>
          issue.path.includes("reminder.set") && /maxAttempts/i.test(issue.message),
      ),
    ).toBe(true);
  });

  it("REVERSE-TEST: rejects maxAttempts=10 for reminder.set", () => {
    const res = validateConfigObject({
      policy: {
        retry: {
          perEffect: {
            "reminder.set": { maxAttempts: 10 },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("repo mutation locks remain in force alongside reminder.set (regression — Cutover-4 Phase 6 invariants preserved)", () => {
    const res = validateConfigObject({
      policy: {
        retry: {
          perEffect: {
            "repo.branch_created": { maxAttempts: 1 },
            "reminder.set": { maxAttempts: 0 },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
    const issues = res.ok ? [] : res.issues;
    expect(
      issues.some(
        (issue) =>
          issue.path.includes("repo.branch_created") &&
          /maxAttempts/i.test(issue.message),
      ),
    ).toBe(true);
  });

  it("accepts both reminder.set=0 and repo mutations=0 in the same retry block", () => {
    const res = validateConfigObject({
      policy: {
        retry: {
          perEffect: {
            "repo.branch_created": { maxAttempts: 0 },
            "repo.commit_landed": { maxAttempts: 0 },
            "repo.merge_completed": { maxAttempts: 0 },
            "reminder.set": { maxAttempts: 0 },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts maxBackoffMs alongside maxAttempts=0 for reminder.set", () => {
    const res = validateConfigObject({
      policy: {
        retry: {
          perEffect: {
            "reminder.set": { maxAttempts: 0, maxBackoffMs: 5_000 },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });
});

describe("zod-schema policy.* reminder.set entry acceptance — Cron/Scheduler Phase 7", () => {
  // The reminder.set effect id must be acceptable as an `effectId` string
  // in existing Stage 2 / 3 / 4 slots. The Zod schema for those slots
  // already validates only `string.min(1)` per Phase 3-5 of PolicyGate
  // Full. These tests pin the contract so a future tightening (e.g.
  // enum-locking effect ids) does not silently regress reminder.set
  // support.

  it("accepts reminder.set in policy.approvals (Stage 2) — high-cardinality reminders require approver", () => {
    const res = validateConfigObject({
      policy: {
        approvals: [
          {
            effectId: "reminder.set",
            requiredApprovals: 1,
            approvers: ["identity:vladimir"],
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts a per-channel hourly cap on reminder.set via policy.budgets (Stage 3, perChannelHourly=10)", () => {
    const res = validateConfigObject({
      policy: {
        budgets: [
          {
            dimension: "channel",
            limit: 10,
            windowMs: 60 * 60 * 1000,
            channel: "telegram",
            effectFamily: "reminder",
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts a per-identity daily cap on reminder.set via policy.budgets (Stage 3, perIdentityDaily=50)", () => {
    const res = validateConfigObject({
      policy: {
        budgets: [
          {
            dimension: "user",
            limit: 50,
            windowMs: 24 * 60 * 60 * 1000,
            identityId: "identity:vladimir",
            effectFamily: "reminder",
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts maintainer / developer role allowedEffects with reminder.set (Stage 4) — viewer NOT added", () => {
    const res = validateConfigObject({
      policy: {
        roles: {
          maintainer: {
            allowedEffects: ["reminder.set"],
            description: "Full reminder write authority",
          },
          developer: {
            allowedEffects: ["reminder.set"],
            description: "Reminder write permitted",
          },
          viewer: {
            // Intentional: viewer NOT permitted reminder.set per spec
            // (sub-plan §1 todo Phase 7 — viewer→none, anonymous→fail-closed
            // by default).
            allowedEffects: [],
            description: "Read-only — NO reminder.set",
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("composite acceptance: full policy block carrying all 5 stages for reminder.set passes Zod end-to-end", () => {
    // Smoke acceptance that the per-stage shapes coexist in one block.
    // Mirrors the Cutover-4 Phase 6 composite repo-block precedent.
    const res = validateConfigObject({
      policy: {
        approvals: [
          {
            effectId: "reminder.set",
            requiredApprovals: 1,
            approvers: ["identity:vladimir"],
          },
        ],
        budgets: [
          {
            dimension: "channel",
            limit: 10,
            windowMs: 60 * 60 * 1000,
            channel: "telegram",
            effectFamily: "reminder",
          },
          {
            dimension: "user",
            limit: 50,
            windowMs: 24 * 60 * 60 * 1000,
            identityId: "identity:vladimir",
            effectFamily: "reminder",
          },
        ],
        roles: {
          maintainer: { allowedEffects: ["reminder.set", "*"] },
          developer: { allowedEffects: ["reminder.set"] },
          viewer: { allowedEffects: [] },
        },
        retry: {
          perEffect: {
            "reminder.set": { maxAttempts: 0 },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });
});
