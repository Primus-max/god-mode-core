import { describe, expect, it } from "vitest";
import {
  artifactRecordSchema,
  reminderQueryRecordSchema,
  repoOperationRecordSchema,
  webEvidenceRecordSchema,
  type ArtifactRecord,
  type ArtifactWorldState,
  type ReminderQueryRecord,
  type ReminderWorldState,
  type RepoOperationRecord,
  type RepoWorldState,
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

describe("RepoSlice — Cutover-4 Phase 3 (type + read-side)", () => {
  it("WorldStateSnapshot accepts the optional repo slice with a frozen empty record list", () => {
    const empty: RepoWorldState = Object.freeze({
      records: Object.freeze([] as readonly RepoOperationRecord[]),
    });
    const snapshot: WorldStateSnapshot = Object.freeze({ repo: empty });
    expect(snapshot.repo?.records).toEqual([]);
    expect(Object.isFrozen(snapshot.repo)).toBe(true);
    expect(Object.isFrozen(snapshot.repo?.records)).toBe(true);
  });

  it("WorldStateSnapshot tolerates absence of the repo slice (existing snapshots remain valid)", () => {
    const snapshot: WorldStateSnapshot = Object.freeze({});
    expect(snapshot.repo).toBeUndefined();
  });

  it("RepoOperationRecord carries minimal required fields and accepts every supported kind", () => {
    for (const kind of [
      "branch_created",
      "commit_landed",
      "merge_completed",
      "diff_observed",
    ] as const) {
      const minimal: RepoOperationRecord = Object.freeze({
        repoOperationId: `repo-op-${kind}`,
        kind,
        observedAt: ISO_NOW,
      });
      expect(minimal.repoOperationId).toBe(`repo-op-${kind}`);
      expect(minimal.kind).toBe(kind);
      expect(minimal.branchName).toBeUndefined();
      expect(minimal.commitSha).toBeUndefined();
    }
  });

  it("RepoOperationRecord accepts every optional structural field", () => {
    const full: RepoOperationRecord = Object.freeze({
      repoOperationId: "repo-op-1",
      kind: "merge_completed",
      branchName: "feature/cutover4-test",
      commitSha: "abcdef1234567890abcdef1234567890abcdef12",
      baseSha: "0123456",
      mergeBaseSha: "fedcba9876543210fedcba9876543210fedcba98",
      filesChanged: 3,
      insertions: 42,
      deletions: 7,
      repoRoot: "/tmp/repo",
      observedAt: ISO_NOW,
    });
    expect(full.commitSha).toBe("abcdef1234567890abcdef1234567890abcdef12");
    expect(full.baseSha).toBe("0123456");
    expect(full.mergeBaseSha).toBe(
      "fedcba9876543210fedcba9876543210fedcba98",
    );
    expect(full.filesChanged).toBe(3);
    expect(full.repoRoot).toBe("/tmp/repo");
  });

  it("repoOperationRecordSchema accepts the canonical minimal shape", () => {
    expect(
      repoOperationRecordSchema.safeParse({
        repoOperationId: "repo-op-1",
        kind: "branch_created",
        observedAt: "2026-05-02T11:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      repoOperationRecordSchema.safeParse({
        repoOperationId: "repo-op-1",
        kind: "branch_created",
        observedAt: "2026-05-02T11:00:00Z",
      }).success,
    ).toBe(true);
  });

  it("repoOperationRecordSchema accepts every supported kind", () => {
    for (const kind of [
      "branch_created",
      "commit_landed",
      "merge_completed",
      "diff_observed",
    ] as const) {
      expect(
        repoOperationRecordSchema.safeParse({
          repoOperationId: `repo-op-${kind}`,
          kind,
          observedAt: "2026-05-02T11:00:00.000Z",
        }).success,
      ).toBe(true);
    }
  });

  it("repoOperationRecordSchema accepts canonical 7-hex and 40-hex sha fields", () => {
    expect(
      repoOperationRecordSchema.safeParse({
        repoOperationId: "repo-op-1",
        kind: "commit_landed",
        commitSha: "abcdef1",
        observedAt: "2026-05-02T11:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      repoOperationRecordSchema.safeParse({
        repoOperationId: "repo-op-1",
        kind: "commit_landed",
        commitSha: "abcdef1234567890abcdef1234567890abcdef12",
        baseSha: "0123456",
        mergeBaseSha: "fedcba9876543210fedcba9876543210fedcba98",
        observedAt: "2026-05-02T11:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("repoOperationRecordSchema rejects unknown kind", () => {
    expect(
      repoOperationRecordSchema.safeParse({
        repoOperationId: "repo-op-1",
        kind: "rebased",
        observedAt: "2026-05-02T11:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("repoOperationRecordSchema rejects empty repoOperationId", () => {
    expect(
      repoOperationRecordSchema.safeParse({
        repoOperationId: "",
        kind: "branch_created",
        observedAt: "2026-05-02T11:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("repoOperationRecordSchema rejects malformed sha (wrong length / non-hex)", () => {
    expect(
      repoOperationRecordSchema.safeParse({
        repoOperationId: "repo-op-1",
        kind: "commit_landed",
        commitSha: "deadbe",
        observedAt: "2026-05-02T11:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      repoOperationRecordSchema.safeParse({
        repoOperationId: "repo-op-1",
        kind: "commit_landed",
        commitSha: "ZZZZZZZ",
        observedAt: "2026-05-02T11:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      repoOperationRecordSchema.safeParse({
        repoOperationId: "repo-op-1",
        kind: "commit_landed",
        baseSha: "deadbeefdeadbeefdeadbeefdeadbeefdead",
        observedAt: "2026-05-02T11:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("repoOperationRecordSchema rejects malformed ISO-8601 observedAt", () => {
    expect(
      repoOperationRecordSchema.safeParse({
        repoOperationId: "repo-op-1",
        kind: "branch_created",
        observedAt: "May 2 2026",
      }).success,
    ).toBe(false);
    expect(
      repoOperationRecordSchema.safeParse({
        repoOperationId: "repo-op-1",
        kind: "branch_created",
        observedAt: "2026-05-02",
      }).success,
    ).toBe(false);
  });

  it("repoOperationRecordSchema rejects extra fields (strict)", () => {
    expect(
      repoOperationRecordSchema.safeParse({
        repoOperationId: "repo-op-1",
        kind: "branch_created",
        observedAt: "2026-05-02T11:00:00.000Z",
        extraField: "nope",
      }).success,
    ).toBe(false);
  });

  it("RepoWorldState carries multiple records preserving insertion order", () => {
    const slice: RepoWorldState = Object.freeze({
      records: Object.freeze([
        Object.freeze({
          repoOperationId: "repo-op-1",
          kind: "branch_created",
          branchName: "feature/x",
          observedAt: ISO_NOW,
        }),
        Object.freeze({
          repoOperationId: "repo-op-2",
          kind: "commit_landed",
          commitSha: "abcdef1",
          observedAt: ISO_NOW,
        }),
      ] satisfies RepoOperationRecord[]),
    });
    expect(slice.records.map((r) => r.repoOperationId)).toEqual([
      "repo-op-1",
      "repo-op-2",
    ]);
  });
});

describe("ReminderSlice — Slice K Phase 4 (type + read-side)", () => {
  it("WorldStateSnapshot accepts the optional reminder slice with no lastQuery", () => {
    const empty: ReminderWorldState = Object.freeze({});
    const snapshot: WorldStateSnapshot = Object.freeze({ reminder: empty });
    expect(snapshot.reminder).toBeDefined();
    expect(snapshot.reminder?.lastQuery).toBeUndefined();
    expect(Object.isFrozen(snapshot.reminder)).toBe(true);
  });

  it("WorldStateSnapshot tolerates absence of the reminder slice (existing snapshots remain valid)", () => {
    const snapshot: WorldStateSnapshot = Object.freeze({});
    expect(snapshot.reminder).toBeUndefined();
  });

  it("ReminderQueryRecord carries queryId + resultCount + observedAt", () => {
    const record: ReminderQueryRecord = Object.freeze({
      queryId: "rem:q-1",
      resultCount: 5,
      observedAt: ISO_NOW,
    });
    expect(record.queryId).toBe("rem:q-1");
    expect(record.resultCount).toBe(5);
    expect(record.observedAt).toBe(ISO_NOW);
  });

  it("ReminderWorldState carries an optional lastQuery record", () => {
    const slice: ReminderWorldState = Object.freeze({
      lastQuery: Object.freeze({
        queryId: "rem:q-1",
        resultCount: 3,
        observedAt: ISO_NOW,
      }),
    });
    const snapshot: WorldStateSnapshot = Object.freeze({ reminder: slice });
    expect(snapshot.reminder?.lastQuery?.queryId).toBe("rem:q-1");
    expect(snapshot.reminder?.lastQuery?.resultCount).toBe(3);
  });

  it("reminderQueryRecordSchema accepts the canonical shape (resultCount = 0 IS valid — empty result IS success)", () => {
    expect(
      reminderQueryRecordSchema.safeParse({
        queryId: "rem:q-1",
        resultCount: 0,
        observedAt: "2026-05-02T11:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      reminderQueryRecordSchema.safeParse({
        queryId: "rem:q-1",
        resultCount: 42,
        observedAt: "2026-05-02T11:00:00Z",
      }).success,
    ).toBe(true);
  });

  it("reminderQueryRecordSchema rejects empty queryId", () => {
    expect(
      reminderQueryRecordSchema.safeParse({
        queryId: "",
        resultCount: 1,
        observedAt: "2026-05-02T11:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("reminderQueryRecordSchema rejects negative resultCount", () => {
    expect(
      reminderQueryRecordSchema.safeParse({
        queryId: "rem:q-1",
        resultCount: -1,
        observedAt: "2026-05-02T11:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("reminderQueryRecordSchema rejects malformed ISO-8601 observedAt", () => {
    expect(
      reminderQueryRecordSchema.safeParse({
        queryId: "rem:q-1",
        resultCount: 0,
        observedAt: "not-a-date",
      }).success,
    ).toBe(false);
  });

  it("reminderQueryRecordSchema rejects extra fields (strict)", () => {
    expect(
      reminderQueryRecordSchema.safeParse({
        queryId: "rem:q-1",
        resultCount: 0,
        observedAt: "2026-05-02T11:00:00.000Z",
        extra: "nope",
      }).success,
    ).toBe(false);
  });
});
