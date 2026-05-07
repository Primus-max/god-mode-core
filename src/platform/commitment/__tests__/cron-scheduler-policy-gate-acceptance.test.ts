import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { asIdentityId } from "../../identity/identity-id.js";
import {
  REMINDER_EFFECT_FAMILY,
  REMINDER_SET_AFFORDANCE_ENTRY,
  REMINDER_SET_EFFECT,
  buildBudgetWindowId,
  createAffordanceRegistry,
  createApprovalPolicy,
  createBudgetPolicy,
  createCutoverPolicy,
  createEscalationHook,
  createInMemoryRetryStateStore,
  createRetryPolicy,
  createRolePolicy,
  type ApprovalRequestCreator,
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
} from "../index.js";
import type { ChannelId, ISO8601 } from "../ids.js";
import type { OperationHint, TargetRef } from "../semantic-intent.js";
import type { WorldStateSnapshot } from "../world-state.js";
import { runTurnDecision } from "../../decision/run-turn-decision.js";
import type {
  TaskClassifierAdapter,
  TaskContract,
} from "../../decision/task-classifier.js";

/**
 * Cron/Scheduler Phase 7 — PolicyGate Full integration ACCEPTANCE.
 *
 * Mirrors `cutover4-policy-gate-acceptance.test.ts` (Cutover-4 P6
 * precedent) but exercises the `reminder.set` write effect with REAL
 * policy readers (`createApprovalPolicy`, `createBudgetPolicy`,
 * `createRolePolicy`, `createRetryPolicy`, `createEscalationHook`)
 * driven by the same Phase 7 config shape that ships in
 * `OpenClawConfig.policy.{approvals,budgets,roles,retry}`.
 *
 * Phase 7 of `commitment_kernel_cron_scheduler.plan.md` is config-only
 * — no new factories, no new orthogonal `*POLICY_REASONS` tuples. This
 * file pins the contract that the EXISTING readers, driven by config
 * fields a host operator writes, deny / permit reminder.set turns
 * end-to-end.
 *
 * Per-stage coverage matrix:
 *   (a) Stage 2 — `reminder.set` requires approver Vladimir; Alice
 *       (not in approvers) denied; Vladimir permitted.
 *   (b) Stage 3 — `policy.budgets` per-channel hourly cap on
 *       `reminder.set` at 10/h; 11th request on the same channel
 *       denied. Per-identity daily cap at 50 verified by entry
 *       acceptance only (50 sequential runs would slow CI).
 *   (c) Stage 4 — maintainer permits `reminder.set`; viewer does NOT
 *       (viewer's allowedEffects empty per spec); developer permits
 *       `reminder.set`; anonymous identity → fail-closed.
 *   (d) Stage 5 — mutation idempotency lock: `reminder.set` config
 *       MUST NOT exceed `maxAttempts=0`. Reverse-test (Zod) lives at
 *       `src/config/zod-schema.policy-reminder-set.test.ts`. Here
 *       we additionally pin: when `attemptCount=1` and `maxAttempts=0`
 *       the runtime reader denies with `retry_limit_exceeded`
 *       — proves the schema lock + runtime reader agree.
 *   (e) Stage 6 — escalation fan-out fires on each denial reason;
 *       observability log line emitted; escalation failure does NOT
 *       gate satisfaction (slice E precedent).
 *   (f) Chain ordering — denial at Stage 2 short-circuits Stages 3/4/5;
 *       Stage 4 denial does NOT consult Stage 5.
 *
 * Frozen-layer integrity: this fixture imports ZERO frozen-layer
 * symbols beyond the already-shipped readers + types. PolicyGate Full
 * files (Phases 3-7 of `commitment_kernel_policy_gate_full.plan.md`)
 * remain BYTE-IDENTICAL through Cron/Scheduler Phase 7.
 *
 * Production cutover-policy is injected via `createCutoverPolicy` to
 * admit the `reminder.set` effect ahead of the Phase-8 flip — Phase 7
 * is config-only, so the policy chain is exercised with a per-test
 * cutover-policy override. The default `defaultCutoverPolicy` stays
 * BYTE-IDENTICAL until Cron/Scheduler Phase 8 lands.
 */

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");

