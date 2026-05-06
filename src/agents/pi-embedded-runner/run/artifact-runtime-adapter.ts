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
import type { InboundImageReferencePreconditionValue } from "../../../platform/commitment/inbound-image-reference-precondition-resolver.js";

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

// ─── Cutover-3 Phase 6 — img2img structural pre-binding ────────────────
//
// Bug #2 closure (audit §c). The `image_generate` tool already accepts
// `image` / `images` schema params (`image-generate-tool.ts:118-128`)
// and the provider transport already wires `inputImages` through to
// Hydra `/v1/images/edits` (`runtime.ts:169`); the bug is the missing
// structural pre-binding seam between an inbound TG attachment and the
// tool args. `injectInboundImageReferenceIntoToolArgs` closes that
// seam by surfacing the resolved `INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION`
// value (a closed `{ paths }` shape from
// `inbound-image-reference-precondition-resolver.ts`) into the tool
// args BEFORE the model formulates its call — same structural pre-
// binding posture Search-Composer 4b PR-#131 used for `<web_evidence>`.
//
// Per invariants #5/#6 the input is STRUCTURED only — paths + tool
// name. No raw user text crosses this seam.

/**
 * Subset of the `image_generate` tool args this helper touches. The
 * tool schema (`image-generate-tool.ts:118-128`) declares both
 * `image: string` (single ref) and `images: string[]` (multi-ref). The
 * helper writes ONE of the two depending on the precondition arity and
 * never both — keeping the provider call unambiguous.
 */
export interface ImageGenerateToolArgs {
  prompt?: string;
  image?: string;
  images?: readonly string[];
  // Allow additional caller-supplied args to flow through unchanged.
  readonly [key: string]: unknown;
}

export interface InjectInboundImageReferenceInput {
  /**
   * The tool name the runner is about to invoke. Only `image_generate`
   * receives the injection — other tools are returned unchanged.
   */
  readonly toolName: string;
  /**
   * The args object the runner will pass to the tool. Treated as
   * READ-ONLY by this helper; the returned `toolArgs` is a NEW object.
   */
  readonly toolArgs: ImageGenerateToolArgs;
  /**
   * The resolved value of `INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION`,
   * or `null` when no inbound image attachment is present this turn
   * (the from-scratch generation branch is preserved verbatim).
   */
  readonly preconditionValue: InboundImageReferencePreconditionValue | null;
  /**
   * Optional sink for the `[image-generate] inputImages count=N
   * referenceMode=img2img` telemetry line. Production wiring routes
   * through `defaultRuntime.log`; tests inject a `vi.fn()` capture.
   */
  readonly logger?: (line: string) => void;
}

export interface InjectInboundImageReferenceResult {
  /**
   * `true` when the helper rewrote `toolArgs` with `image:` (single
   * ref) or `images:` (multi-ref); `false` when the call was a no-op
   * (non-`image_generate` tool, null precondition, or empty paths).
   */
  readonly injected: boolean;
  /**
   * The (possibly rewritten) tool args object. Always a NEW reference
   * — the caller-supplied object is NEVER mutated.
   */
  readonly toolArgs: ImageGenerateToolArgs;
}

/**
 * Structural pre-binding of inbound image references onto the
 * `image_generate` tool args. When the tool is `image_generate` AND the
 * precondition resolves with at least one path, injects:
 *   - `image: paths[0]` for single-ref (one inbound image),
 *   - `images: paths` for multi-ref (two or more).
 *
 * Returns a NEW args object — caller-supplied args stay untouched.
 * Logs `[image-generate] inputImages count=N referenceMode=img2img` on
 * injection so the live-verifier gateway log signal is present
 * regardless of which provider transport actually invokes Hydra.
 *
 * @param input - Tool name, args, resolved precondition value, optional
 *   logger.
 * @returns `{ injected, toolArgs }`.
 */
export function injectInboundImageReferenceIntoToolArgs(
  input: InjectInboundImageReferenceInput,
): InjectInboundImageReferenceResult {
  if (input.toolName !== "image_generate") {
    return { injected: false, toolArgs: { ...input.toolArgs } };
  }
  const value = input.preconditionValue;
  if (!value || value.paths.length === 0) {
    return { injected: false, toolArgs: { ...input.toolArgs } };
  }
  const paths = value.paths;
  const next: ImageGenerateToolArgs = { ...input.toolArgs };
  if (paths.length === 1) {
    next.image = paths[0];
    // Make sure the previous value (if any) does not bleed through onto
    // the multi-ref slot — single-ref injection is exclusive.
    delete next.images;
  } else {
    next.images = Object.freeze([...paths]);
    delete next.image;
  }
  input.logger?.(
    `[image-generate] inputImages count=${String(paths.length)} referenceMode=img2img`,
  );
  return { injected: true, toolArgs: next };
}
