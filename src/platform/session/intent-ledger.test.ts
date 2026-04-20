import { describe, expect, it } from "vitest";
import {
  INTENT_LEDGER_MAX_ENTRIES,
  INTENT_LEDGER_TTL_MS,
  IntentLedger,
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
});