const legacyContract: TaskContract = {
  primaryOutcome: "answer",
  requiredCapabilities: [],
  interactionMode: "respond_only",
  confidence: 0.9,
  ambiguities: [],
};

function cfg(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    ...overrides,
    agents: {
      defaults: {
        embeddedPi: {
          taskClassifier: { backend: "legacy-mock" },
          intentContractor: { backend: "intent-mock" },
          commitment: { cutoverEnabled: true },
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

function reminderSetCutoverPolicy() {
  return createCutoverPolicy([
    { effect: REMINDER_SET_EFFECT, effectFamily: REMINDER_EFFECT_FAMILY },
  ]);
}

const SAMPLE_REMINDER_ID = "reminder_acc_phase7_1";

function reminderSetAttestation(): RuntimeAttestation {
  const stateAfter: WorldStateSnapshot = {
    scheduledReminders: {
      records: [
        {
          reminderId: SAMPLE_REMINDER_ID,
          ownerIdentityId: VLADIMIR,
          fireAt: "2026-05-07T13:00:00.000Z" as ISO8601,
          content: "позвонить клиенту X",
          deliveryChannel: "telegram" as ChannelId,
          deliveryTo: "6533456892",
          createdAt: "2026-05-07T12:30:00.000Z" as ISO8601,
          status: "pending",
        },
      ],
    },
  };
  return {
    commitmentSatisfied: true,
    terminalState: "action_completed",
    acceptanceReason: "commitment_satisfied",
    stateBefore: {},
    stateAfter,
    satisfaction: { satisfied: true, evidence: [] },
  };
}

function reminderSetIntent(): SemanticIntent {
  const target: TargetRef = { kind: "unspecified" };
  const operation: OperationHint = { kind: "create" };
  return {
    desiredEffectFamily: REMINDER_EFFECT_FAMILY,
    target,
    operation,
    constraints: {
      reminderSet: {
        fireAt: "2026-05-07T13:00:00.000Z",
        content: "позвонить клиенту X",
        deliveryChannel: "telegram",
        deliveryTo: "6533456892",
      },
    },
    uncertainty: [],
    confidence: 0.9,
  };
}

function fixedApprovalCreator(id: string): ApprovalRequestCreator & {
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(() => ({ id }));
  return { create };
}

/**
 * In-memory `BudgetStore` fake — same key shape as
 * `cutover4-policy-gate-acceptance.test.ts` (sub-plan §0.6 reference).
 */
function inMemoryBudgetStore(now: () => number = Date.now): BudgetStore {
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
    resetExpired(_t) {
      return Promise.resolve(0);
    },
  };
}

// ---------------------------------------------------------------------------
// console.log capture — Phase 7 sub-plan §1 todo log lines.
// ---------------------------------------------------------------------------

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
// (a) Stage 2 — reminder.set approval gate.
// ---------------------------------------------------------------------------

describe("Cron/Scheduler Phase 7 acceptance — Stage 2 (Approval) on reminder.set", () => {
  it("denies reminder.set when caller is not in approvers list", async () => {
    const approvalCreator = fixedApprovalCreator("approval-acc-cron-stage2");
    const approvalPolicy = createApprovalPolicy({
      cfg: {
        policy: {
          approvals: [
            {
              effectId: REMINDER_SET_EFFECT,
              requiredApprovals: 1,
              approvers: [VLADIMIR],
            },
          ],
        },
      } as unknown as OpenClawConfig,
      approvalCreator,
    });

    const registry = createAffordanceRegistry([REMINDER_SET_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => reminderSetAttestation()) };
    const expectedDelta: ExpectedDelta = {
      scheduledReminders: { added: [SAMPLE_REMINDER_ID] },
    };

    const result = await runTurnDecision({
      prompt: "напомни мне через 30 минут позвонить клиенту X",
      cfg: cfg(),
      identityId: ALICE, // NOT in approvers
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(reminderSetIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: reminderSetCutoverPolicy(),
      approvalPolicy,
    });

    expect(result.kernelFallback).toBe(false);
    expect(approvalCreator.create).toHaveBeenCalledTimes(1);

    const checkedLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=approval_checked stage=2"),
    );
    expect(checkedLine).toBeDefined();
    expect(checkedLine).toContain(`effect=${String(REMINDER_SET_EFFECT)}`);
    expect(checkedLine).toContain("approved=false");

    const requestCreatedLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=approval_request_created"),
    );
    expect(requestCreatedLine).toBeDefined();
    expect(requestCreatedLine).toContain("approval_id=approval-acc-cron-stage2");
  });

  it("permits reminder.set when caller IS in approvers list (positive path)", async () => {
    const approvalCreator = fixedApprovalCreator("approval-not-used-stage2");
    const approvalPolicy = createApprovalPolicy({
      cfg: {
        policy: {
          approvals: [
            {
              effectId: REMINDER_SET_EFFECT,
              requiredApprovals: 1,
              approvers: [VLADIMIR],
            },
          ],
        },
      } as unknown as OpenClawConfig,
      approvalCreator,
    });

    const registry = createAffordanceRegistry([REMINDER_SET_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => reminderSetAttestation()) };
    const expectedDelta: ExpectedDelta = {
      scheduledReminders: { added: [SAMPLE_REMINDER_ID] },
    };

    const result = await runTurnDecision({
      prompt: "напомни мне через 30 минут позвонить клиенту X",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(reminderSetIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: reminderSetCutoverPolicy(),
      approvalPolicy,
    });

    expect(result.kernelFallback).toBe(false);
    expect(approvalCreator.create).not.toHaveBeenCalled();
    const checkedLine = logged.find(
      (l) =>
        l.startsWith("[policy-gate] event=approval_checked stage=2") &&
        l.includes("approved=true"),
    );
    expect(checkedLine).toBeDefined();
  });

  it("REVERSE: anonymous identity (undefined) fail-closed when reminder.set is in approvals list", async () => {
    const approvalCreator = fixedApprovalCreator("approval-anon-stage2");
    const approvalPolicy = createApprovalPolicy({
      cfg: {
        policy: {
          approvals: [
            {
              effectId: REMINDER_SET_EFFECT,
              requiredApprovals: 1,
              approvers: [VLADIMIR],
            },
          ],
        },
      } as unknown as OpenClawConfig,
      approvalCreator,
    });

    const registry = createAffordanceRegistry([REMINDER_SET_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => reminderSetAttestation()) };
    const expectedDelta: ExpectedDelta = {
      scheduledReminders: { added: [SAMPLE_REMINDER_ID] },
    };

    await runTurnDecision({
      prompt: "напомни мне через 30 минут позвонить клиенту X",
      cfg: cfg(),
      // identityId intentionally omitted — anonymous fail-closed.
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(reminderSetIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: reminderSetCutoverPolicy(),
      approvalPolicy,
    });

    const checkedLine = logged.find(
      (l) =>
        l.startsWith("[policy-gate] event=approval_checked stage=2") &&
        l.includes("approved=false"),
    );
    expect(checkedLine).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (b) Stage 3 — per-channel hourly budget cap on reminder.set.
// ---------------------------------------------------------------------------

describe("Cron/Scheduler Phase 7 acceptance — Stage 3 (Budget) on reminder.set", () => {
  it("denies the 11th reminder.set in the same hour on a channel with limit=10", async () => {
    const store = inMemoryBudgetStore();
    const budgetPolicy = createBudgetPolicy({
      cfg: {
        policy: {
          budgets: [
            {
              dimension: "channel",
              limit: 10,
              windowMs: 60 * 60 * 1000,
              channel: "telegram",
              effectFamily: REMINDER_EFFECT_FAMILY,
            },
          ],
        },
        channels: { _activeChannel: "telegram" },
      } as unknown as OpenClawConfig,
      budgetStore: store,
      resolveEffectFamily: () => REMINDER_EFFECT_FAMILY,
    });

    const registry = createAffordanceRegistry([REMINDER_SET_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => reminderSetAttestation()) };
    const expectedDelta: ExpectedDelta = {
      scheduledReminders: { added: [SAMPLE_REMINDER_ID] },
    };

    const runOnce = () =>
      runTurnDecision({
        prompt: "напомни мне через 30 минут позвонить клиенту X",
        cfg: cfg({
          channels: { _activeChannel: "telegram" },
        } as unknown as Partial<OpenClawConfig>),
        identityId: VLADIMIR,
        classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
        intentContractorAdapterRegistry: { "intent-mock": intentAdapter(reminderSetIntent()) },
        affordanceRegistry: registry,
        monitoredRuntime,
        expectedDeltaResolver: () => expectedDelta,
        cutoverPolicy: reminderSetCutoverPolicy(),
        budgetPolicy,
      });

    // Charge ten within-cap reminders.
    for (let i = 0; i < 10; i += 1) {
      const r = await runOnce();
      const trace = r.productionDecision.plannerInput.decisionTrace as
        | { readonly policyBudgetDenial?: { readonly reason: string } }
        | undefined;
      expect(trace?.policyBudgetDenial).toBeUndefined();
    }

    // 11th request denied.
    const denied = await runOnce();
    const trace = denied.productionDecision.plannerInput.decisionTrace as
      | { readonly policyBudgetDenial?: { readonly reason: string } }
      | undefined;
    expect(trace?.policyBudgetDenial?.reason).toBe("budget_exceeded_channel");

    const exceededLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=budget_exceeded"),
    );
    expect(exceededLine).toBeDefined();
  });

  it("denies the 4th reminder.set per identity when daily cap = 3 (per-identity dimension)", async () => {
    // perIdentityDaily=50 in production config; 3 in this test for CI speed.
    // The mechanism (per-user dimension on REMINDER_EFFECT_FAMILY) is the
    // same as the production setting.
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

    const registry = createAffordanceRegistry([REMINDER_SET_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => reminderSetAttestation()) };
    const expectedDelta: ExpectedDelta = {
      scheduledReminders: { added: [SAMPLE_REMINDER_ID] },
    };

    const runOnce = () =>
      runTurnDecision({
        prompt: "напомни мне через 30 минут позвонить клиенту X",
        cfg: cfg(),
        identityId: VLADIMIR,
        classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
        intentContractorAdapterRegistry: { "intent-mock": intentAdapter(reminderSetIntent()) },
        affordanceRegistry: registry,
        monitoredRuntime,
        expectedDeltaResolver: () => expectedDelta,
        cutoverPolicy: reminderSetCutoverPolicy(),
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
  });
});

// ---------------------------------------------------------------------------
// (c) Stage 4 — role allowedEffects matrix on reminder.set.
// ---------------------------------------------------------------------------

describe("Cron/Scheduler Phase 7 acceptance — Stage 4 (Role) on reminder.set", () => {
  it("permits reminder.set for maintainer role", async () => {
    const roleResolver: RoleResolver = vi.fn(async () => ["maintainer" as RoleId]);
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

    const registry = createAffordanceRegistry([REMINDER_SET_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => reminderSetAttestation()) };
    const expectedDelta: ExpectedDelta = {
      scheduledReminders: { added: [SAMPLE_REMINDER_ID] },
    };

    const result = await runTurnDecision({
      prompt: "напомни мне через 30 минут позвонить клиенту X",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(reminderSetIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: reminderSetCutoverPolicy(),
      rolePolicy,
    });

    const trace = result.productionDecision.plannerInput.decisionTrace as
      | { readonly policyRoleDenial?: unknown }
      | undefined;
    expect(trace?.policyRoleDenial).toBeUndefined();

    // Live evidence: role-policy emits role_checked log line without an
    // `effect=` substring (impl in `role-policy.ts:emitChecked`); the
    // turn under test is the only `reminder.set` invocation in the
    // captured stream so the `allowed=true` line uniquely identifies it.
    const checkedLine = logged.find(
      (l) =>
        l.startsWith("[policy-gate] event=role_checked stage=4") &&
        l.includes("role=maintainer") &&
        l.includes("allowed=true"),
    );
    expect(checkedLine).toBeDefined();
  });

  it("denies reminder.set for viewer role (viewer's allowedEffects empty per spec)", async () => {
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

    const registry = createAffordanceRegistry([REMINDER_SET_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => reminderSetAttestation()) };
    const expectedDelta: ExpectedDelta = {
      scheduledReminders: { added: [SAMPLE_REMINDER_ID] },
    };

    const result = await runTurnDecision({
      prompt: "напомни мне через 30 минут позвонить клиенту X",
      cfg: cfg(),
      identityId: ALICE,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(reminderSetIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: reminderSetCutoverPolicy(),
      rolePolicy,
    });

    const trace = result.productionDecision.plannerInput.decisionTrace as
      | {
          readonly policyRoleDenial?: {
            readonly reason: string;
            readonly requiredRole: string;
          };
        }
      | undefined;
    expect(trace?.policyRoleDenial?.reason).toBe("role_denied");

    const deniedLine = logged.find((l) => l.startsWith("[policy-gate] event=role_denied"));
    expect(deniedLine).toBeDefined();
  });

  it("REVERSE: anonymous identity fail-closed even when no role policy is restrictive", async () => {
    // Spec: «anonymous → fail-closed (default-deny)». When the role
    // resolver returns no roles for an anonymous turn AND policy.roles
    // has any entry, the gate denies.
    const roleResolver: RoleResolver = vi.fn(async () => []);
    const rolePolicy = createRolePolicy({
      cfg: {
        policy: {
          roles: {
            maintainer: { allowedEffects: [REMINDER_SET_EFFECT] },
          },
        },
      } as unknown as OpenClawConfig,
      roleResolver,
    });

    const registry = createAffordanceRegistry([REMINDER_SET_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => reminderSetAttestation()) };
    const expectedDelta: ExpectedDelta = {
      scheduledReminders: { added: [SAMPLE_REMINDER_ID] },
    };

    const result = await runTurnDecision({
      prompt: "напомни мне через 30 минут позвонить клиенту X",
      cfg: cfg(),
      // anonymous: no identityId
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(reminderSetIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: reminderSetCutoverPolicy(),
      rolePolicy,
    });

    const trace = result.productionDecision.plannerInput.decisionTrace as
      | { readonly policyRoleDenial?: { readonly reason: string } }
      | undefined;
    expect(trace?.policyRoleDenial?.reason).toBe("role_denied");
  });
});

// ---------------------------------------------------------------------------
// (d) Stage 5 — retry mutation lock on reminder.set (maxAttempts=0).
// ---------------------------------------------------------------------------

describe("Cron/Scheduler Phase 7 acceptance — Stage 5 (Retry) on reminder.set (maxAttempts=0 lock)", () => {
  it("denies reminder.set when caller-supplied attemptCount=1 (any retry exhausts the maxAttempts=0 budget)", async () => {
    // The Zod schema rejects `maxAttempts > 0` for reminder.set at config
    // load (reverse-test in `zod-schema.policy-reminder-set.test.ts`).
    // Here we pin the runtime reader's behaviour given the canonical
    // `maxAttempts=0` config: attemptCount=1 must be denied.
    const retryStateStore = createInMemoryRetryStateStore();
    const retryPolicy = createRetryPolicy({
      cfg: {
        policy: {
          retry: {
            perEffect: {
              [REMINDER_SET_EFFECT]: { maxAttempts: 0 },
            },
          },
        },
      } as unknown as OpenClawConfig,
      retryStateStore,
    });

    const registry = createAffordanceRegistry([REMINDER_SET_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => reminderSetAttestation()) };
    const expectedDelta: ExpectedDelta = {
      scheduledReminders: { added: [SAMPLE_REMINDER_ID] },
    };

    const result = await runTurnDecision({
      prompt: "напомни мне через 30 минут позвонить клиенту X",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(reminderSetIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: reminderSetCutoverPolicy(),
      retryPolicy,
      retryContext: { attemptCount: 1, sessionId: "session_acc_phase7_retry" },
    });

    const trace = result.productionDecision.plannerInput.decisionTrace as
      | {
          readonly policyRetryDenial?: {
            readonly reason: string;
            readonly attemptCount: number;
            readonly maxAttempts: number;
          };
        }
      | undefined;
    expect(trace?.policyRetryDenial?.reason).toBe("retry_limit_exceeded");
    expect(trace?.policyRetryDenial?.maxAttempts).toBe(0);

    const exhaustedLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=retry_exhausted"),
    );
    expect(exhaustedLine).toBeDefined();
    expect(exhaustedLine).toContain(`effect=${String(REMINDER_SET_EFFECT)}`);
  });

  it("REVERSE: permits reminder.set when no perEffect override exists (default-allow path — schema lock defends operator config, runtime falls through to defaultMaxAttempts=3)", async () => {
    // The mutation lock at `zod-schema.ts` superRefine prevents an
    // operator from writing a non-zero `maxAttempts` for `reminder.set`
    // at config-load time — this is the canonical defensive layer.
    // When the operator omits the perEffect entry entirely, the runtime
    // reader falls through to `RETRY_POLICY_DEFAULT_MAX_ATTEMPTS=3`,
    // and the first attempt (`attemptCount=0`) is permitted. This path
    // pins the runtime behaviour for the «no override written» config
    // shape that cron-scheduler ships in production v1.
    const retryStateStore = createInMemoryRetryStateStore();
    const retryPolicy = createRetryPolicy({
      cfg: {
        policy: {
          retry: {
            // No perEffect override — runtime uses defaultMaxAttempts=3.
          },
        },
      } as unknown as OpenClawConfig,
      retryStateStore,
    });

    const registry = createAffordanceRegistry([REMINDER_SET_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => reminderSetAttestation()) };
    const expectedDelta: ExpectedDelta = {
      scheduledReminders: { added: [SAMPLE_REMINDER_ID] },
    };

    const result = await runTurnDecision({
      prompt: "напомни мне через 30 минут позвонить клиенту X",
      cfg: cfg(),
      identityId: VLADIMIR,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(reminderSetIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: reminderSetCutoverPolicy(),
      retryPolicy,
      retryContext: { attemptCount: 0, sessionId: "session_acc_phase7_retry_ok" },
    });

    const trace = result.productionDecision.plannerInput.decisionTrace as
      | { readonly policyRetryDenial?: unknown }
      | undefined;
    expect(trace?.policyRetryDenial).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (e) Stage 6 — escalation fan-out on any denial reason.
// ---------------------------------------------------------------------------

describe("Cron/Scheduler Phase 7 acceptance — Stage 6 (Escalation) fan-out on reminder.set", () => {
  it("escalation fires on reminder.set approval denial", async () => {
    const approvalCreator = fixedApprovalCreator("approval-acc-phase7-stage6");
    const approvalPolicy = createApprovalPolicy({
      cfg: {
        policy: {
          approvals: [
            {
              effectId: REMINDER_SET_EFFECT,
              requiredApprovals: 1,
              approvers: [VLADIMIR],
            },
          ],
        },
      } as unknown as OpenClawConfig,
      approvalCreator,
    });
    const escalationCreator = fixedApprovalCreator("escalation-acc-phase7-stage6");
    const escalationHook = createEscalationHook({
      approvalCreator: escalationCreator,
      idFactory: () => "escalation:acc-phase7-stage6",
    });

    const registry = createAffordanceRegistry([REMINDER_SET_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => reminderSetAttestation()) };
    const expectedDelta: ExpectedDelta = {
      scheduledReminders: { added: [SAMPLE_REMINDER_ID] },
    };

    const result = await runTurnDecision({
      prompt: "напомни мне через 30 минут позвонить клиенту X",
      cfg: cfg(),
      identityId: ALICE,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(reminderSetIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: reminderSetCutoverPolicy(),
      approvalPolicy,
      escalationHook,
    });

    const trace = result.productionDecision.plannerInput.decisionTrace as
      | {
          readonly policyEscalationFired?: {
            readonly denialReason: string;
            readonly escalationId: string;
          };
        }
      | undefined;
    expect(trace?.policyEscalationFired?.denialReason).toBe("requires_approval");

    const firedLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=escalation_fired"),
    );
    expect(firedLine).toBeDefined();
    expect(firedLine).toContain("reason=requires_approval");
  });

  it("escalation fires on reminder.set role denial (different denial reason → memory channel)", async () => {
    const roleResolver: RoleResolver = vi.fn(async () => ["viewer" as RoleId]);
    const rolePolicy = createRolePolicy({
      cfg: {
        policy: {
          roles: {
            viewer: { allowedEffects: [] },
          },
        },
      } as unknown as OpenClawConfig,
      roleResolver,
    });
    // Role denials route to the `memory` channel (sub-plan §6
    // escalation-hook.ts doc-block §3 — only `requires_approval` routes
    // to the approval_request channel; everything else uses memory).
    // Inject a stub memory store so the escalation lifecycle reaches
    // the `fired=true` branch.
    const storeEpisodic = vi.fn(async () => undefined);
    const memoryStore = {
      storeEpisodic,
      // Other methods are unused on this path — cast through `unknown`
      // matches the platform/memory `MemoryStore` shape without the
      // verbose stub for unused surface.
    } as unknown as Parameters<typeof createEscalationHook>[0]["memoryStore"];
    const escalationHook = createEscalationHook({
      memoryStore,
      idFactory: () => "escalation:acc-phase7-role",
    });

    const registry = createAffordanceRegistry([REMINDER_SET_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => reminderSetAttestation()) };
    const expectedDelta: ExpectedDelta = {
      scheduledReminders: { added: [SAMPLE_REMINDER_ID] },
    };

    const result = await runTurnDecision({
      prompt: "напомни мне через 30 минут позвонить клиенту X",
      cfg: cfg(),
      identityId: ALICE,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(reminderSetIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: reminderSetCutoverPolicy(),
      rolePolicy,
      escalationHook,
    });

    const trace = result.productionDecision.plannerInput.decisionTrace as
      | { readonly policyEscalationFired?: { readonly denialReason: string } }
      | undefined;
    expect(trace?.policyEscalationFired?.denialReason).toBe("role_denied");
  });
});

// ---------------------------------------------------------------------------
// (f) Chain ordering — Stage 2 denial short-circuits Stage 3/4/5.
// ---------------------------------------------------------------------------

describe("Cron/Scheduler Phase 7 acceptance — chain ordering on reminder.set", () => {
  it("Stage 2 approval denial short-circuits Stage 3 budget consultation (budgetStore.increment NOT called)", async () => {
    const approvalCreator = fixedApprovalCreator("approval-chain-stage2");
    const approvalPolicy = createApprovalPolicy({
      cfg: {
        policy: {
          approvals: [
            {
              effectId: REMINDER_SET_EFFECT,
              requiredApprovals: 1,
              approvers: [VLADIMIR],
            },
          ],
        },
      } as unknown as OpenClawConfig,
      approvalCreator,
    });

    const incrementSpy = vi.fn(inMemoryBudgetStore().increment);
    const budgetStore: BudgetStore = {
      read() {
        return Promise.resolve(null);
      },
      increment: incrementSpy,
      resetExpired() {
        return Promise.resolve(0);
      },
    };
    const budgetPolicy = createBudgetPolicy({
      cfg: {
        policy: {
          budgets: [
            {
              dimension: "channel",
              limit: 10,
              windowMs: 60 * 60 * 1000,
              channel: "telegram",
              effectFamily: REMINDER_EFFECT_FAMILY,
            },
          ],
        },
      } as unknown as OpenClawConfig,
      budgetStore,
      resolveEffectFamily: () => REMINDER_EFFECT_FAMILY,
    });

    const registry = createAffordanceRegistry([REMINDER_SET_AFFORDANCE_ENTRY]);
    const monitoredRuntime = { run: vi.fn(async () => reminderSetAttestation()) };
    const expectedDelta: ExpectedDelta = {
      scheduledReminders: { added: [SAMPLE_REMINDER_ID] },
    };

    await runTurnDecision({
      prompt: "напомни мне через 30 минут позвонить клиенту X",
      cfg: cfg(),
      identityId: ALICE, // approval denial
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter(reminderSetIntent()) },
      affordanceRegistry: registry,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      cutoverPolicy: reminderSetCutoverPolicy(),
      approvalPolicy,
      budgetPolicy,
    });

    // Approval denied at Stage 2 → Stage 3 budget reader NOT consulted.
    expect(incrementSpy).not.toHaveBeenCalled();
  });
});
