import { describe, expect, it, vi } from "vitest";
import {
  INTENT_LEDGER_MAX_ENTRIES,
  INTENT_LEDGER_TTL_MS,
  IntentLedger,
  RECENT_INTENT_HISTORY_WINDOW,
  clarifyTopicKey,
} from "./intent-ledger.js";
import type { EffectFamilyId } from "../commitment/ids.js";
import type { SemanticIntent } from "../commitment/semantic-intent.js";
import { defaultRuntime } from "../../runtime.js";

const PUBLISH_FAMILY: EffectFamilyId = "publish" as EffectFamilyId;

function makeIntent(overrides: Partial<SemanticIntent> = {}): SemanticIntent {
  return {
    desiredEffectFamily: PUBLISH_FAMILY,
    target: { kind: "workspace" },
    operation: { kind: "create" },
    constraints: {},
    uncertainty: [],
    confidence: 0.8,
    ...overrides,
  };
}

function createLedger() {
  return new IntentLedger({
    now: () => 1_000_000,
  });
}

describe("IntentLedger.recordFromBotTurn", () => {
  it("classifies awaiting_confirmation via explicit confirmation wording", () => {
    const ledger = createLedger();
    const entry = ledger.recordFromBotTurn({
      turnId: "turn-confirm-1",
      sessionId: "session-a",
      channelId: "telegram",
      summary: "Подтверди, что можно начать авторизацию Trader?",
      planOutput: { executionContract: { requiresTools: false } },
    });

    expect(entry?.kind).toBe("awaiting_confirmation");
    expect(entry?.expectsFrom).toBe("user");
  });

  it("classifies awaiting_confirmation via yes/no question", () => {
    const ledger = createLedger();
    const entry = ledger.recordFromBotTurn({
      turnId: "turn-confirm-2",
      sessionId: "session-a",
      channelId: "telegram",
      summary: "Начать прямо сейчас? Да или нет?",
      planOutput: { executionContract: { requiresTools: false } },
    });

    expect(entry?.kind).toBe("awaiting_confirmation");
    expect(entry?.expectsFrom).toBe("user");
  });

  it("classifies awaiting_input via explicit input request", () => {
    const ledger = createLedger();
    const entry = ledger.recordFromBotTurn({
      turnId: "turn-input-1",
      sessionId: "session-a",
      channelId: "telegram",
      summary: "Пришли токен из письма, чтобы продолжить?",
      planOutput: { executionContract: { requiresTools: false } },
    });

    expect(entry?.kind).toBe("awaiting_input");
    expect(entry?.expectsFrom).toBe("user");
  });

  it("classifies clarifying short question that is not confirm/input", () => {
    const ledger = createLedger();
    const entry = ledger.recordFromBotTurn({
      turnId: "turn-clarifying-1",
      sessionId: "session-a",
      channelId: "telegram",
      summary: "Какой профиль выбрать для среды staging?",
      planOutput: { executionContract: { requiresTools: false } },
    });

    expect(entry?.kind).toBe("clarifying");
    expect(entry?.expectsFrom).toBe("user");
  });

  it("classifies promised_action when assistant promises action without tools", () => {
    const ledger = createLedger();
    const entry = ledger.recordFromBotTurn({
      turnId: "turn-promised-1",
      sessionId: "session-a",
      channelId: "telegram",
      summary: "Принял, запускаю авторизацию прямо сейчас.",
      planOutput: { executionContract: { requiresTools: false } },
      runtimeReceipts: [],
    });

    expect(entry?.kind).toBe("promised_action");
    expect(entry?.expectsFrom).toBe("system");
  });

  it("does not classify promised_action when tools were required", () => {
    const ledger = createLedger();
    const entry = ledger.recordFromBotTurn({
      turnId: "turn-promised-2",
      sessionId: "session-a",
      channelId: "telegram",
      summary: "Принял, запускаю авторизацию прямо сейчас.",
      planOutput: { executionContract: { requiresTools: true } },
      runtimeReceipts: [{ tool: "exec" }],
    });

    expect(entry).toBeUndefined();
  });

  it("does not classify long question payloads", () => {
    const ledger = createLedger();
    const longSummary = `${"а".repeat(360)}?`;
    const entry = ledger.recordFromBotTurn({
      turnId: "turn-long-1",
      sessionId: "session-a",
      channelId: "telegram",
      summary: longSummary,
      planOutput: { executionContract: { requiresTools: false } },
    });

    expect(entry).toBeUndefined();
  });

  it("does not write entries when no heuristic matches", () => {
    const ledger = createLedger();
    const entry = ledger.recordFromBotTurn({
      turnId: "turn-none-1",
      sessionId: "session-a",
      channelId: "telegram",
      summary: "Спасибо, понял.",
      planOutput: { executionContract: { requiresTools: false } },
    });

    expect(entry).toBeUndefined();
    expect(ledger.peekPending("session-a", "telegram")).toEqual([]);
  });

  it("records successful receipt entries when a fingerprint is present", () => {
    const ledger = createLedger();
    const entry = ledger.recordFromBotTurn({
      turnId: "turn-receipt-1",
      sessionId: "session-a",
      channelId: "telegram",
      summary: "Уже сделано: dev server started",
      planOutput: {
        executionContract: { requiresTools: true },
        fingerprint: "intent:receipt-1",
      },
      runtimeReceipts: [
        {
          kind: "tool",
          name: "exec",
          status: "success",
          summary: "dev server started",
        },
      ],
    });

    expect(entry?.kind).toBe("receipt");
    expect(entry?.fingerprint).toBe("intent:receipt-1");
    expect(entry?.successfulReceipts).toHaveLength(1);
  });
});

