import { describe, expect, it, vi } from "vitest";

import { asIdentityId } from "../../../platform/identity/identity-id.js";
import { InMemoryMemoryStore } from "../../../platform/memory/in-memory-store.js";
import type { MemoryStore } from "../../../platform/memory/memory-store.js";

import {
  recordMemoryOnCommitmentSatisfied,
  type CommitmentSatisfiedAttestationLike,
  type MemoryWriteOnSatisfiedDeps,
  type MemoryWriteOnSatisfiedLogger,
} from "./memory-write-on-satisfied.js";

/**
 * Slice E Phase 5 — fail-first tests for the commitment-runtime memory
 * hook. These tests pin down the no-op surface (no identity, no
 * commitment, no store) and the failure-isolation contract (memory
 * outage MUST NOT propagate into the calling commitment turn).
 *
 * The hook is invoked from the pi-embedded-runner orchestration path
 * AFTER the runtime attests `commitmentSatisfied === true`. Per the
 * sub-plan, the only payload-bearing effect family in slice E is
 * `persistent_session.created`; the other typed variants stay inert
 * (the hook's switch dispatches them as a no-op until slices F / G /
 * J / K wire their emit sites).
 *
 * Per AGENTS.md test discipline:
 * - tests run against the REAL hook (no `vi.spyOn` on the hook
 *   itself);
 * - the injected `MemoryStore` is the production
 *   `InMemoryMemoryStore` (or a mock that implements the same shape) —
 *   spies live on the dep, not the function under test;
 * - reverse-coverage exists for every positive case (no-op when
 *   conditions miss).
 */

const VLADIMIR = asIdentityId("identity:vladimir");

const VALID_ISO_TIMESTAMP = "2026-05-05T12:34:56.000Z";

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

function buildPersistentSessionEvent(messageId = "msg-001") {
  return {
    effectFamily: "persistent_session" as const,
    effectId: `effect-${messageId}`,
    payload: {
      messageRole: "assistant" as const,
      messageText: `assistant reply for ${messageId}`,
      messageId,
      occurredAt: VALID_ISO_TIMESTAMP,
    },
  };
}

function captureLogger(): MemoryWriteOnSatisfiedLogger & {
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

describe("recordMemoryOnCommitmentSatisfied — happy path (persistent_session.created)", () => {
  it("writes an episodic entry and returns the assigned MemoryEntryId when satisfied + identity + store", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    const deps: MemoryWriteOnSatisfiedDeps = {
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      memoryStore: store,
      episodicEvent: buildPersistentSessionEvent(),
      logger: captureLogger(),
    };

    const outcome = await recordMemoryOnCommitmentSatisfied(deps);

    expect(outcome.kind).toBe("written");
    expect(storeSpy).toHaveBeenCalledTimes(1);
    expect(storeSpy.mock.calls[0]?.[0]).toMatchObject({
      identityId: VLADIMIR,
      effectFamily: "persistent_session",
      effectId: "effect-msg-001",
    });

    const listed = await store.list({ identityId: VLADIMIR });
    expect(listed.episodic).toHaveLength(1);
    expect(listed.episodic[0]?.event.effectFamily).toBe("persistent_session");
    if (outcome.kind === "written") {
      expect(listed.episodic[0]?.id).toBe(outcome.entryId);
    }
  });
});

describe("recordMemoryOnCommitmentSatisfied — reverse: commitmentSatisfied === false", () => {
  it("does NOT call storeEpisodic when attestation rejects the commitment", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    const logger = captureLogger();

    const outcome = await recordMemoryOnCommitmentSatisfied({
      attestation: buildUnsatisfiedAttestation(),
      identityId: VLADIMIR,
      memoryStore: store,
      episodicEvent: buildPersistentSessionEvent(),
      logger,
    });

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("commitment_unsatisfied");
    }
    expect(storeSpy).not.toHaveBeenCalled();
    const listed = await store.list({ identityId: VLADIMIR });
    expect(listed.episodic).toEqual([]);
  });

  it("treats a missing commitmentSatisfied flag as unsatisfied (defensive)", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");

    const outcome = await recordMemoryOnCommitmentSatisfied({
      attestation: {
        // deliberately omit `commitmentSatisfied: true` — the hook must
        // not silently treat "absence" as satisfaction.
        commitmentSatisfied: false,
        terminalState: "unsupported",
        acceptanceReason: "observer_unavailable",
      },
      identityId: VLADIMIR,
      memoryStore: store,
      episodicEvent: buildPersistentSessionEvent(),
      logger: captureLogger(),
    });

    expect(outcome.kind).toBe("skipped");
    expect(storeSpy).not.toHaveBeenCalled();
  });
});

describe("recordMemoryOnCommitmentSatisfied — anonymous session (identityId === undefined)", () => {
  it("does NOT call storeEpisodic when no IdentityId is resolved", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    const logger = captureLogger();

    const outcome = await recordMemoryOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: undefined,
      memoryStore: store,
      episodicEvent: buildPersistentSessionEvent(),
      logger,
    });

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("identity_unresolved");
    }
    expect(storeSpy).not.toHaveBeenCalled();
    expect(logger.warns).toEqual([]); // anonymous sessions are not warnings
  });
});

