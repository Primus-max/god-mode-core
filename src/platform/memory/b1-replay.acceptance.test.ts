import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { recordMemoryOnCommitmentSatisfied } from "../../agents/pi-embedded-runner/run/memory-write-on-satisfied.js";
import {
  PERSISTENT_SESSION_EFFECT_FAMILY,
  type ExpectedDelta,
  type IntentContractorAdapter,
  type IntentContractorAdapterRegistry,
  type RuntimeAttestation,
} from "../commitment/index.js";
import type { AgentId, SessionId } from "../commitment/ids.js";
import type { SemanticIntent } from "../commitment/semantic-intent.js";
import { asIdentityId, type IdentityId } from "../identity/identity-id.js";
import {
  StaticIdentityRegistry,
} from "../identity/static-identity-registry.js";
import { resolveIdentityFromSessionKey } from "../identity/resolve-identity.js";
import {
  SqliteVecMemoryStore,
  type MemoryEmbedder,
  type SqliteVecMemoryStoreLogger,
} from "./sqlite-vec-store.js";
import type { MemoryStore } from "./memory-store.js";
import { runTurnDecision } from "../decision/run-turn-decision.js";
import type { TaskClassifierAdapter, TaskContract } from "../decision/task-classifier.js";

/**
 * Slice E Phase 7 — B1 replay end-to-end acceptance fixture.
 *
 * Closes B1 ("memory does not persist across `/new`") in fixture mode:
 * the live-verify replay against a real Telegram log is a v1-release
 * acceptance step, not this slice. Here we prove the wiring with:
 *
 *   - real `SqliteVecMemoryStore` against a tmp-dir sqlite file (proves
 *     persistence across the simulated process boundary — the store is
 *     closed and reopened between turns 1 and 2);
 *   - stubbed embedder (deterministic vector based on SHA-1 of the
 *     content — same pattern as the Phase-3 sqlite-vec test);
 *   - stubbed `IntentContractorAdapter` whose `classify` records the
 *     prompt it sees and returns a fixed `SemanticIntent`. This is the
 *     ONLY spy in the fixture: the adapter is the LLM seam, not the
 *     contractor under test.
 *   - real `runTurnDecision` for both turns — proving the production
 *     wiring (memoryStore + identityId threaded into
 *     `createIntentContractor`, onAttestation forwarding the
 *     attestation to the Phase-5 hook).
 *
 * Acceptance, per sub-plan §4 + §5 Phase 7:
 *
 *   1. Turn-2 surfaces the reminder planted in turn-1, despite the
 *      in-process cache having been cleared (store closed + reopened).
 *      The adapter prompt for turn-2 contains a `<memory>` block whose
 *      JSON encoding includes the reminder content. (positive)
 *
 *   2. Anonymous session does NOT recall — when no `identityId` is
 *      passed, turn-2 sees no `<memory>` block. (negative)
 *
 *   3. `commitmentSatisfied=false` does NOT write memory — the Phase-5
 *      hook's `onAttestation` callback returns `kind:'skipped'` and
 *      the store remains empty. (reverse)
 *
 *   4. Reverse-test absence-of-fix: a manual override of the wiring
 *      (passing `memoryStore: undefined` into the contractor) produces
 *      the legacy behaviour — turn-2 sees no `<memory>` block — proving
 *      the wiring is what carries the recall, not some unrelated path.
 *
 * Per AGENTS.md test discipline: no `vi.spyOn` on the function under
 * test (`createIntentContractor` / `recordMemoryOnCommitmentSatisfied`).
 * Spies live only on the injected LLM adapter + embedder.
 */

const VLADIMIR = asIdentityId("identity:vladimir");
const VECTOR_DIMS = 32;

const REMINDER_TEXT = "remind me to drink water tomorrow at 9am";
const RECALL_PROMPT = "какие у меня напоминания";

function createStubEmbedder(): MemoryEmbedder {
  return {
    embed(text: string): Promise<Float32Array> {
      const digest = createHash("sha1").update(text).digest();
      const out = new Float32Array(VECTOR_DIMS);
      for (let i = 0; i < VECTOR_DIMS; i += 1) {
        const byte = digest[i % digest.length] ?? 0;
        out[i] = (byte - 128) / 128;
      }
      return Promise.resolve(out);
    },
  };
}

