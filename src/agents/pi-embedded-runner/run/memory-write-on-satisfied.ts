/**
 * Slice E Phase 5 — commitment-runtime memory hook.
 *
 * Pure function `recordMemoryOnCommitmentSatisfied` invoked from the
 * pi-embedded-runner orchestration path AFTER a `RuntimeAttestation`
 * surfaces with `commitmentSatisfied === true`. Writes one episodic
 * event per call into the injected `MemoryStore`.
 *
 * Boundary discipline:
 * - The hook FILE lives in `src/agents/pi-embedded-runner/run/`, NOT
 *   in `src/platform/commitment/` — invariant #8.
 * - The hook reads the attestation via a STRUCTURAL type
 *   (`CommitmentSatisfiedAttestationLike`) — no runtime import from
 *   `src/platform/commitment/` source. Any production
 *   `RuntimeAttestation` is structurally assignable; tests can pass a
 *   minimal literal.
 * - The hook accepts the `IdentityId` brand and a typed
 *   `EpisodicEventInput` (the slice-E `EpisodicMemoryEvent` minus its
 *   redundant `identityId` field — bound here at write time). It
 *   never reads raw user text — invariants #5, #6.
 * - The hook is observability, not gating. Every failure path
 *   (missing dep, store throw, unknown family) returns a typed
 *   `Outcome` instead of throwing — invariant #15. The calling
 *   commitment turn is unaffected.
 *
 * Future families (`subagent.created`, `reminder.set`,
 * `artifact.created`) flow through a `switch (effectFamily)` whose
 * non-`persistent_session` arms are inert no-ops today. Slices F / G
 * / J / K can light those arms by emitting their event type at the
 * call site WITHOUT amending this file's surface (the discriminated
 * union enforces exhaustiveness via
 * `assertNeverEpisodicEventInput`).
 */

import type { IdentityId } from "../../../platform/identity/identity-id.js";
import type {
  ArtifactCreatedPayload,
  EpisodicEffectFamily,
  PersistentSessionCreatedPayload,
  ReminderSetPayload,
  SubagentCreatedPayload,
} from "../../../platform/memory/episodic-memory-event.js";
import type { MemoryEntryId } from "../../../platform/memory/memory-entry-id.js";
import type { MemoryStore } from "../../../platform/memory/memory-store.js";

/**
 * Structural shape the hook reads off a `RuntimeAttestation`. Defined
 * here (not imported from `src/platform/commitment/`) to honour the
 * invariant-#8 rule that `pi-embedded-runner/run/` does not introduce
 * a NEW runtime import into the frozen commitment module. Any
 * production `RuntimeAttestation` value is structurally assignable to
 * this type (TypeScript structural-typing).
 *
 * Only `commitmentSatisfied` is consumed for the dispatch decision.
 * `terminalState` and `acceptanceReason` are kept on the type so test
 * callers can build a realistic literal that matches the production
 * shape without coercion.
 */
export type CommitmentSatisfiedAttestationLike = {
  readonly commitmentSatisfied: boolean;
  readonly terminalState: string;
  readonly acceptanceReason: string;
};

/**
 * Episodic event payload as supplied by the call site. The full
 * `EpisodicMemoryEvent` shape carries the `identityId` field; the
 * caller of this hook MAY have an `IdentityId` or NOT (anonymous
 * session). Splitting the identity off this input lets the hook bind
 * it at write time only after the resolution check passes — anonymous
 * turns short-circuit cleanly without ever building a malformed
 * event.
 */
export type EpisodicEventInput =
  | {
      readonly effectFamily: "persistent_session";
      readonly effectId: string;
      readonly payload: PersistentSessionCreatedPayload;
    }
  | {
      readonly effectFamily: "subagent";
      readonly effectId: string;
      readonly payload: SubagentCreatedPayload;
    }
  | {
      readonly effectFamily: "reminder";
      readonly effectId: string;
      readonly payload: ReminderSetPayload;
    }
  | {
      readonly effectFamily: "artifact";
      readonly effectId: string;
      readonly payload: ArtifactCreatedPayload;
    };

/**
 * Logger surface used by the hook. Intentionally minimal — only the
 * two levels relevant to "memory layer is observability, not
 * gating". `warn` fires on backend failure (sqlite I/O, vec0 absent
 * in fallback mode, etc.); `debug` fires on every dispatch decision
 * so traces line up with the rest of the commitment-runtime log.
 */
export type MemoryWriteOnSatisfiedLogger = {
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
};

export type MemoryWriteOnSatisfiedDeps = {
  readonly attestation: CommitmentSatisfiedAttestationLike;
  readonly identityId: IdentityId | undefined;
  readonly memoryStore: MemoryStore | undefined;
  readonly episodicEvent: EpisodicEventInput | undefined;
  readonly logger: MemoryWriteOnSatisfiedLogger;
};

/**
 * Reasons the hook may decline to write. Closed string union so
 * downstream telemetry can classify without parsing free text.
 */
export type MemoryWriteSkipReason =
  | "commitment_unsatisfied"
  | "identity_unresolved"
  | "memory_store_unavailable"
  | "episodic_event_unavailable"
  | "effect_family_inert";

export type MemoryWriteOutcome =
  | { readonly kind: "written"; readonly entryId: MemoryEntryId }
  | { readonly kind: "skipped"; readonly reason: MemoryWriteSkipReason }
  | {
      readonly kind: "failed";
      readonly reason: "memory_write_error";
      readonly error: Error;
    };

