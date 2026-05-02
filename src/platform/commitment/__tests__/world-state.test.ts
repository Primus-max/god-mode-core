import { describe, expect, it } from "vitest";
import {
  webEvidenceRecordSchema,
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
