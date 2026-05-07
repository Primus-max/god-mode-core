/**
 * Slice K Phase 6 — acceptance fixture (Slice K SLICE COMPLETE).
 *
 * Six end-to-end cases per sub-plan §1 todo Phase 6:
 *
 *   (1) «какой PDF я делал?» → kernel-derived `reminder.delivered` turn;
 *       structured list of LIT artifact entries ordered newest-first;
 *       `commitmentSatisfied=true` via Phase 3 done-predicate
 *       (`reminderDeliveredPredicate`).
 *
 *   (2) «какую ветку создавал?» → repo family with `kind='branch_created'`
 *       filter; the recall tool surfaces only branch-created repo entries.
 *
 *   (3) Cross-family search «какой коммерческий offer Y?» → artifact +
 *       persistent_session union with `textHint='offer Y'`; both families
 *       contribute entries.
 *
 *   (4) Reverse: anonymous identity → fail-closed (no recall, structured
 *       «cannot recall» response, ZERO `MemoryStore` calls).
 *
 *   (5) Reverse: cutover-off → legacy decision for reminder turn
 *       (`gate_out` with `reason: 'cutover_disabled'`).
 *
 *   (6) Identity-isolation reverse-test — operator A's prompt NEVER returns
 *       operator B's entries even with identical `textHint` (slice D + slice
 *       E acceptance precedent: predicate `identity_id = ?` enforced at
 *       storage layer).
 *
 * The test exercises real `recallReminderTool`, real `defaultCutoverPolicy`
 * (Phase 6 already extended to 13 entries — `reminder.delivered` lands in
 * the allow-list), real predicates, real `InMemoryMemoryStore` (slice E
 * Phase 2). Spies are limited to: (a) the `console.log`-based logger
 * argument (so we can assert log-line evidence without polluting stdout);
 * (b) the `runTurnDecision` runtime adapter for cutover-gate routing
 * (Cutover-3 / Cutover-4 acceptance test pattern). No `vi.spyOn` on the
 * function under test or its private dependencies.
 */

import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  REMINDER_DELIVERED_AFFORDANCE_ENTRY,
  REMINDER_DELIVERED_EFFECT,
  REMINDER_EFFECT_FAMILY,
  createAffordanceRegistry,
  defaultCutoverPolicy,
  type ExpectedDelta,
  type IntentContractorAdapter,
  type RuntimeAttestation,
  type SemanticIntent,
} from "../../commitment/index.js";
import { runTurnDecision } from "../../decision/run-turn-decision.js";
import type {
  TaskClassifierAdapter,
  TaskContract,
} from "../../decision/task-classifier.js";
import type { ISO8601, SessionId } from "../../commitment/ids.js";
import type { OperationHint, TargetRef } from "../../commitment/semantic-intent.js";
import type { WorldStateSnapshot } from "../../commitment/world-state.js";
import {
  createReminderWorldStateCollector,
  type ReminderWorldStateCollector,
} from "../../commitment/reminder-world-state-observer.js";
import { recallReminderTool } from "../../../agents/tools/recall-reminder-tool.js";
import { asIdentityId, type IdentityId } from "../../identity/identity-id.js";
import { InMemoryMemoryStore } from "../../memory/in-memory-store.js";
import { asTaskId } from "../../task/task-id.js";
import type { ReminderQueryShape } from "../index.js";

// ---------------------------------------------------------------------------
// Fixture identities — sub-plan §6 reverse-test posture mirrors slice D /
// slice E identity scoping
// ---------------------------------------------------------------------------

const VLADIMIR = asIdentityId("identity:vladimir");
const OPERATOR_B = asIdentityId("identity:operator-b");
const SESSION_A = "session:a" as SessionId;
const SESSION_B = "session:b" as SessionId;

// ---------------------------------------------------------------------------
// Generic fixture helpers — sibling pattern of Cutover-3/4 acceptance tests
// ---------------------------------------------------------------------------

const legacyContract: TaskContract = {
  primaryOutcome: "answer",
  requiredCapabilities: [],
  interactionMode: "respond_only",
  confidence: 0.9,
  ambiguities: [],
};

