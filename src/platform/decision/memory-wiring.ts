/**
 * Slice E gateway-wiring bridge — per-turn memory runtime resolver.
 *
 * Resolves `{ memoryStore, identityId, memoryLogger, onAttestation }`
 * for a single turn from:
 * - the per-process memory runtime singleton (`getMemoryRuntime`),
 * - the supplied agent session-key (resolved into an `IdentityId`),
 * - the prompt text used to populate the `persistent_session.created`
 *   episodic payload AND the parallel semantic write that powers Phase-6
 *   recall.
 *
 * When any precondition is missing (no sessionKey, anonymous session,
 * runtime resolution failure) the helper returns an empty object so
 * `runTurnDecision({ ...input, ...memoryWiring })` is byte-identical to
 * the legacy shape.
 *
 * Boundary discipline:
 * - Lives outside `src/platform/commitment/` (invariant #8).
 * - Reads structured types only — no raw `UserPrompt` / `RawUserTurn`
 *   handling (invariants #5, #6).
 * - Failures are absorbed: any throw from `getMemoryRuntime` or any
 *   memory write is caught and logged via `defaultRuntime.log`. Memory
 *   layer is observability, never gating (invariant #15).
 */

import { randomUUID } from "node:crypto";
import { commitOutboundOnCommitmentSatisfied } from "../../agents/pi-embedded-runner/run/commit-outbound-on-satisfied.js";
import { recordMemoryOnCommitmentSatisfied } from "../../agents/pi-embedded-runner/run/memory-write-on-satisfied.js";
import {
  recordArtifactOnCommitmentSatisfied,
  type ArtifactWriteInput,
} from "../../agents/pi-embedded-runner/run/recordArtifactOnCommitmentSatisfied.js";
import {
  recordTaskOnCommitmentSatisfied,
  type TaskWriteInput,
} from "../../agents/pi-embedded-runner/run/task-write-on-satisfied.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { OutboundCoalescer } from "../../infra/outbound/outbound-coalescer-types.js";
import { defaultRuntime } from "../../runtime.js";
import { getMemoryRuntime } from "../../server/memory-store-bootstrap.js";
import type { IntentContractorLogger } from "../commitment/intent-contractor-impl.js";
import type { RuntimeAttestation } from "../commitment/index.js";
import type { IdentityId } from "../identity/identity-id.js";
import { resolveIdentityFromSessionKey } from "../identity/resolve-identity.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { TaskLedger } from "../task/task-ledger.js";

export type MemoryWiringForTurn = Partial<{
  memoryStore: MemoryStore;
  identityId: IdentityId;
  memoryLogger: IntentContractorLogger;
  taskLedger: TaskLedger;
  onAttestation: (attestation: RuntimeAttestation) => Promise<void>;
}>;

