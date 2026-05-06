/**
 * Cutover-3 Phase 5 — commitment-runtime artifact hook.
 *
 * Sibling of slice E PR-#169 (`memory-write-on-satisfied.ts`) and slice
 * F PR-#185 (`task-write-on-satisfied.ts`). Pure function
 * `recordArtifactOnCommitmentSatisfied` invoked from the
 * pi-embedded-runner orchestration path AFTER a `RuntimeAttestation`
 * surfaces with `commitmentSatisfied === true` AND the wiring layer
 * supplied a structured `ArtifactWriteInput` carrying the artifact
 * descriptor produced by one of the four artifact-producing tools
 * (`pdf`, `docx`, `image_generate`, `apply_patch`).
 *
 * Behavior — lights the slice E `EpisodicEffectFamily: "artifact"`
 * slot for the FIRST time on `dev`:
 *   - emits `EpisodicMemoryEvent { effectFamily: "artifact", payload:
 *     ArtifactCreatedPayload }` keyed on `IdentityId`;
 *   - returns a typed `Outcome` (`written` / `skipped` / `failed`);
 *   - failure isolation: artifact-write throw is `warn`-logged and
 *     SWALLOWED — the calling commitment turn STILL satisfies (slice E
 *     + slice F precedent for defense-in-depth, invariant #15).
 *
 * Boundary discipline:
 * - Lives in `src/agents/pi-embedded-runner/run/`, NOT in
 *   `src/platform/commitment/` — invariant #8.
 * - Reads `CommitmentSatisfiedAttestationLike` (re-exported from the
 *   slice E hook) — no NEW runtime import from
 *   `src/platform/commitment/` source.
 * - Accepts `IdentityId` brand + structured `ArtifactWriteInput` only
 *   — never `RawUserTurn` / `UserPrompt` (invariants #5, #6).
 * - Self-filters on `commitmentSatisfied`, identity, store presence,
 *   and `artifactInput` presence — wiring callers can dispatch
 *   unconditionally and rely on the typed skip reasons.
 */

import type { ArtifactCreatedPayload } from "../../../platform/memory/episodic-memory-event.js";
import type { IdentityId } from "../../../platform/identity/identity-id.js";
import type { MemoryEntryId } from "../../../platform/memory/memory-entry-id.js";
import type { MemoryStore } from "../../../platform/memory/memory-store.js";

import type { CommitmentSatisfiedAttestationLike } from "./memory-write-on-satisfied.js";

/**
 * Structural artifact descriptor the wiring layer hands to the hook.
 * Mirrors the input shape of the runtime adapter
 * (`artifact-runtime-adapter.ts`) but trimmed to the fields the
 * episodic event carries: `artifactId`, `kind`, and `occurredAt`.
 * Optional `effectId` carries the upstream effect identifier (e.g.
 * `pdf.created`) so the cross-reference between the WorldState slice
 * record and the episodic event is closed.
 */
export type ArtifactWriteInput = {
  readonly artifactId: string;
  readonly kind: ArtifactCreatedPayload["kind"];
  readonly occurredAt: string;
  /**
   * Optional upstream `EffectId` (e.g. `pdf.created` /
   * `image.created`). When omitted the hook synthesises
   * `artifact:<artifactId>:created` so episodic ids stay unique.
   */
  readonly effectId?: string;
};

export type ArtifactWriteOnSatisfiedLogger = {
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
};

export type ArtifactWriteOnSatisfiedDeps = {
  readonly attestation: CommitmentSatisfiedAttestationLike;
  readonly identityId: IdentityId | undefined;
  readonly memoryStore: MemoryStore | undefined;
  readonly artifactInput: ArtifactWriteInput | undefined;
  /**
   * Optional `effectFamily` of the satisfying commitment. The hook
   * dispatches ONLY when this value is `"artifact"` so cross-family
   * commitment turns (e.g. `persistent_session`, `web_research`,
   * `task`, `communication`) are no-ops at this seam — they keep
   * their own family-specific hooks in the fan-out (memory hook for
   * persistent_session, task hook for task, etc.).
   *
   * When omitted, the hook treats the family as inert and returns
   * `{ kind: "skipped", reason: "effect_family_mismatch" }`.
   */
  readonly effectFamily: string | undefined;
  readonly logger: ArtifactWriteOnSatisfiedLogger;
};

export type ArtifactWriteSkipReason =
  | "commitment_unsatisfied"
  | "identity_unresolved"
  | "memory_store_unavailable"
  | "artifact_input_unavailable"
  | "effect_family_mismatch";