describe("IntentLedger storage rules", () => {
  it("keeps only the latest N entries per session+channel", () => {
    const ledger = createLedger();
    for (let index = 0; index < INTENT_LEDGER_MAX_ENTRIES + 2; index += 1) {
      ledger.recordFromBotTurn({
        turnId: `turn-${index}`,
        sessionId: "session-limit",
        channelId: "telegram",
        summary: `Подтверди шаг ${String(index)}?`,
        planOutput: { executionContract: { requiresTools: false } },
      });
    }

    const entries = ledger.peekPending("session-limit", "telegram");
    expect(entries).toHaveLength(INTENT_LEDGER_MAX_ENTRIES);
    expect(entries.map((entry) => entry.turnId)).toEqual(
      Array.from({ length: INTENT_LEDGER_MAX_ENTRIES }, (_, index) => `turn-${index + 2}`),
    );
  });

  it("filters entries by TTL during peek without mutating storage", () => {
    let now = 10_000;
    const ledger = new IntentLedger({
      now: () => now,
    });
    ledger.recordFromBotTurn({
      turnId: "turn-ttl-1",
      sessionId: "session-ttl",
      channelId: "telegram",
      summary: "Подтверди действие?",
      planOutput: { executionContract: { requiresTools: false } },
    });

    now += INTENT_LEDGER_TTL_MS + 1;
    const firstPeek = ledger.peekPending("session-ttl", "telegram");
    const secondPeek = ledger.peekPending("session-ttl", "telegram");
    expect(firstPeek).toEqual([]);
    expect(secondPeek).toEqual([]);
    expect(ledger.debugEntryCount("session-ttl", "telegram")).toBe(1);
  });

  it("peekPending is pure and stable across repeated reads", () => {
    const ledger = createLedger();
    ledger.recordFromBotTurn({
      turnId: "turn-pure-1",
      sessionId: "session-pure",
      channelId: "telegram",
      summary: "Подтверди запуск?",
      planOutput: { executionContract: { requiresTools: false } },
    });

    const firstPeek = ledger.peekPending("session-pure", "telegram");
    const secondPeek = ledger.peekPending("session-pure", "telegram");
    expect(firstPeek).toEqual(secondPeek);
    expect(firstPeek[0]?.id).toBe(secondPeek[0]?.id);
  });

  it("stores successful receipts and finds them by fingerprint within the idempotency window", () => {
    let now = 25_000;
    const ledger = new IntentLedger({
      now: () => now,
    });
    ledger.recordFromBotTurn({
      turnId: "turn-exec-1",
      sessionId: "session-receipts",
      channelId: "telegram",
      summary: "Уже сделал: dev server started.",
      planOutput: {
        executionContract: { requiresTools: true },
        fingerprint: "intent:abc123",
      },
      runtimeReceipts: [
        {
          kind: "tool",
          name: "exec",
          status: "success",
          summary: "dev server started",
          metadata: {
            pid: 4242,
            url: "http://127.0.0.1:3000",
          },
        },
      ],
      createdAt: now,
    });

    const found = ledger.lookupRecentReceipt({
      sessionId: "session-receipts",
      channelId: "telegram",
      fingerprint: "intent:abc123",
      windowMs: 60_000,
    });

    expect(found).toEqual(
      expect.objectContaining({
        fingerprint: "intent:abc123",
        receipts: [
          expect.objectContaining({
            kind: "tool",
            name: "exec",
            metadata: expect.objectContaining({
              pid: 4242,
              url: "http://127.0.0.1:3000",
            }),
          }),
        ],
      }),
    );
  });

  it("does not return old or missing fingerprints from recent receipt lookup", () => {
    let now = 50_000;
    const ledger = new IntentLedger({
      now: () => now,
    });
    ledger.recordFromBotTurn({
      turnId: "turn-exec-old",
      sessionId: "session-receipts-window",
      channelId: "telegram",
      summary: "Уже сделал: test run complete.",
      planOutput: {
        executionContract: { requiresTools: true },
        fingerprint: "intent:old",
      },
      runtimeReceipts: [
        {
          kind: "tool",
          name: "exec",
          status: "success",
          summary: "tests passed",
        },
      ],
      createdAt: now,
    });
    now += 61_000;

    expect(
      ledger.lookupRecentReceipt({
        sessionId: "session-receipts-window",
        channelId: "telegram",
        fingerprint: "intent:old",
        windowMs: 60_000,
      }),
    ).toBeUndefined();
    expect(
      ledger.lookupRecentReceipt({
        sessionId: "session-receipts-window",
        channelId: "telegram",
        fingerprint: "intent:missing",
        windowMs: 60_000,
      }),
    ).toBeUndefined();
  });
});

