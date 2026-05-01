/**
 * Unit tests for parent-side aggregation gate (`subagent-aggregation.ts`).
 *
 * Closes audit-gap O1 (parent-сессия не дожидается subagent.terminalState=complete
 * до закрытия user-facing turn'а) на module-level.
 *
 * Структурный invariant под тестом: при наличии continuation-spawn'а
 * (`spawnMode=session` или `expectsCompletionMessage=true`) в active children'ах
 * parent'а в текущем turn-е, payloads parent'а заменяются на ОДНО holding-
 * сообщение БЕЗ повторного LLM-pass'а.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import { HOLDING_MESSAGE_TEXT } from "./aggregation-policy.js";

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

const { applyAggregationOverride, evaluateAggregationOverride } =
  await import("./subagent-aggregation.js");

const NOW = 1_700_000_000_000;

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
    task: "open-models-daily",
    cleanup: "keep",
    label: "open-models-daily",
    spawnMode: "session",
    expectsCompletionMessage: true,
    createdAt: NOW - 5_000,
    ...overrides,
  };
}

const TG_ORIGIN = {
  channel: "telegram",
  to: "6533456892",
  accountId: "acct-1",
  threadId: "thread-1",
};

beforeEach(() => {
  listSubagentRunsMock.mockReset();
  runtimeLog.mockReset();
  runtimeError.mockReset();
});

describe("subagent-aggregation / evaluateAggregationOverride", () => {
  it("returns passthrough when parentSessionKey is empty", () => {
    const result = evaluateAggregationOverride({
      runResult: {
        meta: { executionVerification: { receipts: [buildSpawnReceipt("sessions_spawn")] } },
      },
      parentSessionKey: "",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(result).toEqual({ kind: "passthrough" });
  });

  it("returns passthrough when no user-channel target", () => {
    const result = evaluateAggregationOverride({
      runResult: {
        meta: { executionVerification: { receipts: [buildSpawnReceipt("sessions_spawn")] } },
      },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: { channel: "internal" },
      nowMs: NOW,
    });
    expect(result).toEqual({ kind: "passthrough" });
  });

  it("returns passthrough when no sessions_spawn receipt", () => {
    listSubagentRunsMock.mockReturnValue([buildContinuationChild()]);
    const result = evaluateAggregationOverride({
      runResult: {
        meta: {
          executionVerification: { receipts: [buildSpawnReceipt("read", "success")] },
        },
      },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(result).toEqual({ kind: "passthrough" });
  });

  it("returns passthrough when sessions_spawn receipt status=failed", () => {
    listSubagentRunsMock.mockReturnValue([buildContinuationChild()]);
    const result = evaluateAggregationOverride({
      runResult: {
        meta: {
          executionVerification: {
            receipts: [buildSpawnReceipt("sessions_spawn", "failed")],
          },
        },
      },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(result).toEqual({ kind: "passthrough" });
  });

  it("returns passthrough when no active continuation child in registry", () => {
    listSubagentRunsMock.mockReturnValue([]);
    const result = evaluateAggregationOverride({
      runResult: {
        meta: { executionVerification: { receipts: [buildSpawnReceipt("sessions_spawn")] } },
      },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(result).toEqual({ kind: "passthrough" });
  });

  it("returns passthrough when only one-shot run children exist (mode=run + expectsCompletionMessage=false)", () => {
    listSubagentRunsMock.mockReturnValue([
      buildContinuationChild({ spawnMode: "run", expectsCompletionMessage: false }),
    ]);
    const result = evaluateAggregationOverride({
      runResult: {
        meta: { executionVerification: { receipts: [buildSpawnReceipt("sessions_spawn")] } },
      },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(result).toEqual({ kind: "passthrough" });
  });

  it("returns 'holding' override for persistent_session continuation in current turn", () => {
    listSubagentRunsMock.mockReturnValue([buildContinuationChild()]);
    const result = evaluateAggregationOverride({
      runResult: {
        meta: { executionVerification: { receipts: [buildSpawnReceipt("sessions_spawn")] } },
      },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(result.kind).toBe("holding");
    if (result.kind === "holding") {
      expect(result.payloads).toEqual([{ text: HOLDING_MESSAGE_TEXT }]);
      expect(result.childSessionKey).toBe("agent:default:subagent:abc");
      expect(result.childRunId).toBe("run-child-1");
      expect(result.label).toBe("open-models-daily");
      expect(result.idempotencyKey).toContain("subagent-aggregation:holding:");
      expect(result.idempotencyKey).toContain("agent:default:main");
      expect(result.idempotencyKey).toContain("agent:default:subagent:abc");
      expect(result.idempotencyKey).toContain("run-child-1");
    }
  });

  it("returns 'holding' for followup with expectsCompletionMessage=true", () => {
    listSubagentRunsMock.mockReturnValue([
      buildContinuationChild({ spawnMode: "run", expectsCompletionMessage: true }),
    ]);
    const result = evaluateAggregationOverride({
      runResult: {
        meta: { executionVerification: { receipts: [buildSpawnReceipt("sessions_spawn")] } },
      },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(result.kind).toBe("holding");
  });

  it("ignores stale active children created beyond CURRENT_TURN_WINDOW (>5min)", () => {
    listSubagentRunsMock.mockReturnValue([buildContinuationChild({ createdAt: NOW - 6 * 60_000 })]);
    const result = evaluateAggregationOverride({
      runResult: {
        meta: { executionVerification: { receipts: [buildSpawnReceipt("sessions_spawn")] } },
      },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(result.kind).toBe("passthrough");
  });

  it("ignores ended children (endedAt set)", () => {
    listSubagentRunsMock.mockReturnValue([buildContinuationChild({ endedAt: NOW - 1_000 })]);
    const result = evaluateAggregationOverride({
      runResult: {
        meta: { executionVerification: { receipts: [buildSpawnReceipt("sessions_spawn")] } },
      },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(result.kind).toBe("passthrough");
  });

  it("await-mode treated as passthrough (reserved for future sub-plan)", () => {
    listSubagentRunsMock.mockReturnValue([buildContinuationChild()]);
    const result = evaluateAggregationOverride({
      runResult: {
        meta: { executionVerification: { receipts: [buildSpawnReceipt("sessions_spawn")] } },
      },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      configMode: "await",
      nowMs: NOW,
    });
    expect(result.kind).toBe("passthrough");
  });

  it("picks the most recent active continuation child when several exist", () => {
    listSubagentRunsMock.mockReturnValue([
      buildContinuationChild({
        runId: "run-old",
        childSessionKey: "agent:default:subagent:old",
        createdAt: NOW - 30_000,
      }),
      buildContinuationChild({
        runId: "run-new",
        childSessionKey: "agent:default:subagent:new",
        createdAt: NOW - 1_000,
      }),
    ]);
    const result = evaluateAggregationOverride({
      runResult: {
        meta: { executionVerification: { receipts: [buildSpawnReceipt("sessions_spawn")] } },
      },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(result.kind).toBe("holding");
    if (result.kind === "holding") {
      expect(result.childRunId).toBe("run-new");
      expect(result.childSessionKey).toBe("agent:default:subagent:new");
    }
  });
});

describe("subagent-aggregation / applyAggregationOverride", () => {
  it("returns null on passthrough", () => {
    const out = applyAggregationOverride({
      runResult: { meta: { executionVerification: { receipts: [] } } },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });
    expect(out).toBeNull();
  });

  it("returns single holding payload + emits telemetry log on holding mode", () => {
    listSubagentRunsMock.mockReturnValue([buildContinuationChild()]);

    const out = applyAggregationOverride({
      runResult: {
        meta: { executionVerification: { receipts: [buildSpawnReceipt("sessions_spawn")] } },
      },
      parentSessionKey: "agent:default:main",
      userChannelOrigin: TG_ORIGIN,
      nowMs: NOW,
    });

    expect(out?.payloads).toEqual([{ text: HOLDING_MESSAGE_TEXT }]);
    expect(runtimeLog).toHaveBeenCalledTimes(1);
    const logged = runtimeLog.mock.calls[0]?.[0] as string;
    expect(logged).toContain("[subagent-aggregation]");
    expect(logged).toContain("event=holding_sent");
    expect(logged).toContain("mode=holding");
  });
});
