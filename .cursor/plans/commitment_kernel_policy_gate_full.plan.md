---
slice: PolicyGate Full — Stages 2-6 + 2 co-scheduled orchestration bug-fixes (Stage 1 closed PR-#110)
status: in_progress
signoff: GRANTED via blanket authorization 2026-05-05 (memory feedback_signoff_blanket_authorization.md)
overview: |
  Полный PolicyGate per master §8.5.1: approvals, budgets, role-based access, retry policies, escalation hooks. Обязателен **до cutover-4** (`repo_operation.completed`). Stage 1 (Bug D — clarification policy) уже закрыт PR-#110 (merge `caca87a634`, см §11 Stage 1 history). Этот sub-plan покрывает Stages 2-6 ПЛЮС две co-scheduled orchestration-layer bug-fix фазы, всплывшие 2026-05-06 live test:

    - Bug #1 — `closure-outcome-dispatcher` false-positive «bootstrap pending» когда capability already verified (`src/auto-reply/reply/closure-outcome-dispatcher.ts:863`). НЕ inside frozen `src/platform/commitment/` — orchestration-layer fix, отдельная Phase 8.
    - Bug #3 — PDF subagent hardcoded timeoutMs=2000 (live log: `sessions_yield abort settle timed out`). НЕ inside frozen layer; emit-site обнаруживается в Phase 1 audit (likely `agents.defaults.subagents.runTimeoutSeconds` config default OR recipe-driven default OR subagent-announce). Отдельная Phase 9.

  PolicyGate stages (Stages 2-6) расширяют либо `POLICY_GATE_REASONS` (frozen reverse-test обновляется в том же PR), либо вводят новый orthogonal `*POLICY_REASONS` set со своим reverse-test — choice per stage, фиксируется в Phase 1 audit. **Frozen layer (`src/platform/commitment/`) трогать только additively** — constructor extension по slice E P6 / slice F P6 паттерну. Новые effect-families расширяют `EFFECT_FAMILY_REGISTRY` + `EpisodicEffectFamily` discriminated union (slice E P2 шаблон).

  Acceptance proof = log-line evidence (e.g. `[policy-gate] event=approval_checked`, `[policy-gate] event=budget_exceeded`, `[closure-outcome] event=bootstrap_skip_already_verified`, `[pdf-subagent] event=run_timeout_ms=<N>`), не unit-test greening alone.

audit_gaps_closed: []  # Stages 2-6 закрывают G6.c кусочно по PR; Stage 1 — UX-bug, не G1..G6.c gap.

todos:
  # ===== Stage 1 — CLOSED PR-#110 caca87a634 (preserved for audit trail) =====

  - id: stage1-bug-d-clarification-policy
    stage: 1
    signoff: not_required
    content: |
      Stage 1 closed PR-#110 merge `caca87a634`. Touched: `clarification-policy.ts` (NEW + reverse-test 9/9), `index.ts`, `run-turn-decision.ts`, `run-turn-decision.clarification-downgrade.test.ts` (NEW 8/8), `trace.ts` (FROZEN — `- [x] bug-fix` checkbox). Master §0 row added 2026-04-29. Detailed history → §11.
    status: completed

  # ===== Phase 1 — Audit (read-only) =====

  - id: phase-1-audit
    phase: 1
    signoff: GRANTED (blanket)
    content: |
      Read-only audit. Output `extensions/AUDIT-policy-gate-full.md`. Map:
      (a) текущий `POLICY_GATE_REASONS` shape + frozen reverse-test (`src/platform/commitment/policy-gate.ts` + `__tests__/policy-gate.test.ts`); подтвердить `Object.freeze` + push-throws; зафиксировать current allowlist `['channel_disabled','no_credentials']`.
      (b) Stage-2..Stage-6 orthogonal-vs-extend decision per stage (extend `POLICY_GATE_REASONS` ИЛИ ввести новый `APPROVAL_POLICY_REASONS`/`BUDGET_POLICY_REASONS`/`ROLE_POLICY_REASONS`/`RETRY_POLICY_REASONS`/`ESCALATION_POLICY_REASONS` set). Зафиксировать выбор + обоснование per stage в audit.md. Slice E P6 / Stage 1 (Bug D) precedent strongly favors orthogonal sets.
      (c) `EpisodicEffectFamily` discriminated union (slice E `src/platform/memory/episodic-memory-event.ts`) + `EFFECT_FAMILY_REGISTRY` — новые семантические события для approvals/budgets/role-denials/retry-exhaustion/escalation требуют additive extension; зафиксировать payload shape per stage.
      (d) Bug #1 site (`src/auto-reply/reply/closure-outcome-dispatcher.ts:820-888`): подтвердить — `markClosureRecoveryCheckpointFailed` triggers всегда когда `bootstrapNoOp=true`, но capability-verified path (`Capability '<plugin>' was installed and verified` log) должен НЕ заходить в `isBootstrapRemediation` ветку вообще, либо early-return ДО `markClosureRecoveryCheckpointFailed`. Зафиксировать exact condition predicate (по `decision.reasons` / `executionIntent` / capability state).
      (e) Bug #3 site: grep-find spawn-сайт PDF subagent с `timeoutMs=2000` или `runTimeoutSeconds=2`. Кандидаты для проверки: `agents.defaults.subagents.runTimeoutSeconds` config default, recipe layer (`src/platform/recipe/`), `subagent-announce.ts` defaults, PDF tool wiring (`src/agents/tools/pdf-tool.ts`), `~/.openclaw-dev/openclaw.json`. Если default-config-driven — fix = config schema bump + override at recipe; если hardcoded — fix = enlarge constant + add config-overridable.
      (f) Frozen-layer touch matrix per stage — `src/platform/commitment/policy-gate.ts` для extend-stages, либо new files для orthogonal-stages. `MonitoredRuntime` остаётся untouched. Каждое расширение `POLICY_GATE_REASONS` → frozen reverse-test обновление в том же PR.
      (g) `RuntimeAttestation` — есть ли структурное поле для policy-denial reasons? Если нет — добавить optional `policyDenialReasons?: readonly PolicyGateReason[]` (additive, observability-only) либо carry в `terminalState` (preferred — не задевает frozen contract).
    status: pending

  # ===== Phase 2 — Types + scaffolding =====

  - id: phase-2-types-and-scaffolding
    phase: 2
    signoff: GRANTED (blanket)
    content: |
      Pure types + scaffolding. NEW file `src/platform/commitment/policy-gate-stages.ts` (либо несколько файлов per stage если orthogonal sets) с типами для Stages 2-6: `ApprovalPolicyReader`, `BudgetPolicyReader`, `RolePolicyReader`, `RetryPolicyReader`, `EscalationHook` interfaces. Discriminated union `PolicyGateStageDecision` per stage с frozen reasons set. Zod schemas. Brand discipline: `ApprovalRequestId` / `BudgetWindowId` / `RoleId` distinct branded types per invariant #16. Test: brand non-assignability + Zod round-trip + frozen-set reverse-test (push throws, `Object.isFrozen` true).
      Episodic event extension (additive): расширить `EpisodicEffectFamily` discriminated union (`src/platform/memory/episodic-memory-event.ts`) с новыми членами `policy_approval`, `policy_budget`, `policy_role`, `policy_retry`, `policy_escalation` + per-payload types. Switch в `memory-write-on-satisfied.ts` exhaustiveness guard fires — это desired, lock-step extension.
      EFFECT_FAMILY_REGISTRY extension: добавить `policy.*` family entries по slice E P2 шаблону.
      **Frozen layer touch**: `policy-gate.ts` (если extend path выбран per Phase 1 audit) — additive constructor extension only, mirror slice E P6 pattern. Reverse-test для новых reasons обновляется в этом же PR. **Not** в этой phase: реальные runtime-impl-ы (Stages 3-7) и orchestration wiring (Phases 8-9).
      Log-line evidence: `[policy-gate-stages] event=types_loaded stage_count=5` на module init.
    status: pending

  # ===== Phase 3 — Stage 2 Approvals =====

  - id: phase-3-stage2-approvals
    phase: 3
    signoff: GRANTED (blanket)
    content: |
      Stage 2 — Approvals impl. Реализовать `createApprovalPolicy({cfg, approvalLookup})` factory в `src/platform/commitment/approval-policy.ts`. `ApprovalPolicyReader.evaluate({intent, affordance, identityId})` → `{approved: true} | {approved: false, reason: 'requires_approval', approvalRequestId}`. Approval lookup hook: config-driven role-policy registry в `openclaw.json` (`policy.approvals[]` array, schema через `src/config/zod-schema.ts` extension — NOT frozen). На `approved=false` → emit episodic event `policy_approval` + создать `ApprovalRequest` в существующий `getSharedExecApprovalManager()` (sibling reuse, не дублировать).
      Wiring: на `runTurnDecision` (НЕ frozen) → consume `approvalPolicy?: ApprovalPolicyReader` injection. PolicyGate evaluation chain: `affordance allowlist (existing) → approval (new) → budget (Phase 4) → role (Phase 5) → retry (Phase 6)`.
      Tests: positive (config-listed effect requires approval → blocks); negative (effect not in approval list → passes); missing-identity (anonymous session) → fail-closed (block + warn). Frozen reverse-test для `POLICY_GATE_REASONS` ОБНОВЛЁН (если extend-path) ИЛИ новый reverse-test для `APPROVAL_POLICY_REASONS` (если orthogonal-path) — choice per Phase 1 audit.
      Log-line evidence (acceptance proof, не unit test alone): `[policy-gate] event=approval_checked stage=2 effect=<id> approved=<bool> reason=<r>` в production turn run; `[policy-gate] event=approval_request_created approval_id=<id>` на denial.
    status: pending

  # ===== Phase 4 — Stage 3 Budgets =====

  - id: phase-4-stage3-budgets
    phase: 4
    signoff: GRANTED (blanket)
    content: |
      Stage 3 — Budgets impl. NEW `src/platform/commitment/budget-policy.ts`. `createBudgetPolicy({cfg, budgetStore})` factory; `BudgetPolicyReader.evaluate({intent, affordance, identityId, channel})` → `{within: true, remaining} | {within: false, reason: 'budget_exceeded_user' | 'budget_exceeded_channel' | 'budget_exceeded_effect', windowId}`. Single `'budget_exceeded'` reason с structured payload OR three orthogonal reasons — choice per Phase 1 audit.
      Storage layer: NEW `src/platform/commitment/budget-store.ts` интерфейс + `SqliteBudgetStore` impl на тех же лекалах что `SqliteVecMemoryStore` (slice E P3) — `node:sqlite` `DatabaseSync`, `CREATE TABLE IF NOT EXISTS budget_windows(identity_id, channel, effect_family, window_start, window_end, used, limit_value, ...)` + `schema_version` row. Per-`IdentityId` predicates на каждом read. Reset windows: cron-driven через slice K reminder hook (если slice K landed) ИЛИ inline `Date.now() > window_end` check. DB path: `~/.openclaw-dev/policy/budget.sqlite`.
      Tests: per-user budget exceeded → block + reason; per-channel budget exceeded → block + reason; per-effect budget exceeded → block + reason; window reset (mock clock) → counter resets; concurrent writes (transaction) → atomic increment.
      Log-line evidence: `[policy-gate] event=budget_checked stage=3 dimension=<user|channel|effect> within=<bool> used=<n>/<limit>`; `[policy-gate] event=budget_exceeded window_id=<id> reset_at=<ts>`.
    status: pending

  # ===== Phase 5 — Stage 4 Role-based =====

  - id: phase-5-stage4-role-based
    phase: 5
    signoff: GRANTED (blanket)
    content: |
      Stage 4 — Role-based access impl. NEW `src/platform/commitment/role-policy.ts`. `createRolePolicy({cfg, roleResolver})` factory. `RolePolicyReader.evaluate({intent, affordance, identityId})` → `{allowed: true, role} | {allowed: false, reason: 'role_denied', requiredRole}`. Identity → role resolution: extend `IdentityRecord` schema (`src/config/zod-schema.identities.ts`, NOT frozen) с `roles?: readonly string[]`. Role → effect allowlist: config-driven `policy.roles[<role>].allowedEffects: string[]` в `openclaw.json`.
      Tests: identity with `admin` role → all effects allowed; identity with `user` role + restricted effect → block + `role_denied`; missing identity (anonymous) → fail-closed (default-deny).
      Log-line evidence: `[policy-gate] event=role_checked stage=4 identity=<id> role=<r> allowed=<bool>`; `[policy-gate] event=role_denied required=<r>`.
    status: pending

  # ===== Phase 6 — Stage 5 Retry =====

  - id: phase-6-stage5-retry
    phase: 6
    signoff: GRANTED (blanket)
    content: |
      Stage 5 — Retry policies impl. NEW `src/platform/commitment/retry-policy.ts`. Per-effect retry budgets + exponential backoff. `RetryPolicyReader.evaluate({intent, affordance, attemptCount})` → `{retry: true, backoffMs} | {retry: false, reason: 'retry_limit_exceeded'}`. Storage: in-memory LRU keyed `(identityId, effectId, sessionId)` — НЕ persistent (retry counters reset across `/new` by design — это слой-выше задача).
      Wiring: `MonitoredRuntime` уже видит attempt count через `RuntimeAttestation`; интеграция через wrapper в `src/agents/pi-embedded-runner/run/` (НЕ trogать MonitoredRuntime). На `terminalState=transient_failure` consult retry policy → either retry (backoff sleep + re-invoke) либо emit `policy.retry` episodic event с `reason='retry_limit_exceeded'` и блокировать.
      Tests: 3 attempts → 3 retries (with backoff); 4th attempt → block + reason; backoff growth `100/200/400ms`; retry counter scoped per `(identityId, effectId, sessionId)` — другая session не наследует count.
      Log-line evidence: `[policy-gate] event=retry_checked stage=5 attempt=<n>/<max> backoff_ms=<n>`; `[policy-gate] event=retry_exhausted effect=<id>`.
    status: pending

  # ===== Phase 7 — Stage 6 Escalation =====

  - id: phase-7-stage6-escalation
    phase: 7
    signoff: GRANTED (blanket)
    content: |
      Stage 6 — Escalation hooks impl. NEW `src/platform/commitment/escalation-hook.ts`. `EscalationHook.fire({denialReason, identityId, intent, affordance})` → trigger escalation channel. v1 channels: (a) maintainer notification (slice E `MemoryStore` write of family `policy_escalation` + log warn), (b) approval request raise (sibling reuse `getSharedExecApprovalManager().create()` с escalation-id и `escalationOrigin: 'policy-denial'` flag в payload).
      Wiring: после policy-denial с reason ∈ `{requires_approval, budget_exceeded_*, role_denied}` → `escalationHook.fire(...)`. Defense-in-depth: escalation failure does NOT downgrade commitment satisfaction — escalation = observability, не gating (slice E precedent).
      Tests: positive escalation fired on each denial reason; failure isolation (escalation throws → commitment still satisfies); escalation payload shape (Zod-validated); idempotency (repeated denial same turn → single escalation per `(identityId, denialReason, effectId)`).
      Log-line evidence: `[policy-gate] event=escalation_fired reason=<r> channel=<c> escalation_id=<id>`.
    status: pending

  # ===== Phase 8 — Bug #1 closure-outcome-dispatcher (orchestration-layer) =====

  - id: phase-8-closure-outcome-dispatcher-fix
    phase: 8
    signoff: GRANTED (blanket)
    content: |
      **Bug #1 fix — co-scheduled orchestration-layer phase (NOT inside frozen layer).** Site: `src/auto-reply/reply/closure-outcome-dispatcher.ts:820-888` (`finalizeRetryAndApprovalsForClosure` function).
      Symptom: `decision.remediation === "bootstrap"` && `bootstrapRequestIds.length === 0` → `bootstrapNoOp=true` → `markClosureRecoveryCheckpointFailed({error: 'bootstrap_noop: ...'})` fires даже когда capability already verified (live log: `Capability '<plugin>' was installed and verified` precedes the false bootstrap_noop). User-visible result: «Your task is paused while a capability install is pending».
      Fix (per Phase 1 audit findings): early-return ДО `bootstrapNoOp` block если `executionIntent` (or сигнал-equivalent) carries `capabilityAlreadyVerified=true` flag. Source-of-truth для верификации — добавить optional поле в `PlatformRuntimeExecutionIntent` (НЕ frozen) или прочитать из существующего `ensureBootstrapRequests` return shape (`bootstrapRequestIds.length === 0 && reason === 'already_verified'` отдельно от `length === 0 && reason === 'no_capabilities_advertised'`).
      Tests: positive (capability verified → no bootstrap_noop, no `markClosureRecoveryCheckpointFailed` call, response continues normally); negative (capability NOT verified, no requests → bootstrap_noop fires as before, regression preserved); reverse (multiple capabilities, mixed verified/unverified → only unverified trigger bootstrap_noop).
      Log-line evidence: `[closure-outcome] event=bootstrap_skip_already_verified capability=<id>`; existing `[closure-outcome] event=recovery_checkpoint_terminal` MUST NOT fire on the verified path.
      **Frozen layer untouched** — fix entirely в `src/auto-reply/reply/`.
    status: pending

  # ===== Phase 9 — Bug #3 PDF subagent timeout (orchestration-layer) =====

  - id: phase-9-pdf-subagent-timeout-fix
    phase: 9
    signoff: GRANTED (blanket)
    content: |
      **Bug #3 fix — co-scheduled orchestration-layer phase (NOT inside frozen layer).** Site: discovered in Phase 1 audit (likely `agents.defaults.subagents.runTimeoutSeconds` config default OR recipe-layer hardcoded constant OR `src/agents/subagent-announce.ts` default). Live log evidence: `sessions_yield abort settle timed out: timeoutMs=2000`.
      Symptom: PDF subagent (rendering pipeline) aborted at 2000ms — actual rendering нужен 10-30s+ для нетривиальных PDF.
      Fix: (a) bump default to 60_000ms (60s) для PDF subagent specifically через recipe-driven override (recipe layer — `src/platform/recipe/`, NOT frozen); либо (b) make config-overridable если уже config-driven но default слишком мал — bump в `src/config/zod-schema.core.ts` (`agents.defaults.subagents.runTimeoutSeconds` default) после Phase 1 audit подтвердит exact site.
      **Decision rule per audit findings**: если site === config default → bump в schema; если site === hardcoded constant → выделить именованную константу `DEFAULT_PDF_SUBAGENT_RUN_TIMEOUT_MS = 60_000` + accept config override; если site === recipe layer → recipe-specific override.
      Tests: positive (PDF subagent run with 30s real rendering → completes, не aborts); negative (PDF subagent run > 60s → aborts с structured `terminalState=timeout_exceeded`, не `unknown`); config override works (test-injected config с timeoutMs=120000 → раскрывается).
      Log-line evidence: `[pdf-subagent] event=run_timeout_ms=60000` (новый default); `[pdf-subagent] event=run_completed elapsed_ms=<n>`. Negative: на abort `[pdf-subagent] event=run_timeout terminal_state=timeout_exceeded`.
      **Frozen layer untouched** — fix в config schema / recipe / subagent-announce.
    status: pending

  # ===== Phase 10 — Acceptance + live-verify =====

  - id: phase-10-acceptance-and-live-verify
    phase: 10
    signoff: GRANTED (blanket)
    content: |
      End-to-end acceptance + live-verify. Acceptance fixture per stage (`src/platform/commitment/__tests__/policy-gate-full.acceptance.test.ts`):
      (a) Stage 2 acceptance — config с required-approval effect → turn запускает effect → policy gate denies + creates ApprovalRequest + logs `event=approval_checked approved=false`.
      (b) Stage 3 — config с budget per-channel limit=2 → 3rd attempt в этом канале gets blocked + logs `event=budget_exceeded`.
      (c) Stage 4 — config с user-role + restricted effect → user blocked + logs `event=role_denied`.
      (d) Stage 5 — 4 sequential transient failures → 4th gets blocked + logs `event=retry_exhausted`.
      (e) Stage 6 — denial of any reason → escalation fires + logs `event=escalation_fired`.
      (f) Bug #1 — fixture с capability already verified + bootstrap-remediation request → `bootstrap_noop` НЕ fires + log `event=bootstrap_skip_already_verified`.
      (g) Bug #3 — fixture с PDF subagent simulating 30s render → completes, не aborts.
      Live-verify: после merge всех phases — рестарт gateway, Vladimir шлёт в TG: «привет», «запомни X» / /new / «что я запомнил?», (JPG) «сделай PDF», (DOCX) «сделай КП». live-verifier парсит `C:\tmp\openclaw\openclaw-<date>.log` против log-line acceptance criteria каждого phase. **B1 + B7 регрессионно держим** (slice E/F closure не должен сломаться).
      Frozen-layer integrity check: `pnpm exec lint:commitment:frozen-reverse-tests` green; 5 frozen contracts byte-identical; `policy-gate.ts` reverse-test обновлён с новыми reasons (если extend-path) либо новые reverse-tests для orthogonal sets.
      Master plan §0 row updated by handoff-writer (НЕ в этом sub-plan-е — отдельный `docs(plan)` PR после merge).
    status: pending

isProject: false
---

# PolicyGate Full — Stages 2-6 + 2 co-scheduled orchestration bug-fixes

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `commitment_kernel_v1_master.plan.md` (§8.5.1 PolicyGate split, §0 row 2026-05-06 forward queue) |
| Predecessors | Stage 1 (Bug D — clarification policy) closed PR-#110 merge `caca87a634`. Slice D (`IdentityId`), Slice E (`MemoryStore` + episodic events), Slice F (`TaskLedger`) all CLOSED on `dev` (post-PR-#191 SHA `0c71dd8e36`). Frozen reverse-test для текущего `POLICY_GATE_REASONS = ['channel_disabled','no_credentials']` остаётся authoritative. |
| Trigger | Master §0 row 2026-05-06: 4 production bugs surfaced via live test. Bug #1 + Bug #3 mapped to this sub-plan; Bug #2 → `commitment_kernel_cutover3_artifacts.plan.md`; Bug #4 → minor outbound follow-up. |
| Acceptance criteria | (1) Каждая Phase 3-7 (Stages 2-6) ships log-line evidence + reverse-test для своего policy-reasons set. (2) Bug #1 (Phase 8) — capability-verified path не triggers `bootstrap_noop`. (3) Bug #3 (Phase 9) — PDF subagent default timeout enlarged + config-overridable. (4) Frozen layer additively touched only (`policy-gate.ts` constructor extension OR new orthogonal files); 5 frozen contracts byte-identical. (5) `EpisodicEffectFamily` discriminated union + `EFFECT_FAMILY_REGISTRY` extended via slice E P2 паттерну. (6) Live-verify в TG validates все log-lines per phase. |
| Maintainer signoff | **GRANTED via blanket authorization 2026-05-05** (memory: `feedback_signoff_blanket_authorization.md`). Per-phase signoff gates skipped — agent loop autonomous per Vladimir's standing delegation. |
| Out of scope | Bug #2 (image_generate img2img) — separate `commitment_kernel_cutover3_artifacts.plan.md`. Bug #4 (streaming partials past `streaming: "off"`) — slice I Phase 7 OR standalone. cutover-4 itself — отдельный sub-plan, blocked на этот. |

## 1. Phases

| # | Phase | Status | Frozen-layer touch |
|---|---|---|---|
| 1 | Audit (`extensions/AUDIT-policy-gate-full.md`) | pending | none (read-only) |
| 2 | Types + scaffolding (`policy-gate-stages.ts` + episodic extension) | pending | additive — `policy-gate.ts` constructor + `episodic-memory-event.ts` discriminated union extension |
| 3 | Stage 2 — Approvals impl | pending | conditional — `policy-gate.ts` reverse-test update if extend-path |
| 4 | Stage 3 — Budgets impl + `SqliteBudgetStore` | pending | conditional |
| 5 | Stage 4 — Role-based access impl | pending | conditional |
| 6 | Stage 5 — Retry policies impl | pending | none (in-memory LRU) |
| 7 | Stage 6 — Escalation hooks impl | pending | none |
| 8 | Bug #1 fix — `closure-outcome-dispatcher` capability-verified early-return | pending | none (orchestration-layer) |
| 9 | Bug #3 fix — PDF subagent timeoutMs enlargement + config override | pending | none (config / recipe / subagent-announce) |
| 10 | Acceptance + live-verify | pending | reverse-test integrity check |

## 2. File inventory

| Layer | File | Touch | Frozen? |
|---|---|---|---|
| Audit deliverable | `extensions/AUDIT-policy-gate-full.md` | NEW | — |
| Commitment policy types | `src/platform/commitment/policy-gate-stages.ts` | NEW | NO |
| Commitment policy impl | `src/platform/commitment/approval-policy.ts` | NEW | NO |
| Commitment policy impl | `src/platform/commitment/budget-policy.ts` | NEW | NO |
| Commitment policy storage | `src/platform/commitment/budget-store.ts` | NEW | NO |
| Commitment policy storage impl | `src/platform/commitment/sqlite-budget-store.ts` | NEW | NO |
| Commitment policy impl | `src/platform/commitment/role-policy.ts` | NEW | NO |
| Commitment policy impl | `src/platform/commitment/retry-policy.ts` | NEW | NO |
| Commitment policy hook | `src/platform/commitment/escalation-hook.ts` | NEW | NO |
| Commitment frozen ext | `src/platform/commitment/policy-gate.ts` | MODIFIED (additive constructor + reverse-test update if extend-path) | **YES** — frozen reverse-test enforced; **must stay intact OR be updated in same PR per invariant #11** |
| Commitment frozen reverse-test | `src/platform/commitment/__tests__/policy-gate.test.ts` | MODIFIED (frozen reverse-test reflects new reasons set if extend-path; otherwise untouched) | **YES** |
| Commitment public surface | `src/platform/commitment/index.ts` | MODIFIED (additive exports) | NO |
| Memory layer extension | `src/platform/memory/episodic-memory-event.ts` | MODIFIED (additive discriminated union extension — `policy_*` variants) | NO (slice E module) |
| Memory layer registry | (effect-family registry — Phase 1 audit confirms exact path) | MODIFIED (additive `policy.*` family entries) | NO |
| Decision wiring | `src/platform/decision/run-turn-decision.ts` | MODIFIED (inject policy readers) | NO |
| Orchestration bug #1 | `src/auto-reply/reply/closure-outcome-dispatcher.ts` | MODIFIED (early-return on capability-verified path) | NO |
| Orchestration bug #3 | `src/config/zod-schema.core.ts` OR recipe layer OR `src/agents/subagent-announce.ts` (per Phase 1 audit) | MODIFIED (timeout enlargement + config override) | NO |
| Tests | `src/platform/commitment/__tests__/policy-gate-stages.test.ts` | NEW | — |
| Tests | `src/platform/commitment/__tests__/approval-policy.test.ts` | NEW | — |
| Tests | `src/platform/commitment/__tests__/budget-policy.test.ts` | NEW | — |
| Tests | `src/platform/commitment/__tests__/role-policy.test.ts` | NEW | — |
| Tests | `src/platform/commitment/__tests__/retry-policy.test.ts` | NEW | — |
| Tests | `src/platform/commitment/__tests__/escalation-hook.test.ts` | NEW | — |
| Tests | `src/platform/commitment/__tests__/policy-gate-full.acceptance.test.ts` | NEW | — |
| Tests | `src/auto-reply/reply/closure-outcome-dispatcher.bug1.test.ts` | NEW | — |
| Tests | (PDF subagent timeout test — exact path per Phase 1 audit) | NEW | — |

**Frozen-layer reverse-test integrity:** `POLICY_GATE_REASONS` frozen reverse-test (`Object.isFrozen`, push-throws, exact-set assertion) MUST stay intact OR be updated in the SAME PR that extends the set per invariant #11. Phase 1 audit fixes the choice (extend vs orthogonal) per stage.

## 3. Acceptance criteria per phase (log-line evidence required)

| Phase | Log-line evidence (production turn run) | Test gate |
|---|---|---|
| 1 | `extensions/AUDIT-policy-gate-full.md` exists with §a-§g sections filled | read-only |
| 2 | `[policy-gate-stages] event=types_loaded stage_count=5` on module init | brand-discipline + Zod tests + frozen-set reverse-test |
| 3 | `[policy-gate] event=approval_checked stage=2 effect=<id> approved=<bool>` + `event=approval_request_created` on denial | unit + integration |
| 4 | `[policy-gate] event=budget_checked stage=3 dimension=<user|channel|effect> within=<bool> used=<n>/<limit>` + `event=budget_exceeded` | unit + integration |
| 5 | `[policy-gate] event=role_checked stage=4 identity=<id> role=<r> allowed=<bool>` + `event=role_denied` | unit + integration |
| 6 | `[policy-gate] event=retry_checked stage=5 attempt=<n>/<max>` + `event=retry_exhausted` | unit + mock-clock backoff |
| 7 | `[policy-gate] event=escalation_fired reason=<r> channel=<c>` | unit + idempotency |
| 8 | `[closure-outcome] event=bootstrap_skip_already_verified capability=<id>` AND absence of `event=recovery_checkpoint_terminal` on verified path | unit + replay fixture against live-log line |
| 9 | `[pdf-subagent] event=run_timeout_ms=60000` (new default) + `event=run_completed elapsed_ms=<n>` | unit + simulated-render fixture |
| 10 | All Phase 3-9 log-lines observed in `C:\tmp\openclaw\openclaw-<date>.log` after live verify | live-verifier agent parse |

## 4. Risks

1. **Frozen reverse-test scope creep** — extending `POLICY_GATE_REASONS` from 2 to 5+ codes risks blast radius если orthogonal-vs-extend choice неудачен. Mitigation: Phase 1 audit fixes choice per stage с обоснованием; orthogonal sets предпочтительны для разных concerns (approvals ≠ budgets ≠ role).
2. **PDF subagent timeout site discovery** — current grep не показывает obvious hardcoded `timeoutMs=2000` в PDF tool. Possible site is config-default или recipe-layer. Phase 1 audit обязан зафиксировать exact site до Phase 9 commit.
3. **Bug #1 root-cause precision** — fix predicate (`capabilityAlreadyVerified`) должен readable из existing structures (`executionIntent`, `decision.reasons`, или `ensureBootstrapRequests` return shape). Phase 1 audit fixes precise predicate; не угадывать.
4. **Episodic event extension lock-step** — `assertNeverEpisodic` exhaustiveness guard fires на extension; consumers (slice E `memory-write-on-satisfied.ts` + slice F `task-write-on-satisfied.ts`) обязаны update switch в том же PR.
5. **Live-verify dependency** — Phase 10 acceptance ссылается на `C:\tmp\openclaw\openclaw-<date>.log` which existing only after gateway restart. Slice-implementer Phase 10 spawns gateway restart explicitly, не предполагает существование лога.
6. **Budget store schema migration** — `SqliteBudgetStore` schema_version=1 baseline; future migrations gated on version row (slice E P3 паттерн). Reset windows via cron — slice K (если landed) ИЛИ inline check.
7. **Anonymous session fail-closed** — Stage 2/4 (approvals, role) с anonymous identity → fail-closed (default-deny). Это safety, не bug. Reverse-test обязан зафиксировать.

## 5. Commit / PR convention

- Branch naming: `feat/policy-gate-full-phase-<N>-<slug>` per phase. Phase 1 audit может быть on `audit/policy-gate-full-phase-1`.
- Commit messages: на русском, без `Co-authored-by`. Use `scripts/committer "<msg>" <files...>` if available, else `git commit -F <file>`.
- PR body MUST include:
  - Phase reference (`Phase 3 — Stage 2 Approvals`).
  - Log-line evidence quoted (e.g. `[policy-gate] event=approval_checked ...`).
  - Frozen-layer touch declaration (`- [x] compatibility` if `policy-gate.ts` modified, OR `- [x] bug-fix` for orchestration-layer phases).
  - Reverse-test integrity statement (e.g. «`POLICY_GATE_REASONS` extended to 3 codes; reverse-test updated in same PR» OR «orthogonal `APPROVAL_POLICY_REASONS` introduced; existing `POLICY_GATE_REASONS` reverse-test untouched»).
- Admin-merge via `gh pr merge <N> --admin --squash --delete-branch` per blanket signoff (2026-05-05).
- Post-merge: handoff-writer agent (separate process) updates master §0 row + flips this sub-plan's todo to `completed` + adds Handoff Log row in §6.

## 6. Handoff Log (Phases 1-10 — empty rows filled by handoff-writer post-merge)

### Phase 1 — Audit landed

- Branch: `<TBD>`
- PR: `<TBD>`
- Squash-merge SHA on `dev`: `<TBD>`
- Files added/modified: `<TBD>`
- Acceptance proof (log-line / test count): `<TBD>`
- Frozen-layer integrity statement: `<TBD>`
- Notes: `<TBD>`

### Phase 2 — Types + scaffolding landed

- Branch: `<TBD>`
- PR: `<TBD>`
- Squash-merge SHA on `dev`: `<TBD>`
- Files added/modified: `<TBD>`
- Acceptance proof: `<TBD>`
- Frozen-layer integrity statement: `<TBD>`
- Notes: `<TBD>`

### Phase 3 — Stage 2 Approvals landed

- Branch: `<TBD>`
- PR: `<TBD>`
- Squash-merge SHA on `dev`: `<TBD>`
- Files added/modified: `<TBD>`
- Acceptance proof: `<TBD>`
- Frozen-layer integrity statement: `<TBD>`
- Notes: `<TBD>`

### Phase 4 — Stage 3 Budgets landed

- Branch: `<TBD>`
- PR: `<TBD>`
- Squash-merge SHA on `dev`: `<TBD>`
- Files added/modified: `<TBD>`
- Acceptance proof: `<TBD>`
- Frozen-layer integrity statement: `<TBD>`
- Notes: `<TBD>`

### Phase 5 — Stage 4 Role-based landed

- Branch: `<TBD>`
- PR: `<TBD>`
- Squash-merge SHA on `dev`: `<TBD>`
- Files added/modified: `<TBD>`
- Acceptance proof: `<TBD>`
- Frozen-layer integrity statement: `<TBD>`
- Notes: `<TBD>`

### Phase 6 — Stage 5 Retry landed

- Branch: `<TBD>`
- PR: `<TBD>`
- Squash-merge SHA on `dev`: `<TBD>`
- Files added/modified: `<TBD>`
- Acceptance proof: `<TBD>`
- Frozen-layer integrity statement: `<TBD>`
- Notes: `<TBD>`

### Phase 7 — Stage 6 Escalation landed

- Branch: `<TBD>`
- PR: `<TBD>`
- Squash-merge SHA on `dev`: `<TBD>`
- Files added/modified: `<TBD>`
- Acceptance proof: `<TBD>`
- Frozen-layer integrity statement: `<TBD>`
- Notes: `<TBD>`

### Phase 8 — Bug #1 closure-outcome-dispatcher fix landed

- Branch: `<TBD>`
- PR: `<TBD>`
- Squash-merge SHA on `dev`: `<TBD>`
- Files added/modified: `<TBD>`
- Acceptance proof: `<TBD>`
- Frozen-layer integrity statement (none — orchestration-layer): `<TBD>`
- Notes: `<TBD>`

### Phase 9 — Bug #3 PDF subagent timeoutMs fix landed

- Branch: `<TBD>`
- PR: `<TBD>`
- Squash-merge SHA on `dev`: `<TBD>`
- Files added/modified: `<TBD>`
- Acceptance proof: `<TBD>`
- Frozen-layer integrity statement (none — config / recipe / subagent-announce): `<TBD>`
- Notes: `<TBD>`

### Phase 10 — Acceptance + live-verify landed; **PolicyGate Full COMPLETE**

- Branch: `<TBD>`
- PR: `<TBD>`
- Squash-merge SHA on `dev`: `<TBD>`
- Files added/modified: `<TBD>`
- Live-verify log evidence (per phase): `<TBD>`
- Frozen-layer reverse-test integrity check: `<TBD>`
- Master plan §0 row added by handoff-writer: `<TBD>`
- Notes: cutover-4 unblocked. `<TBD>`

## 7. Maintainer signoff

**GRANTED via blanket authorization 2026-05-05** (memory: `feedback_signoff_blanket_authorization.md`). Per-phase signoff gates skipped per Vladimir's standing delegation для v1 commitment-kernel slices. Slice-implementer agent loop is autonomous; handoff-writer drift-fix runs after each merge.

## 8. Deferred-work table

| Order | Item | Why deferred / status | Future sub-plan |
|---|---|---|---|
| 1 | **Bug A.2 — Block-streaming buffering при tool_call в turn'е** | medium priority; non-regression of slice E/F/I; `Single_final_user_facing_message_per_user_turn` invariant НЕ обеспечивает буферизацию для случаев без `sessions_spawn` | `commitment_kernel_streaming_leak_buffering.plan.md` (TBD) |
| 2 | **Bug F — Persistent worker subsequent push** | medium priority; cron-driven daily push'ы из persistent_worker'а в внешний канал | `commitment_kernel_persistent_worker_push.plan.md` (TBD) |
| 3 | **Bug #2 — image_generate reference image (img2img)** | mapped to **separate sub-plan** per master §0 row 2026-05-06 | `commitment_kernel_cutover3_artifacts.plan.md` |
| 4 | **Bug #4 — `streaming: "off"` partial chunks через `stripBlockTags`** | minor outbound follow-up | Slice I Phase 7 OR standalone |
| 5 | **cutover-4 (`repo_operation.completed`)** | blocked на этот sub-plan COMPLETE; запускается после Phase 10 merge | TBD master §16 |
| 6 | **Search-Composer Phase 4c** | flip `intent-contractor-impl.ts:472` 3-family allowlist на `web_research`; запускается после этот sub-plan + cutover-3 sub-plan COMPLETE | inline в master §0 row 2026-05-02 |

## 9. References

- Master: `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0 PR log row 2026-05-06; §8.5.1 PolicyGate split; §16 next gate).
- Stage 1 (Bug D) baseline: this sub-plan §11 history; PR-#110 merge `caca87a634`.
- Slice templates: `commitment_kernel_memory_layer.plan.md` (slice E — phase structure, frontmatter, §6 handoff, §8 deferred); `commitment_kernel_task_ledger.plan.md` (slice F).
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc` (16 hard).
- Existing PolicyGate impl: `src/platform/commitment/policy-gate.ts` (frozen reverse-test on 2 codes).
- Bug #1 site: `src/auto-reply/reply/closure-outcome-dispatcher.ts:820-888`.
- Bug #3 site: discovery deferred to Phase 1 audit (likely config / recipe / subagent-announce).
- Slice E episodic-event surface: `src/platform/memory/episodic-memory-event.ts` (additive extension target).
- HANDOFF: `.cursor/plans/HANDOFF-2026-05-06-policy-gate-cutover3.md`.

## 10. Hard invariants — Stages 2-6 + bug-fix Phases 8-9

См. `.cursor/rules/commitment-kernel-invariants.mdc` (16 hard invariants — always-applied rule). Точечно для этого sub-plan:

| # | Invariant | Как держим |
| --- | --- | --- |
| 1 | `ExecutionCommitment` tool-free | Не трогаем `execution-commitment.ts` ни в одной Phase. |
| 2 | Affordance selected by (effect + target + preconditions + policy + budgets) | Phases 3-7 расширяют policy/budget оси; affordance selection остаётся orthogonal. |
| 3 | Production success requires `commitmentSatisfied(...) === true` | Policy gates НЕ перезаписывают success/failure decisions; они блокируют ДО execution. |
| 4 | Success requires observed state-after | Не вводим success/failure decisions — только pre-execution gates. |
| 5 | No phrase/text-rule matching на `UserPrompt`/`RawUserTurn` вне whitelist | Все matchers работают на (а) `SemanticIntent` + `Affordance` + `IdentityRecord` структурных полях, (б) classifier OUTPUT-ах. НИ ОДНОГО regex по prompt. |
| 6 | `IntentContractor` — единственный reader сырого user text | Не трогаем. |
| 7 | `ShadowBuilder` принимает только `SemanticIntent` | Не трогаем shadow-builder. |
| 8 | `commitment/` ↛ `decision/` | Новые policy-gate impl-ы живут в `commitment/`; `runTurnDecision` → policy gates direction разрешена. |
| 9 | `DonePredicate` видит только state/delta/receipts/trace | Не трогаем done-predicates. |
| 10 | `DonePredicate` живёт на `Affordance` | Не трогаем. |
| 11 | Five legacy contracts frozen (TaskContract/OutcomeContract/QualificationExecutionContract/ResolutionContract/RecipeRoutingHints) | Не вводим новые orchestration-semantic поля в эти типы. `RuntimeAttestation.policyDenialReasons` (если добавляется в Phase 2) — observability-only, additive optional field. |
| 12 | Emergency phrase patches → ticket + retire deadline | Не emergency. Структурные gates с frozen reasons-sets. |
| 13 | `terminalState` ⊥ `acceptanceReason` | Не трогаем. |
| 14 | `ShadowBuildResult` typed, never null/throw | Не трогаем shape. |
| 15 | PR-1/1.5/2/3 require human signoff regardless of CI | **GRANTED via blanket authorization 2026-05-05** для всех Phases 1-10. |
| 16 | `EffectFamilyId` ⊥ `EffectId` | Brand discipline сохраняется в новых `ApprovalRequestId` / `BudgetWindowId` / `RoleId` ID types per Phase 2. |

## 11. Stage 1 history (Bug D — clarification policy, CLOSED PR-#110)

### 2026-04-29 — Bug D merged (Stage 1 closed)

- Branch: `fix/orchestrator-policy-gate-clarification` → merged into `dev`.
- PR: [#110](https://github.com/Primus-max/god-mode-core/pull/110).
- Merge commit: `caca87a634`. Fix commit: `0753d564c4`.
- Touched: `src/platform/commitment/clarification-policy.ts` (NEW), `src/platform/commitment/__tests__/clarification-policy.test.ts` (NEW), `src/platform/commitment/index.ts`, `src/platform/decision/run-turn-decision.ts`, `src/platform/decision/run-turn-decision.clarification-downgrade.test.ts` (NEW), `src/platform/decision/trace.ts` (FROZEN — PR-body checkbox `- [x] bug-fix`).
- Tests: `clarification-policy.test.ts` 9/9 green; `run-turn-decision.clarification-downgrade.test.ts` 8/8 green; адъюнктная регрессия `decision/**` + `commitment/**` 127/127 green; `pnpm tsgo` clean; `lint:commitment:imports`/`invariants`/`tools` clean; `check-frozen-layer-label.mjs` (BASE_REF=origin/dev, PR_BODY с `- [x] bug-fix`) → exit 0.
- Master §0 PR Progress Log row added: `2026-04-29 | Bug D — clarification policy gate (PolicyGate Stage 1) | caca87a634 | PolicyGate Stages 2-6 (approvals/budgets/role-based/retry/escalation) — signoff required`.
- Stage 1 архитектурное наследие для Stages 2-6: orthogonal-policy паттерн зафиксирован — каждая новая ось (approvals / budgets / role-based) может быть либо отдельным `*POLICY_REASONS` set'ом со своим reverse-test, либо расширением существующего `POLICY_GATE_REASONS` (с обновлением frozen reverse-test в том же PR). Choice per stage TBD на момент старта.

### 2026-04-29 — Stage 1 implementation summary

`createClarificationPolicy({cfg})` factory + `CLARIFICATION_POLICY_REASONS = ['ambiguity_resolved_by_intent']` (orthogonal к `POLICY_GATE_REASONS`). Matcher проверяет `SemanticIntent.target.kind === 'workspace'` ИЛИ `intent.constraints[<curated structural keys>]` несёт local-маркер AND `blockingReasons` содержит deployment-target-related reason. Downgrade transformation: `taskContract.primaryOutcome='answer'`, `interactionMode='respond_only'`, `lowConfidenceStrategy=undefined`. Trace marker `clarificationPolicy.downgradeReason='ambiguity_resolved_by_intent'`. Kernel-derived path priority: clarification gate НЕ вмешивается когда `productionDecision === kernel-derived`.

Curated keys: `LOCAL_DEPLOYMENT_KEYS = ["hosting","deploymentTarget","executionTarget"]`; `LOCAL_DEPLOYMENT_VALUES = {"local","localhost","local_machine"}`; `DEPLOYMENT_BLOCKING_REASON_PATTERNS = ["publish target","deployment target","production target","without an explicit publish target"]` (classifier output, не user input — invariant #5 не нарушен).

---

**Stop gate:** GRANTED via blanket authorization 2026-05-05. Slice-implementer loop runs autonomously. Phase 10 acceptance gates production deployment + cutover-4 unblock.
