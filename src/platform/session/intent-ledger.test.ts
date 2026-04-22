import { describe, expect, it } from "vitest";
import {
  INTENT_LEDGER_MAX_ENTRIES,
  INTENT_LEDGER_TTL_MS,
  IntentLedger,
  clarifyTopicKey,
} from "./intent-ledger.js";

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
