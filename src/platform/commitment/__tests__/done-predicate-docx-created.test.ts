import { describe, expect, it } from "vitest";
import { docxCreatedPredicate } from "../done-predicate-docx-created.js";
import type { DonePredicateCtx } from "../affordance.js";
import type { ArtifactRecord, WorldStateSnapshot } from "../world-state.js";
import type { ExpectedDelta } from "../expected-delta.js";
import type { ISO8601 } from "../ids.js";

const ISO_NOW = "2026-05-06T11:00:00.000Z" as ISO8601;
const EMPTY_DELTA: ExpectedDelta = Object.freeze({});
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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

function docxRecord(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return Object.freeze({
    artifactId: "docx-1",
    kind: "docx",
    path: "media/out/proposal.docx",
    mimeType: DOCX_MIME,
    producedAt: ISO_NOW,
    ...overrides,
  });
}

function withDelta(addedArtifactIds: readonly string[]): ExpectedDelta {
  return Object.freeze({
    artifacts: Object.freeze({
      added: Object.freeze([...addedArtifactIds]),
    }) as unknown as ExpectedDelta["artifacts"],
  });
}

describe("docxCreatedPredicate — cutover-3 Phase 4", () => {
  it("returns satisfied with one evidence fact when a matching docx record is present and listed in delta", () => {
    const ctx = makeCtx(
      Object.freeze({ artifacts: { records: Object.freeze([docxRecord()]) } }),
      withDelta(["docx-1"]),
    );
    const result = docxCreatedPredicate(ctx);

    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]?.kind).toBe("artifact.created");
      expect((result.evidence[0]?.value as { kind: string }).kind).toBe("docx");
      expect((result.evidence[0]?.value as { artifactId: string }).artifactId).toBe(
        "docx-1",
      );
      expect((result.evidence[0]?.value as { path: string }).path).toBe(
        "media/out/proposal.docx",
      );
    }
  });

  it("returns unsatisfied with `artifacts.slice_absent` when WorldStateSnapshot lacks the slice", () => {
    const ctx = makeCtx(Object.freeze({}), withDelta(["docx-1"]));
    const result = docxCreatedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["artifacts.slice_absent"]);
    }
  });

  it("returns unsatisfied with `artifacts.records.empty` when slice has empty records list", () => {
    const ctx = makeCtx(
      Object.freeze({ artifacts: { records: Object.freeze([]) } }),
      withDelta(["docx-1"]),
    );
    const result = docxCreatedPredicate(ctx);

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
            docxRecord({ artifactId: "docx-1", kind: "pdf", mimeType: "application/pdf" }),
          ]),
        },
      }),
      withDelta(["docx-1"]),
    );
    const result = docxCreatedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["artifact_record_missing:docx-1"]);
    }
  });

  it("returns unsatisfied with `artifact_record_missing:<id>` when delta references a missing artifactId", () => {
    const ctx = makeCtx(
      Object.freeze({ artifacts: { records: Object.freeze([docxRecord({ artifactId: "docx-1" })]) } }),
      withDelta(["docx-other"]),
    );
    const result = docxCreatedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["artifact_record_missing:docx-other"]);
    }
  });

  it("selects the matching docx record from a heterogeneous record list (multiple records, only one matches)", () => {
    const ctx = makeCtx(
      Object.freeze({
        artifacts: {
          records: Object.freeze([
            docxRecord({ artifactId: "pdf-1", kind: "pdf", mimeType: "application/pdf" }),
            docxRecord({ artifactId: "docx-1", path: "media/out/correct.docx" }),
            docxRecord({ artifactId: "img-1", kind: "image", mimeType: "image/png" }),
          ]),
        },
      }),
      withDelta(["docx-1"]),
    );
    const result = docxCreatedPredicate(ctx);

    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect((result.evidence[0]?.value as { path: string }).path).toBe(
        "media/out/correct.docx",
      );
    }
  });

  it("returns unsatisfied with `artifacts.delta_empty` when delta carries no added artifactIds", () => {
    const ctx = makeCtx(
      Object.freeze({ artifacts: { records: Object.freeze([docxRecord()]) } }),
      EMPTY_DELTA,
    );
    const result = docxCreatedPredicate(ctx);

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
      stateAfter: Object.freeze({ artifacts: { records: Object.freeze([docxRecord()]) } }),
      expectedDelta: withDelta(["docx-1"]),
      receipts: { entries: [] },
      trace: { steps: [] },
    };

    expect(() => docxCreatedPredicate(ctx)).not.toThrow();
    expect(touchedRawText).toBe(false);
  });
});
