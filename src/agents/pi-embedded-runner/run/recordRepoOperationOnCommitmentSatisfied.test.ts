/**
 * Cutover-4 Phase 5 — fail-first tests for the repo-operation memory hook.
 *
 * Mirrors the slice E (`memory-write-on-satisfied.test.ts`), slice F
 * (`task-write-on-satisfied.test.ts`), and Cutover-3
 * (`recordArtifactOnCommitmentSatisfied.test.ts`) shape. The hook is
 * invoked from the `memory-wiring.ts` fan-out after a `RuntimeAttestation`
 * surfaces with `commitmentSatisfied === true` AND `effectFamily === "repo"`.
 *
 * Tests assert:
 *   - real `InMemoryMemoryStore` round-trip;
 *   - reverse-coverage for every positive case (skipped/failed paths);
 *   - failure-isolation contract: store throw is `warn`-logged and
 *     SWALLOWED — the calling commitment turn STILL satisfies
 *     (invariant #15).
 *
 * The hook lights the slice E `EpisodicEffectFamily: "repo"` slot for
 * the FIRST time on `dev`.
 */

import { describe, expect, it, vi } from "vitest";

import { asIdentityId } from "../../../platform/identity/identity-id.js";
import { InMemoryMemoryStore } from "../../../platform/memory/in-memory-store.js";
import type { MemoryStore } from "../../../platform/memory/memory-store.js";

import {
  recordRepoOperationOnCommitmentSatisfied,
  type RepoWriteInput,
  type RepoWriteOnSatisfiedDeps,
  type RepoWriteOnSatisfiedLogger,
} from "./recordRepoOperationOnCommitmentSatisfied.js";
import type { CommitmentSatisfiedAttestationLike } from "./memory-write-on-satisfied.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const VALID_ISO_TIMESTAMP = "2026-05-07T12:34:56.000Z";

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

function buildInput(overrides: Partial<RepoWriteInput> = {}): RepoWriteInput {
  return {
    repoOperationId: "repo:branch:test-1",
    kind: "branch_created",
    branchName: "feature/x",
    occurredAt: VALID_ISO_TIMESTAMP,
    ...overrides,
  };
}

function captureLogger(): RepoWriteOnSatisfiedLogger & {
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

describe("recordRepoOperationOnCommitmentSatisfied — happy path", () => {
  it("writes an episodic entry tagged effectFamily=repo and returns its MemoryEntryId", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    const deps: RepoWriteOnSatisfiedDeps = {
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      repoInput: buildInput(),
      effectFamily: "repo",
      logger: captureLogger(),
    };

    const outcome = await recordRepoOperationOnCommitmentSatisfied(deps);

    expect(outcome.kind).toBe("written");
    expect(storeSpy).toHaveBeenCalledTimes(1);
    expect(storeSpy.mock.calls[0]?.[0]).toMatchObject({
      identityId: VLADIMIR,
      effectFamily: "repo",
      payload: {
        repoOperationId: "repo:branch:test-1",
        kind: "branch_created",
        branchName: "feature/x",
      },
    });

    const listed = await store.list({ identityId: VLADIMIR });
    expect(listed.episodic).toHaveLength(1);
    expect(listed.episodic[0]?.event.effectFamily).toBe("repo");
  });
});

describe("recordRepoOperationOnCommitmentSatisfied — reverse: commitmentSatisfied=false", () => {
  it("does NOT call storeEpisodic when attestation rejects the commitment", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    const outcome = await recordRepoOperationOnCommitmentSatisfied({
      attestation: buildUnsatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      repoInput: buildInput(),
      effectFamily: "repo",
      logger: captureLogger(),
    });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("commitment_unsatisfied");
    }
    expect(storeSpy).not.toHaveBeenCalled();
  });
});

