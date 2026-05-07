/**
 * Cron/Scheduler Phase 5 — commitment-runtime reminder hook.
 *
 * Sibling of slice E (`memory-write-on-satisfied.ts`), slice F
 * (`task-write-on-satisfied.ts`), Cutover-3
 * (`recordArtifactOnCommitmentSatisfied.ts`), and Cutover-4
 * (`recordRepoOperationOnCommitmentSatisfied.ts`). Pure function
 * invoked from the `memory-wiring.ts` fan-out AFTER a `RuntimeAttestation`
 * surfaces with `commitmentSatisfied === true` AND the wiring layer
 * supplied a structured `ReminderWriteInput` carrying the descriptor
 * produced by the gated `record-reminder-tool.ts`.
 *
 * Behavior — lights the slice E `EpisodicEffectFamily: "reminder"` slot
 * for the FIRST time on `dev`:
 *   - emits `EpisodicMemoryEvent { effectFamily: "reminder", payload:
 *     ReminderSetPayload }` keyed on `IdentityId`;
 *   - returns a typed `Outcome` (`written` / `skipped` / `failed`);
 *   - failure isolation: store throw is `warn`-logged and SWALLOWED —
 *     calling commitment turn STILL satisfies (slice E + slice F +
 *     Cutover-3 + Cutover-4 precedent for defense-in-depth, invariant
 *     #15).
 *
 * Boundary discipline:
 * - Lives in `src/agents/pi-embedded-runner/run/`, NOT in
 *   `src/platform/commitment/` — invariant #8.
 * - Reads `CommitmentSatisfiedAttestationLike` (re-exported from the
 *   slice E hook) — no NEW runtime import from
 *   `src/platform/commitment/` source.
 * - Accepts `IdentityId` brand + structured `ReminderWriteInput` only —
 *   never `RawUserTurn` / `UserPrompt` (invariants #5, #6).
 * - Self-filters on `commitmentSatisfied`, identity, store presence,
 *   `effectFamily === "reminder"`, and `reminderInput` presence — wiring
 *   callers can dispatch unconditionally and rely on the typed skip
 *   reasons.
 */

import type { ReminderSetPayload } from "../../../platform/memory/episodic-memory-event.js";
import type { IdentityId } from "../../../platform/identity/identity-id.js";
import type { MemoryEntryId } from "../../../platform/memory/memory-entry-id.js";
import type { MemoryStore } from "../../../platform/memory/memory-store.js";

import type { CommitmentSatisfiedAttestationLike } from "./memory-write-on-satisfied.js";

/**
 * Structural reminder descriptor the wiring layer hands to the hook.
 * Mirrors the persisted `ScheduledReminderRecord` shape but trimmed to
 * the fields the episodic event carries (`reminderId`, `fireAt`,
 * `occurredAt`). Optional `effectId` carries the upstream effect
 * identifier (`reminder.set`) so the cross-reference between the
 * `WorldState.scheduledReminders` slice record and the episodic event
 * is closed.
 */
export type ReminderWriteInput = {
  readonly reminderId: string;
  readonly fireAt: string;
  readonly occurredAt: string;
  /**
   * Optional upstream `EffectId` (`reminder.set`). When omitted the
   * hook falls back to the canonical `reminder.set` literal so the
   * episodic event always carries the same effect identifier that
   * Phase 4's done-predicate references.
   */
  readonly effectId?: string;
};

export type ReminderWriteOnSatisfiedLogger = {
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
};

export type ReminderWriteOnSatisfiedDeps = {
  readonly attestation: CommitmentSatisfiedAttestationLike;
  readonly identityId: IdentityId | undefined;
  readonly memoryStore: MemoryStore | undefined;
  readonly reminderInput: ReminderWriteInput | undefined;
  /**
   * Optional `effectFamily` of the satisfying commitment. The hook
   * dispatches ONLY when this value is `"reminder"` so cross-family
   * commitment turns (`persistent_session`, `web_research`, `task`,
   * `communication`, `artifact`, `repo`) are no-ops at this seam — they
   * keep their own family-specific hooks in the fan-out.
   *
   * When omitted, the hook treats the family as inert and returns
   * `{ kind: "skipped", reason: "effect_family_mismatch" }`.
   */
  readonly effectFamily: string | undefined;
  readonly logger: ReminderWriteOnSatisfiedLogger;
};

