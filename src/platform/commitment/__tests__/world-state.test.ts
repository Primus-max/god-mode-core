import { describe, expect, it } from "vitest";
import {
  artifactRecordSchema,
  webEvidenceRecordSchema,
  type ArtifactRecord,
  type ArtifactWorldState,
  type WebEvidenceRecord,
  type WebEvidenceWorldState,
  type WorldStateSnapshot,
} from "../world-state.js";
import type { ISO8601 } from "../ids.js";

const ISO_NOW = "2026-05-02T11:00:00.000Z" as ISO8601;

describe("WebEvidenceSlice — Search-Composer Phase 3 (type + read-side)", () => {
  it("WorldStateSnapshot accepts the optional webEvidence slice with a frozen empty record list", () => {
    const empty: WebEvidenceWorldState = Object.freeze({
      records: Object.freeze([] as readonly WebEvidenceRecord[]),
    });
    const snapshot: WorldStateSnapshot = Object.freeze({ webEvidence: empty });
    expect(snapshot.webEvidence?.records).toEqual([]);
    expect(Object.isFrozen(snapshot.webEvidence)).toBe(true);
    expect(Object.isFrozen(snapshot.webEvidence?.records)).toBe(true);
  });

  it("WorldStateSnapshot tolerates absence of the webEvidence slice (existing snapshots remain valid)", () => {
    const snapshot: WorldStateSnapshot = Object.freeze({});
    expect(snapshot.webEvidence).toBeUndefined();
  });

  it("WebEvidenceRecord carries url + snippet + capturedAt and an optional title", () => {
    const minimal: WebEvidenceRecord = Object.freeze({
      url: "https://example.com/2026-05-02",
      snippet: "Latest models released on 2026-05-02 include …",
      capturedAt: ISO_NOW,
    });
    expect(minimal.url).toBe("https://example.com/2026-05-02");
    expect(minimal.title).toBeUndefined();

    const full: WebEvidenceRecord = Object.freeze({
      url: "https://example.com/announcement",
      snippet: "Excerpt from the announcement page",
      title: "Model Family Announcement",
      capturedAt: ISO_NOW,
    });
    expect(full.title).toBe("Model Family Announcement");
  });

  it("webEvidenceRecordSchema accepts the canonical shape (with and without title)", () => {
    expect(
      webEvidenceRecordSchema.safeParse({
        url: "https://example.com",
        snippet: "found",
        capturedAt: "2026-05-02T11:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      webEvidenceRecordSchema.safeParse({
        url: "https://example.com",
        snippet: "found",
        title: "Example",
        capturedAt: "2026-05-02T11:00:00Z",
      }).success,
    ).toBe(true);
  });

  it("webEvidenceRecordSchema rejects empty url", () => {
    expect(
      webEvidenceRecordSchema.safeParse({
        url: "",
        snippet: "x",
        capturedAt: "2026-05-02T11:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("webEvidenceRecordSchema rejects malformed ISO-8601 capturedAt", () => {
    expect(
      webEvidenceRecordSchema.safeParse({
        url: "https://example.com",
        snippet: "x",
        capturedAt: "May 2 2026",
      }).success,
    ).toBe(false);
    expect(
      webEvidenceRecordSchema.safeParse({
        url: "https://example.com",
        snippet: "x",
        capturedAt: "2026-05-02",
      }).success,
    ).toBe(false);
  });

  it("webEvidenceRecordSchema rejects missing required fields", () => {
    expect(
      webEvidenceRecordSchema.safeParse({ url: "https://example.com", snippet: "x" }).success,
    ).toBe(false);
    expect(
      webEvidenceRecordSchema.safeParse({ url: "https://example.com", capturedAt: ISO_NOW })
        .success,
    ).toBe(false);
  });

  it("webEvidenceRecordSchema rejects extra fields (strict)", () => {
    expect(
      webEvidenceRecordSchema.safeParse({
        url: "https://example.com",
        snippet: "x",
        capturedAt: "2026-05-02T11:00:00.000Z",
        extraField: "nope",
      }).success,
    ).toBe(false);
  });

  it("WebEvidenceWorldState carries multiple records preserving insertion order", () => {
    const slice: WebEvidenceWorldState = Object.freeze({
      records: Object.freeze([
        Object.freeze({
          url: "https://a.example.com",
          snippet: "first",
          capturedAt: ISO_NOW,
        }),
        Object.freeze({
          url: "https://b.example.com",
          snippet: "second",
          capturedAt: ISO_NOW,
        }),
      ] satisfies WebEvidenceRecord[]),
    });
    expect(slice.records.map((r) => r.url)).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });
});

describe("ArtifactsSlice — Cutover-3 Phase 3 (type + read-side)", () => {
  it("WorldStateSnapshot accepts the optional artifacts slice with a frozen empty record list", () => {
    const empty: ArtifactWorldState = Object.freeze({
      records: Object.freeze([] as readonly ArtifactRecord[]),
    });
    const snapshot: WorldStateSnapshot = Object.freeze({ artifacts: empty });
    expect(snapshot.artifacts?.records).toEqual([]);
    expect(Object.isFrozen(snapshot.artifacts)).toBe(true);
    expect(Object.isFrozen(snapshot.artifacts?.records)).toBe(true);
  });

  it("WorldStateSnapshot tolerates absence of the artifacts slice (existing snapshots remain valid)", () => {
    const snapshot: WorldStateSnapshot = Object.freeze({});
    expect(snapshot.artifacts).toBeUndefined();
  });

  it("ArtifactRecord carries artifactId + kind + path + mimeType + producedAt and optional sizeBytes / sourcePaths", () => {
    const minimal: ArtifactRecord = Object.freeze({
      artifactId: "art-1",
      kind: "pdf",
      path: "media/outbound/report.pdf",
      mimeType: "application/pdf",
      producedAt: ISO_NOW,
    });
    expect(minimal.artifactId).toBe("art-1");
    expect(minimal.sizeBytes).toBeUndefined();
    expect(minimal.sourcePaths).toBeUndefined();

    const full: ArtifactRecord = Object.freeze({
      artifactId: "art-2",
      kind: "image",
      path: "media/outbound/image.png",
      mimeType: "image/png",
      sizeBytes: 8192,
      sourcePaths: Object.freeze(["media/inbound/sketch.jpg"]),
      producedAt: ISO_NOW,
    });
    expect(full.kind).toBe("image");
    expect(full.sizeBytes).toBe(8192);
    expect(full.sourcePaths).toEqual(["media/inbound/sketch.jpg"]);
  });

  it("artifactRecordSchema accepts the canonical shape (with and without optional fields)", () => {
    expect(
      artifactRecordSchema.safeParse({
        artifactId: "art-1",
        kind: "pdf",
        path: "media/outbound/report.pdf",
        mimeType: "application/pdf",
        producedAt: "2026-05-02T11:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      artifactRecordSchema.safeParse({
        artifactId: "art-2",
        kind: "image",
        path: "media/outbound/img.png",
        mimeType: "image/png",
        sizeBytes: 8192,
        sourcePaths: ["media/inbound/ref.jpg"],
        producedAt: "2026-05-02T11:00:00Z",
      }).success,
    ).toBe(true);
  });

  it("artifactRecordSchema accepts every supported kind (pdf, docx, code_patch, image)", () => {
    for (const kind of ["pdf", "docx", "code_patch", "image"] as const) {
      expect(
        artifactRecordSchema.safeParse({
          artifactId: `art-${kind}`,
          kind,
          path: `media/outbound/x.${kind}`,
          mimeType: "application/octet-stream",
          producedAt: "2026-05-02T11:00:00.000Z",
        }).success,
      ).toBe(true);
    }
  });

  it("artifactRecordSchema rejects unknown kind", () => {
    expect(
      artifactRecordSchema.safeParse({
        artifactId: "art-1",
        kind: "spreadsheet",
        path: "x",
        mimeType: "application/octet-stream",
        producedAt: "2026-05-02T11:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("artifactRecordSchema rejects empty artifactId / path / mimeType", () => {
    const base = {
      artifactId: "art-1",
      kind: "pdf" as const,
      path: "media/outbound/x.pdf",
      mimeType: "application/pdf",
      producedAt: "2026-05-02T11:00:00.000Z",
    };
    expect(
      artifactRecordSchema.safeParse({ ...base, artifactId: "" }).success,
    ).toBe(false);
    expect(
      artifactRecordSchema.safeParse({ ...base, path: "" }).success,
    ).toBe(false);
    expect(
      artifactRecordSchema.safeParse({ ...base, mimeType: "" }).success,
    ).toBe(false);
  });

  it("artifactRecordSchema rejects malformed ISO-8601 producedAt", () => {
    expect(
      artifactRecordSchema.safeParse({
        artifactId: "art-1",
        kind: "pdf",
        path: "x",
        mimeType: "application/pdf",
        producedAt: "May 2 2026",
      }).success,
    ).toBe(false);
    expect(
      artifactRecordSchema.safeParse({
        artifactId: "art-1",
        kind: "pdf",
        path: "x",
        mimeType: "application/pdf",
        producedAt: "2026-05-02",
      }).success,
    ).toBe(false);
  });

  it("artifactRecordSchema rejects missing required fields", () => {
    expect(
      artifactRecordSchema.safeParse({
        kind: "pdf",
        path: "x",
        mimeType: "application/pdf",
        producedAt: ISO_NOW,
      }).success,
    ).toBe(false);
    expect(
      artifactRecordSchema.safeParse({
        artifactId: "art-1",
        kind: "pdf",
        mimeType: "application/pdf",
        producedAt: ISO_NOW,
      }).success,
    ).toBe(false);
  });

  it("artifactRecordSchema rejects extra fields (strict)", () => {
    expect(
      artifactRecordSchema.safeParse({
        artifactId: "art-1",
        kind: "pdf",
        path: "x",
        mimeType: "application/pdf",
        producedAt: "2026-05-02T11:00:00.000Z",
        extraField: "nope",
      }).success,
    ).toBe(false);
  });

  it("ArtifactWorldState carries multiple records preserving insertion order", () => {
    const slice: ArtifactWorldState = Object.freeze({
      records: Object.freeze([
        Object.freeze({
          artifactId: "art-1",
          kind: "pdf",
          path: "media/outbound/report.pdf",
          mimeType: "application/pdf",
          producedAt: ISO_NOW,
        }),
        Object.freeze({
          artifactId: "art-2",
          kind: "docx",
          path: "media/outbound/proposal.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          producedAt: ISO_NOW,
        }),
      ] satisfies ArtifactRecord[]),
    });
    expect(slice.records.map((r) => r.artifactId)).toEqual(["art-1", "art-2"]);
  });
});
