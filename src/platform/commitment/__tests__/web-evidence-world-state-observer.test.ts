import { describe, expect, it } from "vitest";
import {
  createWebEvidenceCollector,
  createWebEvidenceWorldStateObserver,
  type TurnKey,
} from "../web-evidence-world-state-observer.js";
import type { ISO8601, SessionId } from "../ids.js";
import type { WebEvidenceRecord } from "../world-state.js";

const ISO_NOW = "2026-05-02T11:00:00.000Z" as ISO8601;
const SESSION_A = "session-a" as SessionId;
const SESSION_B = "session-b" as SessionId;

function record(url: string, snippet = "snip"): WebEvidenceRecord {
  return Object.freeze({ url, snippet, capturedAt: ISO_NOW });
}

describe("WebEvidenceCollector — Search-Composer Phase 4a", () => {
  it("returns undefined slice when no active turn is set (production default)", () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    expect(observer.observe()).toBeUndefined();
  });

  it("returns undefined slice when active turn has no recorded entries", () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const key: TurnKey = { sessionId: SESSION_A, turnId: "turn-1" };
    collector.setActiveTurn(key);
    expect(observer.observe()).toBeUndefined();
  });

  it("exposes records bucketed under the active turn in insertion order", () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const key: TurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    collector.record(record("https://a.example.com"), key);
    collector.record(record("https://b.example.com"), key);
    collector.setActiveTurn(key);

    const slice = observer.observe();
    expect(slice).toBeDefined();
    expect(slice?.records.map((r) => r.url)).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });

  it("dedupes records with the same url last-writer-wins (idempotent re-record)", () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const key: TurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    collector.record(record("https://x.example.com", "first"), key);
    collector.record(record("https://x.example.com", "updated"), key);
    collector.setActiveTurn(key);

    const slice = observer.observe();
    expect(slice?.records).toHaveLength(1);
    expect(slice?.records[0]?.snippet).toBe("updated");
  });

  it("isolates records by (sessionId, turnId) — same sessionId, different turnId", () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const key1: TurnKey = { sessionId: SESSION_A, turnId: "turn-1" };
    const key2: TurnKey = { sessionId: SESSION_A, turnId: "turn-2" };

    collector.record(record("https://t1.example.com"), key1);
    collector.record(record("https://t2.example.com"), key2);

    collector.setActiveTurn(key1);
    expect(observer.observe()?.records.map((r) => r.url)).toEqual(["https://t1.example.com"]);

    collector.setActiveTurn(key2);
    expect(observer.observe()?.records.map((r) => r.url)).toEqual(["https://t2.example.com"]);
  });

  it("isolates records by (sessionId, turnId) — different sessionId, same turnId string", () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const key1: TurnKey = { sessionId: SESSION_A, turnId: "shared-id" };
    const key2: TurnKey = { sessionId: SESSION_B, turnId: "shared-id" };

    collector.record(record("https://a.example.com"), key1);
    collector.record(record("https://b.example.com"), key2);

    collector.setActiveTurn(key1);
    expect(observer.observe()?.records.map((r) => r.url)).toEqual(["https://a.example.com"]);

    collector.setActiveTurn(key2);
    expect(observer.observe()?.records.map((r) => r.url)).toEqual(["https://b.example.com"]);
  });

  it("resetForTurn clears only the targeted bucket", () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const key1: TurnKey = { sessionId: SESSION_A, turnId: "turn-1" };
    const key2: TurnKey = { sessionId: SESSION_A, turnId: "turn-2" };

    collector.record(record("https://t1.example.com"), key1);
    collector.record(record("https://t2.example.com"), key2);

    collector.resetForTurn(key1);

    collector.setActiveTurn(key1);
    expect(observer.observe()).toBeUndefined();

    collector.setActiveTurn(key2);
    expect(observer.observe()?.records.map((r) => r.url)).toEqual(["https://t2.example.com"]);
  });

  it("setActiveTurn(undefined) clears the active pointer", () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const key: TurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    collector.record(record("https://x.example.com"), key);
    collector.setActiveTurn(key);
    expect(observer.observe()).toBeDefined();

    collector.setActiveTurn(undefined);
    expect(observer.observe()).toBeUndefined();
  });

  it("returns frozen records (consumer cannot mutate)", () => {
    const collector = createWebEvidenceCollector();
    const observer = createWebEvidenceWorldStateObserver(collector);
    const key: TurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    collector.record(record("https://x.example.com"), key);
    collector.setActiveTurn(key);

    const slice = observer.observe();
    expect(Object.isFrozen(slice)).toBe(true);
    expect(Object.isFrozen(slice?.records)).toBe(true);
    expect(Object.isFrozen(slice?.records[0])).toBe(true);
  });

  it("respects perTurnLimit by dropping oldest records when exceeded", () => {
    const collector = createWebEvidenceCollector({ perTurnLimit: 2 });
    const observer = createWebEvidenceWorldStateObserver(collector);
    const key: TurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    collector.record(record("https://1.example.com"), key);
    collector.record(record("https://2.example.com"), key);
    collector.record(record("https://3.example.com"), key);
    collector.setActiveTurn(key);

    expect(observer.observe()?.records.map((r) => r.url)).toEqual([
      "https://2.example.com",
      "https://3.example.com",
    ]);
  });
});
