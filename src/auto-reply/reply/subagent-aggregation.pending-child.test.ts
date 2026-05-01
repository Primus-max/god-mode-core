/**
 * Cross-turn pending-child gate (PR-G `commitment_kernel_subagent_await.plan.md`).
 *
 * Закрывает audit-gap O5: на turn N+1 при незакрытом continuation child
 * из turn N parent НЕ должен публиковать text-only reply в external channel.
 * Вместо этого один `PENDING_CHILD_HOLDING_MESSAGE_TEXT` holding-payload.
 *
 * Hard invariants:
 *   - #5: gate решает по lifecycle полям `SubagentRunRecord` + literal
 *     полям `DeliveryContext`. Никакого парсинга raw user text /
 *     classifier output / assistant text.
 *   - #6: `IntentContractor` не вызывается; raw user text не читается.
 *   - #11: пять frozen decision contracts не затронуты.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import {
  HOLDING_MESSAGE_TEXT,
  PENDING_CHILD_HOLDING_MESSAGE_TEXT,
} from "./aggregation-policy.js";

const listSubagentRunsMock = vi.fn();
const runtimeLog = vi.fn();
const runtimeError = vi.fn();

vi.mock("../../agents/subagent-registry.js", () => ({
  listSubagentRunsForRequester: (key: string) => listSubagentRunsMock(key),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: (...args: unknown[]) => runtimeLog(...args),
    error: (...args: unknown[]) => runtimeError(...args),
  },
}));

const {
  applyAggregationOverride,
  evaluatePendingChildOverride,
  findOldestPendingContinuationChild,
  __resetPendingChildHoldingHistoryForTesting,
} = await import("./subagent-aggregation.js");

const NOW = 1_700_000_000_000;

const TG_ORIGIN = {
  channel: "telegram",
  to: "6533456892",
  accountId: "acct-1",
  threadId: "thread-1",
};

function buildSpawnReceipt(name: string, status: "success" | "failed" = "success") {
  return {
    kind: "tool" as const,
    name,
    status,
    proof: "reported" as const,
    metadata: { toolCallId: "tc-1" },
  };
}

function buildContinuationChild(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-child-1",
    childSessionKey: "agent:default:subagent:abc",
    requesterSessionKey: "agent:default:main",
    requesterDisplayKey: "main",
    task: "Валера",
    cleanup: "keep",
    label: "Валера",
    spawnMode: "session",
    expectsCompletionMessage: true,
    createdAt: NOW - 5_000,
    ...overrides,
  };
}

beforeEach(() => {
  listSubagentRunsMock.mockReset();
  runtimeLog.mockReset();
  runtimeError.mockReset();
  __resetPendingChildHoldingHistoryForTesting();
});

describe("findOldestPendingContinuationChild", () => {
  it("returns undefined when registry has no records", () => {
    listSubagentRunsMock.mockReturnValue([]);
    const out = findOldestPendingContinuationChild("agent:default:main", NOW);
    expect(out).toBeUndefined();
  });

  it("returns the oldest pending continuation child when several exist", () => {
    listSubagentRunsMock.mockReturnValue([
      buildContinuationChild({ runId: "run-newer", createdAt: NOW - 5_000 }),
      buildContinuationChild({ runId: "run-older", createdAt: NOW - 60_000 }),
    ]);
    const out = findOldestPendingContinuationChild("agent:default:main", NOW);
    expect(out?.runId).toBe("run-older");
  });

  it("ignores ended children (endedAt set)", () => {
    listSubagentRunsMock.mockReturnValue([
      buildContinuationChild({ endedAt: NOW - 1_000 }),
    ]);
    const out = findOldestPendingContinuationChild("agent:default:main", NOW);
    expect(out).toBeUndefined();
  });

  it("ignores one-shot run children without expectsCompletionMessage", () => {
    listSubagentRunsMock.mockReturnValue([
      buildContinuationChild({ spawnMode: "run", expectsCompletionMessage: false }),
    ]);
    const out = findOldestPendingContinuationChild("agent:default:main", NOW);
    expect(out).toBeUndefined();
  });

  it("ignores records older than lookback window", () => {
    listSubagentRunsMock.mockReturnValue([
      buildContinuationChild({ createdAt: NOW - 11 * 60_000 }),
    ]);
    const out = findOldestPendingContinuationChild("agent:default:main", NOW);
    expect(out).toBeUndefined();
  });
});

describe("evaluatePendingChildOverride", () => {
  it("returns passthrough when parentSessionKey is empty", () => {
    const result = evaluatePendingChildOverride({
      runResult: { meta: { executionVerification: { receipts: [] } } },
      parentSessionKey: "",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(result.kind).toBe("passthrough");
  });

  it("returns passthrough when no user-channel target", () => {
    const result = evaluatePendingChildOverride({
      runResult: { meta: { executionVerification: { receipts: [] } } },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: { channel: "internal" },
      nowMs: NOW,
    });
    expect(result.kind).toBe("passthrough");
  });

  it("returns passthrough when current runResult contains sessions_spawn (in-turn path will handle it)", () => {
    listSubagentRunsMock.mockReturnValue([buildContinuationChild()]);
    const result = evaluatePendingChildOverride({
      runResult: {
        meta: {
          executionVerification: { receipts: [buildSpawnReceipt("sessions_spawn")] },
        },
      },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(result.kind).toBe("passthrough");
  });

  it("returns 'holding' when pending continuation child exists and current turn has no sessions_spawn", () => {
    listSubagentRunsMock.mockReturnValue([buildContinuationChild()]);
    const result = evaluatePendingChildOverride({
      runResult: { meta: { executionVerification: { receipts: [] } } },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(result.kind).toBe("holding");
    if (result.kind === "holding") {
      expect(result.payloads).toEqual([{ text: PENDING_CHILD_HOLDING_MESSAGE_TEXT }]);
      expect(result.childRunId).toBe("run-child-1");
      expect(result.childSessionKey).toBe("agent:default:subagent:abc");
      expect(result.label).toBe("Валера");
      expect(result.idempotencyKey).toContain("subagent-aggregation:pending-child-holding:");
      expect(result.idempotencyKey).toContain("agent:default:main");
      expect(result.idempotencyKey).toContain("run-child-1");
    }
  });

  it("returns passthrough after the child reaches terminal (endedAt set)", () => {
    listSubagentRunsMock.mockReturnValue([
      buildContinuationChild({ endedAt: NOW - 500 }),
    ]);
    const result = evaluatePendingChildOverride({
      runResult: { meta: { executionVerification: { receipts: [] } } },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(result.kind).toBe("passthrough");
  });

  it("does not see pending children from another session (cross-session isolation)", () => {
    listSubagentRunsMock.mockImplementation((key: string) => {
      if (key === "agent:default:other-session") {
        return [buildContinuationChild()];
      }
      return [];
    });
    const result = evaluatePendingChildOverride({
      runResult: { meta: { executionVerification: { receipts: [] } } },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(result.kind).toBe("passthrough");
    expect(listSubagentRunsMock).toHaveBeenCalledWith("agent:default:main");
  });

  it("falls through to passthrough after timeout (>120s + 2 prior holdings in 5min) and emits telemetry", () => {
    const child = buildContinuationChild({ createdAt: NOW - 130_000 });
    listSubagentRunsMock.mockReturnValue([child]);

    const first = evaluatePendingChildOverride({
      runResult: { meta: { executionVerification: { receipts: [] } } },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW - 100_000,
    });
    expect(first.kind).toBe("holding");

    const second = evaluatePendingChildOverride({
      runResult: { meta: { executionVerification: { receipts: [] } } },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW - 50_000,
    });
    expect(second.kind).toBe("holding");

    const third = evaluatePendingChildOverride({
      runResult: { meta: { executionVerification: { receipts: [] } } },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(third.kind).toBe("passthrough");

    const loggedTimeout = runtimeLog.mock.calls
      .map((call) => call[0] as string)
      .find((line) => line.includes("event=pending_child_timeout"));
    expect(loggedTimeout).toBeDefined();
    expect(loggedTimeout).toContain("[subagent-aggregation]");
    expect(loggedTimeout).toContain("reason=child_terminal_pending_too_long");
    expect(loggedTimeout).toContain("runId=run-child-1");
  });

  it("idempotency: second call within 30s for the same (parent, child) returns passthrough + emits skip telemetry", () => {
    listSubagentRunsMock.mockReturnValue([buildContinuationChild()]);

    const first = evaluatePendingChildOverride({
      runResult: { meta: { executionVerification: { receipts: [] } } },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(first.kind).toBe("holding");

    const second = evaluatePendingChildOverride({
      runResult: { meta: { executionVerification: { receipts: [] } } },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW + 5_000,
    });
    expect(second.kind).toBe("passthrough");

    const loggedSkip = runtimeLog.mock.calls
      .map((call) => call[0] as string)
      .find((line) => line.includes("event=pending_child_idempotent_skip"));
    expect(loggedSkip).toBeDefined();
    expect(loggedSkip).toContain("reason=within_idempotency_window");
  });

  it("idempotency window expires: second call after 30s on the same (parent, child) re-emits holding", () => {
    listSubagentRunsMock.mockReturnValue([buildContinuationChild()]);

    const first = evaluatePendingChildOverride({
      runResult: { meta: { executionVerification: { receipts: [] } } },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(first.kind).toBe("holding");

    const second = evaluatePendingChildOverride({
      runResult: { meta: { executionVerification: { receipts: [] } } },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW + 30_001,
    });
    expect(second.kind).toBe("holding");
  });
});

describe("applyAggregationOverride / cross-turn fallback wiring", () => {
  it("regression: turn N spawns persistent child → existing in-turn holding fires", () => {
    listSubagentRunsMock.mockReturnValue([buildContinuationChild()]);

    const out = applyAggregationOverride({
      runResult: {
        meta: {
          executionVerification: { receipts: [buildSpawnReceipt("sessions_spawn")] },
        },
      },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(out?.payloads).toEqual([{ text: HOLDING_MESSAGE_TEXT }]);
    const loggedInTurn = runtimeLog.mock.calls
      .map((call) => call[0] as string)
      .find((line) => line.includes("event=holding_sent"));
    expect(loggedInTurn).toBeDefined();
    expect(loggedInTurn).toContain("mode=holding");
  });

  it("turn N+1 with no sessions_spawn while child still running → cross-turn holding fires + telemetry", () => {
    listSubagentRunsMock.mockReturnValue([buildContinuationChild()]);

    const out = applyAggregationOverride({
      runResult: { meta: { executionVerification: { receipts: [] } } },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(out?.payloads).toEqual([{ text: PENDING_CHILD_HOLDING_MESSAGE_TEXT }]);
    const loggedCrossTurn = runtimeLog.mock.calls
      .map((call) => call[0] as string)
      .find((line) => line.includes("event=pending_child_holding_sent"));
    expect(loggedCrossTurn).toBeDefined();
    expect(loggedCrossTurn).toContain("[subagent-aggregation]");
    expect(loggedCrossTurn).toContain("parent=agent:default:main");
    expect(loggedCrossTurn).toContain("child=agent:default:subagent:abc");
    expect(loggedCrossTurn).toContain("runId=run-child-1");
    expect(loggedCrossTurn).toContain("label=Валера");
  });

  it("turn N+1 with no sessions_spawn after child reached terminal (endedAt set) → passthrough", () => {
    listSubagentRunsMock.mockReturnValue([
      buildContinuationChild({ endedAt: NOW - 500 }),
    ]);
    const out = applyAggregationOverride({
      runResult: { meta: { executionVerification: { receipts: [] } } },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(out).toBeNull();
  });

  it("cross-session isolation through applyAggregationOverride: pending child in another session does not affect this session", () => {
    listSubagentRunsMock.mockImplementation((key: string) => {
      if (key === "agent:default:other-session") {
        return [buildContinuationChild()];
      }
      return [];
    });
    const out = applyAggregationOverride({
      runResult: { meta: { executionVerification: { receipts: [] } } },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(out).toBeNull();
  });
});