describe("IntentLedger clarify budget", () => {
  it("counts repeated clarify entries with the same ambiguity topic", () => {
    let now = 10_000;
    const ledger = new IntentLedger({
      now: () => now,
    });
    const ambigs = ["receipt format", "platform action receipt"];
    ledger.recordFromBotTurn({
      turnId: "clarify-1",
      sessionId: "session-clarify",
      channelId: "telegram",
      summary: "Какой формат receipt использовать?",
      planOutput: { executionContract: { requiresTools: false } },
      ambigs,
      createdAt: now,
    });
    now += 60_000;
    ledger.recordFromBotTurn({
      turnId: "clarify-2",
      sessionId: "session-clarify",
      channelId: "telegram",
      summary: "Какой именно format receipt нужен для platform action?",
      planOutput: { executionContract: { requiresTools: false } },
      ambigs,
      createdAt: now,
    });

    const topic = clarifyTopicKey(ambigs);
    expect(ledger.peekClarifyCount("session-clarify", "telegram", topic).count).toBe(2);
  });

  it("resets clarify count after budget window expires", () => {
    let now = 50_000;
    const ledger = new IntentLedger({
      now: () => now,
    });
    const ambigs = ["platform_action receipt", "receipt format"];
    ledger.recordFromBotTurn({
      turnId: "clarify-window-1",
      sessionId: "session-window",
      channelId: "telegram",
      summary: "Нужен формат receipt?",
      planOutput: { executionContract: { requiresTools: false } },
      ambigs,
      createdAt: now,
    });
    now += 60_000;
    ledger.recordFromBotTurn({
      turnId: "clarify-window-2",
      sessionId: "session-window",
      channelId: "telegram",
      summary: "Какой receipt format нужен?",
      planOutput: { executionContract: { requiresTools: false } },
      ambigs,
      createdAt: now,
    });
    now += 6 * 60_000;
    ledger.recordFromBotTurn({
      turnId: "clarify-window-3",
      sessionId: "session-window",
      channelId: "telegram",
      summary: "Какой receipt format выбрать в итоге?",
      planOutput: { executionContract: { requiresTools: false } },
      ambigs,
      createdAt: now,
    });

    const topic = clarifyTopicKey(ambigs);
    const count = ledger.peekClarifyCount("session-window", "telegram", topic);
    expect(count.count).toBe(1);
  });

  it("produces different clarify topic keys for different ambiguity sets", () => {
    const first = clarifyTopicKey(["platform action receipt", "receipt format"]);
    const second = clarifyTopicKey(["auth token scope", "environment target"]);
    expect(first).not.toBe(second);
  });

  it("assigns generic clarify topic key when classifier produced no ambiguities", () => {
    let now = 100_000;
    const ledger = new IntentLedger({ now: () => now });
    ledger.recordFromBotTurn({
      turnId: "clarify-generic-1",
      sessionId: "session-generic",
      channelId: "telegram",
      summary: "Что именно сделать?",
      planOutput: { executionContract: { requiresTools: false } },
      createdAt: now,
    });
    now += 30_000;
    ledger.recordFromBotTurn({
      turnId: "clarify-generic-2",
      sessionId: "session-generic",
      channelId: "telegram",
      summary: "Что ты имеешь в виду?",
      planOutput: { executionContract: { requiresTools: false } },
      createdAt: now,
    });

    const count = ledger.peekClarifyCount("session-generic", "telegram", "*generic*");
    expect(count.count).toBe(2);
  });
});

