# AUDIT — PolicyGate Full (Stages 2–6 + Bug #1 + Bug #3)

> Read-only audit deliverable for Phase 1 of
> `.cursor/plans/commitment_kernel_policy_gate_full.plan.md`.
> Predecessor: `dev` SHA `123010276e` (post PR-#192).
> Maintainer signoff: GRANTED via blanket authorization 2026-05-05.
> No source-code modifications. All findings line-anchored against the
> worktree at the predecessor SHA.

---

## §a — Current `POLICY_GATE_REASONS` shape and frozen reverse-test

### Allowlist (current, post PR-#192)

`src/platform/commitment/policy-gate.ts:18`:

```ts
export const POLICY_GATE_REASONS = Object.freeze(["channel_disabled", "no_credentials"] as const);
```

- Tuple with `as const` literal narrowing → `readonly ["channel_disabled", "no_credentials"]`.
- `Object.freeze` applied at module init.
- Public `PolicyGateReason` type (`policy-gate.ts:20`) is the union of the two
  string literals — TS-level scope creep blocked because new reasons would
  fail to assign without source edits to this file.
- The block comment (`policy-gate.ts:7-17`) explicitly defers approvals,
  budgets per-user/per-channel/per-effect, role-based access, retry policies,
  and escalation hooks to **this** sub-plan (`commitment_kernel_policy_gate_full.plan.md`)
  — i.e. the reverse-test exists precisely to make Phases 2–6 visible at PR review.

### Reverse-test (frozen — `__tests__/policy-gate.test.ts:40-51`)

```ts
describe("PolicyGate exported reason set (reverse-test, sub-plan §5 row e)", () => {
  it("exposes exactly two reason codes, in alphabetical order", () => {
    expect(POLICY_GATE_REASONS).toEqual(["channel_disabled", "no_credentials"]);
  });

  it("freezes the reason set so PR-4b cannot append silently", () => {
    expect(Object.isFrozen(POLICY_GATE_REASONS)).toBe(true);
    expect(() => {
      (POLICY_GATE_REASONS as unknown as string[]).push("budget_exceeded");
    }).toThrow();
  });
});
```

Confirmed: the reverse-test asserts (1) exact-set equality, (2)
`Object.isFrozen` truthy, (3) push-throws semantics. `budget_exceeded` is the
canary string — it is not yet a member; if Phase 4 picks the **extend** path
the canary string in this test must change in lock-step with the value
literal.

### Sibling precedent — `CLARIFICATION_POLICY_REASONS` (Stage 1, PR-#110)

`src/platform/commitment/clarification-policy.ts:34-37`:

```ts
export const CLARIFICATION_POLICY_REASONS = Object.freeze([
  "ambiguity_resolved_by_intent",
  "ambiguity_resolved_by_session_history",
] as const);
```

Stage 1 explicitly chose the **orthogonal** pattern: a separate frozen tuple
with its own reverse-test, leaving `POLICY_GATE_REASONS` untouched. The block
comment at `clarification-policy.ts:25-29` codifies the rule:

> "Stages 2-6 of `commitment_kernel_policy_gate_full.plan.md` (approvals,
> budgets, role-based access, retry policies, escalation hooks) belong to
> extensions of `POLICY_GATE_REASONS` … keeping the two reason registries
> separate makes scope-creep visible at PR review (a third reason added to
> either set fails its respective reverse-test)."