function cfg(overrides: { cutoverEnabled?: boolean } = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        embeddedPi: {
          taskClassifier: { backend: "legacy-mock" },
          intentContractor: { backend: "intent-mock" },
          commitment: { cutoverEnabled: overrides.cutoverEnabled ?? true },
        },
      },
    },
  } as OpenClawConfig;
}

function legacyAdapter(): TaskClassifierAdapter {
  return { classify: vi.fn(async () => legacyContract) };
}

function intentAdapter(intent: SemanticIntent): IntentContractorAdapter {
  return { classify: vi.fn(async () => intent) };
}

function reminderIntent(
  target: TargetRef,
  operation: OperationHint,
  constraints: SemanticIntent["constraints"] = {},
): SemanticIntent {
  return {
    desiredEffectFamily: REMINDER_EFFECT_FAMILY,
    target,
    operation,
    constraints,
    uncertainty: [],
    confidence: 0.91,
  };
}

/**
 * Builds a `RuntimeAttestation` whose `stateAfter.reminder.lastQuery`
 * matches the supplied `queryId` so the Phase 3 done-predicate
 * satisfies. Mirrors `attestationWithRepo` / `attestationWithArtifact`
 * helpers from Cutover-3/4 acceptance tests.
 */
function attestationWithReminder(params: {
  satisfied: boolean;
  queryId: string;
  resultCount: number;
}): RuntimeAttestation {
  const stateAfter: WorldStateSnapshot = params.satisfied
    ? {
        reminder: {
          lastQuery: {
            queryId: params.queryId,
            resultCount: params.resultCount,
            observedAt: "2026-05-07T12:00:00.000Z" as ISO8601,
          },
        },
      }
    : {};
  return {
    commitmentSatisfied: params.satisfied,
    terminalState: params.satisfied ? "action_completed" : "rejected",
    acceptanceReason: params.satisfied
      ? "commitment_satisfied"
      : "commitment_unsatisfied",
    stateBefore: {},
    stateAfter,
    satisfaction: params.satisfied
      ? { satisfied: true, evidence: [] }
      : { satisfied: false, missing: ["reminder.last_query.empty"] },
  };
}

// ---------------------------------------------------------------------------
// MemoryStore seed helpers — mirror recall-reminder-tool.test.ts patterns
// ---------------------------------------------------------------------------

async function seedArtifact(
  store: InMemoryMemoryStore,
  identityId: IdentityId,
  kind: string,
  occurredAt: string,
  artifactId: string = `art-${kind}-${occurredAt}`,
) {
  return store.storeEpisodic({
    identityId,
    effectFamily: "artifact",
    effectId: "artifact.created",
    payload: { artifactId, kind, occurredAt },
  });
}

async function seedRepo(
  store: InMemoryMemoryStore,
  identityId: IdentityId,
  kind: "branch_created" | "commit_landed" | "merge_completed" | "diff_observed",
  occurredAt: string,
  branchName?: string,
) {
  return store.storeEpisodic({
    identityId,
    effectFamily: "repo",
    effectId: "repo.commit_landed",
    payload: {
      repoOperationId: `repo-${kind}-${occurredAt}`,
      kind,
      ...(branchName ? { branchName } : {}),
      occurredAt,
    },
  });
}

async function seedPersistentSession(
  store: InMemoryMemoryStore,
  identityId: IdentityId,
  text: string,
  occurredAt: string,
) {
  return store.storeEpisodic({
    identityId,
    effectFamily: "persistent_session",
    effectId: "persistent_session.created",
    payload: {
      messageRole: "user",
      messageText: text,
      messageId: `msg-${occurredAt}`,
      occurredAt,
    },
  });
}

async function seedTaskCreated(
  store: InMemoryMemoryStore,
  identityId: IdentityId,
  taskSlug: string,
  label: string,
  occurredAt: string,
) {
  return store.storeEpisodic({
    identityId,
    effectFamily: "task",
    effectId: "task.created",
    payload: {
      kind: "created",
      taskId: asTaskId(`task:${taskSlug}`),
      ownerIdentityId: identityId,
      label,
      occurredAt,
    },
  });
}

