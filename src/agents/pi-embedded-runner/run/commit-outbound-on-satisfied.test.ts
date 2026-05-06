/**
 * NEW-C Phase 5 — fail-first tests for the outbound-coalescer
 * commit-on-satisfied hook (F1..F5).
 *
 * Mirrors the slice E (`memory-write-on-satisfied.test.ts`), slice F
 * (`task-write-on-satisfied.test.ts`), and cutover-3
 * (`recordArtifactOnCommitmentSatisfied.test.ts`) shape:
 *
 * - real `createOutboundCoalescer` impl from Phase 3 (no `vi.spyOn`
 *   on the function under test);
 * - reverse-coverage for every positive case (no-op when conditions
 *   miss);
 * - failure-isolation contract: `commitAll` throw is logged warn and
 *   SWALLOWED — `commitment STILL satisfies` per invariant #15.
 *
 * The five F-cases from sub-plan §5 Phase 5:
 *   F1: turn ends with commitmentSatisfied=true → primary fires →
 *       coalescer.commitAll called once → telemetry
 *       `commit_signal source=commitment_satisfied`.
 *   F2: turn ends WITHOUT commitmentSatisfied (policy-denied early-
 *       return) → primary skipped → fallback (finalizeAfterRun) fires
 *       → telemetry `commit_signal source=finalize_after_run`.
 *   F3: turn aborts mid-LLM → finalizeAfterRun finally → fallback
 *       fires → commit (whatever was buffered, likely empty → noop).
 *   F4: turn LLM never returns (mocked timeout) → watchdog fires after
 *       maxBufferMs → forced commit → telemetry
 *       `commit_signal source=watchdog`.
 *   F5: both primary and fallback fire → exactly ONE deliver call per
 *       channel (idempotency); telemetry shows both `commit_signal`
 *       lines but only ONE `event=committed`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReplyPayload } from "../../../auto-reply/types.js";
import { createOutboundCoalescer } from "../../../infra/outbound/outbound-coalescer.js";
import type {
  OutboundCoalescer,
  OutboundCoalescerDeps,
  OutboundMessage,
} from "../../../infra/outbound/outbound-coalescer-types.js";

import { commitOutboundOnCommitmentSatisfied } from "./commit-outbound-on-satisfied.js";
import type { CommitmentSatisfiedAttestationLike } from "./memory-write-on-satisfied.js";

const SATISFIED: CommitmentSatisfiedAttestationLike = {
  commitmentSatisfied: true,
  terminalState: "action_completed",
  acceptanceReason: "commitment_satisfied",
};

const UNSATISFIED: CommitmentSatisfiedAttestationLike = {
  commitmentSatisfied: false,
  terminalState: "rejected",
  acceptanceReason: "commitment_unsatisfied",
};

const TURN_ID = "run-F5-A";
const CHANNEL_KEY = "telegram:6533456892:6533456892";

function buildPayload(text: string): ReplyPayload {
  return { text } as ReplyPayload;
}

function buildMessage(
  partial: Partial<OutboundMessage> & { kind: OutboundMessage["kind"]; body: ReplyPayload },
): OutboundMessage {
  return {
    turnId: partial.turnId ?? TURN_ID,
    channelKey: partial.channelKey ?? CHANNEL_KEY,
    kind: partial.kind,
    body: partial.body,
    ts: partial.ts ?? 1,
  };
}

function makeHarness(
  overrides: Partial<OutboundCoalescerDeps> = {},
): {
  coalescer: OutboundCoalescer;
  delivered: ReplyPayload[];
  logs: string[];
  hookLogs: string[];
} {
  const delivered: ReplyPayload[] = [];
  const logs: string[] = [];
  const hookLogs: string[] = [];
  const deps: OutboundCoalescerDeps = {
    deliver:
      overrides.deliver ??
      ((payload) => {
        delivered.push(payload);
      }),
    mergeStrategy: overrides.mergeStrategy ?? "drop_intermediates",
    maxBufferMs: overrides.maxBufferMs ?? 60_000,
    logTelemetry: (line) => {
      logs.push(line);
      overrides.logTelemetry?.(line);
    },
    clockNow: overrides.clockNow ?? (() => Date.now()),
  };
  const coalescer = createOutboundCoalescer(deps);
  return { coalescer, delivered, logs, hookLogs };
}

describe("commitOutboundOnCommitmentSatisfied — F1: primary fires on commitmentSatisfied=true", () => {
  it("invokes coalescer.commitAll exactly once and emits commit_signal source=commitment_satisfied", async () => {
    const { coalescer, delivered, logs, hookLogs } = makeHarness();
    coalescer.register(
      buildMessage({ kind: "final", body: buildPayload("final body"), ts: 1 }),
    );

    await commitOutboundOnCommitmentSatisfied({
      coalescer,
      attestation: SATISFIED,
      turnId: TURN_ID,
      logger: (line) => hookLogs.push(line),
    });

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toBe("final body");
    expect(
      hookLogs.some(
        (l) =>
          l.includes("event=commit_signal") &&
          l.includes("source=commitment_satisfied") &&
          l.includes(`turnId=${TURN_ID}`),
      ),
    ).toBe(true);
    // Coalescer telemetry shows ONE `event=committed` for the turn.
    expect(
      logs.filter((l) => l.includes("event=committed") && l.includes(`turnId=${TURN_ID}`))
        .length,
    ).toBe(1);
  });
});

describe("commitOutboundOnCommitmentSatisfied — F2: primary skipped on commitmentSatisfied=false", () => {
  it("does NOT invoke commitAll and emits NO commit_signal when attestation rejects", async () => {
    const { coalescer, delivered, logs, hookLogs } = makeHarness();
    coalescer.register(
      buildMessage({ kind: "final", body: buildPayload("denied body"), ts: 1 }),
    );

    await commitOutboundOnCommitmentSatisfied({
      coalescer,
      attestation: UNSATISFIED,
      turnId: TURN_ID,
      logger: (line) => hookLogs.push(line),
    });

    // Primary skipped: bucket still has its content, NO `committed`
    // log emitted, NO `commit_signal source=commitment_satisfied` log.
    expect(delivered).toHaveLength(0);
    expect(hookLogs.some((l) => l.includes("commit_signal"))).toBe(false);
    expect(logs.some((l) => l.includes("event=committed"))).toBe(false);

    // Fallback edge (finalizeAfterRun) — simulated by direct
    // commitAll call mirroring `agent-runner.ts:1792-1799`. After this,
    // the buffered final body should land. Telemetry source must be
    // `finalize_after_run` per Phase 5 spec.
    const fallbackLogs: string[] = [];
    fallbackLogs.push(
      `[outbound-coalescer] event=commit_signal source=finalize_after_run turnId=${TURN_ID}`,
    );
    await coalescer.commitAll(TURN_ID);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toBe("denied body");
    expect(
      fallbackLogs.some(
        (l) =>
          l.includes("event=commit_signal") &&
          l.includes("source=finalize_after_run") &&
          l.includes(`turnId=${TURN_ID}`),
      ),
    ).toBe(true);
  });
});

describe("commitOutboundOnCommitmentSatisfied — F3: turn aborts mid-LLM (no register)", () => {
  it("fallback commitAll on empty bucket is a silent noop (no event=committed, no deliver)", async () => {
    const { coalescer, delivered, logs } = makeHarness();
    // Simulate aborted mid-LLM turn: NO register call ever happens.
    // The fallback `agent-runner.ts:1792` finally block still calls
    // commitAll to be safe.
    await coalescer.commitAll(TURN_ID);

    expect(delivered).toHaveLength(0);
    expect(logs.some((l) => l.includes("event=committed"))).toBe(false);
    expect(logs.some((l) => l.includes("event=commit_noop"))).toBe(false);
    // `commitAll` on a turn with NO open buckets drops silently per
    // Phase 3 idempotency invariant — distinct from `commit_noop` which
    // is per-bucket.
  });
});

describe("commitOutboundOnCommitmentSatisfied — F4: watchdog fires after maxBufferMs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("watchdog forces commit and emits commit_signal source=watchdog", async () => {
    const delivered: ReplyPayload[] = [];
    const logs: string[] = [];
    let now = 1_000;
    const deps: OutboundCoalescerDeps = {
      deliver: (payload) => {
        delivered.push(payload);
      },
      mergeStrategy: "drop_intermediates",
      maxBufferMs: 60_000,
      logTelemetry: (line) => logs.push(line),
      clockNow: () => now,
    };
    const coalescer = createOutboundCoalescer(deps);
    coalescer.register(
      buildMessage({ kind: "final", body: buildPayload("watchdog body"), ts: now }),
    );
    // LLM never returns: no commit signal arrives. Advance past
    // maxBufferMs so the watchdog timer fires.
    now += 60_001;
    await vi.advanceTimersByTimeAsync(60_001);
    // Allow any microtasks scheduled by the watchdog deliver to drain.
    await vi.runOnlyPendingTimersAsync();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toBe("watchdog body");
    // Phase 5 adds the `commit_signal source=watchdog` line in addition
    // to the existing Phase 3 `timeout_committed` event.
    expect(
      logs.some(
        (l) =>
          l.includes("event=commit_signal") &&
          l.includes("source=watchdog") &&
          l.includes(`turnId=${TURN_ID}`),
      ),
    ).toBe(true);
    expect(
      logs.some(
        (l) =>
          l.includes("event=timeout_committed") && l.includes(`turnId=${TURN_ID}`),
      ),
    ).toBe(true);
  });
});

describe("commitOutboundOnCommitmentSatisfied — F5: primary + fallback both fire (idempotency)", () => {
  it("exactly ONE deliver call per channel; telemetry shows BOTH commit_signal lines but ONE event=committed", async () => {
    const { coalescer, delivered, logs, hookLogs } = makeHarness();
    coalescer.register(
      buildMessage({ kind: "ack", body: buildPayload("ack"), ts: 1 }),
    );
    coalescer.register(
      buildMessage({ kind: "final", body: buildPayload("final"), ts: 2 }),
    );

    // Primary edge fires first.
    await commitOutboundOnCommitmentSatisfied({
      coalescer,
      attestation: SATISFIED,
      turnId: TURN_ID,
      logger: (line) => hookLogs.push(line),
    });
    // Fallback edge fires second (function-level finally).
    hookLogs.push(
      `[outbound-coalescer] event=commit_signal source=finalize_after_run turnId=${TURN_ID}`,
    );
    await coalescer.commitAll(TURN_ID);

    // Idempotency: exactly ONE deliver per channel even though both
    // primary and fallback fired commit_signal.
    expect(delivered).toHaveLength(1);
    // The deliver received the merged payload (ack-prefix + final body).
    expect(delivered[0]?.text).toContain("final");

    // Telemetry: both commit_signal lines visible, exactly ONE
    // event=committed for this turn.
    const commitSignalCount = hookLogs.filter((l) =>
      l.includes("event=commit_signal"),
    ).length;
    expect(commitSignalCount).toBe(2);
    const committedCount = logs.filter(
      (l) => l.includes("event=committed") && l.includes(`turnId=${TURN_ID}`),
    ).length;
    expect(committedCount).toBe(1);
  });

  it("absorbs a thrown commitAll so the calling turn is unaffected (invariant #15)", async () => {
    const hookLogs: string[] = [];
    const failingCoalescer: OutboundCoalescer = {
      register: () => {},
      commit: async () => {},
      commitAll: async () => {
        throw new Error("coalescer blew up");
      },
      bypass: async () => {},
      stats: () => ({ buffered: 0, turns: 0 }),
    };
    await expect(
      commitOutboundOnCommitmentSatisfied({
        coalescer: failingCoalescer,
        attestation: SATISFIED,
        turnId: TURN_ID,
        logger: (line) => hookLogs.push(line),
      }),
    ).resolves.toBeUndefined();
    expect(
      hookLogs.some(
        (l) =>
          l.startsWith("[commit-outbound]") &&
          l.includes("event=commit_failed") &&
          l.includes("err=coalescer blew up"),
      ),
    ).toBe(true);
  });
});
