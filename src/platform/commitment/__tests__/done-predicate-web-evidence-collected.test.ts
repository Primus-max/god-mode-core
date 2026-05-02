import { describe, expect, it } from "vitest";
import { webEvidenceCollectedPredicate } from "../done-predicate-web-evidence-collected.js";
import type { DonePredicateCtx } from "../affordance.js";
import type { WorldStateSnapshot, WebEvidenceRecord } from "../world-state.js";
import type { ExpectedDelta } from "../expected-delta.js";
import type { ISO8601 } from "../ids.js";

const ISO_NOW = "2026-05-02T11:00:00.000Z" as ISO8601;
const EMPTY_DELTA: ExpectedDelta = Object.freeze({});

function makeCtx(stateAfter: WorldStateSnapshot): DonePredicateCtx {
  return {
    stateBefore: Object.freeze({}),
    stateAfter,
    expectedDelta: EMPTY_DELTA,
    receipts: { entries: [] },
    trace: { steps: [] },
  };
}

describe("webEvidenceCollectedPredicate — Search-Composer Phase 3", () => {
  it("returns satisfied with one evidence fact per cited record (happy path)", () => {
    const records: readonly WebEvidenceRecord[] = Object.freeze([
      Object.freeze({
        url: "https://a.example.com",
        snippet: "first",
        capturedAt: ISO_NOW,
      }),
      Object.freeze({
        url: "https://b.example.com",
        snippet: "second",
        title: "B",
        capturedAt: ISO_NOW,
      }),
    ]);
    const ctx = makeCtx(Object.freeze({ webEvidence: { records } }));
    const result = webEvidenceCollectedPredicate(ctx);

    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect(result.evidence).toHaveLength(2);
      expect(result.evidence[0]?.kind).toBe("web_evidence.collected");
      expect(result.evidence.map((entry) => (entry.value as { url: string }).url)).toEqual([
        "https://a.example.com",
        "https://b.example.com",
      ]);
    }
  });

  it("returns unsatisfied with `evidence_record_missing_url:<index>` when a record has empty url", () => {
    const records: readonly WebEvidenceRecord[] = Object.freeze([
      Object.freeze({
        url: "https://ok.example.com",
        snippet: "ok",
        capturedAt: ISO_NOW,
      }),
      Object.freeze({
        url: "",
        snippet: "missing url",
        capturedAt: ISO_NOW,
      }),
    ]);
    const ctx = makeCtx(Object.freeze({ webEvidence: { records } }));
    const result = webEvidenceCollectedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["evidence_record_missing_url:1"]);
    }
  });

  it("returns unsatisfied with `web_evidence.records.empty` when slice has empty records list", () => {
    const ctx = makeCtx(Object.freeze({ webEvidence: { records: Object.freeze([]) } }));
    const result = webEvidenceCollectedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["web_evidence.records.empty"]);
    }
  });

  it("returns unsatisfied with `web_evidence.slice_absent` when WorldStateSnapshot lacks the slice", () => {
    const ctx = makeCtx(Object.freeze({}));
    const result = webEvidenceCollectedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["web_evidence.slice_absent"]);
    }
  });

  it("does not read raw user text, TaskContract, or task-classifier output (invariant #9)", () => {
    let touchedRawText = false;
    const sentinelStateBefore = new Proxy({}, {
      get(_target, prop) {
        if (prop === "rawUserTurn" || prop === "taskContract") {
          touchedRawText = true;
        }
        return undefined;
      },
    }) as WorldStateSnapshot;
    const records: readonly WebEvidenceRecord[] = Object.freeze([
      Object.freeze({
        url: "https://x.example.com",
        snippet: "sentinel",
        capturedAt: ISO_NOW,
      }),
    ]);
    const ctx: DonePredicateCtx = {
      stateBefore: sentinelStateBefore,
      stateAfter: Object.freeze({ webEvidence: { records } }),
      expectedDelta: EMPTY_DELTA,
      receipts: { entries: [] },
      trace: { steps: [] },
    };
    const result = webEvidenceCollectedPredicate(ctx);

    expect(result.satisfied).toBe(true);
    expect(touchedRawText).toBe(false);
  });
});
