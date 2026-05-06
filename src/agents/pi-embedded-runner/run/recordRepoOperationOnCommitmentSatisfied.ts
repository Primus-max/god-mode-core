/**
 * Cutover-4 Phase 5 — commitment-runtime repo-operation hook.
 *
 * Sibling of slice E PR-#169 (`memory-write-on-satisfied.ts`), slice F
 * PR-#185 (`task-write-on-satisfied.ts`), and Cutover-3 PR-#198
 * (`recordArtifactOnCommitmentSatisfied.ts`). Pure function invoked
 * from the pi-embedded-runner orchestration path AFTER a
 * `RuntimeAttestation` surfaces with `commitmentSatisfied === true`
 * AND the wiring layer supplied a structured `RepoWriteInput` carrying
 * the repo-operation descriptor produced by the gated `repo-tool.ts`.
 *
 * Behavior — lights the slice E `EpisodicEffectFamily: "repo"` slot
 * for the FIRST time on `dev`:
 *   - emits `EpisodicMemoryEvent { effectFamily: "repo", payload:
 *     RepoOperationCompletedPayload }` keyed on `IdentityId`;
 *   - returns a typed `Outcome` (`written` / `skipped` / `failed`);
 *   - failure isolation: store throw is `warn`-logged and SWALLOWED —
 *     the calling commitment turn STILL satisfies (slice E + slice F
 *     + Cutover-3 precedent for defense-in-depth, invariant #15).
 *
 * Boundary discipline:
 * - Lives in `src/agents/pi-embedded-runner/run/`, NOT in
 *   `src/platform/commitment/` — invariant #8.
 * - Reads `CommitmentSatisfiedAttestationLike` (re-exported from the
 *   slice E hook) — no NEW runtime import from
 *   `src/platform/commitment/` source.
 * - Accepts `IdentityId` brand + structured `RepoWriteInput` only —
 *   never `RawUserTurn` / `UserPrompt` (invariants #5, #6).
 * - Self-filters on `commitmentSatisfied`, identity, store presence,
 *   `effectFamily === "repo"`, and `repoInput` presence — wiring
 *   callers can dispatch unconditionally and rely on the typed skip
 *   reasons.
 */

import type { RepoOperationCompletedPayload } from "../../../platform/memory/episodic-memory-event.js";
import type { IdentityId } from "../../../platform/identity/identity-id.js";
import type { MemoryEntryId } from "../../../platform/memory/memory-entry-id.js";
import type { MemoryStore } from "../../../platform/memory/memory-store.js";

import type { CommitmentSatisfiedAttestationLike } from "./memory-write-on-satisfied.js";

/**
 * Structural repo-operation descriptor the wiring layer hands to the
 * hook. Mirrors the input shape of the runtime adapter
 * (`repo-runtime-adapter.ts`) but trimmed to the fields the episodic
 * event carries: `repoOperationId`, `kind`, `branchName?`,
 * `commitSha?`, `occurredAt`. Optional `effectId` carries the upstream
 * effect identifier (e.g. `repo.commit_landed`) so the cross-reference
 * between the WorldState slice record and the episodic event is closed.
 */
export type RepoWriteInput = {
  readonly repoOperationId: string;
  readonly kind: RepoOperationCompletedPayload["kind"];
  readonly branchName?: string;
  readonly commitSha?: string;
  readonly occurredAt: string;
  /**
   * Optional upstream `EffectId` (e.g. `repo.branch_created` /
   * `repo.commit_landed`). When omitted the hook synthesises
   * `repo:<repoOperationId>:completed` so episodic ids stay unique.
   */
  readonly effectId?: string;
};

export type RepoWriteOnSatisfiedLogger = {
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
};

export type RepoWriteOnSatisfiedDeps = {
  readonly attestation: CommitmentSatisfiedAttestationLike;
  readonly identityId: IdentityId | undefined;
  readonly memoryStore: MemoryStore | undefined;
  readonly repoInput: RepoWriteInput | undefined;
  /**
   * Optional `effectFamily` of the satisfying commitment. The hook
   * dispatches ONLY when this value is `"repo"` so cross-family
   * commitment turns (e.g. `persistent_session`, `web_research`,
   * `task`, `communication`, `artifact`) are no-ops at this seam —
   * they keep their own family-specific hooks in the fan-out.
   *
   * When omitted, the hook treats the family as inert and returns
   * `{ kind: "skipped", reason: "effect_family_mismatch" }`.
   */
  readonly effectFamily: string | undefined;
  readonly logger: RepoWriteOnSatisfiedLogger;
};

