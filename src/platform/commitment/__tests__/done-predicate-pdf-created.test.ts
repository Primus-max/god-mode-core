import { describe, expect, it } from "vitest";
import { pdfCreatedPredicate } from "../done-predicate-pdf-created.js";
import type { DonePredicateCtx } from "../affordance.js";
import type { ArtifactRecord, WorldStateSnapshot } from "../world-state.js";
import type { ExpectedDelta } from "../expected-delta.js";
import type { ISO8601 } from "../ids.js";

const ISO_NOW = "2026-05-06T11:00:00.000Z" as ISO8601;
const EMPTY_DELTA: ExpectedDelta = Object.freeze({});

function makeCtx(
  stateAfter: WorldStateSnapshot,
  expectedDelta: ExpectedDelta = EMPTY_DELTA,
): DonePredicateCtx {
  return {
    stateBefore: Object.freeze({}),
    stateAfter,
    expectedDelta,
    receipts: { entries: [] },
    trace: { steps: [] },
  };
}

function pdfRecord(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return Object.freeze({
    artifactId: "pdf-1",
    kind: "pdf",
    path: "media/out/report.pdf",
    mimeType: "application/pdf",
    producedAt: ISO_NOW,
    ...overrides,
  });
}

// `expectedDelta.artifacts` is a `Record<string, never>` until Phase 5 widens
// it. The Phase 4 predicate accepts the future `added: readonly string[]`
// shape via a structural cast — predicates must NEVER throw on the empty
// shape (slice E forward-compat precedent: `web_evidence.slice_absent`).
function withDelta(addedArtifactIds: readonly string[]): ExpectedDelta {
  return Object.freeze({
    artifacts: Object.freeze({
      added: Object.freeze([...addedArtifactIds]),
    }) as unknown as ExpectedDelta["artifacts"],
  });
}

describe("pdfCreatedPredicate — cutover-3 Phase 4", () => {
  it("returns satisfied with one evidence fact when a matching pdf record is present and listed in delta", () => {
    const ctx = makeCtx(
      Object.freeze({ artifacts: { records: Object.freeze([pdfRecord()]) } }),
      withDelta(["pdf-1"]),
    );
    const result = pdfCreatedPredicate(ctx);

    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]?.kind).toBe("artifact.created");
      expect(
        (result.evidence[0]?.value as { kind: string; artifactId: string; path: string }).kind,
      ).toBe("pdf");
      expect(
        (result.evidence[0]?.value as { artifactId: string }).artifactId,
      ).toBe("pdf-1");
      expect((result.evidence[0]?.value as { path: string }).path).toBe(
        "media/out/report.pdf",
      );
    }
  });

  it("returns unsatisfied with `artifacts.slice_absent` when WorldStateSnapshot lacks the slice", () => {
    const ctx = makeCtx(Object.freeze({}), withDelta(["pdf-1"]));
    const result = pdfCreatedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["artifacts.slice_absent"]);
    }
  });

  it("returns unsatisfied with `artifacts.records.empty` when slice has empty records list", () => {
    const ctx = makeCtx(
      Object.freeze({ artifacts: { records: Object.freeze([]) } }),
      withDelta(["pdf-1"]),
    );
    const result = pdfCreatedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["artifacts.records.empty"]);
    }
  });

  it("returns unsatisfied with `artifact_record_missing:<id>` when a different kind matches the id", () => {
    const ctx = makeCtx(
      Object.freeze({
        artifacts: {
          records: Object.freeze([
            pdfRecord({ artifactId: "pdf-1", kind: "docx", mimeType: "application/x" }),
          ]),
        },
      }),
      withDelta(["pdf-1"]),
    );
    const result = pdfCreatedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["artifact_record_missing:pdf-1"]);
    }
  });

  it("returns unsatisfied with `artifact_record_missing:<id>` when delta references a missing artifactId", () => {
    const ctx = makeCtx(
      Object.freeze({ artifacts: { records: Object.freeze([pdfRecord({ artifactId: "pdf-1" })]) } }),
      withDelta(["pdf-other"]),
    );
    const result = pdfCreatedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["artifact_record_missing:pdf-other"]);
    }
  });

  it("selects the matching pdf record from a heterogeneous record list (multiple records, only one matches)", () => {
    const ctx = makeCtx(
      Object.freeze({
        artifacts: {
          records: Object.freeze([
            pdfRecord({ artifactId: "docx-1", kind: "docx", mimeType: "application/x" }),
            pdfRecord({ artifactId: "img-1", kind: "image", mimeType: "image/png" }),
            pdfRecord({ artifactId: "pdf-1", path: "media/out/correct.pdf" }),
          ]),
        },
      }),
      withDelta(["pdf-1"]),
    );
    const result = pdfCreatedPredicate(ctx);

    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect((result.evidence[0]?.value as { path: string }).path).toBe(
        "media/out/correct.pdf",
      );
    }
  });

  it("returns unsatisfied with `artifacts.delta_empty` when delta carries no added artifactIds", () => {
    const ctx = makeCtx(
      Object.freeze({ artifacts: { records: Object.freeze([pdfRecord()]) } }),
      EMPTY_DELTA,
    );
    const result = pdfCreatedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["artifacts.delta_empty"]);
    }
  });

  it("does not throw on hostile / sentinel state-before access (invariant #9 sentinel-proxy)", () => {
    let touchedRawText = false;
    const sentinelStateBefore = new Proxy({}, {
      get(_target, prop) {
        if (prop === "rawUserTurn" || prop === "taskContract") {
          touchedRawText = true;
        }
        return undefined;
      },
    }) as WorldStateSnapshot;
    const ctx: DonePredicateCtx = {
      stateBefore: sentinelStateBefore,
      stateAfter: Object.freeze({ artifacts: { records: Object.freeze([pdfRecord()]) } }),
      expectedDelta: withDelta(["pdf-1"]),
      receipts: { entries: [] },
      trace: { steps: [] },
    };

    // Predicate must never throw and must not touch raw user text.
    expect(() => pdfCreatedPredicate(ctx)).not.toThrow();
    expect(touchedRawText).toBe(false);
  });
});
