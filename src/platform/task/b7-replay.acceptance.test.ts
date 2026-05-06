import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "../../config/config.js";
import { recordTaskOnCommitmentSatisfied } from "../../agents/pi-embedded-runner/run/task-write-on-satisfied.js";
import {
  PERSISTENT_SESSION_EFFECT_FAMILY,
  type ExpectedDelta,
  type IntentContractorAdapter,
  type RuntimeAttestation,
} from "../commitment/index.js";
import type { AgentId, SessionId } from "../commitment/ids.js";
import type { SemanticIntent } from "../commitment/semantic-intent.js";
import { runTurnDecision } from "../decision/run-turn-decision.js";
import type {
  TaskClassifierAdapter,
  TaskContract,
} from "../decision/task-classifier.js";
import { asIdentityId, type IdentityId } from "../identity/identity-id.js";
import {
  StaticIdentityRegistry,
} from "../identity/static-identity-registry.js";
import { resolveIdentityFromSessionKey } from "../identity/resolve-identity.js";
import { InMemoryMemoryStore } from "../memory/in-memory-store.js";

import { SqliteTaskLedger } from "./sqlite-task-ledger.js";

/**
 * Slice F Phase 7 — B7 replay end-to-end acceptance fixture.
 *
 * Closes B7 ("per-user multi-task tracking survives `/new`") in
 * fixture mode. Live-verify against a real Telegram session is the
 * v1-release acceptance step (master roadmap §5), not this slice.
 * Mirrors slice E PR-#170 (`b1-replay.acceptance.test.ts`).
 *
 * Architecture choices (sub-plan §5 Phase 7):
 *
 *   - **TaskLedger**: real `SqliteTaskLedger` against a tmp-dir
 *     sqlite file. Turn 1 writes via the Phase-5 hook
 *     (`recordTaskOnCommitmentSatisfied`) directly; turn 2 reads via
 *     a SECOND `SqliteTaskLedger` instance opened against the SAME
 *     file path. Two distinct instances pointing at one file proves
 *     persistence is on disk, not in process memory.
 *
 *   - **MemoryStore**: `InMemoryMemoryStore` (NOT `SqliteVecMemoryStore`).
 *     Rationale: the Phase-5 task hook ALSO writes an episodic event
 *     for cross-reference, but the slice F closure under test (B7) is
 *     about TASK persistence — the contractor's `<active_tasks>` recall
 *     reads ONLY the ledger, not the episodic store. Standing up a real
 *     SqliteVecMemoryStore would require a deterministic embedder stub
 *     plus a tmp-dir lifecycle; for this fixture an in-process episodic
 *     sink is sufficient (the slice E B1-replay fixture already covers
 *     SqliteVec round-trip end-to-end, so this fixture does not need to
 *     re-prove that path). Episodic write-success is asserted via
 *     `store.list({ identityId, effectFamily: "task" })`.
 *
 *   - **LLM adapter**: stubbed `IntentContractorAdapter` whose
 *     `classify` records the prompt it sees and returns a fixed
 *     `SemanticIntent`. This is the single LLM seam — the test asserts
 *     against the captured prompt to verify the `<active_tasks>` block
 *     was injected by the contractor.
 *
 *   - **Identity**: real `StaticIdentityRegistry` mapping
 *     `identity:vladimir` to one telegram + one webchat session,
 *     resolved via the production `resolveIdentityFromSessionKey`
 *     helper. Mirrors slice E B1-replay smoke.
 *
 * Acceptance per sub-plan §4 + §5 Phase 7:
 *
 *   1. **Positive B7 closure**: turn 1 fires
 *      `recordTaskOnCommitmentSatisfied` with a `kind: "created"`
 *      `TaskWriteInput`; ledger row lands. Turn 2 (simulating `/new`)
 *      constructs a FRESH `SqliteTaskLedger` against the same file path
 *      and runs `runTurnDecision` with `taskLedger` + `identityId`
 *      threaded through. The contractor adapter's captured prompt
 *      contains an `<active_tasks>` block whose JSON encoding includes
 *      the planted task's label.
 *
 *   2. **Reverse — omit `taskLedger`**: turn 2 contractor wired
 *      WITHOUT `taskLedger`. Captured prompt has NO `<active_tasks>`
 *      block (proves the wiring is what carries the closure).
 *
 *   3. **Reverse — anonymous session**: turn 2 with NO `identityId`.
 *      Recall is skipped at the contractor seam; captured prompt has
 *      no `<active_tasks>` block.
 *
 *   4. **Reverse — `commitmentSatisfied=false`**: turn 1 hook fires
 *      with an unsatisfied attestation. Hook returns
 *      `{ kind: "skipped", reason: "commitment_unsatisfied" }`; no
 *      ledger row is written; turn 2 sees no `<active_tasks>` block.
 *
 *   5. **Identity smoke**: same shape as slice E B1-replay — mapping
 *      a session-key through `StaticIdentityRegistry` resolves to the
 *      same `IdentityId` brand the hook + recall consume.
 *
 * Per AGENTS.md test discipline: no `vi.spyOn` on the function under
 * test (`recordTaskOnCommitmentSatisfied`, `createIntentContractor`).
 * Spies live only on the injected LLM adapter + classifier.
 */

