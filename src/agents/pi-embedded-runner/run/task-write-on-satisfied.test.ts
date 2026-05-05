import { describe, expect, it, vi } from "vitest";

import { asIdentityId } from "../../../platform/identity/identity-id.js";
import { InMemoryMemoryStore } from "../../../platform/memory/in-memory-store.js";
import type { MemoryStore } from "../../../platform/memory/memory-store.js";
import { InMemoryTaskLedger } from "../../../platform/task/in-memory-task-ledger.js";
import type { TaskLedger } from "../../../platform/task/task-ledger.js";

import type { CommitmentSatisfiedAttestationLike } from "./memory-write-on-satisfied.js";

import {
  recordTaskOnCommitmentSatisfied,
  type TaskWriteInput,
  type TaskWriteOnSatisfiedDeps,
  type TaskWriteOnSatisfiedLogger,
} from "./task-write-on-satisfied.js";

/**
 * Slice F Phase 5 — fail-first tests for the commitment-runtime task hook.
 *
 * Sibling of slice E PR #169 (`memory-write-on-satisfied.test.ts`). The
 * hook fires on `commitmentSatisfied === true` AND `effectFamily === "task"`
 * and performs TWO writes:
 *   1. `taskLedger.create / complete / cancel / update(failed)`
 *   2. `memoryStore.storeEpisodic({ effectFamily: "task", payload: { kind, taskId, ... } })`
 *
 * Cross-reference invariant: every successful ledger write produces ONE
 * matching episodic call carrying the same `taskId` + `ownerIdentityId`.
 *
 * Per AGENTS.md test discipline:
 * - tests run against the REAL hook (no `vi.spyOn` on the hook itself);
 * - injected `taskLedger` is the production `InMemoryTaskLedger` (or a
 *   minimal mock matching the same shape) — spies live on the dep, not
 *   the function under test;
 * - injected `memoryStore` is the production `InMemoryMemoryStore` (or
 *   a minimal mock) — same discipline;
 * - reverse-coverage exists for every positive case (no-op when
 *   conditions miss);
 * - failure isolation: ledger throw / episodic throw never propagates,
 *   commitment STILL satisfies (invariant #15).
 */

const VLADIMIR = asIdentityId("identity:vladimir");

const VALID_ISO_TIMESTAMP = "2026-05-06T12:34:56.000Z";

function buildSatisfiedAttestation(): CommitmentSatisfiedAttestationLike {
  return {
    commitmentSatisfied: true,
    terminalState: "action_completed",
    acceptanceReason: "commitment_satisfied",
  };
}

function buildUnsatisfiedAttestation(): CommitmentSatisfiedAttestationLike {
  return {
    commitmentSatisfied: false,
    terminalState: "rejected",
    acceptanceReason: "commitment_unsatisfied",
  };
}

function captureLogger(): TaskWriteOnSatisfiedLogger & {
  readonly warns: ReadonlyArray<{ message: string; meta?: Record<string, unknown> }>;
  readonly debugs: ReadonlyArray<{ message: string; meta?: Record<string, unknown> }>;
} {
  const warns: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const debugs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  return {
    warn: (message, meta) => {
      warns.push({ message, ...(meta ? { meta } : {}) });
    },
    debug: (message, meta) => {
      debugs.push({ message, ...(meta ? { meta } : {}) });
    },
    warns,
    debugs,
  };
}

function createdInput(label = "Generate Q3 PDF report"): TaskWriteInput {
  return {
    kind: "created",
    label,
    summary: `summary for ${label}`,
    occurredAt: VALID_ISO_TIMESTAMP,
    sourceEffectFamily: "task",
    sourceEffectId: "effect-task-1",
  };
}

