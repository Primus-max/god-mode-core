/**
 * Cutover-3 Phase 5 — fail-first tests for the artifact memory hook.
 *
 * Mirrors the slice E (`memory-write-on-satisfied.test.ts`) and slice
 * F (`task-write-on-satisfied.test.ts`) shape:
 *
 * - real `InMemoryMemoryStore` (no `vi.spyOn` on the function under
 *   test);
 * - reverse-coverage for every positive case (no-op when conditions
 *   miss);
 * - failure-isolation contract: artifact-write throw is logged warn
 *   and SWALLOWED — `commitment STILL satisfies` per invariant #15.
 *
 * The hook lights the slice E `EpisodicEffectFamily: "artifact"` slot
 * for the first time on `dev` (hence "first emit site" in the
 * sub-plan). Wiring is exercised in
 * `src/platform/decision/memory-wiring.test.ts`; this file isolates
 * the hook surface.
 */

import { describe, expect, it, vi } from "vitest";

import { asIdentityId } from "../../../platform/identity/identity-id.js";
import { InMemoryMemoryStore } from "../../../platform/memory/in-memory-store.js";
import type { MemoryStore } from "../../../platform/memory/memory-store.js";

import {
  recordArtifactOnCommitmentSatisfied,
  type ArtifactWriteInput,
  type ArtifactWriteOnSatisfiedDeps,
  type ArtifactWriteOnSatisfiedLogger,
} from "./recordArtifactOnCommitmentSatisfied.js";
import type { CommitmentSatisfiedAttestationLike } from "./memory-write-on-satisfied.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const VALID_ISO_TIMESTAMP = "2026-05-06T12:34:56.000Z";

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
  overrides: Partial<ArtifactWriteInput> = {},
): ArtifactWriteInput {
  return {
    artifactId: "artifact:pdf:test-1",
    kind: "pdf",
    occurredAt: VALID_ISO_TIMESTAMP,
    ...overrides,
  };
}

function captureLogger(): ArtifactWriteOnSatisfiedLogger & {
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

describe("recordArtifactOnCommitmentSatisfied — happy path (artifact.created)", () => {
  it("writes an episodic entry tagged effectFamily=artifact and returns its MemoryEntryId", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    const deps: ArtifactWriteOnSatisfiedDeps = {
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      artifactInput: buildInput(),
      effectFamily: "artifact",
      logger: captureLogger(),
    };

    const outcome = await recordArtifactOnCommitmentSatisfied(deps);

    expect(outcome.kind).toBe("written");
    expect(storeSpy).toHaveBeenCalledTimes(1);
    expect(storeSpy.mock.calls[0]?.[0]).toMatchObject({
      identityId: VLADIMIR,
      effectFamily: "artifact",
      payload: { artifactId: "artifact:pdf:test-1", kind: "pdf" },
    });

    const listed = await store.list({ identityId: VLADIMIR });
    expect(listed.episodic).toHaveLength(1);
    expect(listed.episodic[0]?.event.effectFamily).toBe("artifact");
  });
});

describe("recordArtifactOnCommitmentSatisfied — reverse: commitmentSatisfied=false", () => {
  it("does NOT call storeEpisodic when attestation rejects the commitment", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    const outcome = await recordArtifactOnCommitmentSatisfied({
      attestation: buildUnsatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      artifactInput: buildInput(),
      effectFamily: "artifact",
      logger: captureLogger(),
    });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("commitment_unsatisfied");
    }
    expect(storeSpy).not.toHaveBeenCalled();
  });
});

