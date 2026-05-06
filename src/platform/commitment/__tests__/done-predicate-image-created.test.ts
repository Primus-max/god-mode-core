import { describe, expect, it } from "vitest";
import { imageCreatedPredicate } from "../done-predicate-image-created.js";
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

function imageRecord(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return Object.freeze({
    artifactId: "img-1",
    kind: "image",
    path: "media/out/sketch.png",
    mimeType: "image/png",
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

describe("imageCreatedPredicate — cutover-3 Phase 4", () => {
  it("returns satisfied with one evidence fact when a matching image record is present and listed in delta", () => {
    const ctx = makeCtx(
      Object.freeze({ artifacts: { records: Object.freeze([imageRecord()]) } }),
      withDelta(["img-1"]),
    );
    const result = imageCreatedPredicate(ctx);

    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]?.kind).toBe("artifact.created");
      expect((result.evidence[0]?.value as { kind: string }).kind).toBe("image");
      expect((result.evidence[0]?.value as { artifactId: string }).artifactId).toBe(
        "img-1",
      );
      expect((result.evidence[0]?.value as { path: string }).path).toBe(
        "media/out/sketch.png",
      );
    }
  });

  it("propagates `sourcePaths` (img2img reference path) into the evidence value when present", () => {
    const ctx = makeCtx(
      Object.freeze({
        artifacts: {
          records: Object.freeze([
            imageRecord({
              sourcePaths: Object.freeze([
                "media/inbound/sketch---1746590000-0.jpg",
              ]),
            }),
          ]),
        },
      }),
      withDelta(["img-1"]),
    );
    const result = imageCreatedPredicate(ctx);

    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      const value = result.evidence[0]?.value as {
        readonly sourcePaths?: readonly string[];
      };
      expect(value.sourcePaths).toEqual([
        "media/inbound/sketch---1746590000-0.jpg",
      ]);
    }
  });

  it("returns unsatisfied with `artifacts.slice_absent` when WorldStateSnapshot lacks the slice", () => {
    const ctx = makeCtx(Object.freeze({}), withDelta(["img-1"]));
    const result = imageCreatedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["artifacts.slice_absent"]);
    }
  });

  it("returns unsatisfied with `artifacts.records.empty` when slice has empty records list", () => {
    const ctx = makeCtx(
      Object.freeze({ artifacts: { records: Object.freeze([]) } }),
      withDelta(["img-1"]),
    );
    const result = imageCreatedPredicate(ctx);

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
            imageRecord({ artifactId: "img-1", kind: "pdf", mimeType: "application/pdf" }),
          ]),
        },
      }),
      withDelta(["img-1"]),
    );
    const result = imageCreatedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["artifact_record_missing:img-1"]);
    }
  });

  it("returns unsatisfied with `artifact_record_missing:<id>` when delta references a missing artifactId", () => {
    const ctx = makeCtx(
      Object.freeze({
        artifacts: { records: Object.freeze([imageRecord({ artifactId: "img-1" })]) },
      }),
      withDelta(["img-other"]),
    );
    const result = imageCreatedPredicate(ctx);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toEqual(["artifact_record_missing:img-other"]);
    }
  });

  it("selects the matching image record from a heterogeneous record list (multiple records, only one matches)", () => {
    const ctx = makeCtx(
      Object.freeze({
        artifacts: {
          records: Object.freeze([
            imageRecord({ artifactId: "pdf-1", kind: "pdf", mimeType: "application/pdf" }),
            imageRecord({ artifactId: "docx-1", kind: "docx", mimeType: "application/x" }),
            imageRecord({ artifactId: "img-1", path: "media/out/correct.png" }),
          ]),
        },
      }),
      withDelta(["img-1"]),
    );
    const result = imageCreatedPredicate(ctx);

    expect(result.satisfied).toBe(true);
    if (result.satisfied) {
      expect((result.evidence[0]?.value as { path: string }).path).toBe(
        "media/out/correct.png",
      );
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
      stateAfter: Object.freeze({ artifacts: { records: Object.freeze([imageRecord()]) } }),
      expectedDelta: withDelta(["img-1"]),
      receipts: { entries: [] },
      trace: { steps: [] },
    };

    expect(() => imageCreatedPredicate(ctx)).not.toThrow();
    expect(touchedRawText).toBe(false);
  });
});