export type ReminderWriteSkipReason =
  | "commitment_unsatisfied"
  | "identity_unresolved"
  | "memory_store_unavailable"
  | "reminder_input_unavailable"
  | "effect_family_mismatch";

export type ReminderWriteOutcome =
  | { readonly kind: "written"; readonly entryId: MemoryEntryId }
  | { readonly kind: "skipped"; readonly reason: ReminderWriteSkipReason }
  | {
      readonly kind: "failed";
      readonly reason: "memory_write_error";
      readonly error: Error;
    };

/**
 * Records a `reminder.set` episodic event on a satisfied commitment
 * whose `effectFamily` is `"reminder"`. Behaviour matches the slice E /
 * slice F / Cutover-3 / Cutover-4 hook contract:
 *
 * 1. If `attestation.commitmentSatisfied !== true`, return
 *    `{ kind: "skipped", reason: "commitment_unsatisfied" }`.
 * 2. If `effectFamily !== "reminder"` (or undefined), return
 *    `{ kind: "skipped", reason: "effect_family_mismatch" }`.
 * 3. If no `IdentityId` was resolved (anonymous session), return
 *    `{ kind: "skipped", reason: "identity_unresolved" }`.
 * 4. If no `MemoryStore` was injected, return
 *    `{ kind: "skipped", reason: "memory_store_unavailable" }`.
 * 5. If the wiring layer declined to supply a `ReminderWriteInput`,
 *    return `{ kind: "skipped", reason: "reminder_input_unavailable" }`.
 * 6. Otherwise, attempt
 *    `memoryStore.storeEpisodic({ effectFamily: "reminder", ... })` and:
 *      - on success, return `{ kind: "written", entryId }`;
 *      - on failure, log `warn` and return
 *        `{ kind: "failed", reason: "memory_write_error", error }`.
 *        NEVER re-throws (invariant #15) — calling commitment turn must
 *        stay satisfied even if the reminder-write side flapped.
 */
export async function recordReminderOnCommitmentSatisfied(
  deps: ReminderWriteOnSatisfiedDeps,
): Promise<ReminderWriteOutcome> {
  const {
    attestation,
    identityId,
    memoryStore,
    reminderInput,
    effectFamily,
    logger,
  } = deps;

  if (attestation.commitmentSatisfied !== true) {
    logger.debug("record-reminder-on-satisfied skipped (commitment_unsatisfied)", {
      terminalState: attestation.terminalState,
      acceptanceReason: attestation.acceptanceReason,
    });
    return { kind: "skipped", reason: "commitment_unsatisfied" };
  }

  if (effectFamily !== "reminder") {
    logger.debug("record-reminder-on-satisfied skipped (effect_family_mismatch)", {
      effectFamily: effectFamily ?? "(undefined)",
    });
    return { kind: "skipped", reason: "effect_family_mismatch" };
  }

  if (identityId === undefined) {
    logger.debug("record-reminder-on-satisfied skipped (identity_unresolved)");
    return { kind: "skipped", reason: "identity_unresolved" };
  }

  if (memoryStore === undefined) {
    logger.debug("record-reminder-on-satisfied skipped (memory_store_unavailable)");
    return { kind: "skipped", reason: "memory_store_unavailable" };
  }

  if (reminderInput === undefined) {
    logger.debug("record-reminder-on-satisfied skipped (reminder_input_unavailable)");
    return { kind: "skipped", reason: "reminder_input_unavailable" };
  }

  const payload: ReminderSetPayload = {
    reminderId: reminderInput.reminderId,
    fireAt: reminderInput.fireAt,
    occurredAt: reminderInput.occurredAt,
  };
  const effectId = reminderInput.effectId ?? "reminder.set";

  try {
    const entryId = await memoryStore.storeEpisodic({
      identityId,
      effectFamily: "reminder",
      effectId,
      payload,
    });
    logger.debug("record-reminder-on-satisfied wrote reminder entry", {
      identityId,
      effectId,
      reminderId: reminderInput.reminderId,
      fireAt: reminderInput.fireAt,
      entryId,
    });
    return { kind: "written", entryId };
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    logger.warn(
      "record-reminder-on-satisfied: failed to persist reminder entry (commitment still satisfies)",
      {
        identityId,
        effectId,
        reminderId: reminderInput.reminderId,
        fireAt: reminderInput.fireAt,
        error: wrapped.message,
      },
    );
    return { kind: "failed", reason: "memory_write_error", error: wrapped };
  }
}
