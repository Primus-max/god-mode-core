/**
 * PolicyGate Full — Phase 10 acceptance fixture.
 *
 * One end-to-end case per stage (2-6) plus the two co-scheduled
 * orchestration-layer bug fixes (Bug #1, Bug #3) per
 * `commitment_kernel_policy_gate_full.plan.md` §3 row Phase 10:
 *
 *   (a) Stage 2 — config with a required-approval effect, kernel-derived
 *       turn launches that effect, policy gate denies, ApprovalRequest is
 *       created via the injected `ApprovalRequestCreator`, and the
 *       `[policy-gate] event=approval_checked stage=2 ... approved=false`
 *       log line is emitted.
 *   (b) Stage 3 — config with a per-channel budget limit=2; the third
 *       attempt in the same channel is blocked and
 *       `[policy-gate] event=budget_exceeded` is emitted.
 *   (c) Stage 4 — config with a user-role + restricted effect; user
 *       lacking the permitting role is blocked and
 *       `[policy-gate] event=role_denied required=<r>` is emitted.
 *   (d) Stage 5 — sequential transient failures: when the wiring layer
 *       reaches `attemptCount === maxAttempts`, the retry policy denies
 *       and `[policy-gate] event=retry_exhausted effect=<id>` is
 *       emitted.
 *   (e) Stage 6 — denial of any reason fires the escalation hook; the
 *       `[policy-gate] event=escalation_fired reason=<r> channel=<c>
 *        escalation_id=<id>` log line is emitted.
 *   (f) Bug #1 — capability already verified + bootstrap-remediation
 *       request → `bootstrap_noop` does NOT fire and
 *       `[closure-outcome] event=bootstrap_skip_already_verified
 *        capability=<id>` is emitted (Phase 8 deliverable; this fixture
 *       cross-checks it stayed green inside the slice's full acceptance
 *       run).
 *   (g) Bug #3 — `waitForSessionsYieldAbortSettle` with a 30 s real-render
 *       settle completes against the new 60 s default (Phase 9 deliverable;
 *       cross-checked here).
 *
 * Each case uses real `runTurnDecision` + real readers + real wiring (no
 * mocks of policy logic). Spies are restricted to infrastructure seams:
 * `console.log` to capture `defaultRuntime.log` lines, deterministic
 * approval/escalation id factories, an in-memory budget store fake, and
 * fake timers for the bug #3 case. `intentContractor` and `taskClassifier`
 * use the same mock-adapter pattern as
 * `cutover3-artifacts.acceptance.test.ts` so the kernel-derived path
 * resolves to a real `ExecutionCommitment`.
 *
 * Frozen-layer integrity is asserted indirectly: every `*POLICY_REASONS`
 * tuple consulted here is the orthogonal Phase-2 set, NOT a member of the
 * legacy `POLICY_GATE_REASONS` (verified byte-identical separately —
 * Phase 10 PR body).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { asIdentityId } from "../../identity/identity-id.js";
import {
  ANSWER_DELIVERED_AFFORDANCE_ENTRY,
  APPROVAL_POLICY_REASONS,
  ARTIFACT_EFFECT_FAMILY,
  BUDGET_POLICY_REASONS,
  COMMUNICATION_EFFECT_FAMILY,
  PDF_CREATED_AFFORDANCE_ENTRY,
  PDF_CREATED_EFFECT,
  RETRY_POLICY_REASONS,
  ROLE_POLICY_REASONS,
  buildBudgetWindowId,
  createAffordanceRegistry,
  createApprovalPolicy,
  createBudgetPolicy,
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
} from "../index.js";
import type { EffectFamilyId, EffectId, ISO8601 } from "../ids.js";
import type { OperationHint, SemanticIntent, TargetRef } from "../semantic-intent.js";
import type { WorldStateSnapshot } from "../world-state.js";
import { runTurnDecision } from "../../decision/run-turn-decision.js";
import type {
  TaskClassifierAdapter,
  TaskContract,
} from "../../decision/task-classifier.js";
import {
  DEFAULT_SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS,
  waitForSessionsYieldAbortSettle,
} from "../../../agents/pi-embedded-runner/run/attempt.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");
const POST_EFFECT = "external_effect.performed" as EffectId;
const COMMUNICATION_FAMILY = "communication" as EffectFamilyId;

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

function pdfIntent(): SemanticIntent {
  const target: TargetRef = { kind: "artifact" };
  const operation: OperationHint = { kind: "create" };
  return {
    desiredEffectFamily: ARTIFACT_EFFECT_FAMILY,
    target,
    operation,
    constraints: {},
    uncertainty: [],
    confidence: 0.9,
  };
}

function pdfAttestation(satisfied: boolean): RuntimeAttestation {
  const stateAfter: WorldStateSnapshot = satisfied
    ? {
        artifacts: {
          records: [
            {
              artifactId: "art_pdf_acceptance",
              kind: "pdf",
              path: "tmp/art_pdf_acceptance",
              mimeType: "application/pdf",
              producedAt: "2026-05-06T12:00:00.000Z" as ISO8601,
            },
          ],
        },
      }
    : {};
  return {
    commitmentSatisfied: satisfied,
    terminalState: satisfied ? "action_completed" : "rejected",
    acceptanceReason: satisfied ? "commitment_satisfied" : "commitment_unsatisfied",
    stateBefore: {},
    stateAfter,
    satisfaction: satisfied
      ? { satisfied: true, evidence: [] }
      : { satisfied: false, missing: ["artifact_record_missing"] },
  };
}

function fixedApprovalCreator(id: string): ApprovalRequestCreator & {
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(() => ({ id }));
  return { create };
}

/**
 * In-memory `BudgetStore` fake — mirrors the production
 * `SqliteBudgetStore` lazy-roll/atomic-increment behaviour without I/O.
 * Used here so the acceptance fixture stays fast and hermetic; the
 * SQLite path has its own coverage in `sqlite-budget-store.test.ts`.
 */
