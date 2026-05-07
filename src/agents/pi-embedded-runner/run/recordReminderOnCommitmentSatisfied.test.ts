/**
 * Cron/Scheduler Phase 5 — fail-first tests for the reminder
 * commit-on-satisfied hook (`recordReminderOnCommitmentSatisfied.ts`).
 *
 * Sibling of slice E (`memory-write-on-satisfied.test.ts`), slice F
 * (`task-write-on-satisfied.test.ts`), Cutover-3
 * (`recordArtifactOnCommitmentSatisfied.test.ts`), and Cutover-4
 * (`recordRepoOperationOnCommitmentSatisfied.test.ts`). Validates:
 *
 *  - happy path: real `InMemoryMemoryStore` round-trip lights
 *    `EpisodicEffectFamily: 'reminder'` for the FIRST time on `dev`;
 *  - reverse-coverage for every positive case (skipped/failed paths);
 *  - failure-isolation contract: store throw is `warn`-logged and
 *    SWALLOWED — calling commitment turn STILL satisfies (#15);
 *  - reverse-test for non-reminder families (4 entries — sibling hook
 *    arms must NOT trigger this hook).
 */

import { describe, expect, it, vi } from "vitest";

import { asIdentityId } from "../../../platform/identity/identity-id.js";
import { InMemoryMemoryStore } from "../../../platform/memory/in-memory-store.js";
import type { MemoryStore } from "../../../platform/memory/memory-store.js";

import {
  recordReminderOnCommitmentSatisfied,
  type ReminderWriteInput,
  type ReminderWriteOnSatisfiedDeps,
  type ReminderWriteOnSatisfiedLogger,
} from "./recordReminderOnCommitmentSatisfied.js";
import type { CommitmentSatisfiedAttestationLike } from "./memory-write-on-satisfied.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const VALID_ISO_TIMESTAMP = "2026-05-07T12:34:56.000Z";
const FUTURE_FIRE_AT = "2026-05-07T13:34:56.000Z";

function buildSatisfied(): CommitmentSatisfiedAttestationLike {
  return {
    commitmentSatisfied: true,
    terminalState: "action_completed",
    acceptanceReason: "commitment_satisfied",
  };
}

function buildUnsatisfied(): CommitmentSatisfiedAttestationLike {
  return {
    commitmentSatisfied: false,
    terminalState: "rejected",
    acceptanceReason: "commitment_unsatisfied",
  };
}

function buildInput(
  overrides: Partial<ReminderWriteInput> = {},
): ReminderWriteInput {
  return {
    reminderId: "reminder-1",
    fireAt: FUTURE_FIRE_AT,
    occurredAt: VALID_ISO_TIMESTAMP,
    ...overrides,
  };
}

function captureLogger(): ReminderWriteOnSatisfiedLogger & {
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

describe("recordReminderOnCommitmentSatisfied — happy path (LIGHTS reminder.set)", () => {
  it("writes an episodic entry tagged effectFamily=reminder and returns its MemoryEntryId (FIRST time on dev)", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    const deps: ReminderWriteOnSatisfiedDeps = {
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      reminderInput: buildInput(),
      effectFamily: "reminder",
      logger: captureLogger(),
    };

    const outcome = await recordReminderOnCommitmentSatisfied(deps);

    expect(outcome.kind).toBe("written");
    expect(storeSpy).toHaveBeenCalledTimes(1);
    expect(storeSpy.mock.calls[0]?.[0]).toMatchObject({
      identityId: VLADIMIR,
      effectFamily: "reminder",
      payload: {
        reminderId: "reminder-1",
        fireAt: FUTURE_FIRE_AT,
        occurredAt: VALID_ISO_TIMESTAMP,
      },
    });

    const listed = await store.list({ identityId: VLADIMIR });
    expect(listed.episodic).toHaveLength(1);
    expect(listed.episodic[0]?.event.effectFamily).toBe("reminder");
  });
});

describe("recordReminderOnCommitmentSatisfied — reverse: commitmentSatisfied=false", () => {
  it("does NOT call storeEpisodic when attestation rejects the commitment", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    const outcome = await recordReminderOnCommitmentSatisfied({
      attestation: buildUnsatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      reminderInput: buildInput(),
      effectFamily: "reminder",
      logger: captureLogger(),
    });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("commitment_unsatisfied");
    }
    expect(storeSpy).not.toHaveBeenCalled();
  });
});