describe("recordTaskOnCommitmentSatisfied — happy path (task.created)", () => {
  it("writes BOTH ledger row + episodic event when satisfied + identity + ledger + store", async () => {
    const ledger = new InMemoryTaskLedger();
    const ledgerSpy = vi.spyOn(ledger, "create");
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");

    const deps: TaskWriteOnSatisfiedDeps = {
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      taskLedger: ledger,
      memoryStore: store,
      taskInput: createdInput(),
      logger: captureLogger(),
    };

    const outcome = await recordTaskOnCommitmentSatisfied(deps);

    expect(outcome.kind).toBe("wrote");
    expect(ledgerSpy).toHaveBeenCalledTimes(1);
    expect(storeSpy).toHaveBeenCalledTimes(1);

    // Cross-reference invariant: ledger row id matches episodic
    // payload taskId, ownerIdentityId matches outer identityId.
    if (outcome.kind === "wrote") {
      const listing = await ledger.list({ ownerIdentityId: VLADIMIR });
      expect(listing.tasks).toHaveLength(1);
      expect(listing.tasks[0]?.id).toBe(outcome.taskId);
      expect(listing.tasks[0]?.label).toBe("Generate Q3 PDF report");
      expect(listing.tasks[0]?.status).toBe("open");

      const memList = await store.list({ identityId: VLADIMIR });
      expect(memList.episodic).toHaveLength(1);
      const episodic = memList.episodic[0]?.event;
      expect(episodic?.effectFamily).toBe("task");
      if (episodic?.effectFamily === "task") {
        expect(episodic.payload.kind).toBe("created");
        expect(episodic.payload.taskId).toBe(outcome.taskId);
        expect(episodic.payload.ownerIdentityId).toBe(VLADIMIR);
      }
    }
  });
});

describe("recordTaskOnCommitmentSatisfied — reverse: commitmentSatisfied === false", () => {
  it("does NOT call ledger.create or storeEpisodic when attestation rejects the commitment", async () => {
    const ledger = new InMemoryTaskLedger();
    const ledgerSpy = vi.spyOn(ledger, "create");
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");

    const outcome = await recordTaskOnCommitmentSatisfied({
      attestation: buildUnsatisfiedAttestation(),
      identityId: VLADIMIR,
      taskLedger: ledger,
      memoryStore: store,
      taskInput: createdInput(),
      logger: captureLogger(),
    });

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("commitment_unsatisfied");
    }
    expect(ledgerSpy).not.toHaveBeenCalled();
    expect(storeSpy).not.toHaveBeenCalled();
  });
});

describe("recordTaskOnCommitmentSatisfied — anonymous session (identityId === undefined)", () => {
  it("does NOT call ledger or storeEpisodic when no IdentityId is resolved", async () => {
    const ledger = new InMemoryTaskLedger();
    const ledgerSpy = vi.spyOn(ledger, "create");
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    const logger = captureLogger();

    const outcome = await recordTaskOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: undefined,
      taskLedger: ledger,
      memoryStore: store,
      taskInput: createdInput(),
      logger,
    });

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("identity_unresolved");
    }
    expect(ledgerSpy).not.toHaveBeenCalled();
    expect(storeSpy).not.toHaveBeenCalled();
    expect(logger.warns).toEqual([]); // anonymous sessions are not warnings
  });
});

describe("recordTaskOnCommitmentSatisfied — no taskLedger injected", () => {
  it("is a no-op (skipped) when taskLedger is undefined and does NOT throw", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    const logger = captureLogger();

    const outcome = await recordTaskOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      taskLedger: undefined,
      memoryStore: store,
      taskInput: createdInput(),
      logger,
    });

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("task_ledger_unavailable");
    }
    // Episodic write is also skipped — the hook is a paired write, not
    // an opportunistic episodic-only writer.
    expect(storeSpy).not.toHaveBeenCalled();
    expect(logger.warns).toEqual([]); // missing dep is not a warning
  });
});

describe("recordTaskOnCommitmentSatisfied — no taskInput provided", () => {
  it("is a no-op (skipped) when taskInput is undefined (caller-side dispatch declined)", async () => {
    const ledger = new InMemoryTaskLedger();
    const ledgerSpy = vi.spyOn(ledger, "create");
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");

    const outcome = await recordTaskOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      taskLedger: ledger,
      memoryStore: store,
      taskInput: undefined,
      logger: captureLogger(),
    });

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("task_input_unavailable");
    }
    expect(ledgerSpy).not.toHaveBeenCalled();
    expect(storeSpy).not.toHaveBeenCalled();
  });
});

