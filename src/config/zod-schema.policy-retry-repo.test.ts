import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

/**
 * Cutover-4 Phase 6 — Stage 5 (Retry policy) config-schema tests.
 *
 * Phase 6 of `commitment_kernel_cutover4_repo_operation.plan.md` integrates
 * the existing PolicyGate Full Stage 5 reader (`createRetryPolicy`,
 * `src/platform/commitment/retry-policy.ts`) into the Zod-validated
 * `OpenClawConfig.policy` block by ADDING a new `policy.retry` slot. The
 * runtime reader already consumes the same shape via its local
 * `RetryPolicyConfigShape` typedef; this slice closes the loop by making
 * the public config schema accept it without `as unknown as OpenClawConfig`
 * casts.
 *
 * The most load-bearing assertion in this file is the **reverse-test for
 * mutation idempotency** — sub-plan §3 row Phase 6 fixes the wider rule
 * "no config can override `maxAttempts=0` for any of the three repo
 * mutation effects (`repo.branch_created`, `repo.commit_landed`,
 * `repo.merge_completed`)" because re-running a partially-applied git
 * mutation produces duplicate branches, partial-merge state, or
 * over-commits. Read-only `repo.diff_observed` retries are permitted
 * (defaults to 2 in the per-effect override block).
 *
 * Acceptance log lines (verified end-to-end in the cutover-4 acceptance
 * fixture, not here):
 *   - `[policy-gate] event=retry_checked stage=5 attempt=<n>/<max>`
 *   - `[policy-gate] event=retry_exhausted effect=<id>` on denial
 */

describe("zod-schema policy.retry slot — Cutover-4 Phase 6", () => {
  it("accepts an empty policy.retry block (default-allow, backward-compat)", () => {
    const res = validateConfigObject({
      policy: {
        retry: {},
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts top-level defaults (defaultMaxAttempts + defaultMaxBackoffMs)", () => {
    const res = validateConfigObject({
      policy: {
        retry: {
          defaultMaxAttempts: 3,
          defaultMaxBackoffMs: 30_000,
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts a per-effect override for repo.diff_observed (read-only) with maxAttempts=2", () => {
    const res = validateConfigObject({
      policy: {
        retry: {
          perEffect: {
            "repo.diff_observed": { maxAttempts: 2 },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts maxAttempts=0 for the three repo mutation effects (branch / commit / merge)", () => {
    const res = validateConfigObject({
      policy: {
        retry: {
          perEffect: {
            "repo.branch_created": { maxAttempts: 0 },
            "repo.commit_landed": { maxAttempts: 0 },
            "repo.merge_completed": { maxAttempts: 0 },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("REVERSE-TEST: rejects maxAttempts > 0 for repo.branch_created (mutation idempotency lock)", () => {
    const res = validateConfigObject({
      policy: {
        retry: {
          perEffect: {
            "repo.branch_created": { maxAttempts: 1 },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
    const issues = res.ok ? [] : res.issues;
    const matched = issues.find((i) =>
      i.path.includes("repo.branch_created") && /maxAttempts/i.test(i.message),
    );
    expect(matched).toBeDefined();
  });

  it("REVERSE-TEST: rejects maxAttempts > 0 for repo.commit_landed (mutation idempotency lock)", () => {
    const res = validateConfigObject({
      policy: {
        retry: {
          perEffect: {
            "repo.commit_landed": { maxAttempts: 5 },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
    const issues = res.ok ? [] : res.issues;
    expect(
      issues.some(
        (i) =>
          i.path.includes("repo.commit_landed") && /maxAttempts/i.test(i.message),
      ),
    ).toBe(true);
  });

  it("REVERSE-TEST: rejects maxAttempts > 0 for repo.merge_completed (mutation idempotency lock)", () => {
    const res = validateConfigObject({
      policy: {
        retry: {
          perEffect: {
            "repo.merge_completed": { maxAttempts: 2 },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
    const issues = res.ok ? [] : res.issues;
    expect(
      issues.some(
        (i) =>
          i.path.includes("repo.merge_completed") &&
          /maxAttempts/i.test(i.message),
      ),
    ).toBe(true);
  });

  it("rejects negative maxAttempts (Zod nonnegative-int floor)", () => {
    const res = validateConfigObject({
      policy: {
        retry: {
          perEffect: {
            "some.effect": { maxAttempts: -1 },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("rejects non-integer maxAttempts", () => {
    const res = validateConfigObject({
      policy: {
        retry: {
          perEffect: {
            "some.effect": { maxAttempts: 1.5 },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("accepts maxBackoffMs alongside maxAttempts in a per-effect entry", () => {
    const res = validateConfigObject({
      policy: {
        retry: {
          perEffect: {
            "repo.diff_observed": { maxAttempts: 2, maxBackoffMs: 5_000 },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });
});

describe("zod-schema policy.* repo-effect entry acceptance — Cutover-4 Phase 6", () => {
  // The four repo effect ids must be acceptable as `effectId` strings in
  // existing Stage 2 / 3 / 4 slots even before Phase 6 lands the dedicated
  // retry slot — the Zod schema for those slots already validates only
  // `string.min(1)` per Phase 3-5 of PolicyGate Full. These tests pin the
  // contract so a future tightening (e.g. enum-locking effect ids) does
  // not silently regress repo support.

  it("accepts repo.merge_completed in policy.approvals (Stage 2)", () => {
    const res = validateConfigObject({
      policy: {
        approvals: [
          {
            effectId: "repo.merge_completed",
            requiredApprovals: 1,
            approvers: ["identity:vladimir"],
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts a per-channel hourly cap on repo.commit_landed via policy.budgets (Stage 3)", () => {
    const res = validateConfigObject({
      policy: {
        budgets: [
          {
            dimension: "channel",
            limit: 5,
            windowMs: 60 * 60 * 1000,
            channel: "telegram",
            effectFamily: "repo",
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts a per-identity daily cap on repo.merge_completed via policy.budgets (Stage 3)", () => {
    const res = validateConfigObject({
      policy: {
        budgets: [
          {
            dimension: "user",
            limit: 1,
            windowMs: 24 * 60 * 60 * 1000,
            identityId: "identity:vladimir",
            effectFamily: "repo",
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts maintainer / developer / viewer role allowedEffects with repo entries (Stage 4)", () => {
    const res = validateConfigObject({
      policy: {
        roles: {
          maintainer: {
            allowedEffects: [
              "repo.branch_created",
              "repo.commit_landed",
              "repo.merge_completed",
              "repo.diff_observed",
            ],
            description: "Full repo authority",
          },
          developer: {
            allowedEffects: [
              "repo.branch_created",
              "repo.commit_landed",
              "repo.diff_observed",
            ],
            description: "Branch + commit + read; cannot merge",
          },
          viewer: {
            allowedEffects: ["repo.diff_observed"],
            description: "Read-only",
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });
});
