/**
 * Cutover-3 Phase 5 — fail-first tests for the per-tool emit-site
 * helper. The four artifact-producing tools (`pdf`, `docx`,
 * `image_generate`, `apply_patch`) call `emitArtifactFromTool` after
 * a successful execution; the helper bridges the ambient turn-key
 * singleton + the process-scoped artifact collector.
 *
 * These tests exercise the real
 * `getProcessArtifactWorldStateCollector` + the real ambient-turn
 * singleton — no mocking of the helper under test. Mocks live only
 * on infrastructure (logger).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  setProcessArtifactWorldStateCollectorForTests,
  createArtifactWorldStateCollector,
  type ArtifactWorldStateCollector,
} from "../../../platform/commitment/artifact-world-state-observer.js";
import type { SessionId } from "../../../platform/commitment/ids.js";

import { setAmbientArtifactTurn } from "./artifact-ambient-turn.js";
import { emitArtifactFromTool } from "./emit-artifact-from-tool.js";

let tmpRoot: string;
let collector: ArtifactWorldStateCollector;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emit-artifact-"));
  collector = createArtifactWorldStateCollector();
  setProcessArtifactWorldStateCollectorForTests(collector);
  setAmbientArtifactTurn(undefined);
});

afterEach(() => {
  setAmbientArtifactTurn(undefined);
  setProcessArtifactWorldStateCollectorForTests(undefined);
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function tmpFile(name: string): string {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, "data");
  return p;
}

describe("emitArtifactFromTool — no ambient turn → typed no-op", () => {
  it("returns ok=false reason=no_ambient_turn when nobody has set the ambient turn", () => {
    const r = emitArtifactFromTool({
      kind: "pdf",
      path: tmpFile("a.pdf"),
      mimeType: "application/pdf",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("no_ambient_turn");
    }
  });

  it("does NOT touch the process collector when the ambient turn is unset", () => {
    emitArtifactFromTool({
      kind: "pdf",
      path: tmpFile("b.pdf"),
      mimeType: "application/pdf",
    });
    collector.setActiveTurn({ sessionId: "s" as SessionId, turnId: "t" });
    expect(collector.getActiveSlice()).toBeUndefined();
  });
});

describe("emitArtifactFromTool — ambient turn set → write through to collector", () => {
  it("appends a record under the ambient turn key", () => {
    setAmbientArtifactTurn({ sessionId: "session:emit-1" as SessionId, turnId: "turn-x" });
    const r = emitArtifactFromTool({
      kind: "image",
      path: tmpFile("art.png"),
      mimeType: "image/png",
      sourcePaths: [tmpFile("ref.jpg")],
      sizeBytes: 4,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      collector.setActiveTurn({
        sessionId: "session:emit-1" as SessionId,
        turnId: "turn-x",
      });
      const slice = collector.getActiveSlice();
      expect(slice).toHaveLength(1);
      expect(slice?.[0]?.artifactId).toBe(r.artifactId);
      expect(slice?.[0]?.kind).toBe("image");
      expect(slice?.[0]?.sourcePaths?.length).toBe(1);
    }
  });

  it("returns ok=false reason=adapter_failed when the path is missing", () => {
    setAmbientArtifactTurn({ sessionId: "session:emit-2" as SessionId, turnId: "turn-y" });
    const r = emitArtifactFromTool({
      kind: "pdf",
      path: path.join(tmpRoot, "nope.pdf"),
      mimeType: "application/pdf",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("adapter_failed");
    }
  });
});

describe("emitArtifactFromTool — never throws", () => {
  it("swallows adapter failure as a typed result instead of propagating", () => {
    setAmbientArtifactTurn({ sessionId: "s" as SessionId, turnId: "t" });
    expect(() =>
      emitArtifactFromTool({
        kind: "pdf",
        path: path.join(tmpRoot, "missing.pdf"),
        mimeType: "application/pdf",
      }),
    ).not.toThrow();
  });
});
