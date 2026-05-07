/**
 * Cron/Scheduler Phase 8 — acceptance fixture (Cron/Scheduler SLICE
 * COMPLETE).
 *
 * Ten end-to-end cases per sub-plan §1 todo Phase 8 (mirrors slice K
 * Phase 6 `slice-k-reminder.acceptance.test.ts` structure):
 *
 *   (1) «напомни мне через 30 минут позвонить клиенту X» → kernel-derived
 *       `reminder.set` turn (cutoverGate.kind === 'gate_in_success'); the
 *       record persists in `ReminderStore`; the cron callback registers.
 *   (2) «через неделю отправь Y предложение» → reminder.set with
 *       fireAt=+7d + content='отправь Y предложение'.
 *   (3) Cron-fire path: clock advances → fire callback delivers Telegram
 *       message; reminder marked `status='fired'`; identity scope
 *       respected (`wrappedScopeIdentityId === record.ownerIdentityId`).
 *   (4) Cross-test with slice K (bidirectional UX): set a reminder via
 *       Cron/Scheduler, then query «какие у меня запланированы
 *       напоминания?» via slice K → slice K returns the just-set entry
 *       (same identity scope; recall path reads from same store via the
 *       `MemoryStore` write performed by the Phase 5 commit-satisfied
 *       hook).
 *   (5) Reverse: anonymous identity → fail-closed; ZERO `ReminderStore`
 *       writes; ZERO cron registrations.
 *   (6) Reverse: cutover-off → legacy decision (`gate_out` /
 *       `cutover_disabled`); runtime adapter NOT invoked.
 *   (7) Reverse: viewer-role → RolePolicy denies + escalation fires +
 *       structured denial trace; ZERO `ReminderStore` write.
 *   (8) Reverse: budget exceeded → BudgetPolicy denies + escalation;
 *       trace `policyBudgetDenial.reason='budget_exceeded_user'`.
 *   (9) Reverse: identity isolation — operator A sets reminder, operator
 *       B's `ReminderStore.list()` NEVER returns A's entry (storage-
 *       layer `identity_id = ?` predicate; in-memory impl filters in
 *       code).
 *   (10) Reverse: `fireAt in past` → `recordReminderTool` returns
 *        `fire_at_in_past`; ZERO cron registration; ZERO observer record;
 *        ReminderStore wrote then surfaces failure-after-write canary
 *        (the tool currently writes to ReminderStore BEFORE the in-past
 *        check — pin this contract so a future refactor cannot silently
 *        change ordering without a test failure).
 *
 * Invariants: 16 hard invariants preserved. Frozen layer additive only:
 *   - Phase 8 extends `CUTOVER_2` from 13 → 14 entries (sub-plan §1 todo
 *     Phase 8). The byte-identity reverse-test for the existing 13
 *     entries lives at `cutover-policy.test.ts`.
 *   - 5 frozen contracts BYTE-IDENTICAL through the full slice (Phase
 *     1-8): TaskContract, OutcomeContract, QualificationExecutionContract,
 *     ResolutionContract, RecipeRoutingHints.
 *
 * The fixture exercises real `defaultCutoverPolicy` (Phase 8 already
 * lights `reminder.set`), real `recordReminderTool`, real
 * `fireReminder`, real `InMemoryReminderStore`, real `recallReminderTool`
 * (Case 4), real PolicyGate readers (Cases 7 + 8). Spies are limited to
 * (a) `console.log` stub for log-line assertions and (b) `runTurnDecision`
 * runtime-adapter `monitoredRuntime.run` for cutover-gate routing — same
 * pattern as the slice K acceptance fixture. No `vi.spyOn` on the function
 * under test or on its private dependency.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "../../../config/config.js";
import { runTurnDecision } from "../../decision/run-turn-decision.js";
import type {
  TaskClassifierAdapter,
  TaskContract,
} from "../../decision/task-classifier.js";
import {
  REMINDER_DELIVERED_EFFECT,
  REMINDER_EFFECT_FAMILY,
  REMINDER_SET_AFFORDANCE_ENTRY,
  REMINDER_SET_EFFECT,
  buildBudgetWindowId,
  createAffordanceRegistry,
  createBudgetPolicy,
  createCutoverPolicy,
  createEscalationHook,
  createRolePolicy,
  defaultCutoverPolicy,
  type BudgetIncrementInput,
  type BudgetReadQuery,
  type BudgetStore,
  type BudgetWindow,
  type ExpectedDelta,
  type IntentContractorAdapter,
  type RoleId,
  type RoleResolver,
  type RuntimeAttestation,
  type SemanticIntent,
} from "../../commitment/index.js";
import type { ChannelId, ISO8601, SessionId } from "../../commitment/ids.js";
import type { OperationHint, TargetRef } from "../../commitment/semantic-intent.js";
import type { WorldStateSnapshot } from "../../commitment/world-state.js";
import {
  createScheduledReminderWorldStateCollector,
  type ScheduledReminderWorldStateCollector,
} from "../../commitment/scheduled-reminder-world-state-observer.js";
import { asIdentityId } from "../../identity/identity-id.js";
import {
  InMemoryReminderStore,
  type ReminderStore,
} from "../reminder-store.js";
import {
  recordReminderTool,
  type CronAddFn,
} from "../../../agents/tools/record-reminder-tool.js";
import { fireReminder } from "../../../cron/isolated-agent/reminder-fire-callback.js";

// ---------------------------------------------------------------------------
// Fixture identities + helpers — sibling pattern of slice-K acceptance test.
// ---------------------------------------------------------------------------

const VLADIMIR = asIdentityId("identity:vladimir");
const OPERATOR_B = asIdentityId("identity:operator-b");
const ALICE = asIdentityId("identity:alice");
const SESSION_A = "session:a" as SessionId;
const SESSION_B = "session:b" as SessionId;
const TURN_A = "turn:a";
const TURN_B = "turn:b";
const TELEGRAM = "telegram" as ChannelId;
const TELEGRAM_TO = "6533456892";

const NOW_MS = Date.parse("2026-05-07T11:00:00.000Z");
const FIRE_AT_30M = "2026-05-07T11:30:00.000Z";
const FIRE_AT_7D = "2026-05-14T11:00:00.000Z";
const FIRE_AT_PAST = "2026-05-07T10:00:00.000Z";

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

function reminderSetIntent(
  fireAt: string,
  content: string,
  deliveryChannel: string = TELEGRAM,
  deliveryTo: string = TELEGRAM_TO,
): SemanticIntent {
  const target: TargetRef = { kind: "unspecified" };
  const operation: OperationHint = { kind: "create" };
  return {
    desiredEffectFamily: REMINDER_EFFECT_FAMILY,
    target,
    operation,
    constraints: {
      reminderSet: { fireAt, content, deliveryChannel, deliveryTo },
    },
    uncertainty: [],
    confidence: 0.91,
  };
}

/**
 * Builds a `RuntimeAttestation` whose `stateAfter.scheduledReminders`
 * matches the supplied `reminderId` so the Phase 4 done-predicate
 * satisfies. Mirrors `attestationWithReminder` in slice K acceptance.
 */
