/**
 * Slice F Phase 5 — commitment-runtime task hook.
 *
 * Sibling of slice E PR-#169 (`memory-write-on-satisfied.ts`). Pure
 * function `recordTaskOnCommitmentSatisfied` invoked from the
 * pi-embedded-runner orchestration path AFTER a `RuntimeAttestation`
 * surfaces with `commitmentSatisfied === true` AND the wiring layer
 * supplied a structured `TaskWriteInput`. Performs TWO writes:
 *
 *   1. `taskLedger.create / complete / cancel / update(failed)`;
 *   2. `memoryStore.storeEpisodic({ effectFamily: "task", payload: {
 *      kind, taskId, ownerIdentityId, ... } })`.
 *
 * The two writes are CROSS-REFERENCED on `(identityId, taskId)` —
 * downstream slices (slice K reconciler, B7 acceptance) JOIN them on
 * that pair. Per invariant #15 + sub-plan §6 line 148, partial-write
 * is tolerated: if EITHER write fails, the OTHER still attempts; the
 * outcome reports per-side success, the warn channel logs the failure,
 * and the commitment STILL satisfies.
 *
 * Boundary discipline:
 * - Lives in `src/agents/pi-embedded-runner/run/`, NOT in
 *   `src/platform/commitment/` — invariant #8.
 * - Reads the attestation via the structural `CommitmentSatisfiedAttestationLike`
 *   type re-exported from the slice E hook — no NEW runtime import
 *   from `src/platform/commitment/` source.
 * - Accepts `IdentityId` brand + structured `TaskWriteInput` only —
 *   never `RawUserTurn` / `UserPrompt` (invariants #5, #6).
 * - Failure paths return a typed `Outcome` instead of throwing
 *   (invariant #15). The calling commitment turn is unaffected.
 *
 * The frozen 5 contracts (`TaskContract`, `OutcomeContract`,
 * `QualificationExecutionContract`, `ResolutionContract`,
 * `RecipeRoutingHints`) are NOT touched — `TaskRecord` is a sibling
 * of `TaskContract`, not a successor.
 */

import { randomUUID } from "node:crypto";

import type { IdentityId } from "../../../platform/identity/identity-id.js";
import type {
  EpisodicMemoryEvent,
  TaskCancelledPayload,
  TaskCompletedPayload,
  TaskCreatedPayload,
  TaskFailedPayload,
} from "../../../platform/memory/episodic-memory-event.js";
import type { MemoryStore } from "../../../platform/memory/memory-store.js";
import type { TaskLedger } from "../../../platform/task/task-ledger.js";
import { asTaskId, type TaskId } from "../../../platform/task/task-id.js";
import type { TaskRecord } from "../../../platform/task/task-record.js";

import type { CommitmentSatisfiedAttestationLike } from "./memory-write-on-satisfied.js";

/**
 * Discriminator for the four task lifecycle events the hook handles.
 * Mirrors the payload-level `kind` discriminator on the slice E
 * `TaskLifecyclePayload` so wiring callers and the hook share a single
 * exhaustiveness surface.
 */
export type TaskWriteInputKind =
  | "created"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * `task.created` write input — the wiring layer constructs this when
 * an attestation reports a NEW task lifecycle event. The ledger mints
 * the `TaskId`, so `created` does NOT carry one (the post-write
 * outcome surfaces the minted id for the episodic cross-reference).
 *
 * `sourceEffectFamily` / `sourceEffectId` are forwarded to the ledger
 * row so a `TaskRecord` carries the originating attestation reference
 * — the JOIN on `(identityId, taskId, sourceEffectId)` lets the
 * reconciler (slice K) match ledger rows to episodic events even if
 * one side is briefly out of sync.
 */
export type TaskCreatedWriteInput = {
  readonly kind: "created";
  readonly label: string;
  readonly summary: string;
  readonly occurredAt: string;
  readonly sourceEffectFamily?: string;
  readonly sourceEffectId?: string;
};

export type TaskCompletedWriteInput = {
  readonly kind: "completed";
  readonly taskId: TaskId;
  readonly result?: string;
  readonly occurredAt: string;
};

export type TaskCancelledWriteInput = {
  readonly kind: "cancelled";
  readonly taskId: TaskId;
  readonly reason?: string;
  readonly occurredAt: string;
};

export type TaskFailedWriteInput = {
  readonly kind: "failed";
  readonly taskId: TaskId;
  readonly result?: string;
  readonly occurredAt: string;
};