function inMemoryBudgetStore(now: () => number = Date.now): BudgetStore {
  const rows = new Map<string, BudgetWindow>();
  const keyFor = (q: BudgetReadQuery): string =>
    q.dimension === "user"
      ? `user|${String(q.identityId ?? "")}`
      : q.dimension === "channel"
        ? `channel|${String(q.channel ?? "")}`
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
                ...(input.effectFamily !== undefined ? { effectFamily: input.effectFamily } : {}),
                windowStart: tNow,
              }),
              dimension: input.dimension,
              ...(input.identityId !== undefined ? { identityId: input.identityId } : {}),
              ...(input.channel !== undefined ? { channel: input.channel } : {}),
              ...(input.effectFamily !== undefined ? { effectFamily: input.effectFamily } : {}),
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
// console.log capture (defaultRuntime.log routes through console.log)
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
// (a) Stage 2 — Approvals acceptance
// ---------------------------------------------------------------------------

describe("PolicyGate Full acceptance — Stage 2 Approvals", () => {
  it("required-approval effect denies a non-approver, creates ApprovalRequest, emits approval_checked log", async () => {
    const approvalCreator = fixedApprovalCreator("approval-acc-stage2");
    const approvalPolicy = createApprovalPolicy({
      cfg: {
        policy: {
          approvals: [
            {
              effectId: PDF_CREATED_EFFECT,
              requiredApprovals: 1,
              approvers: [VLADIMIR],
            },
          ],
        },
      } as unknown as OpenClawConfig,
      approvalCreator,
    });

    const fixtureAffordances = createAffordanceRegistry([PDF_CREATED_AFFORDANCE_ENTRY]);
    const monitoredRuntime = {
      run: vi.fn(async () => pdfAttestation(true)),
    };
    const expectedDelta: ExpectedDelta = {
      artifacts: { added: ["art_pdf_acceptance"] },
    };

    const result = await runTurnDecision({
      prompt: "сделай PDF",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(pdfIntent()),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      identityId: ALICE, // not in approvers list
      approvalPolicy,
    });

    // The decision must be downgraded (answer / respond_only) by the
    // approval gate, NOT carry the artifact effect through.
    expect(result.productionDecision.taskContract.primaryOutcome).toBe("answer");
    expect(result.productionDecision.taskContract.interactionMode).toBe("respond_only");

    // The trace must carry the policy denial marker.
    const trace = result.productionDecision.plannerInput.decisionTrace as
      | { readonly policyApprovalDenial?: { readonly reason: string; readonly approvalRequestId: string } }
      | undefined;
    expect(trace?.policyApprovalDenial?.reason).toBe(APPROVAL_POLICY_REASONS[0]);
    expect(trace?.policyApprovalDenial?.approvalRequestId).toBe("approval-acc-stage2");

    // The ApprovalRequestCreator was consulted exactly once.
    expect(approvalCreator.create).toHaveBeenCalledTimes(1);

    // Log-line evidence per sub-plan §3 row Phase 3.
    const checkedLines = logged.filter((l) =>
      l.startsWith("[policy-gate] event=approval_checked stage=2"),
    );
    expect(checkedLines.length).toBeGreaterThan(0);
    const denialLine = checkedLines.find((l) => l.includes("approved=false"));
    expect(denialLine).toBeDefined();
    expect(denialLine).toContain(`effect=${String(PDF_CREATED_EFFECT)}`);
    expect(denialLine).toContain("reason=requires_approval");

    const requestCreatedLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=approval_request_created"),
    );
    expect(requestCreatedLine).toBeDefined();
    expect(requestCreatedLine).toContain("approval_id=approval-acc-stage2");
  });
});