function createCapturingLogger(): SqliteVecMemoryStoreLogger & {
  readonly warnings: readonly string[];
} {
  const warnings: string[] = [];
  return {
    warn(message: string) {
      warnings.push(message);
    },
    get warnings() {
      return warnings;
    },
  };
}

const cfg = (): OpenClawConfig =>
  ({
    agents: {
      defaults: {
        embeddedPi: {
          taskClassifier: { backend: "legacy-mock" },
          intentContractor: { backend: "intent-mock" },
          commitment: { cutoverEnabled: true },
        },
      },
    },
  } as OpenClawConfig);

const legacyContract: TaskContract = {
  primaryOutcome: "answer",
  requiredCapabilities: [],
  interactionMode: "respond_only",
  confidence: 0.9,
  ambiguities: [],
};

function legacyAdapter(): TaskClassifierAdapter {
  return {
    classify: vi.fn(async () => legacyContract),
  };
}

/**
 * Build an `IntentContractorAdapter` that records every prompt it
 * receives and returns a `persistent_session.<op>` intent. The
 * recorded prompts are what the test asserts against — the adapter
 * stands in for the production LLM call.
 */
function recordingIntentAdapter(operation: "create" | "observe"): {
  readonly adapter: IntentContractorAdapter;
  readonly capturedPrompts: string[];
} {
  const capturedPrompts: string[] = [];
  const adapter: IntentContractorAdapter = {
    classify: vi.fn(async (params): Promise<SemanticIntent> => {
      capturedPrompts.push(params.prompt);
      return {
        desiredEffectFamily: PERSISTENT_SESSION_EFFECT_FAMILY,
        target: { kind: "session" },
        operation: { kind: operation },
        constraints: {},
        uncertainty: [],
        confidence: 0.9,
      };
    }),
  };
  return { adapter, capturedPrompts };
}

const expectedDelta: ExpectedDelta = {
  sessions: {
    followupRegistry: {
      added: [
        {
          sessionId: "agent:worker:main" as SessionId,
          agentId: "worker" as AgentId,
        },
      ],
    },
  },
};

function buildSatisfiedAttestation(): RuntimeAttestation {
  return {
    commitmentSatisfied: true,
    terminalState: "action_completed",
    acceptanceReason: "commitment_satisfied",
    stateBefore: {},
    stateAfter: {},
    satisfaction: { satisfied: true, evidence: [] },
  };
}

function buildUnsatisfiedAttestation(): RuntimeAttestation {
  return {
    commitmentSatisfied: false,
    terminalState: "rejected",
    acceptanceReason: "commitment_unsatisfied",
    stateBefore: {},
    stateAfter: {},
    satisfaction: { satisfied: false, missing: ["evidence_missing"] },
  };
}

