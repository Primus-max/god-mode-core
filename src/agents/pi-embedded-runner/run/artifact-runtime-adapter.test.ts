/**
 * Cutover-3 Phase 5 — fail-first tests for the artifact runtime adapter.
 *
 * Mirrors the slice E / F / Search-Composer 4a/4b adapter test shape:
 * - real `ArtifactWorldStateCollector` (no `vi.spyOn` on the adapter
 *   under test — spies live on dependencies only, per AGENTS.md);
 * - real tmp-dir filesystem so `path_missing` is a real failure path,
 *   not a mocked stub;
 * - closed failure set covered (`transport_error`, `path_missing`,
 *   `kind_unsupported`, `observer_unavailable`);
 * - sessionId / turnId isolation, sourcePaths round-trip, perTurnLimit
 *   delegation, auto-generated artifactId.
 *
 * The adapter is the WRITE side of the cutover-3 `WorldStateSnapshot.artifacts`
 * slice (Phase 3) and emits `expectedDelta.artifacts.added` so the four
 * Phase 4 done-predicates resolve.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createArtifactWorldStateCollector,
  type ArtifactTurnKey,
  type ArtifactWorldStateCollector,
} from "../../../platform/commitment/artifact-world-state-observer.js";
import type { SessionId } from "../../../platform/commitment/ids.js";

import {
  recordArtifactCreated,
  type RecordArtifactInput,
  type RecordArtifactResult,
} from "./artifact-runtime-adapter.js";

const SESSION_A = "session:a" as SessionId;
const SESSION_B = "session:b" as SessionId;

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-adapter-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function tmpFile(name: string, contents = "x"): string {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, contents);
  return p;
}

function turnKey(sessionId: SessionId, turnId: string): ArtifactTurnKey {
  return { sessionId, turnId };
}

function baseInput(
  collector: ArtifactWorldStateCollector,
  overrides: Partial<RecordArtifactInput> = {},
): RecordArtifactInput {
  const filePath = overrides.path ?? tmpFile("doc.pdf");
  return {
    collector,
    sessionId: SESSION_A,
    turnId: "turn-1",
    kind: "pdf",
    path: filePath,
    mimeType: "application/pdf",
    ...overrides,
  };
}

describe("recordArtifactCreated — happy path round-trip", () => {
  it("appends an artifact record to the collector and exposes it via the active slice", () => {
    const collector = createArtifactWorldStateCollector();
    const filePath = tmpFile("hello.pdf", "PDF-FAKE-CONTENT");
    const result = recordArtifactCreated(
      baseInput(collector, { path: filePath, sourcePaths: [tmpFile("ref.jpg")] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok=true");
    }
    expect(typeof result.artifactId).toBe("string");
    expect(result.artifactId.length).toBeGreaterThan(0);
    expect(result.expectedDelta.artifacts?.added).toContain(result.artifactId);

    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    const slice = collector.getActiveSlice();
    expect(slice).toBeDefined();
    expect(slice).toHaveLength(1);
    expect(slice?.[0]?.artifactId).toBe(result.artifactId);
    expect(slice?.[0]?.path).toBe(filePath);
    expect(slice?.[0]?.kind).toBe("pdf");
    expect(slice?.[0]?.mimeType).toBe("application/pdf");
    expect(slice?.[0]?.sourcePaths).toEqual([expect.any(String)]);
  });

  it("auto-generates a deterministic-ish artifactId when omitted", () => {
    const collector = createArtifactWorldStateCollector();
    const r1 = recordArtifactCreated(baseInput(collector, { path: tmpFile("a.pdf") }));
    const r2 = recordArtifactCreated(
      baseInput(collector, { path: tmpFile("b.pdf"), turnId: "turn-2" }),
    );
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.artifactId).not.toBe(r2.artifactId);
      expect(r1.artifactId.length).toBeGreaterThan(0);
    }
  });

  it("uses the supplied artifactId verbatim when provided", () => {
    const collector = createArtifactWorldStateCollector();
    const r = recordArtifactCreated(
      baseInput(collector, { artifactId: "artifact:custom-1" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifactId).toBe("artifact:custom-1");
    }
  });

  it("populates expectedDelta.artifacts.added with exactly the new artifactId", () => {
    const collector = createArtifactWorldStateCollector();
    const r = recordArtifactCreated(
      baseInput(collector, { artifactId: "artifact:42" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expectedDelta.artifacts?.added).toEqual(["artifact:42"]);
    }
  });
});

describe("recordArtifactCreated — closed failure set", () => {
  it("returns path_missing when the path does not exist on disk", () => {
    const collector = createArtifactWorldStateCollector();
    const missing = path.join(tmpRoot, "does-not-exist.pdf");
    const r = recordArtifactCreated(baseInput(collector, { path: missing }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("path_missing");
    }
  });

  it("returns kind_unsupported when kind is outside the closed enum", () => {
    const collector = createArtifactWorldStateCollector();
    const r = recordArtifactCreated(
      baseInput(collector, {
        // @ts-expect-error — exercising the runtime guard against unsanctioned casts
        kind: "video",
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("kind_unsupported");
    }
  });

  it("returns observer_unavailable when collector is undefined", () => {
    const r = recordArtifactCreated({
      // @ts-expect-error — exercising the defensive guard
      collector: undefined,
      sessionId: SESSION_A,
      turnId: "turn-1",
      kind: "pdf",
      path: tmpFile("x.pdf"),
      mimeType: "application/pdf",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("observer_unavailable");
    }
  });

  it("returns transport_error when the collector throws on record (e.g. malformed data)", () => {
    const collector = createArtifactWorldStateCollector();
    // Force a transport-class failure: artifactRecordSchema rejects empty
    // mimeType, so the collector throws — the adapter must wrap it.
    const r = recordArtifactCreated(
      baseInput(collector, { mimeType: "" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("transport_error");
    }
  });

  it("never throws — every failure surfaces as a typed result", () => {
    const collector = createArtifactWorldStateCollector();
    expect(() =>
      recordArtifactCreated(
        baseInput(collector, { path: path.join(tmpRoot, "nope.pdf") }),
      ),
    ).not.toThrow();
  });
});

describe("recordArtifactCreated — sessionId / turnId isolation", () => {
  it("does NOT leak records across sessions", () => {
    const collector = createArtifactWorldStateCollector();
    const r1 = recordArtifactCreated(baseInput(collector, { sessionId: SESSION_A }));
    const r2 = recordArtifactCreated(
      baseInput(collector, { sessionId: SESSION_B, path: tmpFile("b.pdf") }),
    );
    expect(r1.ok && r2.ok).toBe(true);

    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    expect(collector.getActiveSlice()).toHaveLength(1);

    collector.setActiveTurn(turnKey(SESSION_B, "turn-1"));
    expect(collector.getActiveSlice()).toHaveLength(1);
    if (r2.ok) {
      expect(collector.getActiveSlice()?.[0]?.artifactId).toBe(r2.artifactId);
    }
  });

  it("does NOT leak records across turns within the same session", () => {
    const collector = createArtifactWorldStateCollector();
    recordArtifactCreated(baseInput(collector, { turnId: "turn-1" }));
    recordArtifactCreated(
      baseInput(collector, { turnId: "turn-2", path: tmpFile("t2.pdf") }),
    );

    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    expect(collector.getActiveSlice()).toHaveLength(1);

    collector.setActiveTurn(turnKey(SESSION_A, "turn-2"));
    expect(collector.getActiveSlice()).toHaveLength(1);
  });
});

describe("recordArtifactCreated — perTurnLimit delegation", () => {
  it("respects the collector's perTurnLimit when overflow occurs", () => {
    const collector = createArtifactWorldStateCollector({ perTurnLimit: 2 });
    for (let i = 0; i < 5; i += 1) {
      recordArtifactCreated(
        baseInput(collector, {
          path: tmpFile(`overflow-${i}.pdf`),
          artifactId: `artifact:${i}`,
        }),
      );
    }
    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    const slice = collector.getActiveSlice();
    expect(slice).toHaveLength(2);
  });
});

describe("recordArtifactCreated — kind round-trip for all four families", () => {
  it.each([
    ["pdf", "application/pdf"],
    ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["code_patch", "text/x-patch"],
    ["image", "image/png"],
  ] as const)("records kind=%s", (kind, mimeType) => {
    const collector = createArtifactWorldStateCollector();
    const result: RecordArtifactResult = recordArtifactCreated(
      baseInput(collector, {
        kind,
        mimeType,
        path: tmpFile(`asset.${kind}`),
        artifactId: `artifact:${kind}`,
      }),
    );
    expect(result.ok).toBe(true);
    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    expect(collector.getActiveSlice()?.[0]?.kind).toBe(kind);
  });
});