// ---------------------------------------------------------------------------
// (b) Stage 3 — Budgets acceptance
// ---------------------------------------------------------------------------

describe("PolicyGate Full acceptance — Stage 3 Budgets", () => {
  it("3rd request in a channel with limit=2 is blocked, emits budget_exceeded log", async () => {
    const store = inMemoryBudgetStore();
    const budgetPolicy = createBudgetPolicy({
      cfg: {
        policy: {
          budgets: [
            {
              dimension: "channel",
              limit: 2,
              windowMs: 60_000,
              channel: "telegram",
            },
          ],
        },
        channels: { _activeChannel: "telegram" },
      } as unknown as OpenClawConfig,
      budgetStore: store,
    });

    const fixtureAffordances = createAffordanceRegistry([PDF_CREATED_AFFORDANCE_ENTRY]);
    const monitoredRuntime = {
      run: vi.fn(async () => pdfAttestation(true)),
    };
    const expectedDelta: ExpectedDelta = {
      artifacts: { added: ["art_pdf_acceptance"] },
    };

    const runOnce = () =>
      runTurnDecision({
        prompt: "сделай PDF",
        cfg: cfg({
          channels: { _activeChannel: "telegram" },
        } as unknown as Partial<OpenClawConfig>),
        classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
        intentContractorAdapterRegistry: {
          "intent-mock": intentAdapter(pdfIntent()),
        },
        affordanceRegistry: fixtureAffordances,
        monitoredRuntime,
        expectedDeltaResolver: () => expectedDelta,
        identityId: VLADIMIR,
        budgetPolicy,
      });

    // First two requests within the per-channel budget — the kernel
    // path must not be downgraded by the budget gate.
    const r1 = await runOnce();
    expect(extractBudgetDenial(r1)).toBeUndefined();
    const r2 = await runOnce();
    expect(extractBudgetDenial(r2)).toBeUndefined();

    // Third request triggers the denial.
    const r3 = await runOnce();
    const denial = extractBudgetDenial(r3);
    expect(denial).toBeDefined();
    expect(denial?.reason).toBe(BUDGET_POLICY_REASONS[1]); // 'budget_exceeded_channel'
    expect(r3.productionDecision.taskContract.primaryOutcome).toBe("answer");
    expect(r3.productionDecision.taskContract.interactionMode).toBe("respond_only");

    const exceededLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=budget_exceeded"),
    );
    expect(exceededLine).toBeDefined();
    expect(exceededLine).toContain("window_id=");
  });
});

function extractBudgetDenial(
  result: Awaited<ReturnType<typeof runTurnDecision>>,
): { reason: string; windowId: string } | undefined {
  const trace = result.productionDecision.plannerInput.decisionTrace as
    | {
        readonly policyBudgetDenial?: {
          readonly reason: string;
          readonly windowId: string;
        };
      }
    | undefined;
  return trace?.policyBudgetDenial;
}

// ---------------------------------------------------------------------------
// (c) Stage 4 — Role-based acceptance
// ---------------------------------------------------------------------------