describe("recordRepoOperationOnCommitmentSatisfied — reverse: non-repo families are no-ops", () => {
  it.each([
    "communication",
    "persistent_session",
    "web_research",
    "task",
    "artifact",
  ] as const)("skips when effectFamily=%s", async (family) => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    const outcome = await recordRepoOperationOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      repoInput: buildInput(),
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

describe("recordRepoOperationOnCommitmentSatisfied — defensive guards", () => {
  it("skips when effectFamily flag is missing (no crash, no write)", async () => {
    const store = new InMemoryMemoryStore();
    const outcome = await recordRepoOperationOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      repoInput: buildInput(),
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
    const outcome = await recordRepoOperationOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: undefined,
      memoryStore: store,
      repoInput: buildInput(),
      effectFamily: "repo",
      logger: captureLogger(),
    });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("identity_unresolved");
    }
  });

  it("skips with memory_store_unavailable when store is undefined (no crash)", async () => {
    const logger = captureLogger();
    const outcome = await recordRepoOperationOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: undefined,
      repoInput: buildInput(),
      effectFamily: "repo",
      logger,
    });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("memory_store_unavailable");
    }
    expect(logger.warns).toHaveLength(0);
  });

  it("skips with repo_input_unavailable when repoInput is undefined", async () => {
    const store = new InMemoryMemoryStore();
    const outcome = await recordRepoOperationOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      repoInput: undefined,
      effectFamily: "repo",
      logger: captureLogger(),
    });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("repo_input_unavailable");
    }
  });
});

describe("recordRepoOperationOnCommitmentSatisfied — payload contract", () => {
  it("forwards repoInput verbatim into RepoOperationCompletedPayload", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    await recordRepoOperationOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      repoInput: buildInput({
        repoOperationId: "repo:commit:42",
        kind: "commit_landed",
        branchName: "feature/x",
        commitSha: "abc1234",
        occurredAt: VALID_ISO_TIMESTAMP,
        effectId: "repo.commit_landed",
      }),
      effectFamily: "repo",
      logger: captureLogger(),
    });
    expect(storeSpy.mock.calls[0]?.[0]).toMatchObject({
      effectFamily: "repo",
      effectId: "repo.commit_landed",
      payload: {
        repoOperationId: "repo:commit:42",
        kind: "commit_landed",
        branchName: "feature/x",
        commitSha: "abc1234",
        occurredAt: VALID_ISO_TIMESTAMP,
      },
    });
  });

  it("synthesises effectId when caller omits it", async () => {
    const store = new InMemoryMemoryStore();
    const storeSpy = vi.spyOn(store, "storeEpisodic");
    await recordRepoOperationOnCommitmentSatisfied({
      attestation: buildSatisfied(),
      identityId: VLADIMIR,
      memoryStore: store,
      repoInput: buildInput({ repoOperationId: "repo:diff:99", kind: "diff_observed" }),
      effectFamily: "repo",
      logger: captureLogger(),
    });
    expect(storeSpy.mock.calls[0]?.[0]).toMatchObject({
      effectId: "repo:repo:diff:99:completed",
    });
  });
});

describe("recordRepoOperationOnCommitmentSatisfied — failure isolation (invariant #15)", () => {
  it("returns failed when storeEpisodic throws AND warn-logs AND does NOT re-throw", async () => {
    const failingStore: MemoryStore = {
      storeEpisodic: async () => {
        throw new Error("backend down");
      },
      storeSemantic: async () => {
        throw new Error("not used");
      },
      list: async () => ({ episodic: [], semantic: [] }),
      recall: async () => ({ episodic: [], semantic: [] }),
    } as unknown as MemoryStore;
    const logger = captureLogger();

    let thrown: unknown;
    let outcome:
      | Awaited<ReturnType<typeof recordRepoOperationOnCommitmentSatisfied>>
      | undefined;
    try {
      outcome = await recordRepoOperationOnCommitmentSatisfied({
        attestation: buildSatisfied(),
        identityId: VLADIMIR,
        memoryStore: failingStore,
        repoInput: buildInput(),
        effectFamily: "repo",
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