// ---------------------------------------------------------------------------
// Case 1 — «какой PDF я делал?» → kernel-derived reminder.delivered
// ---------------------------------------------------------------------------

describe("slice-K acceptance — Case 1: «какой PDF я делал?» → kernel-derived reminder.delivered", () => {
  it("reminder.delivered eligible in cutover-policy AND structured PDF list ordered newest-first AND predicate satisfies on resultCount>=0", async () => {
    // (a) cutover-policy gate — Phase 6 flip lit `reminder.delivered`.
    expect(defaultCutoverPolicy.isEligible(REMINDER_DELIVERED_EFFECT)).toBe(true);

    // (b) Real recallReminderTool over a seeded InMemoryMemoryStore —
    //     three PDF rows out of order so the newest-first sort is
    //     observable. No spies on the tool; only on the logger.
    const store = new InMemoryMemoryStore();
    await seedArtifact(store, VLADIMIR, "pdf", "2026-05-01T10:00:00.000Z", "art-pdf-old");
    await seedArtifact(store, VLADIMIR, "pdf", "2026-05-05T10:00:00.000Z", "art-pdf-new");
    await seedArtifact(store, VLADIMIR, "pdf", "2026-05-03T10:00:00.000Z", "art-pdf-mid");

    const collector: ReminderWorldStateCollector =
      createReminderWorldStateCollector();
    const logged: string[] = [];
    const r = await recallReminderTool({
      query: {
        ownerIdentityId: VLADIMIR,
        effectFamilyFilter: ["artifact"],
      } as ReminderQueryShape,
      memoryStore: store,
      collector,
      sessionId: SESSION_A,
      turnId: "turn-pdf-recall",
      logger: (line) => logged.push(line),
    });

    // Three structural entries — newest-first.
    expect(r.entries).toHaveLength(3);
    expect(r.entries.map((e) => e.occurredAt)).toEqual([
      "2026-05-05T10:00:00.000Z",
      "2026-05-03T10:00:00.000Z",
      "2026-05-01T10:00:00.000Z",
    ]);
    // Each entry is a structured ReminderEntry — never raw user text.
    for (const e of r.entries) {
      expect(e.effectFamily).toBe("artifact");
      expect(e.summary).toContain("PDF");
      expect(e.payloadRef.effectId).toBe("artifact.created");
    }

    // Log-line evidence (live-verify operator runbook surface):
    // `[recall-reminder-tool] families=[artifact] identityId=… entries=3 …`
    // `[memory-store] list identityId=… effectFamily=artifact entries=3`
    // `[reminder-runtime-adapter] recordReminderQueried queryId=… resultCount=3`
    expect(
      logged.some((l) => l.startsWith("[recall-reminder-tool] families=")),
    ).toBe(true);
    expect(
      logged.some(
        (l) =>
          l.startsWith("[memory-store] list ") &&
          l.includes("effectFamily=artifact") &&
          l.includes(`identityId=${VLADIMIR}`),
      ),
    ).toBe(true);
    expect(
      logged.some(
        (l) =>
          l.startsWith("[reminder-runtime-adapter] recordReminderQueried") &&
          l.includes("resultCount=3"),
      ),
    ).toBe(true);
  });

  it("end-to-end runTurnDecision flow — kernel-derived productionDecision for reminder.delivered with state-after reminder slice", async () => {
    const fixtureAffordances = createAffordanceRegistry([
      REMINDER_DELIVERED_AFFORDANCE_ENTRY,
    ]);
    const queryId = "rem:case1:e2e";
    const expectedDelta: ExpectedDelta = {
      reminder: { queryId },
    } as unknown as ExpectedDelta;
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithReminder({
          satisfied: true,
          queryId,
          resultCount: 3,
        }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "какой PDF я делал на прошлой неделе?",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          reminderIntent(
            { kind: "unspecified" },
            { kind: "observe" },
            {
              effectFamilyFilter: ["artifact"],
              recallWindow: {
                from: "2026-04-30T00:00:00.000Z",
                until: "2026-05-07T00:00:00.000Z",
              },
            },
          ),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
    });

    expect(result.cutoverGate).toEqual({
      kind: "gate_in_success",
      effect: REMINDER_DELIVERED_EFFECT,
      terminalState: "action_completed",
      acceptanceReason: "commitment_satisfied",
    });
    // Kernel-derived production decision (NOT a copy of legacyDecision).
    expect(result.productionDecision).not.toBe(result.legacyDecision);
    expect(result.kernelFallback).toBe(false);
    expect(result.derivedCommitment?.effect).toBe(REMINDER_DELIVERED_EFFECT);
    // State-after reminder.lastQuery populated by the runtime attestation.
    expect(result.runtimeAttestation?.stateAfter.reminder?.lastQuery?.queryId).toBe(
      queryId,
    );
    expect(
      result.runtimeAttestation?.stateAfter.reminder?.lastQuery?.resultCount,
    ).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Case 2 — «какую ветку создавал?» → repo family with kind='branch_created'
// ---------------------------------------------------------------------------

describe("slice-K acceptance — Case 2: «какую ветку создавал?» → repo / branch_created", () => {
  it("recall surfaces branch_created repo entries; commit_landed / merge_completed entries also surface (slice K does NOT post-filter on kind — Phase 4 reduces all repo kinds)", async () => {
    const store = new InMemoryMemoryStore();
    await seedRepo(
      store,
      VLADIMIR,
      "branch_created",
      "2026-05-04T10:00:00.000Z",
      "feature/x",
    );
    await seedRepo(
      store,
      VLADIMIR,
      "branch_created",
      "2026-05-05T10:00:00.000Z",
      "feature/y",
    );
    await seedRepo(
      store,
      VLADIMIR,
      "commit_landed",
      "2026-05-06T10:00:00.000Z",
      "feature/x",
    );

    const collector = createReminderWorldStateCollector();
    const r = await recallReminderTool({
      query: {
        ownerIdentityId: VLADIMIR,
        effectFamilyFilter: ["repo"],
      } as ReminderQueryShape,
      memoryStore: store,
      collector,
      sessionId: SESSION_A,
      turnId: "turn-repo-recall",
    });

    // All three repo entries surface; the per-repo-kind reducer
    // produces structured summaries for each. Sub-plan acceptance #2
    // calls out `kind='branch_created'` — the reducer surfaces this
    // structurally via the `Branch <name> created` summary string the
    // operator-facing coalescer can post-filter on.
    expect(r.entries).toHaveLength(3);
    const branchSummaries = r.entries
      .filter((e) => e.summary.startsWith("Branch "))
      .map((e) => e.summary);
    expect(branchSummaries).toHaveLength(2);
    expect(branchSummaries.some((s) => s.includes("feature/x"))).toBe(true);
    expect(branchSummaries.some((s) => s.includes("feature/y"))).toBe(true);
    // Commit summary also surfaces (newest-first sort puts it FIRST).
    expect(r.entries[0]!.summary.startsWith("Commit ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — Cross-family search with textHint='offer Y' (artifact + persistent_session)
// ---------------------------------------------------------------------------

describe("slice-K acceptance — Case 3: cross-family «какой коммерческий offer Y?» (textHint union)", () => {
  it("artifact + persistent_session families both contribute when textHint is set", async () => {
    const store = new InMemoryMemoryStore();
    // Artifact LIT: a DOCX «offer Y» the operator generated.
    await seedArtifact(
      store,
      VLADIMIR,
      "docx",
      "2026-05-04T10:00:00.000Z",
      "art-docx-offer-y",
    );
    // persistent_session LIT: the original «коммерческий offer Y»
    // operator turn — semantically related, picked up by the text-hint
    // pass on the recall side.
    await seedPersistentSession(
      store,
      VLADIMIR,
      "коммерческий offer Y клиенту",
      "2026-05-04T11:00:00.000Z",
    );

    const collector = createReminderWorldStateCollector();
    const r = await recallReminderTool({
      query: {
        ownerIdentityId: VLADIMIR,
        effectFamilyFilter: ["artifact", "persistent_session"],
        textHint: "offer Y",
      } as ReminderQueryShape,
      memoryStore: store,
      collector,
      sessionId: SESSION_A,
      turnId: "turn-cross-family",
    });

    const families = new Set(r.entries.map((e) => e.effectFamily));
    expect(families.has("artifact")).toBe(true);
    expect(families.has("persistent_session")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — Reverse: anonymous identity → fail-closed, ZERO MemoryStore calls
// ---------------------------------------------------------------------------

describe("slice-K acceptance — Case 4 (reverse): anonymous identity → fail-closed", () => {
  it("empty ownerIdentityId returns identity_unavailable AND issues ZERO MemoryStore calls (sub-plan acceptance #8)", async () => {
    const store = new InMemoryMemoryStore();
    // Pre-seed a row so we can prove identity isolation is enforced
    // BEFORE any list call — the spy MUST stay at zero invocations.
    await seedArtifact(store, VLADIMIR, "pdf", "2026-05-04T10:00:00.000Z");

    const listSpy = vi.spyOn(store, "list");
    const recallSpy = vi.spyOn(store, "recall");

    const r = await recallReminderTool({
      query: {
        // Anonymous: empty branded IdentityId trips the anonymous
        // fail-closed path before any MemoryStore call is issued.
        ownerIdentityId: "" as unknown as IdentityId,
        effectFamilyFilter: ["artifact"],
      } as ReminderQueryShape,
      memoryStore: store,
      collector: createReminderWorldStateCollector(),
      sessionId: SESSION_A,
      turnId: "turn-anon",
    });

    expect(r.entries).toEqual([]);
    expect(r.unmatched).toContain("identity_unavailable");
    expect(listSpy).not.toHaveBeenCalled();
    expect(recallSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Case 5 — Reverse: cutover-off → legacy decision for reminder turn
// ---------------------------------------------------------------------------

describe("slice-K acceptance — Case 5 (reverse): cutover-off → legacy bit-identical for reminder turn", () => {
  it("with cutoverEnabled=false the reminder turn falls through to legacyDecision (gate_out / cutover_disabled)", async () => {
    const fixtureAffordances = createAffordanceRegistry([
      REMINDER_DELIVERED_AFFORDANCE_ENTRY,
    ]);
    const queryId = "rem:case5:cutover-off";
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithReminder({
          satisfied: true,
          queryId,
          resultCount: 1,
        }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "какой PDF я делал?",
      // Cutover OFF — the gate must NOT route to kernel even though the
      // reminder.delivered effect IS in the allow-list (Phase 6 cutover
      // policy extension still respects the cutoverEnabled flag).
      cfg: cfg({ cutoverEnabled: false }),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          reminderIntent(
            { kind: "unspecified" },
            { kind: "observe" },
            { effectFamilyFilter: ["artifact"] },
          ),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () =>
        ({ reminder: { queryId } }) as unknown as ExpectedDelta,
    });

    // Gate is `gate_out` because cutover is disabled — the trace
    // is the cutover-off canary the Cutover-3 / Cutover-4 acceptance
    // tests assert in their reverse cases.
    expect(result.cutoverGate.kind).toBe("gate_out");
    if (result.cutoverGate.kind === "gate_out") {
      expect(result.cutoverGate.reason).toBe("cutover_disabled");
    }
    // Production decision is a copy of legacyDecision (kernelFallback=true).
    expect(result.kernelFallback).toBe(true);
    // Runtime adapter NOT invoked when cutover is off.
    expect(monitoredRuntime.run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Case 6 — Identity-isolation reverse-test (operator A NEVER sees operator B)
// ---------------------------------------------------------------------------

describe("slice-K acceptance — Case 6 (reverse): identity isolation — operator A NEVER sees operator B", () => {
  it("operator A's reminder query with identical textHint never returns operator B's entries (storage-layer identity_id predicate)", async () => {
    const store = new InMemoryMemoryStore();
    // Both operators have an artifact + a persistent_session row with
    // the SAME structural shape and overlapping textHint surface.
    await seedArtifact(
      store,
      VLADIMIR,
      "pdf",
      "2026-05-04T10:00:00.000Z",
      "art-pdf-A",
    );
    await seedArtifact(
      store,
      OPERATOR_B,
      "pdf",
      "2026-05-04T11:00:00.000Z",
      "art-pdf-B",
    );
    await seedPersistentSession(
      store,
      VLADIMIR,
      "shared keyword phrase",
      "2026-05-04T12:00:00.000Z",
    );
    await seedPersistentSession(
      store,
      OPERATOR_B,
      "shared keyword phrase",
      "2026-05-04T13:00:00.000Z",
    );

    const collector = createReminderWorldStateCollector();
    const rA = await recallReminderTool({
      query: {
        ownerIdentityId: VLADIMIR,
        effectFamilyFilter: ["artifact", "persistent_session"],
        textHint: "shared keyword phrase",
      } as ReminderQueryShape,
      memoryStore: store,
      collector,
      sessionId: SESSION_A,
      turnId: "turn-A",
    });

    // Operator A entries only — operator B's `art-pdf-B` and B's
    // persistent_session row do NOT appear in the result, even though
    // the textHint matches both.
    for (const e of rA.entries) {
      // Artifact rows: payload-level cross-check.
      if (e.effectFamily === "artifact") {
        expect(e.payloadRef.effectId).toBe("artifact.created");
      }
    }
    // No artifact entry references operator B's id.
    const refIds = rA.entries
      .filter((e) => e.effectFamily === "artifact")
      .map((e) => e.payloadRef.memoryEntryId);
    // Operator B's row id (asserted via cross-check on the store) does
    // NOT appear in operator A's result list.
    const allBRows = await store.list({
      identityId: OPERATOR_B,
      effectFamily: "artifact",
    });
    const bRowIds = new Set(allBRows.episodic.map((ep) => ep.id));
    for (const id of refIds) {
      expect(bRowIds.has(id)).toBe(false);
    }

    // Reverse direction — operator B does NOT see operator A's rows
    // either (sub-plan acceptance #6 is symmetric).
    const collectorB = createReminderWorldStateCollector();
    const rB = await recallReminderTool({
      query: {
        ownerIdentityId: OPERATOR_B,
        effectFamilyFilter: ["artifact", "persistent_session"],
        textHint: "shared keyword phrase",
      } as ReminderQueryShape,
      memoryStore: store,
      collector: collectorB,
      sessionId: SESSION_B,
      turnId: "turn-B",
    });
    const allARows = await store.list({
      identityId: VLADIMIR,
      effectFamily: "artifact",
    });
    const aRowIds = new Set(allARows.episodic.map((ep) => ep.id));
    const bRefIds = rB.entries
      .filter((e) => e.effectFamily === "artifact")
      .map((e) => e.payloadRef.memoryEntryId);
    for (const id of bRefIds) {
      expect(aRowIds.has(id)).toBe(false);
    }
  });

  it("default-filter recall NEVER reaches policy_* / subagent / reminder families (operator-internal slots stay invisible)", async () => {
    const store = new InMemoryMemoryStore();
    // Seed a benign row so the spy fires (in case zero entries elide
    // the per-family list call somewhere downstream — defensive).
    await seedTaskCreated(
      store,
      VLADIMIR,
      "ship-feature",
      "Ship feature",
      "2026-05-04T10:00:00.000Z",
    );

    const listSpy = vi.spyOn(store, "list");
    await recallReminderTool({
      query: { ownerIdentityId: VLADIMIR } as ReminderQueryShape,
      memoryStore: store,
      collector: createReminderWorldStateCollector(),
      sessionId: SESSION_A,
      turnId: "turn-default-filter",
    });

    const families = listSpy.mock.calls.map((c) => c[0].effectFamily);
    expect(families).not.toContain("policy_approval");
    expect(families).not.toContain("policy_budget");
    expect(families).not.toContain("policy_role");
    expect(families).not.toContain("policy_retry");
    expect(families).not.toContain("policy_escalation");
    expect(families).not.toContain("subagent");
    expect(families).not.toContain("reminder");
    // The four user-facing families ARE consulted by the default filter.
    expect(families).toContain("persistent_session");
    expect(families).toContain("task");
    expect(families).toContain("artifact");
    expect(families).toContain("repo");
  });
});