describe("IntentLedger recent-intent history (PR-H Phase 2)", () => {
  it("records and returns the most recent SemanticIntent for a session+channel", () => {
    const ledger = createLedger();
    ledger.recordRecentIntent({
      sessionId: "session-a",
      channelId: "telegram",
      intent: makeIntent({ target: { kind: "workspace" } }),
    });

    expect(ledger.getRecentIntent("session-a", "telegram")?.target.kind).toBe("workspace");
  });

  it("returns the latest of multiple recorded intents within the sliding window", () => {
    const ledger = createLedger();
    ledger.recordRecentIntent({
      sessionId: "session-a",
      channelId: "telegram",
      intent: makeIntent({ target: { kind: "workspace" } }),
    });
    ledger.recordRecentIntent({
      sessionId: "session-a",
      channelId: "telegram",
      intent: makeIntent({ target: { kind: "external_channel", channelId: "telegram" as never } }),
    });

    expect(ledger.getRecentIntent("session-a", "telegram")?.target.kind).toBe("external_channel");
  });

  it("isolates state across sessions (no cross-session leakage)", () => {
    const ledger = createLedger();
    ledger.recordRecentIntent({
      sessionId: "session-a",
      channelId: "telegram",
      intent: makeIntent({ target: { kind: "workspace" } }),
    });

    expect(ledger.getRecentIntent("session-b", "telegram")).toBeUndefined();
  });

  it("isolates state across channels for the same sessionId", () => {
    const ledger = createLedger();
    ledger.recordRecentIntent({
      sessionId: "session-a",
      channelId: "telegram",
      intent: makeIntent({ target: { kind: "workspace" } }),
    });

    expect(ledger.getRecentIntent("session-a", "discord")).toBeUndefined();
  });

  it("returns undefined on cold start with no prior records", () => {
    const ledger = createLedger();
    expect(ledger.getRecentIntent("never-seen", "telegram")).toBeUndefined();
  });

  it("silently drops low-confidence intents below the floor", () => {
    const ledger = createLedger();
    ledger.recordRecentIntent({
      sessionId: "session-a",
      channelId: "telegram",
      intent: makeIntent({ confidence: 0 }),
    });

    expect(ledger.getRecentIntent("session-a", "telegram")).toBeUndefined();
  });

  it("trims the sliding window to RECENT_INTENT_HISTORY_WINDOW entries", () => {
    let now = 1_000_000;
    const ledger = new IntentLedger({ now: () => now });
    for (let i = 0; i < RECENT_INTENT_HISTORY_WINDOW + 3; i++) {
      ledger.recordRecentIntent({
        sessionId: "session-a",
        channelId: "telegram",
        intent: makeIntent({ confidence: 0.5 + i * 0.01 }),
        recordedAt: now,
      });
      now += 1000;
    }

    const latest = ledger.getRecentIntent("session-a", "telegram");
    expect(latest).toBeDefined();
    expect(latest?.confidence).toBeGreaterThan(0.5);
  });

  it("evicts intents older than INTENT_LEDGER_TTL_MS", () => {
    let now = 1_000_000;
    const ledger = new IntentLedger({ now: () => now });
    ledger.recordRecentIntent({
      sessionId: "session-a",
      channelId: "telegram",
      intent: makeIntent({ target: { kind: "workspace" } }),
      recordedAt: now,
    });

    now += INTENT_LEDGER_TTL_MS + 1_000;

    expect(ledger.getRecentIntent("session-a", "telegram")).toBeUndefined();
  });
});

