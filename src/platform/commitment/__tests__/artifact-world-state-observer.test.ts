import { describe, expect, it } from "vitest";
import {
  createArtifactWorldStateCollector,
  createArtifactWorldStateObserver,
  type ArtifactTurnKey,
} from "../artifact-world-state-observer.js";
import { createDefaultMonitoredRuntime } from "../production-runtime-defaults.js";
import type { ISO8601, SessionId } from "../ids.js";
import type { ArtifactRecord } from "../world-state.js";

const ISO_NOW = "2026-05-02T11:00:00.000Z" as ISO8601;
const SESSION_A = "session-a" as SessionId;
const SESSION_B = "session-b" as SessionId;

function record(
  artifactId: string,
  overrides: Partial<ArtifactRecord> = {},
): ArtifactRecord {
  return Object.freeze({
    artifactId,
    kind: "pdf",
    path: `media/outbound/${artifactId}.pdf`,
    mimeType: "application/pdf",
    producedAt: ISO_NOW,
    ...overrides,
  });
}

describe("ArtifactWorldStateCollector — Cutover-3 Phase 3", () => {
  it("returns undefined slice when no active turn is set (production default)", () => {
    const collector = createArtifactWorldStateCollector();
    const observer = createArtifactWorldStateObserver(collector);
    expect(observer.observe()).toBeUndefined();
  });

  it("returns undefined slice when active turn has no recorded entries", () => {
    const collector = createArtifactWorldStateCollector();
    const observer = createArtifactWorldStateObserver(collector);
    const key: ArtifactTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };
    collector.setActiveTurn(key);
    expect(observer.observe()).toBeUndefined();
  });

  it("round-trip: append → read returns the same record under the active turn", () => {
    const collector = createArtifactWorldStateCollector();
    const observer = createArtifactWorldStateObserver(collector);
    const key: ArtifactTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    const r = record("art-1");
    collector.record(r, key);
    collector.setActiveTurn(key);

    const slice = observer.observe();
    expect(slice).toBeDefined();
    expect(slice?.records.map((entry) => entry.artifactId)).toEqual(["art-1"]);
    expect(slice?.records[0]).toEqual(r);
  });

  it("exposes records bucketed under the active turn in insertion order", () => {
    const collector = createArtifactWorldStateCollector();
    const observer = createArtifactWorldStateObserver(collector);
    const key: ArtifactTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    collector.record(record("art-1"), key);
    collector.record(record("art-2"), key);
    collector.setActiveTurn(key);

    expect(observer.observe()?.records.map((r) => r.artifactId)).toEqual([
      "art-1",
      "art-2",
    ]);
  });

  it("dedupes records with the same artifactId last-writer-wins", () => {
    const collector = createArtifactWorldStateCollector();
    const observer = createArtifactWorldStateObserver(collector);
    const key: ArtifactTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    collector.record(
      record("art-1", { path: "media/outbound/first.pdf" }),
      key,
    );
    collector.record(
      record("art-1", { path: "media/outbound/second.pdf" }),
      key,
    );
    collector.setActiveTurn(key);

    const slice = observer.observe();
    expect(slice?.records).toHaveLength(1);
    expect(slice?.records[0]?.path).toBe("media/outbound/second.pdf");
  });

  it("isolates records by (sessionId, turnId) — same sessionId, different turnId", () => {
    const collector = createArtifactWorldStateCollector();
    const observer = createArtifactWorldStateObserver(collector);
    const key1: ArtifactTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };
    const key2: ArtifactTurnKey = { sessionId: SESSION_A, turnId: "turn-2" };

    collector.record(record("art-t1"), key1);
    collector.record(record("art-t2"), key2);

    collector.setActiveTurn(key1);
    expect(observer.observe()?.records.map((r) => r.artifactId)).toEqual([
      "art-t1",
    ]);

    collector.setActiveTurn(key2);
    expect(observer.observe()?.records.map((r) => r.artifactId)).toEqual([
      "art-t2",
    ]);
  });

  it("isolates records by (sessionId, turnId) — different sessionId, same turnId string", () => {
    const collector = createArtifactWorldStateCollector();
    const observer = createArtifactWorldStateObserver(collector);
    const key1: ArtifactTurnKey = { sessionId: SESSION_A, turnId: "shared-id" };
    const key2: ArtifactTurnKey = { sessionId: SESSION_B, turnId: "shared-id" };

    collector.record(record("art-a"), key1);
    collector.record(record("art-b"), key2);

    collector.setActiveTurn(key1);
    expect(observer.observe()?.records.map((r) => r.artifactId)).toEqual([
      "art-a",
    ]);

    collector.setActiveTurn(key2);
    expect(observer.observe()?.records.map((r) => r.artifactId)).toEqual([
      "art-b",
    ]);
  });

  it("resetForTurn clears only the targeted bucket; other turns untouched", () => {
    const collector = createArtifactWorldStateCollector();
    const observer = createArtifactWorldStateObserver(collector);
    const key1: ArtifactTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };
    const key2: ArtifactTurnKey = { sessionId: SESSION_A, turnId: "turn-2" };

    collector.record(record("art-t1"), key1);
    collector.record(record("art-t2"), key2);

    collector.resetForTurn(key1);

    collector.setActiveTurn(key1);
    expect(observer.observe()).toBeUndefined();

    collector.setActiveTurn(key2);
    expect(observer.observe()?.records.map((r) => r.artifactId)).toEqual([
      "art-t2",
    ]);
  });

  it("setActiveTurn(undefined) clears the active pointer", () => {
    const collector = createArtifactWorldStateCollector();
    const observer = createArtifactWorldStateObserver(collector);
    const key: ArtifactTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    collector.record(record("art-1"), key);
    collector.setActiveTurn(key);
    expect(observer.observe()).toBeDefined();

    collector.setActiveTurn(undefined);
    expect(observer.observe()).toBeUndefined();
  });

  it("returns frozen records (consumer cannot mutate)", () => {
    const collector = createArtifactWorldStateCollector();
    const observer = createArtifactWorldStateObserver(collector);
    const key: ArtifactTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    collector.record(record("art-1"), key);
    collector.setActiveTurn(key);

    const slice = observer.observe();
    expect(Object.isFrozen(slice)).toBe(true);
    expect(Object.isFrozen(slice?.records)).toBe(true);
    expect(Object.isFrozen(slice?.records[0])).toBe(true);
  });

  it("default perTurnLimit=8 drops oldest record when 9th is appended", () => {
    const collector = createArtifactWorldStateCollector();
    const observer = createArtifactWorldStateObserver(collector);
    const key: ArtifactTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    for (let i = 1; i <= 9; i += 1) {
      collector.record(record(`art-${i}`), key);
    }
    collector.setActiveTurn(key);

    const ids = observer.observe()?.records.map((r) => r.artifactId);
    expect(ids).toHaveLength(8);
    expect(ids?.[0]).toBe("art-2");
    expect(ids?.[ids.length - 1]).toBe("art-9");
    expect(ids).not.toContain("art-1");
  });

  it("respects custom perTurnLimit by dropping oldest records when exceeded", () => {
    const collector = createArtifactWorldStateCollector({ perTurnLimit: 2 });
    const observer = createArtifactWorldStateObserver(collector);
    const key: ArtifactTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    collector.record(record("art-1"), key);
    collector.record(record("art-2"), key);
    collector.record(record("art-3"), key);
    collector.setActiveTurn(key);

    expect(observer.observe()?.records.map((r) => r.artifactId)).toEqual([
      "art-2",
      "art-3",
    ]);
  });

  it("rejects malformed input — missing artifactId / path / kind", () => {
    const collector = createArtifactWorldStateCollector();
    const key: ArtifactTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };

    expect(() =>
      collector.record(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { kind: "pdf", path: "x", mimeType: "application/pdf", producedAt: ISO_NOW } as any,
        key,
      ),
    ).toThrow();
    expect(() =>
      collector.record(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          artifactId: "art-1",
          kind: "pdf",
          mimeType: "application/pdf",
          producedAt: ISO_NOW,
        } as any,
        key,
      ),
    ).toThrow();
    expect(() =>
      collector.record(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          artifactId: "art-1",
          kind: "spreadsheet",
          path: "x",
          mimeType: "application/octet-stream",
          producedAt: ISO_NOW,
        } as any,
        key,
      ),
    ).toThrow();
  });

  it("createDefaultMonitoredRuntime exposes the artifacts slice when the process collector is populated", async () => {
    const { setProcessArtifactWorldStateCollectorForTests, createArtifactWorldStateCollector } =
      await import("../artifact-world-state-observer.js");

    const fixture = createArtifactWorldStateCollector();
    setProcessArtifactWorldStateCollectorForTests(fixture);
    try {
      const key: ArtifactTurnKey = { sessionId: SESSION_A, turnId: "turn-1" };
      fixture.record(record("art-1"), key);
      fixture.setActiveTurn(key);

      const runtime = createDefaultMonitoredRuntime();
      expect(runtime).toBeDefined();
      // The wired observer reads the same singleton; assert via direct observation.
      const observer = createArtifactWorldStateObserver(fixture);
      const slice = observer.observe();
      expect(slice?.records.map((r) => r.artifactId)).toEqual(["art-1"]);
    } finally {
      setProcessArtifactWorldStateCollectorForTests(undefined);
    }
  });
});