const VLADIMIR = asIdentityId("identity:vladimir");

const TASK_LABEL = "Refactor PDF export pipeline";
const TASK_SUMMARY =
  "Convert the legacy ReportLab path to WeasyPrint and verify locale parity";
const RECALL_PROMPT = "какая моя последняя задача?";

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

type CapturingLogger = {
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
};

function captureLogger(): {
  readonly logger: CapturingLogger;
  readonly warnings: ReadonlyArray<{ message: string; meta?: Record<string, unknown> }>;
} {
  const warnings: { message: string; meta?: Record<string, unknown> }[] = [];
  return {
    logger: {
      warn(message, meta) {
        warnings.push({ message, ...(meta ? { meta } : {}) });
      },
      debug() {
        /* drop */
      },
    },
    get warnings() {
      return warnings;
    },
  };
}

describe("Slice F Phase 7 — B7 replay end-to-end acceptance fixture", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "openclaw-b7-replay-"));
    dbPath = path.join(tmpDir, "identity-task-ledger.sqlite");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — Windows may briefly hold an open DB
      // handle after `close()`. Test runner does not depend on cleanup;
      // CI's tmpdir is wiped between jobs.
    }
  });

  it("turn-2 surfaces the task planted in turn-1 across a simulated /new boundary", async () => {
    // ----- TURN 1 — write via the Phase-5 hook directly -----
    // The hook is the wiring's `onAttestation` callback; we invoke it
    // here with a hand-built `task.created` write input rather than
    // driving a full `runTurnDecision` for turn 1, because the hook is
    // the seam that carries the closure (slice F Phase 5 contract).
    const writeLedger = await SqliteTaskLedger.open({ dbPath });
    const writeStore = new InMemoryMemoryStore();
    const writeLog = captureLogger();

    const createOutcome = await recordTaskOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      taskLedger: writeLedger,
      memoryStore: writeStore,
      taskInput: {
        kind: "created",
        label: TASK_LABEL,
        summary: TASK_SUMMARY,
        occurredAt: new Date().toISOString(),
        sourceEffectFamily: "task",
        sourceEffectId: "task:fixture-001",
      },
      logger: writeLog.logger,
    });
    expect(createOutcome.kind).toBe("wrote");
    if (createOutcome.kind !== "wrote") {
      throw new Error("turn-1 hook did not write");
    }
    expect(createOutcome.taskId).toMatch(/^task:/u);

    // Sanity: ledger row is on disk under VLADIMIR.
    const turn1List = await writeLedger.list({ ownerIdentityId: VLADIMIR });
    expect(turn1List.tasks).toHaveLength(1);
    expect(turn1List.tasks[0]?.label).toBe(TASK_LABEL);
    expect(turn1List.tasks[0]?.status).toBe("open");

    // Cross-reference: episodic event landed under family "task".
    const episodicListing = await writeStore.list({
      identityId: VLADIMIR,
      effectFamily: "task",
    });
    expect(episodicListing.episodic).toHaveLength(1);
    expect(episodicListing.episodic[0]?.event.payload).toMatchObject({
      kind: "created",
      taskId: createOutcome.taskId,
    });

    await writeLedger.close();

    // ----- SIMULATE /new — open a SECOND ledger instance on the same DB.
    // The slice F closure is the persistent ledger row surviving the
    // simulated process boundary. A fresh `SqliteTaskLedger` against the
    // same file path is the in-fixture analogue of restarting the
    // gateway after the user said `/new`.
    const readLedger = await SqliteTaskLedger.open({ dbPath });

    // Sanity: the planted row is visible from the fresh instance BEFORE
    // turn 2 runs — proves persistence is not in-process state.
    const reopenList = await readLedger.list({ ownerIdentityId: VLADIMIR });
    expect(reopenList.tasks).toHaveLength(1);
    expect(reopenList.tasks[0]?.label).toBe(TASK_LABEL);

    // ----- TURN 2 — recall surfaces the task in the contractor prompt -----
    const turn2 = recordingIntentAdapter("observe");
    await runTurnDecision({
      prompt: RECALL_PROMPT,
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": turn2.adapter },
      monitoredRuntime: { run: vi.fn(async () => buildSatisfiedAttestation()) },
      expectedDeltaResolver: () => expectedDelta,
      taskLedger: readLedger,
      identityId: VLADIMIR,
    });

    expect(turn2.capturedPrompts).toHaveLength(1);
    const turn2Prompt = turn2.capturedPrompts[0] ?? "";

    // Fix-mode assertions: the `<active_tasks>` block precedes the raw
    // user prompt and the planted label is JSON-encoded inside it.
    expect(turn2Prompt).toContain("<active_tasks>");
    expect(turn2Prompt).toContain("</active_tasks>");
    expect(turn2Prompt).toContain(TASK_LABEL);
    // The raw recall prompt is still present — the block is prepended,
    // not substituted (mirrors `<memory>` + `<web_evidence>` pattern).
    expect(turn2Prompt).toContain(RECALL_PROMPT);
    // Block precedes the prompt text (same ordering as <memory>).
    const blockEnd = turn2Prompt.indexOf("</active_tasks>");
    const promptStart = turn2Prompt.indexOf(RECALL_PROMPT);
    expect(blockEnd).toBeGreaterThanOrEqual(0);
    expect(promptStart).toBeGreaterThan(blockEnd);

    await readLedger.close();
  });

  it("reverse — omitting taskLedger from the contractor wiring reproduces B7 absence-of-fix", async () => {
    // Plant a row that COULD be recalled if the wiring were active.
    const ledger = await SqliteTaskLedger.open({ dbPath });
    const log = captureLogger();
    const wrote = await recordTaskOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      taskLedger: ledger,
      memoryStore: new InMemoryMemoryStore(),
      taskInput: {
        kind: "created",
        label: TASK_LABEL,
        summary: TASK_SUMMARY,
        occurredAt: new Date().toISOString(),
      },
      logger: log.logger,
    });
    expect(wrote.kind).toBe("wrote");

    const turn = recordingIntentAdapter("observe");
    await runTurnDecision({
      prompt: RECALL_PROMPT,
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": turn.adapter },
      monitoredRuntime: { run: vi.fn(async () => buildSatisfiedAttestation()) },
      expectedDeltaResolver: () => expectedDelta,
      // taskLedger intentionally omitted — this is the absence-of-fix
      // shape (and the shape of `runTurnDecision` callers BEFORE slice F
      // Phase 6 wiring landed). Even with `identityId` set, no recall
      // happens because the contractor has no ledger seam to read from.
      identityId: VLADIMIR,
    });

    expect(turn.capturedPrompts).toHaveLength(1);
    const prompt = turn.capturedPrompts[0] ?? "";
    expect(prompt).not.toContain("<active_tasks>");
    expect(prompt).not.toContain(TASK_LABEL);
    expect(prompt).toContain(RECALL_PROMPT);

    await ledger.close();
  });

  it("reverse — anonymous session (no identityId) does not recall the planted task", async () => {
    const ledger = await SqliteTaskLedger.open({ dbPath });
    const log = captureLogger();
    const wrote = await recordTaskOnCommitmentSatisfied({
      attestation: buildSatisfiedAttestation(),
      identityId: VLADIMIR,
      taskLedger: ledger,
      memoryStore: new InMemoryMemoryStore(),
      taskInput: {
        kind: "created",
        label: TASK_LABEL,
        summary: TASK_SUMMARY,
        occurredAt: new Date().toISOString(),
      },
      logger: log.logger,
    });
    expect(wrote.kind).toBe("wrote");

    const turn = recordingIntentAdapter("observe");
    await runTurnDecision({
      prompt: RECALL_PROMPT,
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": turn.adapter },
      monitoredRuntime: { run: vi.fn(async () => buildSatisfiedAttestation()) },
      expectedDeltaResolver: () => expectedDelta,
      taskLedger: ledger,
      // identityId intentionally absent — anonymous session.
    });

    const prompt = turn.capturedPrompts[0] ?? "";
    expect(prompt).not.toContain("<active_tasks>");
    expect(prompt).not.toContain(TASK_LABEL);
    expect(prompt).toContain(RECALL_PROMPT);

    await ledger.close();
  });

  it("reverse — commitmentSatisfied=false does NOT write a ledger row, turn-2 sees no block", async () => {
    const ledger = await SqliteTaskLedger.open({ dbPath });
    const memory = new InMemoryMemoryStore();
    const log = captureLogger();

    const skipped = await recordTaskOnCommitmentSatisfied({
      attestation: buildUnsatisfiedAttestation(),
      identityId: VLADIMIR,
      taskLedger: ledger,
      memoryStore: memory,
      taskInput: {
        kind: "created",
        label: TASK_LABEL,
        summary: TASK_SUMMARY,
        occurredAt: new Date().toISOString(),
      },
      logger: log.logger,
    });
    // The Phase-5 hook MUST skip on commitmentUnsatisfied.
    expect(skipped.kind).toBe("skipped");
    if (skipped.kind === "skipped") {
      expect(skipped.reason).toBe("commitment_unsatisfied");
    }

    // No ledger row should exist for VLADIMIR.
    const list = await ledger.list({ ownerIdentityId: VLADIMIR });
    expect(list.tasks).toEqual([]);
    // No episodic cross-reference event either.
    const episodic = await memory.list({
      identityId: VLADIMIR,
      effectFamily: "task",
    });
    expect(episodic.episodic).toEqual([]);

    // Turn 2: contractor with the (empty) ledger — no block, because
    // there is nothing to recall.
    const turn = recordingIntentAdapter("observe");
    await runTurnDecision({
      prompt: RECALL_PROMPT,
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": turn.adapter },
      monitoredRuntime: { run: vi.fn(async () => buildSatisfiedAttestation()) },
      expectedDeltaResolver: () => expectedDelta,
      taskLedger: ledger,
      identityId: VLADIMIR,
    });

    const prompt = turn.capturedPrompts[0] ?? "";
    expect(prompt).not.toContain("<active_tasks>");
    expect(prompt).not.toContain(TASK_LABEL);
    expect(prompt).toContain(RECALL_PROMPT);

    await ledger.close();
  });

  it("IdentityRegistry resolves a session-key to the operator used for ledger keys", async () => {
    // Smoke that the production identity-resolution helper threads
    // cleanly into the same fixture — proves the `IdentityRegistry`
    // boundary point in the spec (mapping vladimir → telegram chatId
    // 123 / webchat session web-1) ends in the same `IdentityId` brand
    // that the task hook + recall consume.
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

    const tgKey = "agent:worker:telegram:direct:123";
    const wcKey = "agent:worker:webchat:direct:web-1";
    const fromTg: IdentityId | undefined = resolveIdentityFromSessionKey(
      tgKey,
      registry,
    );
    const fromWc: IdentityId | undefined = resolveIdentityFromSessionKey(
      wcKey,
      registry,
    );
    expect(fromTg).toBe(VLADIMIR);
    expect(fromWc).toBe(VLADIMIR);

    // Unmapped peer → undefined (anonymous session).
    expect(
      resolveIdentityFromSessionKey(
        "agent:worker:telegram:direct:999",
        registry,
      ),
    ).toBeUndefined();
  });
});