export type RepoWriteSkipReason =
  | "commitment_unsatisfied"
  | "identity_unresolved"
  | "memory_store_unavailable"
  | "repo_input_unavailable"
  | "effect_family_mismatch";

export type RepoWriteOutcome =
  | { readonly kind: "written"; readonly entryId: MemoryEntryId }
  | { readonly kind: "skipped"; readonly reason: RepoWriteSkipReason }
  | {
      readonly kind: "failed";
      readonly reason: "memory_write_error";
      readonly error: Error;
    };

/**
 * Records a `repo.completed` episodic event on a satisfied commitment
 * whose `effectFamily` is `"repo"`. Behaviour matches the slice E /
 * slice F / Cutover-3 hook contract:
 *
 * 1. If `attestation.commitmentSatisfied !== true`, return
 *    `{ kind: "skipped", reason: "commitment_unsatisfied" }`.
 * 2. If `effectFamily !== "repo"` (or undefined), return
 *    `{ kind: "skipped", reason: "effect_family_mismatch" }`.
 * 3. If no `IdentityId` was resolved (anonymous session), return
 *    `{ kind: "skipped", reason: "identity_unresolved" }`.
 * 4. If no `MemoryStore` was injected, return
 *    `{ kind: "skipped", reason: "memory_store_unavailable" }`.
 * 5. If the wiring layer declined to supply a `RepoWriteInput`, return
 *    `{ kind: "skipped", reason: "repo_input_unavailable" }`.
 * 6. Otherwise, attempt
 *    `memoryStore.storeEpisodic({ effectFamily: "repo", ... })` and:
 *      - on success, return `{ kind: "written", entryId }`;
 *      - on failure, log `warn` and return
 *        `{ kind: "failed", reason: "memory_write_error", error }`.
 *        NEVER re-throws (invariant #15) — the calling commitment turn
 *        must stay satisfied even if the repo-write side flapped.
 */
export async function recordRepoOperationOnCommitmentSatisfied(
  deps: RepoWriteOnSatisfiedDeps,
): Promise<RepoWriteOutcome> {
  const {
    attestation,
    identityId,
    memoryStore,
    repoInput,
    effectFamily,
    logger,
  } = deps;

  if (attestation.commitmentSatisfied !== true) {
    logger.debug("record-repo-on-satisfied skipped (commitment_unsatisfied)", {
      terminalState: attestation.terminalState,
      acceptanceReason: attestation.acceptanceReason,
    });
    return { kind: "skipped", reason: "commitment_unsatisfied" };
  }

  if (effectFamily !== "repo") {
    logger.debug("record-repo-on-satisfied skipped (effect_family_mismatch)", {
      effectFamily: effectFamily ?? "(undefined)",
    });
    return { kind: "skipped", reason: "effect_family_mismatch" };
  }

  if (identityId === undefined) {
    logger.debug("record-repo-on-satisfied skipped (identity_unresolved)");
    return { kind: "skipped", reason: "identity_unresolved" };
  }

  if (memoryStore === undefined) {
    logger.debug("record-repo-on-satisfied skipped (memory_store_unavailable)");
    return { kind: "skipped", reason: "memory_store_unavailable" };
  }

  if (repoInput === undefined) {
    logger.debug("record-repo-on-satisfied skipped (repo_input_unavailable)");
    return { kind: "skipped", reason: "repo_input_unavailable" };
  }

  const payload: RepoOperationCompletedPayload = {
    repoOperationId: repoInput.repoOperationId,
    kind: repoInput.kind,
    ...(repoInput.branchName !== undefined ? { branchName: repoInput.branchName } : {}),
    ...(repoInput.commitSha !== undefined ? { commitSha: repoInput.commitSha } : {}),
    occurredAt: repoInput.occurredAt,
  };
  const effectId =
    repoInput.effectId ?? `repo:${repoInput.repoOperationId}:completed`;

  try {
    const entryId = await memoryStore.storeEpisodic({
      identityId,
      effectFamily: "repo",
      effectId,
      payload,
    });
    logger.debug("record-repo-on-satisfied wrote repo operation", {
      identityId,
      effectId,
      repoOperationId: repoInput.repoOperationId,
      kind: repoInput.kind,
      entryId,
    });
    return { kind: "written", entryId };
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    logger.warn(
      "record-repo-on-satisfied: failed to persist repo entry (commitment still satisfies)",
      {
        identityId,
        effectId,
        repoOperationId: repoInput.repoOperationId,
        kind: repoInput.kind,
        error: wrapped.message,
      },
    );
    return { kind: "failed", reason: "memory_write_error", error: wrapped };
  }
}