/**
 * Record an episodic memory entry on a satisfied commitment. The
 * hook is intentionally narrow:
 *
 * 1. If the attestation rejects the commitment, return
 *    `{ kind: 'skipped', reason: 'commitment_unsatisfied' }`.
 * 2. If no `IdentityId` was resolved, return
 *    `{ kind: 'skipped', reason: 'identity_unresolved' }` — anonymous
 *    sessions never write memory (B1 closure stays scoped to known
 *    operators per slice D).
 * 3. If no `MemoryStore` was injected, return
 *    `{ kind: 'skipped', reason: 'memory_store_unavailable' }`. This
 *    is the path the production wiring takes today: until slices
 *    F / G / J / K supply a concrete store, the hook is wired but
 *    inert.
 * 4. If the call site declined to supply an `EpisodicEventInput`,
 *    return `{ kind: 'skipped', reason: 'episodic_event_unavailable' }`.
 * 5. For non-`persistent_session` families, return
 *    `{ kind: 'skipped', reason: 'effect_family_inert' }` — the slot
 *    is reserved for slice F / G / J / K to wire their emit sites.
 * 6. On `persistent_session`, attempt
 *    `memoryStore.storeEpisodic(...)` and:
 *      - on success, return `{ kind: 'written', entryId }`;
 *      - on failure, log warn with the error message AND return
 *        `{ kind: 'failed', error }` — never re-throw. The calling
 *        commitment turn MUST NOT be downgraded by a memory outage
 *        (invariant #15).
 *
 * The function is async because `storeEpisodic` returns a Promise.
 * All non-write branches resolve synchronously after one microtask.
 */
export async function recordMemoryOnCommitmentSatisfied(
  deps: MemoryWriteOnSatisfiedDeps,
): Promise<MemoryWriteOutcome> {
  const { attestation, identityId, memoryStore, episodicEvent, logger } = deps;

  if (attestation.commitmentSatisfied !== true) {
    logger.debug("memory-write-on-satisfied skipped (commitment_unsatisfied)", {
      terminalState: attestation.terminalState,
      acceptanceReason: attestation.acceptanceReason,
    });
    return { kind: "skipped", reason: "commitment_unsatisfied" };
  }

  if (identityId === undefined) {
    logger.debug("memory-write-on-satisfied skipped (identity_unresolved)");
    return { kind: "skipped", reason: "identity_unresolved" };
  }

  if (memoryStore === undefined) {
    logger.debug("memory-write-on-satisfied skipped (memory_store_unavailable)");
    return { kind: "skipped", reason: "memory_store_unavailable" };
  }

  if (episodicEvent === undefined) {
    logger.debug("memory-write-on-satisfied skipped (episodic_event_unavailable)");
    return { kind: "skipped", reason: "episodic_event_unavailable" };
  }

  switch (episodicEvent.effectFamily) {
    case "persistent_session": {
      try {
        const entryId = await memoryStore.storeEpisodic({
          identityId,
          effectFamily: "persistent_session",
          effectId: episodicEvent.effectId,
          payload: episodicEvent.payload,
        });
        logger.debug("memory-write-on-satisfied wrote persistent_session", {
          identityId,
          effectId: episodicEvent.effectId,
          entryId,
        });
        return { kind: "written", entryId };
      } catch (error) {
        const wrapped =
          error instanceof Error ? error : new Error(String(error));
        logger.warn(
          "memory-write-on-satisfied failed to persist persistent_session entry",
          {
            identityId,
            effectId: episodicEvent.effectId,
            error: wrapped.message,
          },
        );
        return { kind: "failed", reason: "memory_write_error", error: wrapped };
      }
    }
    case "subagent":
    case "reminder":
    case "artifact": {
      // Slice E ships ONLY `persistent_session.created` as a
      // payload-emitting event. The other typed variants exist so the
      // discriminated union compiles end-to-end and slices F / G / J /
      // K can light their emit sites WITHOUT modifying this hook's
      // surface — they just start passing the matching
      // `episodicEvent.effectFamily` from the call site.
      logger.debug("memory-write-on-satisfied skipped (effect_family_inert)", {
        effectFamily: episodicEvent.effectFamily,
      });
      return { kind: "skipped", reason: "effect_family_inert" };
    }
    default:
      // Force a TypeScript exhaustiveness check: adding a new
      // `EpisodicEffectFamily` variant elsewhere will fail to compile
      // here until this switch is updated. The runtime branch is
      // unreachable when types are honoured but defends the hook
      // against an unsanctioned cast at the call site.
      return assertNeverEpisodicEventInput(episodicEvent);
  }
}

/**
 * Exhaustiveness helper — see `assertNeverEpisodic` in
 * `src/platform/memory/episodic-memory-event.ts`. Local copy here so
 * the hook does not need to import from the platform memory module's
 * runtime exports just to enforce the switch (this file already
 * imports the *types* it needs).
 */
function assertNeverEpisodicEventInput(value: never): never {
  // Do NOT throw an exception here that callers might mask — this is
  // a compile-time guard. If the runtime ever reaches this branch,
  // surface a hard error so the bug is loud during development.
  throw new Error(
    `recordMemoryOnCommitmentSatisfied: unhandled effectFamily ${
      JSON.stringify(value)
    }`,
  );
}

// Re-export the discriminator type for callers that build the input
// programmatically (e.g. slice F's reminder emit site can switch on
// the union in a typed way without re-importing from
// `platform/memory`).
export type { EpisodicEffectFamily };