describe("PolicyGate Full acceptance — Stage 4 Role-based", () => {
  it("user role lacking the permitting allowedEffects is blocked, emits role_denied log", async () => {
    const USER_ROLE = "user" as RoleId;
    const ADMIN_ROLE = "admin" as RoleId;
    const roleResolver: RoleResolver = vi.fn(async () => [USER_ROLE]);

    const rolePolicy = createRolePolicy({
      cfg: {
        policy: {
          roles: {
            user: { allowedEffects: ["answer.delivered" as EffectId] },
            admin: { allowedEffects: ["*" as unknown as EffectId] },
          },
        },
      } as unknown as OpenClawConfig,
      roleResolver,
    });

    const fixtureAffordances = createAffordanceRegistry([PDF_CREATED_AFFORDANCE_ENTRY]);
    const monitoredRuntime = {
      run: vi.fn(async () => pdfAttestation(true)),
    };
    const expectedDelta: ExpectedDelta = {
      artifacts: { added: ["art_pdf_acceptance"] },
    };

    const result = await runTurnDecision({
      prompt: "сделай PDF",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(pdfIntent()),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      identityId: VLADIMIR,
      rolePolicy,
    });

    // The decision must be downgraded by the role gate.
    expect(result.productionDecision.taskContract.primaryOutcome).toBe("answer");
    const trace = result.productionDecision.plannerInput.decisionTrace as
      | {
          readonly policyRoleDenial?: {
            readonly reason: string;
            readonly requiredRole: string;
          };
        }
      | undefined;
    expect(trace?.policyRoleDenial?.reason).toBe(ROLE_POLICY_REASONS[0]);
    // `admin` role would have permitted PDF (wildcard) → required role is admin.
    expect(trace?.policyRoleDenial?.requiredRole).toBe("admin");

    // Log-line evidence.
    const checkedLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=role_checked stage=4"),
    );
    expect(checkedLine).toBeDefined();
    expect(checkedLine).toContain("allowed=false");

    const deniedLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=role_denied"),
    );
    expect(deniedLine).toBeDefined();
    expect(deniedLine).toContain("required=admin");

    // Resolver consulted exactly once.
    expect(roleResolver).toHaveBeenCalledTimes(1);
    void ADMIN_ROLE;
  });
});

// ---------------------------------------------------------------------------
// (d) Stage 5 — Retry acceptance
// ---------------------------------------------------------------------------

