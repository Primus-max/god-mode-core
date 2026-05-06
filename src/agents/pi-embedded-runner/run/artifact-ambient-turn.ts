/**
 * Cutover-3 Phase 5 — process-scoped ambient artifact turn key.
 *
 * The four artifact-producing tools (`pdf-tool.ts`, `docx-tool.ts`,
 * `image-generate-tool.ts`, `apply-patch.ts`) emit a structural
 * `ArtifactRecord` after a successful execution by calling
 * `recordArtifactCreated(...)` from `artifact-runtime-adapter.ts`. The
 * adapter needs `(sessionId, turnId)` to bucket the record correctly,
 * but the tool surfaces are FROZEN per Phase 5 sub-plan ("tool wrapper
 * signatures NOT changed"). Threading the turn key through every tool
 * factory + execute() call would have been invasive and would have
 * required updating every test fixture.
 *
 * The ambient-turn singleton is the thin compromise:
 * - The attempt.ts orchestrator (or `runTurnDecision` caller) sets
 *   the turn at turn-start via `setAmbientArtifactTurn(key)` and
 *   clears it at turn-end via `setAmbientArtifactTurn(undefined)`.
 * - The four tools call `getAmbientArtifactTurn()` inside their
 *   emit-site try/catch; absent ambient turn, the emit is a typed
 *   no-op (no error, no logged warn — the runner has chosen not to
 *   route this turn through the artifact observer).
 *
 * Phase 5 does NOT yet wire the runner-side `set` call (that lives in
 * Phase 7/8 production routing). Until then the emit sites are
 * structurally present but inert — same pattern slice F P5 used for
 * the task hook (wired but inert until task input arrives in J / G).
 *
 * Boundary discipline:
 * - Process-scoped, single-writer, last-writer-wins. Tests reset
 *   between runs via `setAmbientArtifactTurn(undefined)` in
 *   `afterEach`.
 * - The module exports NOTHING reachable from `src/platform/commitment/`
 *   — invariant #8 unchanged.
 * - Reads NO raw user text — the key is a synthetic
 *   `(sessionId, turnId)` tuple — invariants #5/#6 unchanged.
 */

import type { ArtifactTurnKey } from "../../../platform/commitment/artifact-world-state-observer.js";

let ambientKey: ArtifactTurnKey | undefined;

/**
 * Sets the ambient turn key the four artifact-producing tools read at
 * emit time. Production callers (`runTurnDecision` caller wiring in a
 * later phase) call this once at turn-start and clear with
 * `undefined` at turn-end.
 *
 * @param key - Turn key, or `undefined` to clear.
 */
export function setAmbientArtifactTurn(key: ArtifactTurnKey | undefined): void {
  ambientKey = key;
}

/**
 * Reads the currently-set ambient turn key. Returns `undefined` when
 * no caller has plumbed a turn for this process — emit sites then
 * skip silently (the WorldState slice stays absent for the turn,
 * predicates report `artifacts.slice_absent`).
 *
 * @returns Ambient turn key, or `undefined` when unset.
 */
export function getAmbientArtifactTurn(): ArtifactTurnKey | undefined {
  return ambientKey;
}