describe("recordTaskOnCommitmentSatisfied — failure isolation: ledger throws (invariant #15)", () => {
  it("catches ledger.create rejection, episodic STILL writes, returns failed, logs warn", async () => {
    const failingLedger: TaskLedger = {
      create: vi.fn(async () => {
        throw new Error("simulated ledger I/O failure");
      }),
      list: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      complete: vi.fn(),
      cancel: vi.fn(),
    } as unknown as TaskLedger;
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    const logger = captureLogger();

    const outcome = await recordTaskOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      taskLedger: failingLedger,
      memoryStore: store,
      taskInput: createdInput(),
      logger,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.ledgerWritten).toBe(false);
      // Defense-in-depth #15: episodic write still attempted even when
      // the ledger side fails. The cross-reference is observability,
      // not a transactional pair — partial-write tolerated.
      expect(outcome.episodicWritten).toBe(true);
      expect(outcome.error).toBeInstanceOf(Error);
    }
    expect(failingLedger.create).toHaveBeenCalledTimes(1);
    expect(storeSpy).toHaveBeenCalledTimes(1);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]?.message).toMatch(/task-write-on-satisfied/);
  });
});

describe("recordTaskOnCommitmentSatisfied — failure isolation: episodic throws (invariant #15)", () => {
  it("catches storeEpisodic rejection, ledger STILL wrote, returns failed, logs warn", async () => {
    const ledger = new InMemoryTaskLedger();
    const failingStore: MemoryStore = {
      storeEpisodic: vi.fn(async () => {
        throw new Error("simulated sqlite-vec I/O failure");
      }),
      storeSemantic: vi.fn(),
      recall: vi.fn(),
      list: vi.fn(),
      forget: vi.fn(),
    } as unknown as MemoryStore;
    const logger = captureLogger();

    const outcome = await recordTaskOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      taskLedger: ledger,
      memoryStore: failingStore,
      taskInput: createdInput(),
      logger,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.ledgerWritten).toBe(true);
      expect(outcome.episodicWritten).toBe(false);
      expect(outcome.error).toBeInstanceOf(Error);
    }
    // Ledger row exists despite the episodic failure — partial-write
    // tolerated per cross-reference contract (sub-plan §6 line 148).
    const listing = await ledger.list({ ownerIdentityId: VLADIMIR });
    expect(listing.tasks).toHaveLength(1);
    expect(failingStore.storeEpisodic).toHaveBeenCalledTimes(1);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]?.message).toMatch(/task-write-on-satisfied/);
  });
});

describe("recordTaskOnCommitmentSatisfied — task.completed lifecycle", () => {
  it("calls taskLedger.complete + emits episodic task.completed when input.kind === 'completed'", async () => {
    const ledger = new InMemoryTaskLedger();
    const created = await ledger.create({
      ownerIdentityId: VLADIMIR,
      label: "Pre-existing task",
      summary: "Created before completion",
    });
    // Move to in_progress so complete() is a legal transition.
    await ledger.update(VLADIMIR, created.id, { status: "in_progress" });

    const ledgerCompleteSpy = vi.spyOn(ledger, "complete");
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");

    const outcome = await recordTaskOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      taskLedger: ledger,
      memoryStore: store,
      taskInput: {
        kind: "completed",
        taskId: created.id,
        result: "Posted retrospective to #eng-leads",
        occurredAt: VALID_ISO_TIMESTAMP,
      },
      logger: captureLogger(),
    });

    expect(outcome.kind).toBe("wrote");
    expect(ledgerCompleteSpy).toHaveBeenCalledTimes(1);
    expect(storeSpy).toHaveBeenCalledTimes(1);
    if (outcome.kind === "wrote") {
      expect(outcome.taskId).toBe(created.id);
    }

    const finalRow = await ledger.get(VLADIMIR, created.id);
    expect(finalRow?.status).toBe("completed");

    const memList = await store.list({ identityId: VLADIMIR });
    const episodic = memList.episodic[0]?.event;
    expect(episodic?.effectFamily).toBe("task");
    if (episodic?.effectFamily === "task") {
      expect(episodic.payload.kind).toBe("completed");
      expect(episodic.payload.taskId).toBe(created.id);
      expect(episodic.payload.ownerIdentityId).toBe(VLADIMIR);
      if (episodic.payload.kind === "completed") {
        expect(episodic.payload.result).toBe("Posted retrospective to #eng-leads");
      }
    }
  });
});