describe("recordReminderOnCommitmentSatisfied — reverse: non-reminder families are no-ops", () => {
  it.each([
    "communication",
    "persistent_session",
    "task",
    "artifact",
    "repo",
    "web_research",
  ] as const)("skips when effectFamily=%s", async (family) => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    const outcome = await recordReminderOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      reminderInput: buildInput(),
      effectFamily: family,
      logger: captureLogger(),
    });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("effect_family_mismatch");
    }
    expect(storeSpy).not.toHaveBeenCalled();
  });
});

describe("recordReminderOnCommitmentSatisfied — defensive guards", () => {
  it("skips when effectFamily flag is missing (no crash, no write)", async () => {
    const store = new InMemoryMemoryStore();
    const outcome = await recordReminderOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      reminderInput: buildInput(),
      effectFamily: undefined,
      logger: captureLogger(),
    });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("effect_family_mismatch");
    }
  });

  it("skips with identity_unresolved on anonymous session", async () => {
    const store = new InMemoryMemoryStore();
    const outcome = await recordReminderOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: undefined,
      memoryStore: store,
      reminderInput: buildInput(),
      effectFamily: "reminder",
      logger: captureLogger(),
    });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("identity_unresolved");
    }
  });

  it("skips with memory_store_unavailable when store is undefined (no crash)", async () => {
    const logger = captureLogger();
    const outcome = await recordReminderOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: undefined,
      reminderInput: buildInput(),
      effectFamily: "reminder",
      logger,
    });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("memory_store_unavailable");
    }
    expect(logger.warns).toHaveLength(0);
  });

  it("skips with reminder_input_unavailable when reminderInput is undefined", async () => {
    const store = new InMemoryMemoryStore();
    const outcome = await recordReminderOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      reminderInput: undefined,
      effectFamily: "reminder",
      logger: captureLogger(),
    });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("reminder_input_unavailable");
    }
  });
});

describe("recordReminderOnCommitmentSatisfied — payload contract", () => {
  it("forwards reminderInput verbatim into ReminderSetPayload", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    await recordReminderOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      reminderInput: buildInput({
        reminderId: "reminder:42",
        fireAt: FUTURE_FIRE_AT,
        occurredAt: VALID_ISO_TIMESTAMP,
        effectId: "reminder.set",
      }),
      effectFamily: "reminder",
      logger: captureLogger(),
    });
    expect(storeSpy.mock.calls[0]?.[0]).toMatchObject({
      effectFamily: "reminder",
      effectId: "reminder.set",
      payload: {
        reminderId: "reminder:42",
        fireAt: FUTURE_FIRE_AT,
        occurredAt: VALID_ISO_TIMESTAMP,
      },
    });
  });

  it("synthesises effectId when caller omits it (fallback for direct emit sites)", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    await recordReminderOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      reminderInput: buildInput({ reminderId: "reminder:99" }),
      effectFamily: "reminder",
      logger: captureLogger(),
    });
    expect(storeSpy.mock.calls[0]?.[0]).toMatchObject({
      effectId: "reminder.set",
    });
  });
});

describe("recordReminderOnCommitmentSatisfied — failure isolation (invariant #15)", () => {
  it("returns failed when storeEpisodic throws AND warn-logs AND does NOT re-throw", async () => {
    const failingStore: MemoryStore = {
      storeEpisodic: async () => {
        throw new Error("backend down");
      },
      storeSemantic: async () => {
        throw new Error("not used");
      },
      list: async () => ({ episodic: [], semantic: [] }),
      recall: async () => ({ entries: [] }),
    } as unknown as MemoryStore;
    const logger = captureLogger();

    let thrown: unknown;
    let outcome:
      | Awaited<ReturnType<typeof recordReminderOnCommitmentSatisfied>>
      | undefined;
    try {
      outcome = await recordReminderOnCommitmentSatisfied({
        attestation: buildSatisfied(),
        identityId: VLADIMIR,
        memoryStore: failingStore,
        reminderInput: buildInput(),
        effectFamily: "reminder",
        logger,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeUndefined();
    expect(outcome).toBeDefined();
    expect(outcome?.kind).toBe("failed");
    if (outcome?.kind === "failed") {
      expect(outcome.reason).toBe("memory_write_error");
    }
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]?.message).toContain("commitment still satisfies");
  });
});
