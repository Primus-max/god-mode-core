/**
 * Phase 9 — bug #3 (PolicyGate Full audit) — `sessions_yield abort settle`
 * grace window must (a) default to 60 000 ms (not the historical 2 000 ms),
 * (b) be operator-overridable via `agents.sessionsYieldAbortSettleTimeoutMs`,
 * (c) be honored at the call-site in `waitForSessionsYieldAbortSettle`.
 *
 * Audit reference: `extensions/AUDIT-policy-gate-full.md` §e.
 * Bug evidence: live log `sessions_yield abort settle timed out: timeoutMs=2000`
 * during PDF subagent rendering (>2 s, <60 s) — the constant is generic, not
 * PDF-specific.
 *
 * Fail-first verification: prior to the fix this test set asserts a 60 000 ms
 * default, while the constant was 2 000 ms — the "default applied" and "30 s
 * subagent does not abort at 2 s" cases would fail. Verified by reverting
 * `attempt.ts` and re-running.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  DEFAULT_SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS,
  resolveSessionsYieldAbortSettleTimeoutMs,
  waitForSessionsYieldAbortSettle,
} from "./attempt.js";

function makeConfig(agents: Partial<NonNullable<OpenClawConfig["agents"]>>): OpenClawConfig {
  return { agents } as OpenClawConfig;
}

// The repo-wide test setup forces `OPENCLAW_TEST_FAST=1` to keep unrelated
// fake-timer suites snappy. The bug #3 fix specifically needs to validate
// production-shape resolution, so we neutralize the override for these tests
// and restore it afterwards. Suites that intentionally exercise the fast-path
// short-circuit live in their own scope below.
function withFastEnvDisabled(): { restore: () => void } {
  const previous = process.env.OPENCLAW_TEST_FAST;
  delete process.env.OPENCLAW_TEST_FAST;
  return {
    restore: () => {
      if (previous === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previous;
      }
    },
  };
}

describe("resolveSessionsYieldAbortSettleTimeoutMs (bug #3)", () => {
  let envHandle: { restore: () => void };
  beforeEach(() => {
    envHandle = withFastEnvDisabled();
  });
  afterEach(() => {
    envHandle.restore();
  });

  it("returns the 60 000 ms default when config is undefined", () => {
    expect(resolveSessionsYieldAbortSettleTimeoutMs(undefined)).toBe(60_000);
    expect(DEFAULT_SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS).toBe(60_000);
  });

  it("returns the default when agents block is missing (backward-compat)", () => {
    expect(resolveSessionsYieldAbortSettleTimeoutMs({} as OpenClawConfig)).toBe(60_000);
  });

  it("honors a valid operator override", () => {
    const cfg = makeConfig({ sessionsYieldAbortSettleTimeoutMs: 90_000 });
    expect(resolveSessionsYieldAbortSettleTimeoutMs(cfg)).toBe(90_000);
  });

  it("clamps overrides above 120 000 ms down to 120 000 ms", () => {
    const cfg = makeConfig({ sessionsYieldAbortSettleTimeoutMs: 999_999 });
    expect(resolveSessionsYieldAbortSettleTimeoutMs(cfg)).toBe(120_000);
  });

  it("clamps overrides below 1 000 ms up to 1 000 ms", () => {
    const cfg = makeConfig({ sessionsYieldAbortSettleTimeoutMs: 100 });
    expect(resolveSessionsYieldAbortSettleTimeoutMs(cfg)).toBe(1_000);
  });

  it("rejects non-finite overrides and falls back to default", () => {
    const cfg = makeConfig({ sessionsYieldAbortSettleTimeoutMs: Number.POSITIVE_INFINITY });
    expect(resolveSessionsYieldAbortSettleTimeoutMs(cfg)).toBe(60_000);
  });
});

describe("resolveSessionsYieldAbortSettleTimeoutMs — OPENCLAW_TEST_FAST short-circuit", () => {
  // Negative coverage: when the test-fast env is set, even a config override
  // is bypassed and 250 ms is used. This locks in the existing fast-path
  // contract so future refactors do not silently slow the embedded test suite.
  it("ignores config overrides and returns 250 ms when OPENCLAW_TEST_FAST=1", () => {
    const previous = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    try {
      const cfg = makeConfig({ sessionsYieldAbortSettleTimeoutMs: 90_000 });
      expect(resolveSessionsYieldAbortSettleTimeoutMs(cfg)).toBe(250);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previous;
      }
    }
  });
});

describe("waitForSessionsYieldAbortSettle (bug #3)", () => {
  it("does NOT time out at 2 s for a 30 s settle promise (regression: was 2_000 ms cap)", async () => {
    vi.useFakeTimers();
    try {
      let resolveSettle: () => void = () => {};
      const settlePromise = new Promise<void>((resolve) => {
        resolveSettle = resolve;
      });

      const wait = waitForSessionsYieldAbortSettle({
        settlePromise,
        runId: "r-30s",
        sessionId: "s-30s",
        timeoutMs: 60_000,
      });

      // Advance 30 s — under the new 60 s default the wait must not time out.
      await vi.advanceTimersByTimeAsync(30_000);
      // Real settle arrives after 30 s.
      resolveSettle();
      await vi.advanceTimersByTimeAsync(0);

      // Should resolve cleanly (no exception, no timeout warning).
      await expect(wait).resolves.toBeUndefined();
      // No leftover timers — confirms timeout setTimeout was cleared, not fired.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("does time out when the settle promise exceeds the resolved window (default 60 s, settle never)", async () => {
    vi.useFakeTimers();
    try {
      const settlePromise = new Promise<void>(() => {
        // Never resolves — simulates a wedged subagent abort.
      });

      const wait = waitForSessionsYieldAbortSettle({
        settlePromise,
        runId: "r-stuck",
        sessionId: "s-stuck",
        timeoutMs: DEFAULT_SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS,
      });

      await vi.advanceTimersByTimeAsync(60_000);

      // wait should resolve (not throw) — the timeout path logs a warning and
      // returns void; the calling code continues without deadlocking.
      await expect(wait).resolves.toBeUndefined();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("respects a per-call timeoutMs override (config path: 120 000 ms)", async () => {
    vi.useFakeTimers();
    try {
      let resolveSettle: () => void = () => {};
      const settlePromise = new Promise<void>((resolve) => {
        resolveSettle = resolve;
      });

      const wait = waitForSessionsYieldAbortSettle({
        settlePromise,
        runId: "r-override",
        sessionId: "s-override",
        timeoutMs: 120_000,
      });

      // 70 s in — must NOT have timed out (override is 120 s).
      await vi.advanceTimersByTimeAsync(70_000);
      resolveSettle();
      await vi.advanceTimersByTimeAsync(0);

      await expect(wait).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("returns immediately when settlePromise is null", async () => {
    // No fake timers — pure no-op path.
    await expect(
      waitForSessionsYieldAbortSettle({
        settlePromise: null,
        runId: "r-null",
        sessionId: "s-null",
        timeoutMs: 60_000,
      }),
    ).resolves.toBeUndefined();
  });

  it("falls back to the 60 s default when timeoutMs is omitted", async () => {
    vi.useFakeTimers();
    try {
      let resolveSettle: () => void = () => {};
      const settlePromise = new Promise<void>((resolve) => {
        resolveSettle = resolve;
      });

      const wait = waitForSessionsYieldAbortSettle({
        settlePromise,
        runId: "r-default",
        sessionId: "s-default",
        // timeoutMs intentionally omitted — must use 60 s default, not 2 s.
      });

      // Advance 5 s — well past the old 2 s cap, well under the new 60 s default.
      await vi.advanceTimersByTimeAsync(5_000);
      resolveSettle();
      await vi.advanceTimersByTimeAsync(0);

      await expect(wait).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });
});
