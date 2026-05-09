/**
 * Cutover-3 Phase 5 — emit-site contract test for apply_patch.
 *
 * Real apply_patch tool is invoked against a tmp workspace. After a
 * successful patch, the ambient turn key is set; the test verifies
 * the WorldState slice now contains a `kind=code_patch` record with
 * `sourcePaths` listing the touched files. Reverse: omitting the
 * ambient turn → no record.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createArtifactWorldStateCollector,
  setProcessArtifactWorldStateCollectorForTests,
  type ArtifactWorldStateCollector,
} from "../platform/commitment/artifact-world-state-observer.js";
import type { SessionId } from "../platform/identity/branded-ids.js";

import { createApplyPatchTool } from "./apply-patch.js";
import { setAmbientArtifactTurn } from "./pi-embedded-runner/run/artifact-ambient-turn.js";

let tmpRoot: string;
let collector: ArtifactWorldStateCollector;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apply-patch-emit-"));
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

const ADD_PATCH = `*** Begin Patch
*** Add File: hello.txt
+hello world
*** End Patch
`;

describe("apply-patch — cutover-3 Phase 5 emit site", () => {
  it("records a kind=code_patch artifact with sourcePaths covering the touched files when ambient turn is set", async () => {
    setAmbientArtifactTurn({
      sessionId: "session:patch" as SessionId,
      turnId: "turn-1",
    });
    const tool = createApplyPatchTool({ cwd: tmpRoot, workspaceOnly: false });
    await tool.execute(
      "call-1",
      { input: ADD_PATCH },
      undefined as unknown as AbortSignal,
    );

    collector.setActiveTurn({
      sessionId: "session:patch" as SessionId,
      turnId: "turn-1",
    });
    const slice = collector.getActiveSlice();
    expect(slice).toHaveLength(1);
    expect(slice?.[0]?.kind).toBe("code_patch");
    expect(slice?.[0]?.sourcePaths?.length).toBeGreaterThan(0);
    expect(slice?.[0]?.sourcePaths?.[0]).toContain("hello.txt");
  });

  it("does NOT record an artifact when ambient turn is unset (default until Phase 7/8 wires the runner)", async () => {
    const tool = createApplyPatchTool({ cwd: tmpRoot, workspaceOnly: false });
    await tool.execute(
      "call-1",
      { input: ADD_PATCH },
      undefined as unknown as AbortSignal,
    );

    collector.setActiveTurn({
      sessionId: "session:patch" as SessionId,
      turnId: "turn-1",
    });
    expect(collector.getActiveSlice()).toBeUndefined();
  });
});
