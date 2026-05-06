import { describe, expect, it } from "vitest";

import type { SessionId } from "../commitment/ids.js";

import { IntentLedger } from "./intent-ledger.js";
import {
  createIntentLedgerResetSubscriber,
  type IntentLedgerInvalidator,
} from "./intent-ledger-reset-subscriber.js";
import {
  createSessionResetSubscriberRegistry,
  resetTurnSession,
  type SessionResetEvent,
} from "./reset.js";

const VALID_ISO = "2026-05-06T18:25:00.000Z";
const SESSION_ID = "f71784c5-aaaa-bbbb-cccc-111111111111" as SessionId;
const PREV_SESSION_ID = "99f9e4f2-82be-4148-bd79-ffb80a2e07e3" as SessionId;

function buildEvent(overrides: Partial<SessionResetEvent> = {}): SessionResetEvent {
  return {
    sessionId: SESSION_ID,
    sessionKey: "telegram:6533456892",
    previousSessionId: PREV_SESSION_ID,
    reason: "reset_trigger",
    occurredAt: VALID_ISO,
    ...overrides,
  };
}

describe("subscriber:intent-ledger-clear — round-trip with real IntentLedger", () => {
  it("invalidates entries for previousSessionId and preserves entries for sessionId", async () => {
    const ledger = new IntentLedger();
    // Seed an entry that the heuristic classifier will accept (clarifying).
    const recorded = ledger.recordFromBotTurn({
      turnId: "turn-001",
      sessionId: PREV_SESSION_ID,
      channelId: "telegram",
      summary: "Какой ваш любимый рецепт борща?",
      planOutput: undefined,
    });
    expect(recorded).toBeDefined();
    expect(ledger.debugEntryCount(PREV_SESSION_ID, "telegram")).toBe(1);

    // And one under the new sessionId (must survive).
    ledger.recordFromBotTurn({
      turnId: "turn-002",
      sessionId: SESSION_ID,
      channelId: "telegram",
      summary: "Какой ваш любимый суп?",
      planOutput: undefined,
    });
    expect(ledger.debugEntryCount(SESSION_ID, "telegram")).toBe(1);

    const subscriber = createIntentLedgerResetSubscriber({ ledger });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("cleared");
    if (outcome.kind === "cleared") {
      expect(outcome.details).toEqual({
        sessionId: PREV_SESSION_ID,
        entriesCleared: 1,
      });
    }

    expect(ledger.debugEntryCount(PREV_SESSION_ID, "telegram")).toBe(0);
    expect(ledger.debugEntryCount(SESSION_ID, "telegram")).toBe(1);
  });

  it("emits kind=skipped reason=no_entries_for_session when nothing matches", async () => {
    const ledger = new IntentLedger();
    const subscriber = createIntentLedgerResetSubscriber({ ledger });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("no_entries_for_session");
    }
  });

  it("emits kind=skipped reason=no_previous_session_id when event has no prior id", async () => {
    const ledger = new IntentLedger();
    const subscriber = createIntentLedgerResetSubscriber({ ledger });
    const outcome = await subscriber.onReset(
      buildEvent({ previousSessionId: undefined }),
    );
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("no_previous_session_id");
    }
  });
});

describe("subscriber:intent-ledger-clear — reverse-test (bug reproduction)", () => {
  it("entries for previousSessionId remain when subscriber not registered", async () => {
    const ledger = new IntentLedger();
    ledger.recordFromBotTurn({
      turnId: "turn-001",
      sessionId: PREV_SESSION_ID,
      channelId: "telegram",
      summary: "Какой ваш любимый рецепт борща?",
      planOutput: undefined,
    });
    expect(ledger.debugEntryCount(PREV_SESSION_ID, "telegram")).toBe(1);

    const registry = createSessionResetSubscriberRegistry();
    // Intentionally NO subscriber registration.
    await resetTurnSession({ event: buildEvent(), registry });
    expect(ledger.debugEntryCount(PREV_SESSION_ID, "telegram")).toBe(1);
  });
});

describe("subscriber:intent-ledger-clear — failure isolation", () => {
  it("converts a thrown invalidator into kind=failed without rethrow", async () => {
    const stub: IntentLedgerInvalidator = {
      invalidate(): number {
        throw new Error("ledger_corrupt");
      },
    };
    const subscriber = createIntentLedgerResetSubscriber({ ledger: stub });
    const outcome = await subscriber.onReset(buildEvent());
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.reason).toBe("ledger_corrupt");
    }
  });
});
