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
import { recordMemoryOnCommitmentSatisfied } from "../../agents/pi-embedded-runner/run/memory-write-on-satisfied.js";
import {
  recordTaskOnCommitmentSatisfied,
  type TaskWriteInput,
} from "../../agents/pi-embedded-runner/run/task-write-on-satisfied.js";
import type { OpenClawConfig } from "../../config/config.js";
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
    },
  };
}
