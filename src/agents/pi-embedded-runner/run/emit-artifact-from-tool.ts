/**
 * Cutover-3 Phase 5 — emit-site convenience for the four
 * artifact-producing tools.
 *
 * The four tools (`pdf-tool`, `docx-tool`, `image-generate-tool`,
 * `apply-patch` via `agent-command`) call `emitArtifactFromTool(...)`
 * after a successful tool execution. The helper:
 *
 * 1. Reads the ambient turn key from `artifact-ambient-turn.ts`. If
 *    no turn is set (the runner has not opted this turn into artifact
 *    observation), the helper returns `{ ok: false, reason:
 *    "no_ambient_turn" }` and the tool continues normally.
 * 2. Otherwise resolves the process-scoped collector
 *    (`getProcessArtifactWorldStateCollector`) and invokes
 *    `recordArtifactCreated(...)`.
 * 3. Logs to `defaultRuntime.log` on success / failure — failures are
 *    SWALLOWED (artifact observability never gates tool execution).
 *
 * The helper is the thin shim that lets the four tool surfaces stay
 * frozen at their existing signatures while still emitting a
 * structural `ArtifactRecord` into the cutover-3 WorldState slice.
 */

import { defaultRuntime } from "../../../runtime.js";
import { getProcessArtifactWorldStateCollector } from "../../../platform/commitment/artifact-world-state-observer.js";
import type { ArtifactRecord } from "../../../platform/commitment/world-state.js";

import { getAmbientArtifactTurn } from "./artifact-ambient-turn.js";
import {
  recordArtifactCreated,
  type RecordArtifactResult,
} from "./artifact-runtime-adapter.js";

export type EmitArtifactFromToolInput = {
  readonly kind: ArtifactRecord["kind"];
  readonly path: string;
  readonly mimeType: string;
  readonly sourcePaths?: readonly string[];
  readonly sizeBytes?: number;
  readonly artifactId?: string;
};

export type EmitArtifactFromToolResult =
  | { readonly ok: true; readonly artifactId: string }
  | {
      readonly ok: false;
      readonly reason: "no_ambient_turn" | "adapter_failed";
      readonly detail?: string;
    };

/**
 * Records an artifact created by one of the four artifact-producing
 * tools. Reads the ambient turn key (set by the runner at turn-start)
 * and writes through the process-scoped collector. Returns a typed
 * outcome — never throws.
 */
export function emitArtifactFromTool(
  input: EmitArtifactFromToolInput,
): EmitArtifactFromToolResult {
  const turnKey = getAmbientArtifactTurn();
  if (turnKey === undefined) {
    return { ok: false, reason: "no_ambient_turn" };
  }

  let result: RecordArtifactResult;
  try {
    result = recordArtifactCreated({
      collector: getProcessArtifactWorldStateCollector(),
      sessionId: turnKey.sessionId,
      turnId: turnKey.turnId,
      kind: input.kind,
      path: input.path,
      mimeType: input.mimeType,
      ...(input.sourcePaths && input.sourcePaths.length > 0
        ? { sourcePaths: input.sourcePaths }
        : {}),
      ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
      ...(input.artifactId !== undefined ? { artifactId: input.artifactId } : {}),
      logger: (line: string) => defaultRuntime.log(line),
    });
  } catch (err) {
    // recordArtifactCreated never throws by contract, but defense-
    // in-depth: if it did, swallow + warn so the tool keeps running.
    defaultRuntime.log(
      `[artifact-runtime-adapter] emitArtifactFromTool unexpected throw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      ok: false,
      reason: "adapter_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!result.ok) {
    defaultRuntime.log(
      `[artifact-runtime-adapter] emitArtifactFromTool failed kind=${input.kind} path=${input.path} reason=${result.reason}${
        result.detail ? ` detail=${result.detail}` : ""
      }`,
    );
    return {
      ok: false,
      reason: "adapter_failed",
      detail: result.reason,
    };
  }

  return { ok: true, artifactId: result.artifactId };
}