/**
 * Discriminated union of every task lifecycle write the hook accepts.
 * The wiring layer constructs the matching variant; the hook switches
 * on `kind`. Adding a new lifecycle event is an additive
 * discriminated-union extension that fails the build at the switch
 * arm via `assertNeverTaskWriteInput` until the hook is updated.
 */
export type TaskWriteInput =
  | TaskCreatedWriteInput
  | TaskCompletedWriteInput
  | TaskCancelledWriteInput
  | TaskFailedWriteInput;

/**
 * Logger surface used by the hook. Same shape as
 * `MemoryWriteOnSatisfiedLogger` (slice E PR-#169) — `warn` fires on
 * partial-write failure (ledger or episodic threw); `debug` fires on
 * every dispatch decision so traces line up with the rest of the
 * commitment-runtime log.
 */
export type TaskWriteOnSatisfiedLogger = {
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
};

export type TaskWriteOnSatisfiedDeps = {
  readonly attestation: CommitmentSatisfiedAttestationLike;
  readonly identityId: IdentityId | undefined;
  readonly taskLedger: TaskLedger | undefined;
  readonly memoryStore: MemoryStore | undefined;
  readonly taskInput: TaskWriteInput | undefined;
  readonly logger: TaskWriteOnSatisfiedLogger;
};

/**
 * Reasons the hook may decline to dispatch a write. Closed string
 * union so downstream telemetry can classify without parsing free
 * text.
 */
export type TaskWriteSkipReason =
  | "commitment_unsatisfied"
  | "identity_unresolved"
  | "task_ledger_unavailable"
  | "task_input_unavailable";

/**
 * Outcome on a successful paired write. The minted/looked-up
 * `TaskId` is surfaced so callers can correlate the ledger row with
 * the cross-referenced episodic event (the JOIN key).
 */
export type TaskWriteWroteOutcome = {
  readonly kind: "wrote";
  readonly taskId: TaskId;
};

/**
 * Outcome on a partial write — at least one of (ledger, episodic)
 * failed. The two booleans report which side succeeded; the `error`
 * carries the FIRST failure (the warn channel logs both). Per
 * invariant #15, the commitment STILL satisfies — the calling turn
 * is unaffected.
 */
export type TaskWriteFailedOutcome = {
  readonly kind: "failed";
  readonly ledgerWritten: boolean;
  readonly episodicWritten: boolean;
  readonly error: Error;
};

export type TaskWriteSkippedOutcome = {
  readonly kind: "skipped";
  readonly reason: TaskWriteSkipReason;
};

export type TaskWriteOutcome =
  | TaskWriteWroteOutcome
  | TaskWriteFailedOutcome
  | TaskWriteSkippedOutcome;

/**
 * Record the task lifecycle on a satisfied commitment. Behaviour:
 *
 * 1. If `attestation.commitmentSatisfied !== true`, return
 *    `{ kind: 'skipped', reason: 'commitment_unsatisfied' }`.
 * 2. If no `IdentityId` was resolved (anonymous session), return
 *    `{ kind: 'skipped', reason: 'identity_unresolved' }` — slice F
 *    keys on `IdentityId` per invariant #16; anonymous sessions never
 *    write tasks.
 * 3. If no `TaskLedger` was injected, return
 *    `{ kind: 'skipped', reason: 'task_ledger_unavailable' }`. The
 *    episodic write is ALSO skipped — this hook is a paired-write
 *    surface, not an opportunistic episodic-only writer (slice E
 *    PR-#169 owns the standalone memory-write path).
 * 4. If the wiring layer declined to supply a `TaskWriteInput`,
 *    return `{ kind: 'skipped', reason: 'task_input_unavailable' }`.
 *    This is the default Phase-5 production wiring — until slices J
 *    (cron) / G (subagent) emit task lifecycle attestations, no
 *    `taskInput` is constructed and the hook is wired but inert.
 * 5. Otherwise, dispatch on `taskInput.kind`:
 *      - `created`  → `taskLedger.create(...)`;
 *      - `completed` → `taskLedger.complete(...)`;
 *      - `cancelled` → `taskLedger.cancel(...)`;
 *      - `failed`   → `taskLedger.update(..., { status: 'failed' })`.
 *    Then ALWAYS attempt `memoryStore.storeEpisodic(...)` with the
 *    matching `task.<kind>` payload. If EITHER write throws, the
 *    OTHER still runs (defense-in-depth #15) and the outcome reports
 *    per-side success. Failures log via `logger.warn`.
 *
 * On success: `{ kind: 'wrote', taskId }`. On any partial failure:
 * `{ kind: 'failed', ledgerWritten, episodicWritten, error }`.
 */