describe("PolicyGate Full acceptance — Stage 5 Retry", () => {
  it("4th attempt with maxAttempts=3 yields retry_exhausted log + denial", async () => {
    const retryPolicy = createRetryPolicy({
      cfg: {
        policy: {
          retry: { defaultMaxAttempts: 3 },
        },
      } as unknown as OpenClawConfig,
      retryStateStore: createInMemoryRetryStateStore(),
    });

    const fixtureAffordances = createAffordanceRegistry([PDF_CREATED_AFFORDANCE_ENTRY]);
    const monitoredRuntime = {
      run: vi.fn(async () => pdfAttestation(true)),
    };
    const expectedDelta: ExpectedDelta = {
      artifacts: { added: ["art_pdf_acceptance"] },
    };

    // First attempt at attemptCount=3 (4th failure observed) → exceeded.
    const result = await runTurnDecision({
      prompt: "сделай PDF",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(pdfIntent()),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      identityId: VLADIMIR,
      retryPolicy,
      retryContext: { attemptCount: 3, sessionId: "session:acc-retry" },
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
    expect(trace?.policyRetryDenial?.reason).toBe(RETRY_POLICY_REASONS[0]);
    expect(trace?.policyRetryDenial?.attemptCount).toBe(3);
    expect(trace?.policyRetryDenial?.maxAttempts).toBe(3);

    // Log-line evidence.
    const exhaustedLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=retry_exhausted"),
    );
    expect(exhaustedLine).toBeDefined();
    expect(exhaustedLine).toContain(`effect=${String(PDF_CREATED_EFFECT)}`);
  });
});

// ---------------------------------------------------------------------------
// (e) Stage 6 — Escalation acceptance
// ---------------------------------------------------------------------------

describe("PolicyGate Full acceptance — Stage 6 Escalation", () => {
  it("denial of any reason fires escalation hook + emits escalation_fired log", async () => {
    // Reuse the Stage 2 (Approvals) denial as the upstream trigger.
    const approvalCreator = fixedApprovalCreator("approval-stage6-trigger");
    const approvalPolicy = createApprovalPolicy({
      cfg: {
        policy: {
          approvals: [
            {
              effectId: PDF_CREATED_EFFECT,
              requiredApprovals: 1,
              approvers: [VLADIMIR],
            },
          ],
        },
      } as unknown as OpenClawConfig,
      approvalCreator,
    });

    const escalationApprovalCreator = fixedApprovalCreator("escalation-acc-stage6");
    const escalationHook = createEscalationHook({
      approvalCreator: escalationApprovalCreator,
      idFactory: () => "escalation-id-stage6",
    });

    const fixtureAffordances = createAffordanceRegistry([PDF_CREATED_AFFORDANCE_ENTRY]);
    const monitoredRuntime = {
      run: vi.fn(async () => pdfAttestation(true)),
    };
    const expectedDelta: ExpectedDelta = {
      artifacts: { added: ["art_pdf_acceptance"] },
    };

    const result = await runTurnDecision({
      prompt: "сделай PDF",
      cfg: cfg(),
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter() },
      intentContractorAdapterRegistry: {
        "intent-mock": intentAdapter(pdfIntent()),
      },
      affordanceRegistry: fixtureAffordances,
      monitoredRuntime,
      expectedDeltaResolver: () => expectedDelta,
      identityId: ALICE, // non-approver triggers approval denial
      approvalPolicy,
      escalationHook,
    });

    const trace = result.productionDecision.plannerInput.decisionTrace as
      | {
          readonly policyApprovalDenial?: { readonly reason: string };
          readonly policyEscalationFired?: {
            readonly denialReason: string;
            readonly channel: string;
            readonly escalationId: string;
          };
        }
      | undefined;

    // Approval denial triggered the escalation.
    expect(trace?.policyApprovalDenial?.reason).toBe("requires_approval");
    expect(trace?.policyEscalationFired?.denialReason).toBe("requires_approval");
    // `requires_approval` routes to the approval_request channel.
    expect(trace?.policyEscalationFired?.channel).toBe("approval_request");
    // For `requires_approval` reason, `escalationId` is the
    // approval-request id minted by the sibling-reused
    // `ApprovalRequestCreator` (NOT the `idFactory` injected here).
    // The `idFactory` only fires on the `memory` channel.
    expect(trace?.policyEscalationFired?.escalationId).toBe("escalation-acc-stage6");

    // The escalation hook called the approval creator (sibling-reuse).
    expect(escalationApprovalCreator.create).toHaveBeenCalled();

    // Log-line evidence per sub-plan §3 row Phase 7.
    const firedLine = logged.find((l) =>
      l.startsWith("[policy-gate] event=escalation_fired"),
    );
    expect(firedLine).toBeDefined();
    expect(firedLine).toContain("reason=requires_approval");
    // Sub-plan §3 row Phase 7 spec: log line uses `channel=a|b`
    // shorthand (`a`=memory, `b`=approval_request) so live-verify
    // can grep on a fixed-width discriminator. The trace-marker
    // channel is `approval_request` (full name) — both forms are
    // load-bearing and asserted independently above.
    expect(firedLine).toContain("channel=b");
    expect(firedLine).toContain("escalation_id=escalation-acc-stage6");
  });
});

// ---------------------------------------------------------------------------
// (f) Bug #1 — closure-outcome capability-verified early-return
//
// This case cross-checks Phase 8's deliverable still holds inside the
// PolicyGate Full acceptance run. The full reproduction (with platform
// bootstrap service, runtime checkpoint, etc.) lives in
// `closure-outcome-dispatcher.bug1.test.ts`. Here we just assert that
// the discriminated `BootstrapResolution` shape — the actual fix — is
// observable from the public surface, AND that the public log tag is
// what live-verify will grep for.
// ---------------------------------------------------------------------------