describe("recordTaskOnCommitmentSatisfied — task.cancelled lifecycle", () => {
  it("calls taskLedger.cancel + emits episodic task.cancelled when input.kind === 'cancelled'", async () => {
    const ledger = new InMemoryTaskLedger();
    const created = await ledger.create({
      ownerIdentityId: VLADIMIR,
      label: "Cancellable task",
      summary: "To be cancelled",
    });

    const ledgerCancelSpy = vi.spyOn(ledger, "cancel");
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");

    const outcome = await recordTaskOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      taskLedger: ledger,
      memoryStore: store,
      taskInput: {
        kind: "cancelled",
        taskId: created.id,
        occurredAt: VALID_ISO_TIMESTAMP,
      },
      logger: captureLogger(),
    });

    expect(outcome.kind).toBe("wrote");
    expect(ledgerCancelSpy).toHaveBeenCalledTimes(1);
    expect(storeSpy).toHaveBeenCalledTimes(1);

    const finalRow = await ledger.get(VLADIMIR, created.id);
    expect(finalRow?.status).toBe("cancelled");

    const memList = await store.list({ identityId: VLADIMIR });
    const episodic = memList.episodic[0]?.event;
    if (episodic?.effectFamily === "task") {
      expect(episodic.payload.kind).toBe("cancelled");
      expect(episodic.payload.taskId).toBe(created.id);
    }
  });
});

describe("recordTaskOnCommitmentSatisfied — task.failed lifecycle", () => {
  it("calls taskLedger.update({status: 'failed'}) + emits episodic task.failed when input.kind === 'failed'", async () => {
    const ledger = new InMemoryTaskLedger();
    const created = await ledger.create({
      ownerIdentityId: VLADIMIR,
      label: "Risky operation",
      summary: "May fail",
    });
    await ledger.update(VLADIMIR, created.id, { status: "in_progress" });

    const ledgerUpdateSpy = vi.spyOn(ledger, "update");
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");

    const outcome = await recordTaskOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      taskLedger: ledger,
      memoryStore: store,
      taskInput: {
        kind: "failed",
        taskId: created.id,
        result: "Upstream API timed out",
        occurredAt: VALID_ISO_TIMESTAMP,
      },
      logger: captureLogger(),
    });

    expect(outcome.kind).toBe("wrote");
    expect(ledgerUpdateSpy).toHaveBeenCalledTimes(1);
    expect(storeSpy).toHaveBeenCalledTimes(1);

    const finalRow = await ledger.get(VLADIMIR, created.id);
    expect(finalRow?.status).toBe("failed");

    const memList = await store.list({ identityId: VLADIMIR });
    const episodic = memList.episodic[0]?.event;
    if (episodic?.effectFamily === "task") {
      expect(episodic.payload.kind).toBe("failed");
      if (episodic.payload.kind === "failed") {
        expect(episodic.payload.result).toBe("Upstream API timed out");
      }
    }
  });
});

describe("recordTaskOnCommitmentSatisfied — cross-reference invariant", () => {
  it("ledger.create writes one row AND storeEpisodic is called exactly once with matching taskId + identityId", async () => {
    const ledger = new InMemoryTaskLedger();
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");

    const outcome = await recordTaskOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      taskLedger: ledger,
      memoryStore: store,
      taskInput: createdInput("X-ref test"),
      logger: captureLogger(),
    });

    expect(outcome.kind).toBe("wrote");
    if (outcome.kind === "wrote") {
      // Ledger side
      const listing = await ledger.list({ ownerIdentityId: VLADIMIR });
      expect(listing.tasks).toHaveLength(1);
      expect(listing.tasks[0]?.id).toBe(outcome.taskId);

      // Episodic side: spy receives one call, payload.taskId matches.
      expect(storeSpy).toHaveBeenCalledTimes(1);
      const call = storeSpy.mock.calls[0]?.[0];
      expect(call?.identityId).toBe(VLADIMIR);
      expect(call?.effectFamily).toBe("task");
      if (call?.effectFamily === "task") {
        expect(call.payload.taskId).toBe(outcome.taskId);
        expect(call.payload.ownerIdentityId).toBe(VLADIMIR);
      }
    }
  });
});