export async function recordTaskOnCommitmentSatisfied(
  deps: TaskWriteOnSatisfiedDeps,
): Promise<TaskWriteOutcome> {
  const { attestation, identityId, taskLedger, memoryStore, taskInput, logger } = deps;

  if (attestation.commitmentSatisfied !== true) {
    logger.debug("task-write-on-satisfied skipped (commitment_unsatisfied)", {
      terminalState: attestation.terminalState,
      acceptanceReason: attestation.acceptanceReason,
    });
    return { kind: "skipped", reason: "commitment_unsatisfied" };
  }

  if (identityId === undefined) {
    logger.debug("task-write-on-satisfied skipped (identity_unresolved)");
    return { kind: "skipped", reason: "identity_unresolved" };
  }

  if (taskLedger === undefined) {
    logger.debug("task-write-on-satisfied skipped (task_ledger_unavailable)");
    return { kind: "skipped", reason: "task_ledger_unavailable" };
  }

  if (taskInput === undefined) {
    logger.debug("task-write-on-satisfied skipped (task_input_unavailable)");
    return { kind: "skipped", reason: "task_input_unavailable" };
  }

  // Phase 1: ledger write. Capture the resolved TaskId (minted by
  // create() OR carried by the input variant) for the episodic
  // cross-reference. Failure here does NOT short-circuit the
  // episodic side — the cross-reference contract tolerates partial
  // writes (sub-plan §6 line 148).
  let resolvedTaskId: TaskId | undefined;
  let ledgerWritten = false;
  let firstError: Error | undefined;
  try {
    const ledgerOutcome = await dispatchLedgerWrite(taskLedger, identityId, taskInput);
    resolvedTaskId = ledgerOutcome.taskId;
    ledgerWritten = ledgerOutcome.written;
    if (!ledgerOutcome.written && ledgerOutcome.error !== undefined) {
      firstError = ledgerOutcome.error;
      logger.warn(
        "task-write-on-satisfied: ledger write failed (commitment still satisfies)",
        {
          identityId,
          kind: taskInput.kind,
          error: ledgerOutcome.error.message,
        },
      );
    }
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    firstError = wrapped;
    logger.warn(
      "task-write-on-satisfied: ledger write failed (commitment still satisfies)",
      {
        identityId,
        kind: taskInput.kind,
        error: wrapped.message,
      },
    );
    // Per defense-in-depth #15 + sub-plan §6 line 148: failure of the
    // ledger side does NOT block the episodic side. For lifecycle
    // events that carry a `taskId` on the input we already have the
    // cross-reference key; for `created` we synthesize a placeholder
    // TaskId so the episodic event still lands and the warn log
    // surfaces both writes for the reconciler (slice K) to JOIN on
    // best-effort terms.
    if (taskInput.kind !== "created") {
      resolvedTaskId = taskInput.taskId;
    } else {
      resolvedTaskId = asTaskId(`task:orphan-${randomUUID().slice(0, 8)}`);
    }
  }

  // Phase 2: episodic write. Always attempt when we have a TaskId to
  // cross-reference; skip otherwise (e.g. `created` whose ledger
  // write threw before minting an id).
  let episodicWritten = false;
  if (resolvedTaskId !== undefined && memoryStore !== undefined) {
    try {
      await memoryStore.storeEpisodic(
        buildEpisodicEvent(identityId, resolvedTaskId, taskInput),
      );
      episodicWritten = true;
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      if (firstError === undefined) {
        firstError = wrapped;
      }
      logger.warn(
        "task-write-on-satisfied: episodic write failed (commitment still satisfies)",
        {
          identityId,
          taskId: resolvedTaskId,
          kind: taskInput.kind,
          error: wrapped.message,
        },
      );
    }
  }

  if (firstError !== undefined || !ledgerWritten || !episodicWritten) {
    return {
      kind: "failed",
      ledgerWritten,
      episodicWritten,
      error: firstError ?? new Error("task-write-on-satisfied: partial write"),
    };
  }

  // resolvedTaskId is non-undefined here because both writes
  // succeeded — narrow defensively to satisfy the type checker.
  if (resolvedTaskId === undefined) {
    return {
      kind: "failed",
      ledgerWritten,
      episodicWritten,
      error: new Error("task-write-on-satisfied: missing resolved taskId"),
    };
  }

  logger.debug("task-write-on-satisfied wrote task", {
    identityId,
    taskId: resolvedTaskId,
    kind: taskInput.kind,
  });
  return { kind: "wrote", taskId: resolvedTaskId };
}