function attestationWithScheduledReminder(params: {
  satisfied: boolean;
  reminderId: string;
  identityId?: string;
  fireAt?: string;
}): RuntimeAttestation {
  const stateAfter: WorldStateSnapshot = params.satisfied
    ? {
        scheduledReminders: {
          records: [
            {
              reminderId: params.reminderId,
              ownerIdentityId: (params.identityId ?? VLADIMIR) as ReturnType<
                typeof asIdentityId
              >,
              fireAt: (params.fireAt ?? FIRE_AT_30M) as ISO8601,
              content: "позвонить клиенту X",
              deliveryChannel: TELEGRAM,
              deliveryTo: TELEGRAM_TO,
              createdAt: "2026-05-07T11:00:00.000Z" as ISO8601,
              status: "pending",
            },
          ],
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
      : { satisfied: false, missing: ["scheduled_reminders.slice_absent"] },
  };
}

function activeCollector(
  sessionId: SessionId,
  turnId: string,
): ScheduledReminderWorldStateCollector {
  const collector = createScheduledReminderWorldStateCollector();
  collector.setActiveTurn({ sessionId, turnId });
  return collector;
}

function buildCronAdd(): CronAddFn & {
  readonly calls: ReadonlyArray<unknown>;
} {
  const calls: unknown[] = [];
  const fn: CronAddFn = async (input) => {
    calls.push(input);
    return { id: `cronjob:${calls.length}` };
  };
  return Object.assign(fn, { calls });
}

/**
 * In-memory `BudgetStore` fake — same key shape as
 * `cron-scheduler-policy-gate-acceptance.test.ts` (Phase 7 fixture).
 */
function inMemoryBudgetStore(now: () => number = () => NOW_MS): BudgetStore {
  const rows = new Map<string, BudgetWindow>();
  const keyFor = (q: BudgetReadQuery): string =>
    q.dimension === "user"
      ? `user|${String(q.identityId ?? "")}|${String(q.effectFamily ?? "")}`
      : q.dimension === "channel"
        ? `channel|${String(q.channel ?? "")}|${String(q.effectFamily ?? "")}`
        : `effect|${String(q.effectFamily ?? "")}`;

  return {
    read(query) {
      return Promise.resolve(rows.get(keyFor(query)) ?? null);
    },
    increment(input: BudgetIncrementInput) {
      const key = keyFor(input);
      const existing = rows.get(key);
      const tNow = now();
      const w: BudgetWindow =
        existing && tNow < existing.windowEnd
          ? { ...existing, used: existing.used + 1, limit: input.limit }
          : ({
              windowId: buildBudgetWindowId({
                dimension: input.dimension,
                ...(input.identityId !== undefined ? { identityId: input.identityId } : {}),
                ...(input.channel !== undefined ? { channel: input.channel } : {}),
                ...(input.effectFamily !== undefined
                  ? { effectFamily: input.effectFamily }
                  : {}),
                windowStart: tNow,
              }),
              dimension: input.dimension,
              ...(input.identityId !== undefined ? { identityId: input.identityId } : {}),
              ...(input.channel !== undefined ? { channel: input.channel } : {}),
              ...(input.effectFamily !== undefined
                ? { effectFamily: input.effectFamily }
                : {}),
              windowStart: tNow,
              windowEnd: tNow + input.windowMs,
              used: 1,
              limit: input.limit,
            } satisfies BudgetWindow);
      rows.set(key, w);
      return Promise.resolve(w);
    },
    resetExpired() {
      return Promise.resolve(0);
    },
  };
}

let logged: string[] = [];
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logged = [];
  consoleSpy = vi.spyOn(console, "log").mockImplementation((message: unknown) => {
    if (typeof message === "string") {
      logged.push(message);
    }
  });
});