export type ResolveMemoryWiringForTurnParams = {
  readonly cfg: OpenClawConfig;
  readonly sessionKey?: string;
  readonly sessionId?: string;
  readonly promptText: string;
  /**
   * Slice F Phase 5 — optional caller-side `TaskWriteInput`. When set,
   * the fanned-out `onAttestation` callback dispatches the task hook
   * alongside the memory hook with this input. When absent (the
   * default Phase-5 production wiring), the task hook is wired but
   * inert — slice J (cron) and slice G (subagent) supply this input
   * at their attestation construction sites once those slices land.
   */
  readonly taskWriteInput?: TaskWriteInput;
  /**
   * Cutover-3 Phase 5 — optional caller-side `ArtifactWriteInput`. When
   * set AND the satisfying commitment's `effectFamily === "artifact"`,
   * the fanned-out `onAttestation` callback emits a typed
   * `EpisodicMemoryEvent { effectFamily: "artifact", payload:
   * ArtifactCreatedPayload }` against the operator's `IdentityId`. This
   * is the FIRST emit site for the slice E `artifact` slot on `dev`.
   *
   * When absent (the default until artifact-producing tools light
   * their emit sites in this same phase via the runtime adapter +
   * caller plumbing), the hook is wired but inert.
   */
  readonly artifactWriteInput?: ArtifactWriteInput;
  /**
   * Cutover-3 Phase 5 — optional `effectFamily` of the satisfying
   * commitment. The artifact hook self-filters on
   * `effectFamily === "artifact"` so non-artifact families
   * (`persistent_session`, `task`, `web_research`, etc.) stay routed
   * through their own family-specific hooks at this fan-out seam.
   */
  readonly effectFamily?: string;
  /**
   * NEW-C Phase 5 — optional outbound-coalescer instance + the turnId
   * that scopes its bucket store. When supplied AND the attestation
   * reports `commitmentSatisfied === true`, the fanned-out
   * `onAttestation` callback dispatches the PRIMARY commit trigger
   * (sibling of the memory / task / artifact hooks). When absent (the
   * default decision-layer wiring path in `input.ts:580` — the
   * coalescer is constructed later, per-`runReplyAgent` invocation in
   * `agent-runner.ts`), the primary trigger is wired but inert and the
   * fallback `finalizeAfterRun` finally block at
   * `agent-runner.ts:~1792` covers the commit edge.
   *
   * The optional pairing keeps the contract surface backward-
   * compatible: callers that DO have a coalescer (e.g. the slice F P5
   * acceptance fixture, future agent-runner-side wiring) opt-in
   * additively without touching legacy decision flows.
   */
  readonly outboundCoalescer?: OutboundCoalescer;
  /**
   * NEW-C Phase 5 — turnId carried alongside `outboundCoalescer`. The
   * coalescer keys on `(turnId, channelKey)` so the primary-trigger
   * dispatch must know which turn to flush. When `outboundCoalescer`
   * is omitted, this field is ignored.
   */
  readonly outboundTurnId?: string;
};