describe("recordArtifactOnCommitmentSatisfied — reverse: non-artifact families are no-ops", () => {
  it.each(["communication", "persistent_session", "web_research", "task"] as const)(
    "skips when effectFamily=%s",
    async (family) => {
      const store = new InMemoryMemoryStore();
      const storeSpy = vi.spyOn(store, "storeEpisodic");
      const outcome = await recordArtifactOnCommitmentSatisfied({
        attestation: buildSatisfied(),
        identityId: VLADIMIR,
        memoryStore: store,
        artifactInput: buildInput(),
        effectFamily: family,
        logger: captureLogger(),
      });
      expect(outcome.kind).toBe("skipped");
      if (outcome.kind === "skipped") {
        expect(outcome.reason).toBe("effect_family_mismatch");
      }
      expect(storeSpy).not.toHaveBeenCalled();
    },
  );
});

describe("recordArtifactOnCommitmentSatisfied — defensive guards", () => {
  it("skips when effectFamily flag is missing (no crash, no write)", async () => {
    const store = new InMemoryMemoryStore();
    const outcome = await recordArtifactOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      artifactInput: buildInput(),
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
    const outcome = await recordArtifactOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: undefined,
      memoryStore: store,
      artifactInput: buildInput(),
      effectFamily: "artifact",
      logger: captureLogger(),
    });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("identity_unresolved");
    }
  });

  it("skips with memory_store_unavailable when store is undefined (no crash)", async () => {
    const logger = captureLogger();
    const outcome = await recordArtifactOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: undefined,
      artifactInput: buildInput(),
      effectFamily: "artifact",
      logger,
    });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("memory_store_unavailable");
    }
    expect(logger.warns).toHaveLength(0);
  });

  it("skips with artifact_input_unavailable when artifactInput is undefined", async () => {
    const store = new InMemoryMemoryStore();
    const outcome = await recordArtifactOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      artifactInput: undefined,
      effectFamily: "artifact",
      logger: captureLogger(),
    });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("artifact_input_unavailable");
    }
  });
});

describe("recordArtifactOnCommitmentSatisfied — payload contract", () => {
  it("forwards artifactInput verbatim into ArtifactCreatedPayload", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    await recordArtifactOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      artifactInput: buildInput({
        artifactId: "artifact:image:42",
        kind: "image",
        occurredAt: VALID_ISO_TIMESTAMP,
        effectId: "image.created",
      }),
      effectFamily: "artifact",
      logger: captureLogger(),
    });
    expect(storeSpy.mock.calls[0]?.[0]).toMatchObject({
      effectFamily: "artifact",
      effectId: "image.created",
      payload: {
        artifactId: "artifact:image:42",
        kind: "image",
        occurredAt: VALID_ISO_TIMESTAMP,
      },
    });
  });

  it("synthesises effectId when caller omits it", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    await recordArtifactOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      artifactInput: buildInput({ artifactId: "artifact:docx:99", kind: "docx" }),
      effectFamily: "artifact",
      logger: captureLogger(),
    });
    expect(storeSpy.mock.calls[0]?.[0]).toMatchObject({
      effectId: "artifact:artifact:docx:99:created",
    });
  });
});

describe("recordArtifactOnCommitmentSatisfied — failure isolation (invariant #15)", () => {
  it("returns failed when memoryStore.storeEpisodic throws AND warn-logs the error AND does NOT re-throw", async () => {
    const failingStore: MemoryStore = {
      storeEpisodic: async () => {
        throw new Error("backend down");
      },
      storeSemantic: async () => {
        throw new Error("not used");
      },
      // The hook only touches storeEpisodic; provide minimal stubs
      // for the rest of the contract.
      list: async () => ({ episodic: [], semantic: [] }),
      recall: async () => ({ episodic: [], semantic: [] }),
    } as unknown as MemoryStore;
    const logger = captureLogger();

    let thrown: unknown;
    let outcome: Awaited<ReturnType<typeof recordArtifactOnCommitmentSatisfied>> | undefined;
    try {
      outcome = await recordArtifactOnCommitmentSatisfied({
        attestation: buildSatisfied(),
        identityId: VLADIMIR,
        memoryStore: failingStore,
        artifactInput: buildInput(),
        effectFamily: "artifact",
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
