/**
 * Cutover-3 Phase 5 — artifact runtime adapter.
 *
 * Sibling of the Search-Composer Phase 4a/4b
 * `web-research-runtime-adapter.ts` (PR-#130/#131). The adapter is the
 * WRITE side of the cutover-3 `WorldStateSnapshot.artifacts` slice
 * (Phase 3): it receives a structural artifact descriptor produced by
 * one of the four artifact-producing tools (`pdf`, `docx`,
 * `image_generate`, `apply_patch`), validates the path / kind /
 * collector availability, appends an `ArtifactRecord` to the injected
 * `ArtifactWorldStateCollector`, and emits the matching
 * `ExpectedDelta.artifacts.added` so the four Phase 4 done-predicates
 * can resolve the artifactId on commitmentSatisfied.
 *
 * Boundary discipline:
 * - Lives in `src/agents/pi-embedded-runner/run/`, NOT in
 *   `src/platform/commitment/` — invariant #8.
 * - Reads STRUCTURAL inputs only (path, mimeType, kind, sessionId,
 *   turnId). Never reads raw user text — invariants #5, #6.
 * - Failure surface is a closed string union (`transport_error` /
 *   `path_missing` / `kind_unsupported` / `observer_unavailable`).
 *   The function NEVER throws — invariant #15. Artifact tracking is
 *   observability, not gating; tool emit-site failure must not
 *   downgrade the calling commitment turn.
 *
 * Each emit-site (pdf-tool, docx-tool, image-generate-tool,
 * apply-patch via agent-command) imports this helper and calls it
 * after a successful tool execution. The helper is intentionally
 * synchronous — observers are in-memory, no I/O is required to record
 * a fact about an already-saved artifact (the `fs.existsSync` check is
 * the only filesystem touch and is sync by design).
 */

import { existsSync } from "node:fs";

import {
  type ArtifactWorldStateCollector,
  type ArtifactTurnKey,
} from "../../../platform/commitment/artifact-world-state-observer.js";
import type { SessionId } from "../../../platform/commitment/ids.js";
import type { ExpectedDelta } from "../../../platform/commitment/expected-delta.js";
import type { ArtifactRecord } from "../../../platform/commitment/world-state.js";

const SUPPORTED_KINDS: ReadonlySet<ArtifactRecord["kind"]> = new Set([
  "pdf",
  "docx",
  "code_patch",
  "image",
]);

let monotonicCounter = 0;

function nextArtifactId(kind: ArtifactRecord["kind"]): string {
  monotonicCounter += 1;
  // Combine timestamp + monotonic counter so two emits in the same
  // millisecond still produce distinct ids; format mirrors the
  // delivery-receipt-registry pattern (`<kind>:<sessionId>:<turnId>:...`).
  return `artifact:${kind}:${Date.now()}:${monotonicCounter}`;
}

export interface RecordArtifactInput {
  /**
   * Append-only collector backing `WorldStateSnapshot.artifacts`. In
   * production this is `getProcessArtifactWorldStateCollector()`
   * (the singleton wired into `createDefaultMonitoredRuntime` in
   * Phase 3); tests inject a deterministic instance.
   */
  readonly collector: ArtifactWorldStateCollector;
  readonly sessionId: SessionId;
  readonly turnId: string;
  readonly kind: ArtifactRecord["kind"];
  readonly path: string;
  readonly mimeType: string;
  readonly sourcePaths?: readonly string[];
  readonly sizeBytes?: number;
  /**
   * When omitted, the adapter mints a deterministic-ish id of the
   * form `artifact:<kind>:<timestamp>:<counter>`. Production callers
   * may forward the producer-side id (e.g. the `media/store.ts` saved
   * filename) to keep traces JOIN-able.
   */
  readonly artifactId?: string;
  /**
   * Optional sink for the `[artifact-runtime-adapter]` telemetry
   * line. Defaults to a no-op so tests do not pollute stdout;
   * production wiring (Phase 5+ caller in `attempt.ts` or in each
   * tool emit-site) injects the gateway logger.
   */
  readonly logger?: (line: string) => void;
}

export type RecordArtifactFailureReason =
  | "transport_error"
  | "path_missing"
  | "kind_unsupported"
  | "observer_unavailable";

export type RecordArtifactResult =
  | {
      readonly ok: true;
      readonly artifactId: string;
      readonly expectedDelta: ExpectedDelta;
    }
  | {
      readonly ok: false;
      readonly reason: RecordArtifactFailureReason;
      readonly detail?: string;
    };

/**
 * Records an artifact emit on the active turn. Returns a typed result
 * — never throws.
 *
 * The closed failure set is exhaustive:
 * - `observer_unavailable` — collector dependency missing (defensive
 *   guard for production wiring before the singleton is initialized);
 * - `kind_unsupported` — kind outside the closed enum
 *   `pdf | docx | code_patch | image`;
 * - `path_missing` — path does not exist on disk at the time of
 *   record (the tool must save the file before emitting);
 * - `transport_error` — collector throws (Zod schema rejection on
 *   malformed mimeType, etc.).
 *
 * The `expectedDelta` returned on success carries
 * `artifacts.added: [artifactId]`. Callers MERGE this into the
 * commitment-runtime `expectedDelta` before invoking
 * `monitoredRuntime.run(...)` so the Phase 4 done-predicates resolve
 * the artifactId.
 */
export function recordArtifactCreated(
  input: RecordArtifactInput,
): RecordArtifactResult {
  if (!input.collector || typeof input.collector.record !== "function") {
    return { ok: false, reason: "observer_unavailable" };
  }

  if (!SUPPORTED_KINDS.has(input.kind as ArtifactRecord["kind"])) {
    return { ok: false, reason: "kind_unsupported", detail: String(input.kind) };
  }

  if (typeof input.path !== "string" || input.path.length === 0) {
    return { ok: false, reason: "path_missing" };
  }
  try {
    if (!existsSync(input.path)) {
      return { ok: false, reason: "path_missing" };
    }
  } catch (err) {
    return {
      ok: false,
      reason: "path_missing",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const artifactId = input.artifactId ?? nextArtifactId(input.kind);
  const producedAt = new Date().toISOString();

  const record: ArtifactRecord = {
    artifactId,
    kind: input.kind,
    path: input.path,
    mimeType: input.mimeType,
    ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
    ...(input.sourcePaths && input.sourcePaths.length > 0
      ? { sourcePaths: Object.freeze([...input.sourcePaths]) }
      : {}),
    producedAt: producedAt as ArtifactRecord["producedAt"],
  };

  const turnKey: ArtifactTurnKey = {
    sessionId: input.sessionId,
    turnId: input.turnId,
  };

  try {
    input.collector.record(record, turnKey);
  } catch (err) {
    return {
      ok: false,
      reason: "transport_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  input.logger?.(
    `[artifact-runtime-adapter] recordArtifactCreated kind=${input.kind} path=${input.path} sessionId=${input.sessionId} turnId=${input.turnId} artifactId=${artifactId}`,
  );

  const expectedDelta: ExpectedDelta = {
    artifacts: { added: Object.freeze([artifactId]) },
  };

  return { ok: true, artifactId, expectedDelta };
}