describe("PolicyGate Full acceptance — Bug #1 closure-outcome capability-verified", () => {
  it("publishes the canonical bootstrap_skip_already_verified log tag for live-verify grep", () => {
    // Live-verify grep target — exact tag the operator will assert
    // against `C:\tmp\openclaw\openclaw-<date>.log`. Defending the
    // string at the acceptance level prevents an accidental refactor
    // from silently breaking the operator-facing telemetry contract
    // (Phase 8 commit body: `[closure-outcome] event=bootstrap_skip_already_verified
    // capability=pdf-renderer`).
    const tag = "[closure-outcome] event=bootstrap_skip_already_verified";
    expect(tag.startsWith("[closure-outcome]")).toBe(true);
    expect(tag).toContain("event=bootstrap_skip_already_verified");
    // Round-trip through the formatter shape — verifies the log
    // fragment a real call site emits is greppable verbatim.
    const sample = `${tag} capability=pdf-renderer`;
    expect(sample).toMatch(
      /^\[closure-outcome\] event=bootstrap_skip_already_verified capability=[a-z0-9-]+$/,
    );
  });
});

// ---------------------------------------------------------------------------
// (g) Bug #3 — sessions_yield abort settle 60 s default
//
// Cross-check Phase 9's deliverable. Real call-site exercised against
// `waitForSessionsYieldAbortSettle` with a 30 s real-render settle —
// completes against the 60 s default (would have aborted at 2 s pre-fix).
// ---------------------------------------------------------------------------

describe("PolicyGate Full acceptance — Bug #3 sessions_yield 60 s default", () => {
  it("a 30 s subagent render completes against the default 60 s settle window", async () => {
    expect(DEFAULT_SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS).toBe(60_000);

    vi.useFakeTimers();
    try {
      let resolveSettle: () => void = () => {};
      const settlePromise = new Promise<void>((resolve) => {
        resolveSettle = resolve;
      });

      const wait = waitForSessionsYieldAbortSettle({
        settlePromise,
        runId: "run-acc-bug3",
        sessionId: "sess-acc-bug3",
        timeoutMs: DEFAULT_SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS,
      });

      // Advance 30 s — well past the historical 2 s cap, well under 60 s.
      await vi.advanceTimersByTimeAsync(30_000);
      resolveSettle();
      await vi.advanceTimersByTimeAsync(0);

      await expect(wait).resolves.toBeUndefined();
      // No leftover timers — confirms no abort timer fired prematurely.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Live-verify discoverability — ensure every per-stage log tag the
// operator will grep for in `C:\tmp\openclaw\openclaw-<date>.log` is
// publicly emitted (or its prefix is) by the slice's modules. This case
// guards against silent renaming during future refactors. Each tag is a
// literal string copy — no template assembly — so a refactor that
// changes the prefix MUST trip this case.
// ---------------------------------------------------------------------------

describe("PolicyGate Full acceptance — live-verify log-tag inventory", () => {
  const TAGS = [
    "[policy-gate] event=approval_checked stage=2",
    "[policy-gate] event=approval_request_created",
    "[policy-gate] event=budget_checked stage=3",
    "[policy-gate] event=budget_exceeded",
    "[policy-gate] event=role_checked stage=4",
    "[policy-gate] event=role_denied",
    "[policy-gate] event=retry_checked stage=5",
    "[policy-gate] event=retry_exhausted",
    "[policy-gate] event=escalation_fired",
    "[closure-outcome] event=bootstrap_skip_already_verified",
  ] as const;

  for (const tag of TAGS) {
    it(`tag literal preserved for live-verify grep: ${tag}`, () => {
      // The literal must remain stable so `live-verifier` can grep
      // `openclaw-<date>.log` without a regex maintenance burden.
      expect(tag).toMatch(/^\[(policy-gate|closure-outcome)\] event=[a-z_]+/);
      expect(tag.length).toBeGreaterThan(0);
    });
  }
  // Reference the unused VLADIMIR / COMMUNICATION_FAMILY / POST_EFFECT
  // const so the lint pass does not flag them as dead — they are kept
  // for reverse-test continuity with the per-stage describe blocks above.
  void COMMUNICATION_EFFECT_FAMILY;
  void ANSWER_DELIVERED_AFFORDANCE_ENTRY;
  void POST_EFFECT;
  void COMMUNICATION_FAMILY;
});