That comment is internally inconsistent — it says Stages 2-6 "belong to
extensions of `POLICY_GATE_REASONS`" while the file itself demonstrates the
orthogonal pattern. **The actual landed precedent (Stage 1, PR-#110) is
orthogonal.** This audit recommends the orthogonal pattern (see §b below)
and surfaces the comment-vs-pattern mismatch as a follow-up doc fix in the
Phase 2 PR.

---

## §b — Stage 2…6 orthogonal-vs-extend decision (per stage)

**Recommendation matrix.** Each stage gets its own frozen reasons set with a
dedicated reverse-test. `POLICY_GATE_REASONS` is left **unchanged** (still
`["channel_disabled", "no_credentials"]`); its reverse-test stays byte-identical.

| # | Stage | Choice | New tuple (proposed) | Reverse-test file (proposed) | Rationale |
|---|---|---|---|---|---|
| 2 | Approvals | **orthogonal** | `APPROVAL_POLICY_REASONS = ['requires_approval']` | `__tests__/approval-policy.test.ts` | Approvals are a positive-acknowledgement gate (need explicit human OK), categorically different from infra denials (`channel_disabled` / `no_credentials`). Stage 1 (`CLARIFICATION_POLICY_REASONS`) precedent says new orthogonal sets stay narrow (1–2 reasons) and grow only when a *new* concern appears. |
| 3 | Budgets | **orthogonal** | `BUDGET_POLICY_REASONS = ['budget_exceeded_user', 'budget_exceeded_channel', 'budget_exceeded_effect']` | `__tests__/budget-policy.test.ts` | Three sub-reasons because the dimension matters at observability (`event=budget_exceeded dimension=…`) and at escalation routing (per-user vs per-channel vs per-effect). A single `'budget_exceeded'` reason with structured payload would force callers to read payload to know which axis tripped, defeating the closed-set guarantee. |
| 4 | Role-based | **orthogonal** | `ROLE_POLICY_REASONS = ['role_denied']` | `__tests__/role-policy.test.ts` | Role denial is a single concept (identity lacks role required for effect). Required role is *data*, carried in the decision payload (`{ allowed: false, reason: 'role_denied', requiredRole: '<r>' }`), not part of the reasons enum. Mirrors `CLARIFICATION_POLICY_REASONS` discipline (1–2 reasons + structural decision payload). |
| 5 | Retry | **orthogonal** | `RETRY_POLICY_REASONS = ['retry_limit_exceeded']` | `__tests__/retry-policy.test.ts` | Single terminal reason; backoff progression is observability (logged per attempt), not a reason code. Retry policy is a temporal decision (`{ retry: true, backoffMs }` vs `{ retry: false, reason: 'retry_limit_exceeded' }`) and orthogonal to all other policy axes. |
| 6 | Escalation | **orthogonal** | `ESCALATION_POLICY_REASONS = ['escalation_failed']` | `__tests__/escalation-hook.test.ts` | Escalation is not a *gate* (per sub-plan §10 invariant #3 footnote: "escalation = observability, не gating"). Its reasons set is internal-only — the *reason that triggered escalation* is one of `APPROVAL_/BUDGET_/ROLE_/RETRY_POLICY_REASONS`, carried via payload (`escalationOrigin`). The single `'escalation_failed'` reason exists only for the failure-isolation observability path (escalation throws → log, do not gate). |

### Why orthogonal for all five

1. **Blast radius.** Extending `POLICY_GATE_REASONS` from 2 to 9+ reasons would
   require updating the canary push (`'budget_exceeded'` → still ok, but every
   downstream consumer that assumes a closed pair fails). Orthogonal sets keep
   each consumer's switch local.
2. **Stage 1 precedent.** PR-#110 (`caca87a634`) shipped
   `CLARIFICATION_POLICY_REASONS` orthogonal to `POLICY_GATE_REASONS`; sub-plan
   §0 row 2026-04-29 records this as the architectural baseline for Stages 2-6.
3. **Frozen-layer minimization.** `policy-gate.ts` is **frozen** (sub-plan §2
   File inventory). Orthogonal sets in NEW files (`approval-policy.ts`,
   `budget-policy.ts`, `role-policy.ts`, `retry-policy.ts`, `escalation-hook.ts`)
   touch frozen layer only via `index.ts` additive re-exports. The existing
   reverse-test for `POLICY_GATE_REASONS` stays **byte-identical** across all
   five stages — strongest invariant-#11 guarantee.
4. **Observability shape parity.** Each stage emits `event=<axis>_checked …
   reason=<r>` (sub-plan §3 acceptance table); orthogonal reasons match the
   per-axis log-line discipline 1:1.

### Frozen-layer touch on `policy-gate.ts`

**Conclusion: zero edits to `src/platform/commitment/policy-gate.ts` and
`src/platform/commitment/__tests__/policy-gate.test.ts` across Stages 2–6.**

`src/platform/commitment/index.ts` (NOT frozen — comment at line 1 marks it
as the public-surface barrel) gets additive re-exports per stage (5 stages ×
~6 lines each).

---

## §c — `EpisodicEffectFamily` discriminated union + `EFFECT_FAMILY_REGISTRY` extensions

### Episodic effect family — current shape

`src/platform/memory/episodic-memory-event.ts:31-36`:

```ts
export type EpisodicEffectFamily =
  | "persistent_session"
  | "subagent"
  | "reminder"
  | "artifact"
  | "task";
```

Each variant carries a typed payload (`PersistentSessionCreatedPayload`,
`SubagentCreatedPayload`, …) and the union is enforced at runtime via
`EpisodicMemoryEventSchema` (line 366) using `z.discriminatedUnion("effectFamily",
[…])`. Exhaustiveness is policed by `assertNeverEpisodic` (line 409).

The `task` variant (line 36) demonstrates the multi-status pattern — one
family slot, payload-level `kind` discriminator (`created`/`completed`/
`cancelled`/`failed`).

### Proposed additive extension for Stages 2–6

**Add five new family symbols** (additive, lock-step with consumer switch
extensions per sub-plan §4 risk #4):

| Family | Payload type | Sub-payload `kind` discriminator? | Stage |
|---|---|---|---|
| `policy_approval` | `PolicyApprovalPayload` | `'requested' \| 'granted' \| 'denied'` (mirror `task` pattern) | 3 (Stage 2) |
| `policy_budget` | `PolicyBudgetPayload` | `'within' \| 'exceeded'` | 4 (Stage 3) |
| `policy_role` | `PolicyRolePayload` | `'allowed' \| 'denied'` | 5 (Stage 4) |
| `policy_retry` | `PolicyRetryPayload` | `'allowed' \| 'exhausted'` | 6 (Stage 5) |
| `policy_escalation` | `PolicyEscalationPayload` | `'fired' \| 'failed'` | 7 (Stage 6) |

**Payload skeletons (proposed — exact shapes finalized in Phase 2):**

```ts
// Phase 3 — Stage 2 Approvals
type PolicyApprovalPayload = {
  readonly kind: 'requested' | 'granted' | 'denied';
  readonly approvalRequestId: ApprovalRequestId;     // brand per inv #16
  readonly identityId: IdentityId;
  readonly effectId: EffectId;
  readonly occurredAt: string;                        // ISO-8601
};

// Phase 4 — Stage 3 Budgets
type PolicyBudgetPayload = {
  readonly kind: 'within' | 'exceeded';
  readonly windowId: BudgetWindowId;                  // brand per inv #16
  readonly dimension: 'user' | 'channel' | 'effect';
  readonly identityId: IdentityId;
  readonly used: number;
  readonly limit: number;
  readonly occurredAt: string;
};

// Phase 5 — Stage 4 Role-based
type PolicyRolePayload = {
  readonly kind: 'allowed' | 'denied';
  readonly identityId: IdentityId;
  readonly role: RoleId;                              // brand per inv #16
  readonly effectId: EffectId;
  readonly requiredRole?: RoleId;                     // populated only on 'denied'
  readonly occurredAt: string;
};

// Phase 6 — Stage 5 Retry
type PolicyRetryPayload = {
  readonly kind: 'allowed' | 'exhausted';
  readonly identityId: IdentityId;
  readonly effectId: EffectId;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly backoffMs?: number;                        // populated only on 'allowed'
  readonly occurredAt: string;
};

// Phase 7 — Stage 6 Escalation
type PolicyEscalationPayload = {
  readonly kind: 'fired' | 'failed';
  readonly escalationId: string;
  readonly originReason:
    | ApprovalPolicyReason
    | BudgetPolicyReason
    | RolePolicyReason
    | RetryPolicyReason;                              // payload-carry, not enum extension
  readonly identityId: IdentityId;
  readonly channel: 'memory' | 'approval_request';
  readonly occurredAt: string;
};
```

Brand discipline (invariant #16): each new ID type (`ApprovalRequestId`,
`BudgetWindowId`, `RoleId`) is a distinct branded string symbol per Phase 2;
no implicit conversion to/from `EffectId` / `IdentityId`.

### `EFFECT_FAMILY_REGISTRY` — additive extension

`src/platform/commitment/effect-family-registry.ts:23-48` is the closed
registry consumed by `IntentContractor` for structured-output prompts:

```ts
export const EFFECT_FAMILY_REGISTRY = Object.freeze([
  Object.freeze({ id: PERSISTENT_SESSION_EFFECT_FAMILY, ... }),
  Object.freeze({ id: COMMUNICATION_EFFECT_FAMILY, ... }),
  Object.freeze({ id: WEB_RESEARCH_EFFECT_FAMILY, ... }),
  Object.freeze({ id: UNKNOWN_EFFECT_FAMILY, ... }),
] satisfies EffectFamilyDefinition[]);
```

Note: this registry is in `src/platform/commitment/` (frozen layer). It is
consumed by `IntentContractor` to build the closed list of effect families
the model can pick. **Adding `policy_*` families here is a category mismatch:**
policy-gate decisions are NOT effect families the user *asks for* — they are
gates *applied to* user-requested effects. Phase 1 audit recommends:

- **NO additions to `EFFECT_FAMILY_REGISTRY`.** Policy-gate semantic events
  flow through `EpisodicEffectFamily` (memory layer) only; the
  intent-contractor-facing registry stays at 4 entries.
- The sub-plan §0 row referencing "EFFECT_FAMILY_REGISTRY extension" in
  Phase 2 overview line 51 should be **softened** to "memory-layer
  `EpisodicEffectFamily` extension only" in the Phase 2 PR (file: `policy-gate-stages.ts`
  module-init log line should not reference effect-family registry).

(This is the only audit finding that contradicts a sub-plan instruction.
Surfaced here per slice-implementer rules; final adjudication on Phase 2
PR review.)

### Memory-write hook — exhaustiveness lock-step

`src/platform/memory/episodic-memory-event.ts:409-413`:

```ts
export function assertNeverEpisodic(value: never): never {
  throw new Error(
    `assertNeverEpisodic: unhandled episodic memory event variant ${JSON.stringify(value)}`,
  );
}
```

Sub-plan §4 risk #4 already calls out the lock-step constraint. Confirmed
consumers that switch over `EpisodicEffectFamily`:

- `src/platform/memory/memory-write-on-satisfied.ts` — slice E P5 hook.
- `src/platform/task/task-write-on-satisfied.ts` — slice F P5 hook (mentioned by sub-plan).
- `src/platform/decision/memory-wiring.ts` — recall consumer.

All three must extend their switch with the five new `policy_*` arms in the
**same Phase 2 PR** as the union extension; otherwise the build breaks.

---

## §d — Bug #1 site predicate (`closure-outcome-dispatcher.ts`)

### Current behaviour

`src/auto-reply/reply/closure-outcome-dispatcher.ts:836-868`:

```ts
const isBootstrapRemediation = decision.remediation === "bootstrap";
const bootstrapRequestIds = isBootstrapRemediation
  ? ensureBootstrapRequests({
      decision,
      executionIntent: params.executionIntent,
      queueKey: params.queueKey,
      sourceRun: params.sourceRun,
      settings: params.settings,
    })
  : [];

// Fail-closed safety net: …
const bootstrapNoOp =
  isBootstrapRemediation &&
  bootstrapRequestIds.length === 0 &&
  !shouldCreateHumanApproval(decision);
if (bootstrapNoOp) {
  const reason =
    decision.reasons[0] ??
    "bootstrap remediation requested but no capabilities are pending bootstrap";
  markClosureRecoveryCheckpointFailed({
    sourceRun: params.sourceRun,
    error: `bootstrap_noop: ${reason}`,
  });
}
```

### Source-of-truth for "capability already verified"

`ensureBootstrapRequests` (`closure-outcome-dispatcher.ts:704-761`) returns
`string[]` — it elides the `BootstrapResolution.status` field. Specifically
at line 757-760:

```ts
return resolutions
  .map((resolution) => resolution.request)
  .filter((request): request is BootstrapRequest => request !== undefined)
  .map((request) => service.create(request).id);
```

**Three causally distinct empty-array returns are conflated:**

| Path | Trigger | Status returned by `resolveBootstrapRequest` | Filter behaviour |
|---|---|---|---|
| (i) **No capabilities advertised** | `capabilityIds.length === 0` (line 739-741, early `return []`) | n/a | bypass |
| (ii) **Capability already verified/installed** | `existing?.status === "available"` at `resolver.ts:83-88` | `status: "available"` (no `request`) | filtered out → `[]` |
| (iii) **Untrusted / unknown / install error** | `resolver.ts:91-122` (`status: "unknown" \| "untrusted"`) | `status: "unknown" \| "untrusted"` (no `request`) | filtered out → `[]` |

**Path (ii) is the false-positive trigger.** The live log
`Capability '<plugin>' was installed and verified` (`platform/bootstrap/service.ts:144-145`)
is emitted in `dispatchBlockedRunResumeAfterBootstrap`, which runs once
the registry has flipped the entry to `status: 'available'`. On the *next*
turn (the verified resume), `resolveBootstrapRequest` correctly returns
`status: "available"`, but `ensureBootstrapRequests` flattens it to `[]`,
indistinguishable from path (iii) at the dispatcher.

### Recommended fix predicate (Phase 8)

**Two candidate signals — recommend the resolver-derived signal, not an
intent-side flag.**

#### Option A (recommended) — return-shape extension on `ensureBootstrapRequests`

Change the return type to a discriminated union or a tuple:

```ts
type EnsureBootstrapRequestsResult =
  | { kind: 'created'; requestIds: string[] }            // existing+new requests
  | { kind: 'no_capabilities' }                          // path (i)
  | { kind: 'already_verified'; verifiedCapabilityIds: string[] }  // path (ii) — NEW
  | { kind: 'untrusted'; reasons: string[] };            // path (iii)
```

The verified-path detection key is `resolution.status === 'available' &&
resolution.capability !== undefined` per `resolver.ts:83-88`. Then in the
dispatcher:

```ts
const bootstrapResult = isBootstrapRemediation
  ? ensureBootstrapRequests(...)
  : { kind: 'no_capabilities' as const };

if (bootstrapResult.kind === 'already_verified') {
  // Phase 8 acceptance: log skip + early-return, no markClosureRecoveryCheckpointFailed
  log.info(
    `[closure-outcome] event=bootstrap_skip_already_verified ` +
    `capability=${bootstrapResult.verifiedCapabilityIds.join(',')}`,
  );
  return { queuedSemanticRetry: false };  // or proceed to other branches as appropriate
}
```

#### Option B (rejected) — `executionIntent` flag

Adding `capabilityAlreadyVerified?: boolean` to `PlatformRuntimeExecutionIntent`
(`src/platform/runtime/contracts.ts:605-631`) would touch the runtime contracts
schema. Even though `PlatformRuntimeExecutionIntent` is **not** in the
five-frozen-contract list (invariant #11), it has wide upstream consumers
(`runtime/service.ts`, `recipe/runtime-adapter.ts`, `decision/contracts.ts`)
and an additive boolean here forces every constructor call to thread it
through. Option A localizes the change to the dispatcher + resolver-return-shape
read.

### Predicate summary (for Phase 8 implementer)

- **Site:** `src/auto-reply/reply/closure-outcome-dispatcher.ts:818-868`
  (`dispatchMessagingClosureOutcome`).
- **Cause:** `ensureBootstrapRequests` (line 704-761) collapses three causally
  distinct `[]` returns into one; verified-path `[]` is misread as
  no-capabilities-pending `[]`.
- **Fix predicate:** detect `BootstrapResolution.status === 'available'` at
  `closure-outcome-dispatcher.ts:757-760` (right before the
  `.filter(...request !== undefined)` step) and surface it through a
  discriminated return shape so the caller at line 856-868 can branch
  *before* `markClosureRecoveryCheckpointFailed` fires.
- **Acceptance log line (per sub-plan):**
  `[closure-outcome] event=bootstrap_skip_already_verified capability=<id>`
  (NEW, Phase 8 — emit at the new `kind === 'already_verified'` branch).
  Negative: `[closure-outcome] event=recovery_checkpoint_terminal` MUST NOT fire.

---

## §e — Bug #3 site (PDF subagent timeout)

### Live log evidence (sub-plan §0 trigger)

`sessions_yield abort settle timed out: timeoutMs=2000`

### Exact site

**`src/agents/pi-embedded-runner/run/attempt.ts:178`:**

```ts
const SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS =
  process.env.OPENCLAW_TEST_FAST === "1" ? 250 : 2_000;
```

Used at `attempt.ts:309` (the `setTimeout` race in
`waitForSessionsYieldAbortSettle`) and at `attempt.ts:317` (the warn log line
that matches the live evidence string).

### Site analysis — NOT what the sub-plan guessed

The sub-plan Phase 1 todo (line 38) listed candidates as:
1. `agents.defaults.subagents.runTimeoutSeconds` config default
2. recipe layer (`src/platform/recipe/`)
3. `src/agents/subagent-announce.ts` defaults
4. PDF tool wiring (`src/agents/tools/pdf-tool.ts`)
5. `~/.openclaw-dev/openclaw.json`

None of these is the actual site. The actual site is a **module-level
hardcoded constant in `pi-embedded-runner`** governing how long the runner
waits for an in-flight `sessions_yield` abort to settle before logging
"timed out" and continuing.

### What this constant actually governs

It is **not** the PDF subagent's run-time budget — that one is
`runTimeoutSeconds` on `subagent-spawn.ts:439-441`, default 0 (disabled), and
the gateway tests confirm `runTimeoutSeconds: 0` is the wired default
(`gateway/server-methods/agent.test.ts:533`).

Instead, `SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS` is the **runner's grace
window** for an outstanding `sessions_yield` async abort to flush before
the runner gives up waiting and emits the "abort settle timed out" warning.
On the live test path:

1. PDF subagent yields via `sessions_yield`.
2. The parent runner attempts to abort the yield (e.g. a follow-up turn arrives).
3. The abort signal is in flight; the runner races
   `settlePromise` against a 2 000 ms timer.
4. PDF rendering takes longer than 2 s to settle, so the timer wins → warn
   line emitted.
5. The user-visible symptom is the orchestration confusion that follows
   (the run is reported as "stalled / timed out" downstream).

The 2 000 ms is therefore a **diagnostic settle window**, not a hard kill.
The downstream confusion is what makes it look like a hard timeout.

### Recommended fix path category — `hardcoded constant` → `named constant + config-overridable`

Per sub-plan Phase 9 decision rule (line 138):
> "if site === hardcoded constant → выделить именованную константу
> `DEFAULT_PDF_SUBAGENT_RUN_TIMEOUT_MS = 60_000` + accept config override"

Adapted to actual site:

- **NEW named constant:** `DEFAULT_SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS =
  60_000` (replacing the existing 2 000 ms; keep the
  `OPENCLAW_TEST_FAST=1 → 250` short-circuit).
- **Config override path:** add optional
  `agents.runner.sessionsYieldAbortSettleTimeoutMs?: number` in
  `src/config/zod-schema.core.ts` near line 392 (where
  `agents.defaults.subagents.runTimeoutMs` already lives at `min(1000).max(120000)`).
  Use the same `min(1000).max(120000)` bounds for consistency.
- **Wire**: `attempt.ts:178` reads
  `cfg?.agents?.runner?.sessionsYieldAbortSettleTimeoutMs ??
   DEFAULT_SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS`.
- **Note**: the constant is **not** PDF-specific. The label
  `DEFAULT_PDF_SUBAGENT_RUN_TIMEOUT_MS` from the sub-plan is misleading —
  the real constant is generic and applies to any subagent that uses
  `sessions_yield`. Phase 9 PR body should clarify this scope difference.

### Acceptance log lines (per sub-plan, adapted)

The sub-plan's proposed log lines are PDF-specific:

> `[pdf-subagent] event=run_timeout_ms=60000` (новый default);
> `[pdf-subagent] event=run_completed elapsed_ms=<n>`.

For the actual site this should become:

> `[pi-runner] event=sessions_yield_abort_settle_timeout_ms=<N>` (module init log).
> `[pi-runner] event=sessions_yield_abort_settled elapsed_ms=<n>` (success path).
> `[pi-runner] event=sessions_yield_abort_settle_timed_out elapsed_ms=<N>` (timeout path).

Phase 9 implementer should propose this re-scoping at PR review.

### Out-of-scope follow-up uncovered during audit

While searching for `2000` constants, three other 2-second hardcoded
timeouts surfaced (likely safe but worth a follow-up audit pass):

- `src/cli/gateway-cli/run.ts:237` — `timeoutMs: 2000` (gateway CLI ping).
- `src/plugins/setup-binary.ts:31` — `runCommandWithTimeout({ timeoutMs: 2000 })`
  (binary setup probe).
- `src/commands/onboard-remote.ts:79` — `discoverGatewayBeacons({ timeoutMs: 2000 })`.

These are likely intentional (network probes), but if the same symptom
recurs after Phase 9 ships, these are the next candidates. NOT in scope
for Phase 9.

---

## §f — Frozen-layer touch matrix per stage

| Phase | Frozen file | Touch | Reverse-test impact |
|---|---|---|---|
| 1 (this audit) | none | none | none |
| 2 (types + scaffolding) | `src/platform/commitment/index.ts` (re-exports), `src/platform/memory/episodic-memory-event.ts` (additive `policy_*` arms + payload schemas) | additive | none on `policy-gate.test.ts`; new reverse-tests for each `*POLICY_REASONS` set introduced in their own `__tests__/<axis>-policy.test.ts` |
| 3 (Stage 2 — Approvals) | `src/platform/commitment/index.ts` (re-exports) | additive | new `__tests__/approval-policy.test.ts` reverse-test for `APPROVAL_POLICY_REASONS` |
| 4 (Stage 3 — Budgets) | `src/platform/commitment/index.ts` (re-exports) | additive | new `__tests__/budget-policy.test.ts` reverse-test for `BUDGET_POLICY_REASONS` |
| 5 (Stage 4 — Role-based) | `src/platform/commitment/index.ts` (re-exports) | additive | new `__tests__/role-policy.test.ts` reverse-test for `ROLE_POLICY_REASONS` |
| 6 (Stage 5 — Retry) | `src/platform/commitment/index.ts` (re-exports) | additive | new `__tests__/retry-policy.test.ts` reverse-test for `RETRY_POLICY_REASONS` |
| 7 (Stage 6 — Escalation) | `src/platform/commitment/index.ts` (re-exports) | additive | new `__tests__/escalation-hook.test.ts` reverse-test for `ESCALATION_POLICY_REASONS` |
| 8 (Bug #1) | none | orchestration-layer only (`src/auto-reply/reply/closure-outcome-dispatcher.ts`) | none |
| 9 (Bug #3) | none | runner + config layer only (`src/agents/pi-embedded-runner/run/attempt.ts`, `src/config/zod-schema.core.ts`) | none |
| 10 (acceptance) | none | acceptance fixtures only | reverse-test integrity check (lint:commitment:frozen-reverse-tests) |

### `MonitoredRuntime` — confirmed untouched

`src/platform/commitment/monitored-runtime.ts` (lines 1-115) — the
`MonitoredRuntime` interface and `createMonitoredRuntime` factory are NOT
touched by any Phase 2-9. Policy-gate readers consume `runTurnDecision`
inputs; they never wrap or extend `MonitoredRuntime.run(...)`. Confirmed
sub-plan §10 invariant #11 footnote: "`RuntimeAttestation.policyDenialReasons`
… observability-only, additive optional field" — see §g below.

### `index.ts` re-export discipline

`src/platform/commitment/index.ts` is the public-surface barrel for the
commitment kernel. It is **not** in the five-frozen-contract list (invariant
#11). Each of Phases 2-7 adds 6-8 lines of `export {...}` and `export type
{...}` per stage following the existing `clarification-policy` pattern at
lines 66-78. **No removals or renamings** — additive only.

### Existing five frozen contracts — confirmed byte-identical impact

The five-frozen contracts list (per invariant #11):
- `TaskContract`
- `OutcomeContract`
- `QualificationExecutionContract`
- `ResolutionContract`
- `RecipeRoutingHints`

None of Phases 2-9 touch these files (confirmed by file inventory in
sub-plan §2 and by §g below). Phase 10 acceptance includes a
`pnpm exec lint:commitment:frozen-reverse-tests` integrity assertion as a
mechanical check.

---

## §g — `RuntimeAttestation` policy-denial signal

### Current shape

`src/platform/commitment/monitored-runtime.ts:14-28`:

```ts
export type RuntimeTerminalState = "action_completed" | "rejected" | "unsupported";

export type RuntimeAcceptanceReason =
  | "commitment_satisfied"
  | "commitment_unsatisfied"
  | "observer_unavailable";

export type RuntimeAttestation = {
  readonly terminalState: RuntimeTerminalState;
  readonly acceptanceReason: RuntimeAcceptanceReason;
  readonly commitmentSatisfied: boolean;
  readonly stateBefore: WorldStateSnapshot;
  readonly stateAfter: WorldStateSnapshot;
  readonly satisfaction: SatisfactionResult;
};
```

No structural slot for policy-denial reasons. Sub-plan §10 invariant #11
note explicitly allows an additive optional field
`policyDenialReasons?: readonly PolicyGateReason[]` "observability-only,
additive optional field".

### Recommendation

**Do NOT add `policyDenialReasons` to `RuntimeAttestation`.**

Two reasons:

1. **Architectural fit.** `RuntimeAttestation` is the *post-execution*
   monitoring result — it answers "did the commitment satisfy?" given a
   pre/post state delta. Policy gates run *before* execution; their denial
   never produces a `MonitoredRuntime.run(...)` invocation in the first
   place (the runTurnDecision short-circuits ahead of the runtime). Adding
   `policyDenialReasons` to attestation creates a "ghost field" that is
   `undefined` on every actually-attested run.
2. **`terminalState` already carries it** (sub-plan §10 invariant #11
   footnote: "carry в `terminalState` (preferred — не задевает frozen
   contract)"). The pattern is to widen `RuntimeTerminalState` to include
   policy-denial-flavoured terminals only if the policy denial path needs
   to *replay* through the monitored runtime (e.g. for telemetry uniformity).
   For Stages 2-6 the path is upstream of the runtime; the policy-denial
   reasons live on the `runTurnDecision` decision-trace and on the new
   `policy_*` episodic events (§c above). Telemetry via log lines + memory
   writes is sufficient.

**Recommendation finalized for Phase 2:**
- `RuntimeAttestation` stays byte-identical.
- Policy-denial observability flows through:
  (i) `decision.reasons` enriched with `<axis>_policy:<reason>` strings on
  `runTurnDecision` short-circuits;
  (ii) `policy_*` episodic events (§c) — the joinable record;
  (iii) per-axis log lines (`[policy-gate] event=approval_checked …`, etc.).

### Brand discipline residual (invariant #16)

If Phase 2 implementer disagrees with the recommendation and adds
`policyDenialReasons?: readonly PolicyGateReason[]`, the `PolicyGateReason`
union would need to widen to `PolicyGateReason | ApprovalPolicyReason |
BudgetPolicyReason | RolePolicyReason | RetryPolicyReason |
EscalationPolicyReason` — losing the closed-set guarantee. This is a
secondary reason to keep `RuntimeAttestation` untouched: it preserves the
narrow `PolicyGateReason = "channel_disabled" | "no_credentials"` union for
existing consumers.

---

## Summary table — Phase 1 deliverables for Phase 2 implementer

| Item | Decision | Source-of-truth file:line |
|---|---|---|
| `POLICY_GATE_REASONS` shape | byte-identical, 2-tuple frozen | `src/platform/commitment/policy-gate.ts:18` |
| `POLICY_GATE_REASONS` reverse-test | unchanged | `src/platform/commitment/__tests__/policy-gate.test.ts:40-51` |
| Stage 2 (Approvals) reasons | orthogonal `APPROVAL_POLICY_REASONS = ['requires_approval']` | NEW `src/platform/commitment/approval-policy.ts` |
| Stage 3 (Budgets) reasons | orthogonal `BUDGET_POLICY_REASONS = ['budget_exceeded_user', 'budget_exceeded_channel', 'budget_exceeded_effect']` | NEW `src/platform/commitment/budget-policy.ts` |
| Stage 4 (Role-based) reasons | orthogonal `ROLE_POLICY_REASONS = ['role_denied']` | NEW `src/platform/commitment/role-policy.ts` |
| Stage 5 (Retry) reasons | orthogonal `RETRY_POLICY_REASONS = ['retry_limit_exceeded']` | NEW `src/platform/commitment/retry-policy.ts` |
| Stage 6 (Escalation) reasons | orthogonal `ESCALATION_POLICY_REASONS = ['escalation_failed']` | NEW `src/platform/commitment/escalation-hook.ts` |
| `EpisodicEffectFamily` extension | additive — 5 new arms (`policy_approval`, `policy_budget`, `policy_role`, `policy_retry`, `policy_escalation`) | `src/platform/memory/episodic-memory-event.ts:31-36` |
| `EFFECT_FAMILY_REGISTRY` extension | **none** — registry is intent-contractor surface, not a memory family | `src/platform/commitment/effect-family-registry.ts:23-48` (sub-plan Phase 2 line 51 wording softened in PR body) |
| Bug #1 fix predicate | resolver-return-shape extension; detect `BootstrapResolution.status === 'available'` and route through new discriminated return shape | `src/auto-reply/reply/closure-outcome-dispatcher.ts:704-761` (`ensureBootstrapRequests`); resolver: `src/platform/bootstrap/resolver.ts:83-88` |
| Bug #3 site | hardcoded module constant `SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS` | `src/agents/pi-embedded-runner/run/attempt.ts:178` |
| Bug #3 fix path | named constant + config-overridable (sub-plan rule "hardcoded constant"), bump to 60 000 ms | NEW config field at `src/config/zod-schema.core.ts` near line 392 |
| `RuntimeAttestation` policy-denial slot | **none** — observability via decision-trace + episodic events + log lines | `src/platform/commitment/monitored-runtime.ts:14-28` (unchanged) |

---

## Concerns surfaced during audit (for Phase 2+ implementers)

1. **Sub-plan internal inconsistency (low impact).** Sub-plan Phase 2 line 51
   says "EFFECT_FAMILY_REGISTRY extension: добавить `policy.*` family entries".
   Recommendation §c above is to **not** extend that registry — it is the
   intent-contractor closed-list surface, not a memory family registry.
   Surface this in the Phase 2 PR body for explicit caller adjudication.
2. **Sub-plan internal inconsistency (low impact).** Bug #3 site label
   `DEFAULT_PDF_SUBAGENT_RUN_TIMEOUT_MS` (sub-plan Phase 9 line 138) does not
   match the actual site (`SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS`, generic
   to all subagents using `sessions_yield`). Phase 9 PR body should rename
   the proposed constant to match the real scope.
3. **Comment vs pattern mismatch in `clarification-policy.ts:25-29`.** The
   block comment claims Stages 2-6 belong to `POLICY_GATE_REASONS` extensions,
   but the file itself exemplifies the orthogonal pattern. Phase 2 PR
   should update this block comment to reflect the orthogonal-set decision
   confirmed in §b above (one-line doc fix; non-load-bearing).
4. **Three other 2 000 ms hardcoded constants** (out of scope for Phase 9 —
   see §e). If post-Phase-9 the symptom recurs, audit:
   `src/cli/gateway-cli/run.ts:237`, `src/plugins/setup-binary.ts:31`,
   `src/commands/onboard-remote.ts:79`.

---

**End of audit. Phase 1 deliverable complete.**