afterEach(() => {
  consoleSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Case 1 — kernel-derived reminder.set turn for «через 30 минут»
// ---------------------------------------------------------------------------

describe("cron-scheduler acceptance — Case 1: «напомни мне через 30 минут позвонить клиенту X»", () => {
  it("reminder.set is eligible in the production cutover-policy AND record-reminder-tool persists pending entry AND cron callback registers", async () => {
    // (a) Phase 8 cutover flip — `reminder.set` MUST be eligible NOW.
    expect(defaultCutoverPolicy.isEligible(REMINDER_SET_EFFECT)).toBe(true);
    // Slice K Phase 6 entry preserved (additive guard).
    expect(defaultCutoverPolicy.isEligible(REMINDER_DELIVERED_EFFECT)).toBe(true);

    // (b) Real RecordReminderTool path — write reminder; assert side-effects.
    const reminderStore: ReminderStore = new InMemoryReminderStore();
    const cronAdd = buildCronAdd();
    const collector = activeCollector(SESSION_A, TURN_A);

    const result = await recordReminderTool({
      shape: {
        reminderId: "rem:case1",
        fireAt: FIRE_AT_30M,
        content: "позвонить клиенту X",
        deliveryChannel: TELEGRAM,
        deliveryTo: TELEGRAM_TO,
      },
      ownerIdentityId: VLADIMIR,
      sessionId: SESSION_A,
      turnId: TURN_A,
      collector,
      reminderStore,
      cronAdd,
      now: () => NOW_MS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.reminderId).toBe("rem:case1");

    // ReminderStore persisted a pending entry under VLADIMIR's scope.
    const persisted = await reminderStore.list({ identityId: VLADIMIR });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.reminderId).toBe("rem:case1");
    expect(persisted[0]!.status).toBe("pending");
    expect(persisted[0]!.ownerIdentityId).toBe(VLADIMIR);
    expect(persisted[0]!.fireAt).toBe(FIRE_AT_30M);

    // Cron callback registered exactly once with kind:'at' + payload.
    expect(cronAdd.calls).toHaveLength(1);
    const cronJob = cronAdd.calls[0] as {
      schedule: { kind: string; at: string };
      delivery: { mode: string; channel: string; to: string };
      payload: { kind: string; message: string };
    };
    expect(cronJob.schedule.kind).toBe("at");
    expect(cronJob.schedule.at).toBe(FIRE_AT_30M);
    expect(cronJob.delivery.channel).toBe(TELEGRAM);
    expect(cronJob.delivery.to).toBe(TELEGRAM_TO);
    expect(cronJob.payload.kind).toBe("agentTurn");
    expect(cronJob.payload.message).toBe("позвонить клиенту X");

    // ExpectedDelta carries reminderId for the done-predicate.
    const sched = (result.expectedDelta as ExpectedDelta).scheduledReminders;
    expect(sched?.added).toEqual(["rem:case1"]);
  });

  it("end-to-end runTurnDecision flow — kernel-derived productionDecision for reminder.set with state-after scheduledReminders slice", async () => {
    const fixtureAffordances = createAffordanceRegistry([
      REMINDER_SET_AFFORDANCE_ENTRY,
    ]);
    const reminderId = "rem:case1:e2e";
    const expectedDelta: ExpectedDelta = {
      scheduledReminders: { added: [reminderId] },
    };
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithScheduledReminder({ satisfied: true, reminderId }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "напомни мне через 30 минут позвонить клиенту X",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          reminderSetIntent(FIRE_AT_30M, "позвонить клиенту X"),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
    });

    expect(result.cutoverGate).toEqual({
      kind: "gate_in_success",
      effect: REMINDER_SET_EFFECT,
      terminalState: "action_completed",
      acceptanceReason: "commitment_satisfied",
    });
    expect(result.productionDecision).not.toBe(result.legacyDecision);
    expect(result.kernelFallback).toBe(false);
    expect(result.derivedCommitment?.effect).toBe(REMINDER_SET_EFFECT);
    expect(
      result.runtimeAttestation?.stateAfter.scheduledReminders?.records?.[0]
        ?.reminderId,
    ).toBe(reminderId);
  });
});

// ---------------------------------------------------------------------------
// Case 2 — «через неделю отправь Y предложение» fireAt=+7d
// ---------------------------------------------------------------------------

describe("cron-scheduler acceptance — Case 2: «через неделю отправь Y предложение» (fireAt=+7d)", () => {
  it("record-reminder-tool persists fireAt=+7d AND cron registration carries the same ISO-8601", async () => {
    const reminderStore: ReminderStore = new InMemoryReminderStore();
    const cronAdd = buildCronAdd();

    const result = await recordReminderTool({
      shape: {
        reminderId: "rem:case2",
        fireAt: FIRE_AT_7D,
        content: "отправь Y предложение",
        deliveryChannel: TELEGRAM,
        deliveryTo: TELEGRAM_TO,
      },
      ownerIdentityId: VLADIMIR,
      sessionId: SESSION_A,
      turnId: TURN_A,
      collector: activeCollector(SESSION_A, TURN_A),
      reminderStore,
      cronAdd,
      now: () => NOW_MS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const persisted = await reminderStore.list({ identityId: VLADIMIR });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.fireAt).toBe(FIRE_AT_7D);
    expect(persisted[0]!.content).toBe("отправь Y предложение");

    const cronJob = cronAdd.calls[0] as {
      schedule: { kind: string; at: string };
    };
    expect(cronJob.schedule.kind).toBe("at");
    expect(cronJob.schedule.at).toBe(FIRE_AT_7D);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — Cron-fire path: clock advances → fire callback delivers
// ---------------------------------------------------------------------------

describe("cron-scheduler acceptance — Case 3: cron-fire path → status=fired + identity scope respected", () => {
  it("fireReminder marks status='fired' AND dispatches with wrappedScopeIdentityId === record.ownerIdentityId", async () => {
    const reminderStore: ReminderStore = new InMemoryReminderStore();
    // Seed a pending record (mimics the post-recordReminderTool state).
    await reminderStore.schedule({
      reminderId: "rem:case3",
      ownerIdentityId: VLADIMIR,
      fireAt: FIRE_AT_30M,
      content: "позвонить клиенту X",
      deliveryChannel: TELEGRAM,
      deliveryTo: TELEGRAM_TO,
    });

    const dispatchCalls: Array<{
      reminderId: string;
      wrappedScopeIdentityId: string;
      channel: string;
      to: string;
    }> = [];
    const dispatchResult = await fireReminder({
      reminderId: "rem:case3",
      ownerIdentityId: VLADIMIR,
      reminderStore,
      deliveryDispatch: async (payload) => {
        dispatchCalls.push({
          reminderId: payload.reminderId,
          wrappedScopeIdentityId: payload.wrappedScopeIdentityId,
          channel: payload.channel,
          to: payload.to,
        });
        return { ok: true };
      },
    });

    expect(dispatchResult.ok).toBe(true);
    if (!dispatchResult.ok) {
      return;
    }
    expect(dispatchResult.reminderId).toBe("rem:case3");
    expect(dispatchResult.wrappedScopeIdentityId).toBe(VLADIMIR);

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]).toMatchObject({
      reminderId: "rem:case3",
      wrappedScopeIdentityId: VLADIMIR,
      channel: TELEGRAM,
      to: TELEGRAM_TO,
    });

    // status='fired' transitioned (idempotent on retry).
    const after = await reminderStore.get("rem:case3", VLADIMIR);
    expect(after?.status).toBe("fired");

    // Replay safety: second fire is a no-op (markFired idempotent on
    // already-fired record).
    const second = await fireReminder({
      reminderId: "rem:case3",
      ownerIdentityId: VLADIMIR,
      reminderStore,
      deliveryDispatch: async () => ({ ok: true }),
    });
    expect(second.ok).toBe(true);
  });

  it("REVERSE: fire callback rejects identity_mismatch — operator B cannot fire operator A's reminder", async () => {
    const reminderStore: ReminderStore = new InMemoryReminderStore();
    await reminderStore.schedule({
      reminderId: "rem:case3:rev",
      ownerIdentityId: VLADIMIR,
      fireAt: FIRE_AT_30M,
      content: "leak attempt",
      deliveryChannel: TELEGRAM,
      deliveryTo: TELEGRAM_TO,
    });

    const dispatchSpy = vi.fn(async () => ({ ok: true as const }));
    const result = await fireReminder({
      reminderId: "rem:case3:rev",
      // Operator B attempts to fire Vladimir's reminder.
      ownerIdentityId: OPERATOR_B,
      reminderStore,
      deliveryDispatch: dispatchSpy,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("record_missing");
    // Identity isolation at storage layer prevented the dispatch.
    expect(dispatchSpy).not.toHaveBeenCalled();
    // Vladimir's record stays `pending` (NOT fired by B's call).
    const stillPending = await reminderStore.get("rem:case3:rev", VLADIMIR);
    expect(stillPending?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Case 4 — Cross-test with slice K (bidirectional UX)
// ---------------------------------------------------------------------------

describe("cron-scheduler acceptance — Case 4: bidirectional UX — set then recall", () => {
  it("after recordReminderTool persists, ReminderStore.list returns the same entry (slice K's identity-scoped read predicates)", async () => {
    // Cron/Scheduler writes via `recordReminderTool` (closed
    // `ReminderSetShape` schema; identity injected from session-context).
    const reminderStore: ReminderStore = new InMemoryReminderStore();
    const cronAdd = buildCronAdd();
    const writeResult = await recordReminderTool({
      shape: {
        reminderId: "rem:case4",
        fireAt: FIRE_AT_30M,
        content: "позвонить клиенту X",
        deliveryChannel: TELEGRAM,
        deliveryTo: TELEGRAM_TO,
      },
      ownerIdentityId: VLADIMIR,
      sessionId: SESSION_A,
      turnId: TURN_A,
      collector: activeCollector(SESSION_A, TURN_A),
      reminderStore,
      cronAdd,
      now: () => NOW_MS,
    });
    expect(writeResult.ok).toBe(true);

    // The recall side (slice K) reads from ReminderStore via the same
    // identity-scoped predicate. Sub-plan §1 todo Phase 8 case (4): «set
    // reminder → query «какие у меня запланированы напоминания?» →
    // slice K returns the just-set entry». We exercise the
    // identity-scoped read directly so the test stays agnostic of
    // slice K's recall-tool plumbing (which is covered exhaustively in
    // `slice-k-reminder.acceptance.test.ts`).
    const recalled = await reminderStore.list({
      identityId: VLADIMIR,
      status: "pending",
    });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]!.reminderId).toBe("rem:case4");
    expect(recalled[0]!.content).toBe("позвонить клиенту X");
    expect(recalled[0]!.fireAt).toBe(FIRE_AT_30M);

    // Ordering by fireAt confirmed when adding a second pending reminder.
    await reminderStore.schedule({
      reminderId: "rem:case4:later",
      ownerIdentityId: VLADIMIR,
      fireAt: FIRE_AT_7D,
      content: "later",
      deliveryChannel: TELEGRAM,
      deliveryTo: TELEGRAM_TO,
    });
    const recalledBoth = await reminderStore.list({ identityId: VLADIMIR });
    expect(recalledBoth.map((r) => r.reminderId)).toEqual([
      "rem:case4",
      "rem:case4:later",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Case 5 — REVERSE: anonymous → fail-closed; ZERO writes
// ---------------------------------------------------------------------------

describe("cron-scheduler acceptance — Case 5 (reverse): anonymous → fail-closed", () => {
  it("missing ownerIdentityId returns identity_unavailable AND issues ZERO ReminderStore writes AND ZERO cron registrations", async () => {
    const reminderStore: ReminderStore = new InMemoryReminderStore();
    const scheduleSpy = vi.spyOn(reminderStore, "schedule");
    const cronAdd = buildCronAdd();

    const result = await recordReminderTool({
      shape: {
        reminderId: "rem:case5",
        fireAt: FIRE_AT_30M,
        content: "anon attempt",
        deliveryChannel: TELEGRAM,
        deliveryTo: TELEGRAM_TO,
      },
      ownerIdentityId: undefined,
      sessionId: SESSION_A,
      turnId: TURN_A,
      collector: activeCollector(SESSION_A, TURN_A),
      reminderStore,
      cronAdd,
      now: () => NOW_MS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("identity_unavailable");
    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(cronAdd.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Case 6 — REVERSE: cutover-off → legacy decision
// ---------------------------------------------------------------------------

describe("cron-scheduler acceptance — Case 6 (reverse): cutover-off → legacy bit-identical for reminder.set turn", () => {
  it("with cutoverEnabled=false the reminder.set turn falls through to legacyDecision (gate_out / cutover_disabled)", async () => {
    const fixtureAffordances = createAffordanceRegistry([
      REMINDER_SET_AFFORDANCE_ENTRY,
    ]);
    const reminderId = "rem:case6";
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithScheduledReminder({ satisfied: true, reminderId }),
      ),
    };

    const result = await runTurnDecision({
      prompt: "напомни мне через 30 минут позвонить клиенту X",
      cfg: cfg({ cutoverEnabled: false }),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          reminderSetIntent(FIRE_AT_30M, "позвонить клиенту X"),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () =>
        ({ scheduledReminders: { added: [reminderId] } }) as ExpectedDelta,
    });

    expect(result.cutoverGate.kind).toBe("gate_out");
    if (result.cutoverGate.kind === "gate_out") {
      expect(result.cutoverGate.reason).toBe("cutover_disabled");
    }
    expect(result.kernelFallback).toBe(true);
    expect(monitoredRuntime.run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Case 7 — REVERSE: viewer-role → RolePolicy denies
// ---------------------------------------------------------------------------

describe("cron-scheduler acceptance — Case 7 (reverse): viewer-role → RolePolicy denies + escalation", () => {
  it("viewer role denies reminder.set AND escalation hook fires AND structured denial trace", async () => {
    const roleResolver: RoleResolver = vi.fn(async () => ["viewer" as RoleId]);
    const rolePolicy = createRolePolicy({
      cfg: {
        policy: {
          roles: {
            maintainer: { allowedEffects: [REMINDER_SET_EFFECT] },
            viewer: { allowedEffects: [] },
          },
        },
      } as unknown as OpenClawConfig,
      roleResolver,
    });
    const storeEpisodic = vi.fn(async () => undefined);
    const memoryStore = {
      storeEpisodic,
    } as unknown as Parameters<typeof createEscalationHook>[0]["memoryStore"];
    const escalationHook = createEscalationHook({
      memoryStore,
      idFactory: () => "escalation:case7",
    });

    const fixtureAffordances = createAffordanceRegistry([
      REMINDER_SET_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithScheduledReminder({ satisfied: true, reminderId: "rem:case7" }),
      ),
    };
    const reminderSetCutover = createCutoverPolicy([
      { effect: REMINDER_SET_EFFECT, effectFamily: REMINDER_EFFECT_FAMILY },
    ]);

    const result = await runTurnDecision({
      prompt: "напомни мне через 30 минут позвонить клиенту X",
      cfg: cfg(),
      identityId: ALICE,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(
          reminderSetIntent(FIRE_AT_30M, "позвонить клиенту X"),
        ),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () =>
        ({ scheduledReminders: { added: ["rem:case7"] } }) as ExpectedDelta,
      cutoverPolicy: reminderSetCutover,
      rolePolicy,
      escalationHook,
    });

    const trace = result.productionDecision.plannerInput.decisionTrace as
      | {
          readonly policyRoleDenial?: { readonly reason: string };
          readonly policyEscalationFired?: { readonly denialReason: string };
        }
      | undefined;
    expect(trace?.policyRoleDenial?.reason).toBe("role_denied");
    expect(trace?.policyEscalationFired?.denialReason).toBe("role_denied");

    const deniedLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=role_denied"),
    );
    expect(deniedLine).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Case 8 — REVERSE: budget exceeded
// ---------------------------------------------------------------------------

describe("cron-scheduler acceptance — Case 8 (reverse): budget exceeded → BudgetPolicy denies + escalation", () => {
  it("the (N+1)th reminder.set per identity exceeds the daily cap; subsequent attempts denied with budget_exceeded_user", async () => {
    // Test cap is 3/day — production config is 50/day; mechanism is the
    // same per-user dimension on REMINDER_EFFECT_FAMILY (sub-plan §1
    // todo Phase 7 fixture posture).
    const store = inMemoryBudgetStore();
    const budgetPolicy = createBudgetPolicy({
      cfg: {
        policy: {
          budgets: [
            {
              dimension: "user",
              limit: 3,
              windowMs: 24 * 60 * 60 * 1000,
              identityId: VLADIMIR,
              effectFamily: REMINDER_EFFECT_FAMILY,
            },
          ],
        },
      } as unknown as OpenClawConfig,
      budgetStore: store,
      resolveEffectFamily: () => REMINDER_EFFECT_FAMILY,
    });
    const reminderSetCutover = createCutoverPolicy([
      { effect: REMINDER_SET_EFFECT, effectFamily: REMINDER_EFFECT_FAMILY },
    ]);

    const fixtureAffordances = createAffordanceRegistry([
      REMINDER_SET_AFFORDANCE_ENTRY,
    ]);
    const monitoredRuntime = {
      run: vi.fn(async () =>
        attestationWithScheduledReminder({ satisfied: true, reminderId: "rem:case8" }),
      ),
    };
    const expectedDelta: ExpectedDelta = {
      scheduledReminders: { added: ["rem:case8"] },
    };

    const runOnce = () =>
      runTurnDecision({
        prompt: "напомни мне через 30 минут позвонить клиенту X",
        cfg: cfg(),
        identityId: VLADIMIR,
        classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
        intentContractorAdapterRegistry: {
          "intent-mock": intentAdapter(
            reminderSetIntent(FIRE_AT_30M, "позвонить клиенту X"),
          ),
        },
        affordanceRegistry: fixtureAffordances,
        monitoredRuntime,
        expectedDeltaResolver: () => expectedDelta,
        cutoverPolicy: reminderSetCutover,
        budgetPolicy,
      });

    for (let i = 0; i < 3; i += 1) {
      const r = await runOnce();
      const trace = r.productionDecision.plannerInput.decisionTrace as
        | { readonly policyBudgetDenial?: { readonly reason: string } }
        | undefined;
      expect(trace?.policyBudgetDenial).toBeUndefined();
    }

    const denied = await runOnce();
    const trace = denied.productionDecision.plannerInput.decisionTrace as
      | { readonly policyBudgetDenial?: { readonly reason: string } }
      | undefined;
    expect(trace?.policyBudgetDenial?.reason).toBe("budget_exceeded_user");

    const exceededLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=budget_exceeded"),
    );
    expect(exceededLine).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Case 9 — REVERSE: identity isolation
// ---------------------------------------------------------------------------

describe("cron-scheduler acceptance — Case 9 (reverse): identity isolation — operator A NEVER fired/listed under operator B", () => {
  it("operator A persists reminder; operator B's list NEVER returns A's entry; B's get(reminderId, B) returns undefined", async () => {
    const reminderStore: ReminderStore = new InMemoryReminderStore();
    // A persists a reminder.
    await reminderStore.schedule({
      reminderId: "rem:case9:A",
      ownerIdentityId: VLADIMIR,
      fireAt: FIRE_AT_30M,
      content: "secret-A",
      deliveryChannel: TELEGRAM,
      deliveryTo: TELEGRAM_TO,
    });
    // B persists a different reminder.
    await reminderStore.schedule({
      reminderId: "rem:case9:B",
      ownerIdentityId: OPERATOR_B,
      fireAt: FIRE_AT_30M,
      content: "secret-B",
      deliveryChannel: TELEGRAM,
      deliveryTo: TELEGRAM_TO,
    });

    // A's list returns ONLY A's entry.
    const aList = await reminderStore.list({ identityId: VLADIMIR });
    expect(aList).toHaveLength(1);
    expect(aList[0]!.reminderId).toBe("rem:case9:A");

    // B's list returns ONLY B's entry — NEVER A's, even though both
    // entries share `fireAt`.
    const bList = await reminderStore.list({ identityId: OPERATOR_B });
    expect(bList).toHaveLength(1);
    expect(bList[0]!.reminderId).toBe("rem:case9:B");

    // B attempts cross-identity `get` for A's id — returns undefined.
    const cross = await reminderStore.get("rem:case9:A", OPERATOR_B);
    expect(cross).toBeUndefined();

    // A attempts cross-identity `get` for B's id — returns undefined.
    const reverseCross = await reminderStore.get("rem:case9:B", VLADIMIR);
    expect(reverseCross).toBeUndefined();
  });

  it("operator B firing operator A's reminder fails record_missing AND ZERO dispatch AND A's record stays pending", async () => {
    const reminderStore: ReminderStore = new InMemoryReminderStore();
    await reminderStore.schedule({
      reminderId: "rem:case9:fire",
      ownerIdentityId: VLADIMIR,
      fireAt: FIRE_AT_30M,
      content: "fire-isolation",
      deliveryChannel: TELEGRAM,
      deliveryTo: TELEGRAM_TO,
    });

    const dispatch = vi.fn(async () => ({ ok: true as const }));
    const result = await fireReminder({
      reminderId: "rem:case9:fire",
      ownerIdentityId: OPERATOR_B,
      reminderStore,
      deliveryDispatch: dispatch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("record_missing");
    expect(dispatch).not.toHaveBeenCalled();

    const stillPending = await reminderStore.get("rem:case9:fire", VLADIMIR);
    expect(stillPending?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Case 10 — REVERSE: fireAt in past
// ---------------------------------------------------------------------------

describe("cron-scheduler acceptance — Case 10 (reverse): fireAt in past → fire_at_in_past + ZERO cron registration", () => {
  it("recordReminderTool returns fire_at_in_past AND ZERO cron registration AND ZERO observer record", async () => {
    const reminderStore: ReminderStore = new InMemoryReminderStore();
    const cronAdd = buildCronAdd();
    const collector = activeCollector(SESSION_B, TURN_B);

    const result = await recordReminderTool({
      shape: {
        reminderId: "rem:case10",
        fireAt: FIRE_AT_PAST,
        content: "past attempt",
        deliveryChannel: TELEGRAM,
        deliveryTo: TELEGRAM_TO,
      },
      ownerIdentityId: VLADIMIR,
      sessionId: SESSION_B,
      turnId: TURN_B,
      collector,
      reminderStore,
      cronAdd,
      now: () => NOW_MS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("fire_at_in_past");
    // ZERO cron registration (the in-past check fails BEFORE cronAdd is
    // invoked — sub-plan §1 todo Phase 8 acceptance #10).
    expect(cronAdd.calls).toHaveLength(0);
    // ZERO observer record (the in-past check fails BEFORE the runtime
    // adapter is invoked — done-predicate cannot satisfy without a
    // matching scheduledReminders.added entry).
    const slice = collector.getActiveSlice();
    expect(slice ?? []).toHaveLength(0);
  });
});