describe("recordMemoryOnCommitmentSatisfied — no MemoryStore injected", () => {
  it("is a no-op (skipped) when memoryStore is undefined and does NOT throw", async () => {
    const logger = captureLogger();

    const outcome = await recordMemoryOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      memoryStore: undefined,
      episodicEvent: buildPersistentSessionEvent(),
      logger,
    });

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("memory_store_unavailable");
    }
    expect(logger.warns).toEqual([]); // missing dep is not a warning
  });
});

describe("recordMemoryOnCommitmentSatisfied — no episodicEvent provided", () => {
  it("is a no-op (skipped) when episodicEvent is undefined (caller-side dispatch declined)", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");

    const outcome = await recordMemoryOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      memoryStore: store,
      episodicEvent: undefined,
      logger: captureLogger(),
    });

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("episodic_event_unavailable");
    }
    expect(storeSpy).not.toHaveBeenCalled();
  });
});

describe("recordMemoryOnCommitmentSatisfied — failure isolation (invariant #15)", () => {
  it("catches storeEpisodic rejection, logs warn, and DOES NOT propagate", async () => {
    const failingStore: MemoryStore = {
      storeEpisodic: vi.fn(async () => {
        throw new Error("simulated sqlite I/O failure");
      }),
      storeSemantic: vi.fn(),
      recall: vi.fn(),
      list: vi.fn(),
      forget: vi.fn(),
    } as unknown as MemoryStore;
    const logger = captureLogger();

    const outcome = await recordMemoryOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      memoryStore: failingStore,
      episodicEvent: buildPersistentSessionEvent("msg-fail"),
      logger,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.reason).toBe("memory_write_error");
      expect(outcome.error).toBeInstanceOf(Error);
    }
    expect(failingStore.storeEpisodic).toHaveBeenCalledTimes(1);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]?.message).toMatch(/memory-write-on-satisfied/);
  });
});

describe("recordMemoryOnCommitmentSatisfied — payload contract (persistent_session.created)", () => {
  it("forwards the supplied effectId + payload verbatim and binds the resolved identityId", async () => {
    const store = new InMemoryMemoryStore();

    await recordMemoryOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      memoryStore: store,
      episodicEvent: {
        effectFamily: "persistent_session",
        effectId: "effect-zeta-1",
        payload: {
          messageRole: "user",
          messageText: "remember that I trade XAUUSD",
          messageId: "user-msg-zeta-1",
          occurredAt: "2026-05-05T13:00:00Z",
        },
      },
      logger: captureLogger(),
    });

    const listing = await store.list({ identityId: VLADIMIR });
    expect(listing.episodic).toHaveLength(1);
    const stored = listing.episodic[0]?.event;
    expect(stored).toMatchObject({
      identityId: VLADIMIR,
      effectFamily: "persistent_session",
      effectId: "effect-zeta-1",
      payload: {
        messageRole: "user",
        messageText: "remember that I trade XAUUSD",
        messageId: "user-msg-zeta-1",
        occurredAt: "2026-05-05T13:00:00Z",
      },
    });
  });
});

describe("recordMemoryOnCommitmentSatisfied — future effect families (inert switch slot)", () => {
  it("dispatches subagent.created as a no-op until slice G wires it", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    const logger = captureLogger();

    const outcome = await recordMemoryOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      memoryStore: store,
      episodicEvent: {
        effectFamily: "subagent",
        effectId: "subagent-1",
        payload: {
          subagentId: "sub-1",
          displayName: "test",
          occurredAt: VALID_ISO_TIMESTAMP,
        },
      },
      logger,
    });

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("effect_family_inert");
    }
    expect(storeSpy).not.toHaveBeenCalled();
  });

  it("dispatches reminder.set as a no-op until slice F/J wires it", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");

    const outcome = await recordMemoryOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      memoryStore: store,
      episodicEvent: {
        effectFamily: "reminder",
        effectId: "rem-1",
        payload: {
          reminderId: "rem-1",
          fireAt: VALID_ISO_TIMESTAMP,
          occurredAt: VALID_ISO_TIMESTAMP,
        },
      },
      logger: captureLogger(),
    });

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("effect_family_inert");
    }
    expect(storeSpy).not.toHaveBeenCalled();
  });

  it("dispatches artifact.created as a no-op until slice K wires it", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");

    const outcome = await recordMemoryOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      memoryStore: store,
      episodicEvent: {
        effectFamily: "artifact",
        effectId: "artifact-1",
        payload: {
          artifactId: "art-1",
          kind: "document",
          occurredAt: VALID_ISO_TIMESTAMP,
        },
      },
      logger: captureLogger(),
    });

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("effect_family_inert");
    }
    expect(storeSpy).not.toHaveBeenCalled();
  });
});