export async function resolveMemoryWiringForTurn(
  params: ResolveMemoryWiringForTurnParams,
): Promise<MemoryWiringForTurn> {
  if (!params.sessionKey || params.sessionKey.trim().length === 0) {
    return {};
  }
  let runtime: Awaited<ReturnType<typeof getMemoryRuntime>>;
  try {
    runtime = await getMemoryRuntime(params.cfg);
  } catch (err) {
    defaultRuntime.log(
      `[memory-wiring] runtime resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
  const identityId = resolveIdentityFromSessionKey(params.sessionKey, runtime.identityRegistry);
  if (!identityId) {
    return {};
  }
  const messageId = `${params.sessionId ?? "session"}-${randomUUID().slice(0, 8)}`;
  const occurredAt = new Date().toISOString();
  return {
    memoryStore: runtime.memoryStore,
    identityId,
    memoryLogger: {
      warn: (message: string) => defaultRuntime.log(`[memory-recall] ${message}`),
    },
    taskLedger: runtime.taskLedger,
    onAttestation: async (attestation) => {
      // Slice F Phase 5 — fan-out: ONE attestation drives BOTH the
      // memory hook AND the task hook. Strategy A from
      // `extensions/AUDIT-task-ledger.md` §5: extending the existing
      // wiring helper preserves the single-callback discipline at
      // `run-turn-decision.ts:294` and avoids a second call site.
      const outcome = await recordMemoryOnCommitmentSatisfied({
        attestation,
        identityId,
        memoryStore: runtime.memoryStore,
        episodicEvent: {
          effectFamily: "persistent_session",
          effectId: messageId,
          payload: {
            messageRole: "user",
            messageText: params.promptText,
            messageId,
            occurredAt,
          },
        },
        logger: {
          warn: (message: string) => defaultRuntime.log(`[memory-write] ${message}`),
          debug: () => {
            /* trace volume — drop debug events at the production seam */
          },
        },
      });
      // The Phase-5 hook writes EPISODIC only. For the recall hook
      // (Phase 6) to surface anything on a later turn, the same prompt
      // must also land in SEMANTIC memory under the operator's identity.
      // The b1-replay acceptance fixture (`b1-replay.acceptance.test.ts`)
      // does this inline; production cron / artifact slices (J / K) will
      // own their own semantic-emit shape. For the demo path we mirror
      // the fixture: a single semantic write tagged with
      // `source: persistent_session` so recall surfaces the user's
      // most recent prompts.
      if (outcome.kind === "written") {
        try {
          await runtime.memoryStore.storeSemantic({
            identityId,
            content: params.promptText,
            metadata: { source: "persistent_session", messageId },
          });
        } catch (err) {
          defaultRuntime.log(
            `[memory-write] semantic write failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Slice F Phase 5 task hook fan-out. The hook self-filters on
      // `commitmentSatisfied`, identity, ledger presence, and
      // `taskInput` presence — so calling it here unconditionally is
      // safe (it returns `{ kind: 'skipped', ... }` when the wiring
      // does NOT carry a `TaskWriteInput`, which is the default
      // production path until slice J / G emit task lifecycle
      // attestations). The task hook NEVER throws (invariant #15);
      // the outer `try`/`catch` is defensive only.
      try {
        await recordTaskOnCommitmentSatisfied({
          attestation,
          identityId,
          taskLedger: runtime.taskLedger,
          memoryStore: runtime.memoryStore,
          taskInput: params.taskWriteInput,
          logger: {
            warn: (message: string) => defaultRuntime.log(`[task-write] ${message}`),
            debug: () => {
              /* trace volume — drop debug events at the production seam */
            },
          },
        });
      } catch (err) {
        defaultRuntime.log(
          `[task-write] fan-out failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Cutover-3 Phase 5 artifact hook fan-out. Self-filters on
      // `commitmentSatisfied`, `effectFamily === "artifact"`,
      // identity, store presence, and `artifactInput` presence — so
      // calling it here unconditionally is safe (returns
      // `{ kind: "skipped", ... }` when any precondition misses). When
      // it DOES write, it emits the LIVE log line
      // `[memory-write-on-satisfied] effectFamily=artifact wrote=true`
      // (slice E typed-but-inert `artifact` slot now LIT for the first
      // time on `dev`).
      try {
        const artifactOutcome = await recordArtifactOnCommitmentSatisfied({
          attestation,
          identityId,
          memoryStore: runtime.memoryStore,
          artifactInput: params.artifactWriteInput,
          effectFamily: params.effectFamily,
          logger: {
            warn: (message: string) =>
              defaultRuntime.log(`[artifact-write] ${message}`),
            debug: () => {
              /* trace volume — drop debug events at the production seam */
            },
          },
        });
        if (artifactOutcome.kind === "written") {
          defaultRuntime.log(
            `[memory-write-on-satisfied] effectFamily=artifact wrote=true entryId=${artifactOutcome.entryId}`,
          );
        }
      } catch (err) {
        defaultRuntime.log(
          `[artifact-write] fan-out failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // NEW-C Phase 5 outbound-coalescer commit-on-satisfied hook
      // fan-out. The hook self-filters on `commitmentSatisfied===true`
      // — calling it here unconditionally is safe (returns silently on
      // unsatisfied attestations). When BOTH `outboundCoalescer` AND
      // `outboundTurnId` are supplied, the hook fires the PRIMARY
      // commit trigger (sibling of slice E memory hook, slice F task
      // hook, cutover-3 artifact hook). When EITHER is absent (the
      // default decision-layer wiring path — coalescer is built later
      // in `agent-runner.ts`), the hook is wired but inert and the
      // fallback `finalizeAfterRun` finally block covers the commit
      // edge. The hook NEVER throws (invariant #15); the outer
      // `try`/`catch` is defensive only.
      if (params.outboundCoalescer && params.outboundTurnId) {
        try {
          await commitOutboundOnCommitmentSatisfied({
            coalescer: params.outboundCoalescer,
            attestation,
            turnId: params.outboundTurnId,
            logger: (line: string) => defaultRuntime.log(line),
          });
        } catch (err) {
          defaultRuntime.log(
            `[commit-outbound] fan-out failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },
  };
}