describe("Slice E Phase 7 — B1 replay end-to-end acceptance fixture", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "openclaw-b1-replay-"));
    dbPath = path.join(tmpDir, "identity-memory.sqlite");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — Windows can hold an open DB handle for a
      // moment after `close()`. The test runner does not depend on
      // cleanup; CI's tmpdir is wiped between jobs.
    }
  });

  it("turn-2 surfaces the reminder planted in turn-1 across a simulated process boundary", async () => {
    // ----- TURN 1 — write memory on commitmentSatisfied -----
    const writeStore = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
      logger: createCapturingLogger(),
    });

    const monitoredRuntime = {
      run: vi.fn(async () => buildSatisfiedAttestation()),
    };
    const turn1Adapter = recordingIntentAdapter("create");

    // The `onAttestation` callback wires the Phase-5 episodic hook
    // AND emits a semantic write encoding the reminder content. The
    // semantic write is what the Phase-6 contractor recall surfaces in
    // turn 2; in production this is the slice-J wiring point (cron
    // tool emits both episodic + semantic memory on commitment), but
    // for the slice E acceptance fixture we emit them inline.
    const onAttestation = async (attestation: RuntimeAttestation) => {
      await recordMemoryOnCommitmentSatisfied({
        attestation,
        identityId: VLADIMIR,
        memoryStore: writeStore,
        episodicEvent: {
          effectFamily: "persistent_session",
          effectId: `effect-${Date.now()}`,
          payload: {
            messageRole: "user",
            messageText: REMINDER_TEXT,
            messageId: "msg-001",
            occurredAt: new Date().toISOString(),
          },
        },
        logger: { warn: () => {}, debug: () => {} },
      });
      // Slice J / cron wiring will emit a semantic entry here when the
      // cron family is wired; for the fixture we do it inline so the
      // Phase-6 recall has something to find.
      if (attestation.commitmentSatisfied) {
        await writeStore.storeSemantic({
          identityId: VLADIMIR,
          content: REMINDER_TEXT,
          metadata: { source: "cron_fixture", kind: "reminder" },
        });
      }
    };

    await runTurnDecision({
      prompt: REMINDER_TEXT,
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": turn1Adapter.adapter },
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      memoryStore: writeStore,
      identityId: VLADIMIR,
      onAttestation,
    });

    // Sanity: memory was actually written (proves turn 1 produced state).
    const turn1List = await writeStore.list({ identityId: VLADIMIR });
    expect(turn1List.episodic.length).toBeGreaterThanOrEqual(1);
    expect(turn1List.semantic.length).toBeGreaterThanOrEqual(1);
    await writeStore.close();

    // ----- SIMULATE /new — close + reopen the store on a new instance.
    // This is the in-fixture analogue of the live B1 symptom: a fresh
    // process must surface the same memory because it persists in
    // sqlite, not in-process state.
    const readStore: MemoryStore = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
      logger: createCapturingLogger(),
    });

    // ----- TURN 2 — recall surfaces the reminder in the contractor prompt -----
    const turn2Adapter = recordingIntentAdapter("observe");
    await runTurnDecision({
      prompt: RECALL_PROMPT,
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": turn2Adapter.adapter },
      monitoredRuntime: { run: vi.fn(async () => buildSatisfiedAttestation()) },
      expectedDeltaResolver: () => expectedDelta,
      memoryStore: readStore,
      identityId: VLADIMIR,
    });

    expect(turn2Adapter.capturedPrompts).toHaveLength(1);
    const turn2Prompt = turn2Adapter.capturedPrompts[0] ?? "";
    // The fix-mode assertion: the contractor's adapter sees the
    // reminder text inside a `<memory>` block prepended to the raw user
    // prompt. Without the wiring this fails because the contractor
    // never receives the recalled memory.
    expect(turn2Prompt).toContain("<memory>");
    expect(turn2Prompt).toContain(REMINDER_TEXT);
    // The raw prompt is still present after the memory block
    // (mirrors the `<web_evidence>` prepend pattern).
    expect(turn2Prompt).toContain(RECALL_PROMPT);

    await (readStore as SqliteVecMemoryStore).close();
  });

  it("anonymous session — no identityId means no `<memory>` block (negative coverage)", async () => {
    const store = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
      logger: createCapturingLogger(),
    });

    // Plant a semantic entry for VLADIMIR so the store has something
    // to recall — the test is whether an anonymous turn STILL pulls
    // it (it must NOT, per invariant: cross-operator memory leak).
    await store.storeSemantic({
      identityId: VLADIMIR,
      content: REMINDER_TEXT,
      metadata: { source: "fixture" },
    });

    const turn = recordingIntentAdapter("observe");
    await runTurnDecision({
      prompt: RECALL_PROMPT,
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": turn.adapter },
      monitoredRuntime: { run: vi.fn(async () => buildSatisfiedAttestation()) },
      expectedDeltaResolver: () => expectedDelta,
      memoryStore: store,
      // identityId intentionally absent — anonymous session.
    });

    expect(turn.capturedPrompts).toHaveLength(1);
    const prompt = turn.capturedPrompts[0] ?? "";
    expect(prompt).not.toContain("<memory>");
    expect(prompt).not.toContain(REMINDER_TEXT);
    expect(prompt).toContain(RECALL_PROMPT);

    await store.close();
  });

  it("commitmentSatisfied=false does NOT write memory (reverse coverage)", async () => {
    const store = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
      logger: createCapturingLogger(),
    });

    let onAttestationCalls = 0;
    let semanticWrites = 0;
    const onAttestation = async (attestation: RuntimeAttestation) => {
      onAttestationCalls += 1;
      const outcome = await recordMemoryOnCommitmentSatisfied({
        attestation,
        identityId: VLADIMIR,
        memoryStore: store,
        episodicEvent: {
          effectFamily: "persistent_session",
          effectId: "effect-bad",
          payload: {
            messageRole: "user",
            messageText: REMINDER_TEXT,
            messageId: "msg-bad",
            occurredAt: new Date().toISOString(),
          },
        },
        logger: { warn: () => {}, debug: () => {} },
      });
      // The Phase 5 hook MUST skip on commitmentUnsatisfied.
      expect(outcome.kind).toBe("skipped");
      // And the call site MUST gate the semantic emit on the same
      // boolean — production cron-family hooks will mirror this shape.
      if (attestation.commitmentSatisfied) {
        semanticWrites += 1;
        await store.storeSemantic({
          identityId: VLADIMIR,
          content: REMINDER_TEXT,
        });
      }
    };

    const adapter = recordingIntentAdapter("create");
    await runTurnDecision({
      prompt: REMINDER_TEXT,
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": adapter.adapter },
      monitoredRuntime: {
        run: vi.fn(async () => buildUnsatisfiedAttestation()),
      },
      expectedDeltaResolver: () => expectedDelta,
      memoryStore: store,
      identityId: VLADIMIR,
      onAttestation,
    });

    expect(onAttestationCalls).toBe(1);
    expect(semanticWrites).toBe(0);

    const list = await store.list({ identityId: VLADIMIR });
    expect(list.episodic).toEqual([]);
    expect(list.semantic).toEqual([]);

    await store.close();
  });

  it("reverse-test: omitting memoryStore from the contractor wiring reproduces B1 absence-of-fix", async () => {
    // Plant a semantic entry that COULD be recalled if the wiring were
    // active.
    const store = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
      logger: createCapturingLogger(),
    });
    await store.storeSemantic({
      identityId: VLADIMIR,
      content: REMINDER_TEXT,
      metadata: { source: "fixture" },
    });

    const turn = recordingIntentAdapter("observe");
    await runTurnDecision({
      prompt: RECALL_PROMPT,
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": turn.adapter },
      monitoredRuntime: { run: vi.fn(async () => buildSatisfiedAttestation()) },
      expectedDeltaResolver: () => expectedDelta,
      // memoryStore intentionally omitted — this is the absence-of-fix
      // shape (and the shape of `runTurnDecision` callers BEFORE this
      // slice). Even with `identityId` set, no recall happens.
      identityId: VLADIMIR,
    });

    const prompt = turn.capturedPrompts[0] ?? "";
    expect(prompt).not.toContain("<memory>");
    expect(prompt).not.toContain(REMINDER_TEXT);

    await store.close();
  });

  it("IdentityRegistry resolves a session-key to the operator used for recall", async () => {
    // Smoke that the production identity-resolution helper threads
    // cleanly into the same fixture — proves the `IdentityRegistry`
    // boundary point in the spec (mapping vladimir → telegram chatId
    // 123 / webchat session web-1) ends in the same `IdentityId`
    // brand that the recall hook consumes.
    const registry = new StaticIdentityRegistry({
      records: [
        {
          identityId: VLADIMIR,
          displayName: "Vladimir",
          mappings: [
            { channel: "telegram", externalId: "123" },
            { channel: "webchat", externalId: "web-1" },
          ],
        },
      ],
    });

    // Telegram-shaped agent session key per `routing/session-key.ts`.
    const tgKey = "agent:worker:telegram:direct:123";
    const wcKey = "agent:worker:webchat:direct:web-1";
    const fromTg: IdentityId | undefined = resolveIdentityFromSessionKey(tgKey, registry);
    const fromWc: IdentityId | undefined = resolveIdentityFromSessionKey(wcKey, registry);
    expect(fromTg).toBe(VLADIMIR);
    expect(fromWc).toBe(VLADIMIR);

    // Unmapped peer → undefined (anonymous session).
    expect(resolveIdentityFromSessionKey("agent:worker:telegram:direct:999", registry)).toBeUndefined();
  });
});