type LedgerDispatchOutcome = {
  readonly taskId: TaskId | undefined;
  readonly written: boolean;
  readonly error?: Error;
};

async function dispatchLedgerWrite(
  taskLedger: TaskLedger,
  identityId: IdentityId,
  taskInput: TaskWriteInput,
): Promise<LedgerDispatchOutcome> {
  switch (taskInput.kind) {
    case "created": {
      const created = await taskLedger.create({
        ownerIdentityId: identityId,
        label: taskInput.label,
        summary: taskInput.summary,
        ...(taskInput.sourceEffectFamily !== undefined
          ? { sourceEffectFamily: taskInput.sourceEffectFamily }
          : {}),
        ...(taskInput.sourceEffectId !== undefined
          ? { sourceEffectId: taskInput.sourceEffectId }
          : {}),
      });
      return { taskId: created.id, written: true };
    }
    case "completed": {
      const result = await taskLedger.complete(
        identityId,
        taskInput.taskId,
        taskInput.result,
      );
      return notFoundOrWritten(result, taskInput.taskId, "completed");
    }
    case "cancelled": {
      const result = await taskLedger.cancel(
        identityId,
        taskInput.taskId,
        taskInput.reason,
      );
      return notFoundOrWritten(result, taskInput.taskId, "cancelled");
    }
    case "failed": {
      const result = await taskLedger.update(identityId, taskInput.taskId, {
        status: "failed",
        ...(taskInput.result !== undefined ? { result: taskInput.result } : {}),
      });
      return notFoundOrWritten(result, taskInput.taskId, "failed");
    }
    default:
      // Force a TypeScript exhaustiveness check — adding a new
      // lifecycle variant fails the build until the dispatch switch
      // is extended (mirrors slice E `assertNeverEpisodicEventInput`).
      return assertNeverTaskWriteInput(taskInput);
  }
}

function notFoundOrWritten(
  result: TaskRecord | { kind: "not_found" },
  taskId: TaskId,
  kind: TaskWriteInputKind,
): LedgerDispatchOutcome {
  if ("kind" in result && result.kind === "not_found") {
    return {
      taskId,
      written: false,
      error: new Error(
        `task-write-on-satisfied: ledger ${kind} -> not_found for ${taskId}`,
      ),
    };
  }
  return { taskId, written: true };
}

function buildEpisodicEvent(
  identityId: IdentityId,
  taskId: TaskId,
  taskInput: TaskWriteInput,
): EpisodicMemoryEvent {
  switch (taskInput.kind) {
    case "created": {
      const payload: TaskCreatedPayload = {
        kind: "created",
        taskId,
        ownerIdentityId: identityId,
        label: taskInput.label,
        occurredAt: taskInput.occurredAt,
      };
      return {
        identityId,
        effectFamily: "task",
        effectId: taskInput.sourceEffectId ?? `task:${taskId}:created`,
        payload,
      };
    }
    case "completed": {
      const payload: TaskCompletedPayload = {
        kind: "completed",
        taskId,
        ownerIdentityId: identityId,
        ...(taskInput.result !== undefined ? { result: taskInput.result } : {}),
        occurredAt: taskInput.occurredAt,
      };
      return {
        identityId,
        effectFamily: "task",
        effectId: `task:${taskId}:completed`,
        payload,
      };
    }
    case "cancelled": {
      const payload: TaskCancelledPayload = {
        kind: "cancelled",
        taskId,
        ownerIdentityId: identityId,
        occurredAt: taskInput.occurredAt,
      };
      return {
        identityId,
        effectFamily: "task",
        effectId: `task:${taskId}:cancelled`,
        payload,
      };
    }
    case "failed": {
      const payload: TaskFailedPayload = {
        kind: "failed",
        taskId,
        ownerIdentityId: identityId,
        ...(taskInput.result !== undefined ? { result: taskInput.result } : {}),
        occurredAt: taskInput.occurredAt,
      };
      return {
        identityId,
        effectFamily: "task",
        effectId: `task:${taskId}:failed`,
        payload,
      };
    }
    default:
      return assertNeverTaskWriteInput(taskInput);
  }
}

function assertNeverTaskWriteInput(value: never): never {
  throw new Error(
    `recordTaskOnCommitmentSatisfied: unhandled task lifecycle ${
      JSON.stringify(value)
    }`,
  );
}