export type ArtifactWriteOutcome =
  | { readonly kind: "written"; readonly entryId: MemoryEntryId }
  | { readonly kind: "skipped"; readonly reason: ArtifactWriteSkipReason }
  | {
      readonly kind: "failed";
      readonly reason: "memory_write_error";
      readonly error: Error;
    };

/**
 * Records an `artifact.created` episodic event on a satisfied
 * commitment whose `effectFamily` is `"artifact"`. Behaviour:
 *
 * 1. If `attestation.commitmentSatisfied !== true`, return
 *    `{ kind: "skipped", reason: "commitment_unsatisfied" }`.
 * 2. If `effectFamily !== "artifact"` (or undefined), return
 *    `{ kind: "skipped", reason: "effect_family_mismatch" }`. This
 *    is the path the production wiring takes when the satisfying
 *    commitment belongs to a DIFFERENT family (memory or task hook
 *    runs in those cases via the fan-out seam).
 * 3. If no `IdentityId` was resolved (anonymous session), return
 *    `{ kind: "skipped", reason: "identity_unresolved" }` — slice D
 *    precedent (anonymous turns never write memory).
 * 4. If no `MemoryStore` was injected, return
 *    `{ kind: "skipped", reason: "memory_store_unavailable" }`.
 * 5. If the wiring layer declined to supply an `ArtifactWriteInput`,
 *    return `{ kind: "skipped", reason: "artifact_input_unavailable" }`.
 * 6. Otherwise, attempt
 *    `memoryStore.storeEpisodic({ effectFamily: "artifact", ... })`
 *    and:
 *      - on success, return `{ kind: "written", entryId }`;
 *      - on failure, log `warn` and return
 *        `{ kind: "failed", reason: "memory_write_error", error }`.
 *        NEVER re-throws (invariant #15) — the calling commitment
 *        turn must stay satisfied even if the artifact-write side
 *        flapped.
 */
export async function recordArtifactOnCommitmentSatisfied(
  deps: ArtifactWriteOnSatisfiedDeps,
): Promise<ArtifactWriteOutcome> {
  const {
    attestation,
    identityId,
    memoryStore,
    artifactInput,
    effectFamily,
    logger,
  } = deps;

  if (attestation.commitmentSatisfied !== true) {
    logger.debug("record-artifact-on-satisfied skipped (commitment_unsatisfied)", {
      terminalState: attestation.terminalState,
      acceptanceReason: attestation.acceptanceReason,
    });
    return { kind: "skipped", reason: "commitment_unsatisfied" };
  }

  if (effectFamily !== "artifact") {
    logger.debug("record-artifact-on-satisfied skipped (effect_family_mismatch)", {
      effectFamily: effectFamily ?? "(undefined)",
    });
    return { kind: "skipped", reason: "effect_family_mismatch" };
  }

  if (identityId === undefined) {
    logger.debug("record-artifact-on-satisfied skipped (identity_unresolved)");
    return { kind: "skipped", reason: "identity_unresolved" };
  }

  if (memoryStore === undefined) {
    logger.debug("record-artifact-on-satisfied skipped (memory_store_unavailable)");
    return { kind: "skipped", reason: "memory_store_unavailable" };
  }

  if (artifactInput === undefined) {
    logger.debug("record-artifact-on-satisfied skipped (artifact_input_unavailable)");
    return { kind: "skipped", reason: "artifact_input_unavailable" };
  }

  const payload: ArtifactCreatedPayload = {
    artifactId: artifactInput.artifactId,
    kind: artifactInput.kind,
    occurredAt: artifactInput.occurredAt,
  };
  const effectId =
    artifactInput.effectId ?? `artifact:${artifactInput.artifactId}:created`;

  try {
    const entryId = await memoryStore.storeEpisodic({
      identityId,
      effectFamily: "artifact",
      effectId,
      payload,
    });
    logger.debug("record-artifact-on-satisfied wrote artifact", {
      identityId,
      effectId,
      artifactId: artifactInput.artifactId,
      kind: artifactInput.kind,
      entryId,
    });
    return { kind: "written", entryId };
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    logger.warn(
      "record-artifact-on-satisfied: failed to persist artifact entry (commitment still satisfies)",
      {
        identityId,
        effectId,
        artifactId: artifactInput.artifactId,
        kind: artifactInput.kind,
        error: wrapped.message,
      },
    );
    return { kind: "failed", reason: "memory_write_error", error: wrapped };
  }
}