describe("IntentLedger recent-intent debug telemetry (slice 3)", () => {
  it("emits [intent-history] event=record result=accept on accepted intents", () => {
    const ledger = createLedger();
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    try {
      ledger.recordRecentIntent({
        sessionId: "session-a-debug",
        channelId: "telegram",
        intent: makeIntent({ target: { kind: "workspace" } }),
      });
      const messages = logSpy.mock.calls.map((args) => args.join(" "));
      const recordLine = messages.find((m) => m.includes("[intent-history] event=record"));
      expect(recordLine).toBeDefined();
      expect(recordLine).toContain("result=accept");
      expect(recordLine).toContain("target.kind=workspace");
      expect(recordLine).toContain("confidence=0.80");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("emits [intent-history] event=record result=reject_low_confidence when below floor", () => {
    const ledger = createLedger();
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    try {
      ledger.recordRecentIntent({
        sessionId: "session-a-debug",
        channelId: "telegram",
        intent: makeIntent({ confidence: 0.1 }),
      });
      const messages = logSpy.mock.calls.map((args) => args.join(" "));
      const recordLine = messages.find((m) => m.includes("[intent-history] event=record"));
      expect(recordLine).toContain("result=reject_low_confidence");
      expect(recordLine).toContain("confidence=0.10");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("emits [intent-history] event=get result=cold_start on empty history", () => {
    const ledger = createLedger();
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    try {
      expect(ledger.getRecentIntent("never-seen", "telegram")).toBeUndefined();
      const messages = logSpy.mock.calls.map((args) => args.join(" "));
      const getLine = messages.find((m) => m.includes("[intent-history] event=get"));
      expect(getLine).toContain("result=cold_start");
      expect(getLine).toContain("records=0");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("emits [intent-history] event=get result=hit when most recent record is non-expired", () => {
    const ledger = createLedger();
    ledger.recordRecentIntent({
      sessionId: "session-a-debug",
      channelId: "telegram",
      intent: makeIntent({ target: { kind: "external_channel", channelId: "telegram" as never } }),
    });
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    try {
      ledger.getRecentIntent("session-a-debug", "telegram");
      const messages = logSpy.mock.calls.map((args) => args.join(" "));
      const getLine = messages.find((m) => m.includes("[intent-history] event=get"));
      expect(getLine).toContain("result=hit");
      expect(getLine).toContain("target.kind=external_channel");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("emits [intent-history] event=get result=expired after TTL", () => {
    let now = 1_000_000;
    const ledger = new IntentLedger({ now: () => now });
    ledger.recordRecentIntent({
      sessionId: "session-a-debug",
      channelId: "telegram",
      intent: makeIntent({ target: { kind: "workspace" } }),
      recordedAt: now,
    });
    now += INTENT_LEDGER_TTL_MS + 1_000;
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    try {
      ledger.getRecentIntent("session-a-debug", "telegram");
      const messages = logSpy.mock.calls.map((args) => args.join(" "));
      const getLine = messages.find((m) => m.includes("[intent-history] event=get"));
      expect(getLine).toContain("result=expired");
    } finally {
      logSpy.mockRestore();
    }
  });
});
