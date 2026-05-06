---
name: Cutover-4 — repo_operation effects routing through AffordanceRegistry
slice: cutover-4-repo-operation
status: in_progress
signoff: GRANTED via blanket authorization 2026-05-05
overview: "Cutover-4 routes `repo_operation.completed`-family effects (broader workspace mutation: branch ops, multi-file commits, merges, repo-state queries) through commitment-kernel `AffordanceRegistry` — narrower than artifact `code_patch.applied` (Cutover-3 P7 already flipped) but broader in blast radius (whole-tree git state). Slice introduces new `repo` effect-family with `update`/`create`/`observe`/`cancel` operationKinds, four affordances (`repo.branch_created`, `repo.commit_landed`, `repo.merge_completed`, `repo.diff_observed`), corresponding done-predicates over NEW `WorldStateSnapshot.repo` slice populated by `RepoWorldStateObserver`, runtime adapter `repo-runtime-adapter.ts` outside frozen layer, emit sites at every git-command-issuing surface (NEW invariant: «no direct `execFile('git', ...)` outside gated adapter»), and `cutoverPolicy` extension on `CUTOVER_2` (in-place naming precedent from Cutover-3). **Hard dependency on PolicyGate Full** (landed this session per master §0 row 2026-05-06): repo-operation turns are higher-risk than artifact, so Phase 6 MUST consult ApprovalPolicy (`repo.merge_completed` requires per-tenant approval), BudgetPolicy (per-channel commit-count cap), RolePolicy (only `maintainer` role can perform `repo.merge_completed` on protected branches), RetryPolicy (transient-failure retry for `repo.diff_observed` only — never auto-retry mutations), EscalationHook (denial fan-out). Risk tiers: `repo.diff_observed` low (read-only); `repo.branch_created`/`repo.commit_landed` medium; `repo.merge_completed` high (history-altering on protected refs). Slice closes cutover sequence in master §16; v1 commitment-kernel demo-ready end-to-end."
todos:
  - id: c4-phase-1-audit
    content: "Phase 1 — Audit (read-only). Output `extensions/AUDIT-cutover4-repo-operation.md`. Map: (a) every existing direct git invocation — `src/platform/session/workspace-probe.ts:103,109` (read-only probe; grandfathered orchestrator-internal); `src/infra/update-runner.ts:522,734,791` (self-update; grandfathered, predates kernel); test files (test-only). (b) Confirm NO existing user-facing git/exec_shell tool wrapper at `src/agents/tools/` (slice ships FIRST one as gated `repo-tool.ts`). (c) `EFFECT_FAMILY_REGISTRY` 5 entries → add `repo` (Cutover-2/3 precedent). (d) `WorldStateSnapshot` slices `sessions, artifacts, workspace (empty stub), deliveries, webEvidence` → NEW `repo` slice (orthogonal to `workspace` stub per Cutover-3 §2.4 precedent). (e) `CUTOVER_2` 8 entries → Phase 7 extends in-place (Cutover-3 precedent; comment lines 42-43 explicitly anticipates). (f) `EpisodicEffectFamily` 10 members → add `repo` + `RepoOperationCompletedPayload` (mirrors `ArtifactCreatedPayload` shape). (g) `IntentContractor` allowlist 4 families → Phase 8 adds `repo`. (h) PolicyGate Full integration audit: confirm Stages 2-6 readers landed; enumerate evaluation chain `affordance → approval → budget → role → retry → escalation`. (i) NEW invariant proposal: «no direct `execFile('git', ...)` outside gated `runRepoCommand` in `repo-runtime-adapter.ts`» — enumerate grandfathered sites exactly."
    status: pending
  - id: c4-phase-2-effect-family-and-payload-shapes
    content: "Phase 2 — Extend `EFFECT_FAMILY_REGISTRY` additively. NEW `REPO_EFFECT_FAMILY = 'repo'` + entry `{id, displayName: 'Repository operation', allowedOperationKinds: ['create','observe','update','cancel']}`. NEW EffectIds: `REPO_BRANCH_CREATED_EFFECT='repo.branch_created'`, `REPO_COMMIT_LANDED_EFFECT='repo.commit_landed'`, `REPO_MERGE_COMPLETED_EFFECT='repo.merge_completed'`, `REPO_DIFF_OBSERVED_EFFECT='repo.diff_observed'`. NEW `EpisodicEffectFamily` member `'repo'` + `RepoOperationCompletedPayload = {repoOperationId, kind, branchName?, commitSha?, occurredAt}` — additive discriminated-union extension at `src/platform/memory/episodic-memory-event.ts` (slice E P2 / Cutover-3 P2 precedent — `assertNeverEpisodic` exhaustiveness lock-step). Tests: registry frozen + push throws; family present exactly once; allowedOperationKinds exact; 4 EffectIds distinct. Cutover-2/3 precedent. 5 frozen contracts byte-identical."
    status: pending
  - id: c4-phase-3-world-state-repo-slice
    content: "Phase 3 — Add `WorldStateSnapshot.repo` slice. NEW `RepoOperationRecord = {repoOperationId, kind, branchName?, commitSha?, baseSha?, mergeBaseSha?, filesChanged?, insertions?, deletions?, repoRoot?, observedAt}`. NEW `RepoWorldState = {records}`. Extend `WorldStateSnapshot.repo?: RepoWorldState` (additive). NEW process-scoped `RepoWorldStateObserver` (mirrors `artifact-world-state-observer.ts` from Cutover-3 PR-#197 — same per-(sessionId, turnId) keying, last-writer-wins on `repoOperationId`, `perTurnLimit=8`). Wired into `createDefaultMonitoredRuntime`. Zod `repoOperationRecordSchema.strict()` with ISO-8601 + sha regex; collector parses on each call. Tests: round-trip; per-turn reset; limit enforcement; sessionId isolation; last-writer-wins; kind-mismatch reject; malformed sha reject. Frozen layer additive only."
    status: pending
  - id: c4-phase-4-affordance-registry-extend
    content: "Phase 4 — 4 affordances + 4 done-predicates + 2 preconditions. NEW preconditions: `REPO_ROOT_AVAILABLE_PRECONDITION` (resolves `{repoRoot, gitBinaryAvailable}`); `BRANCH_NAME_VALID_PRECONDITION` (resolves proposed branch name vs existing branches via runtime adapter). Affordances: (1) `REPO_BRANCH_CREATED_AFFORDANCE_ENTRY` target=workspace, op=create, requiredPreconditions=[both], constraints=[branchName, baseRef, checkoutAfterCreate], riskTier=medium, maxLatencyMs=30_000, maxRetries=0. (2) `REPO_COMMIT_LANDED_AFFORDANCE_ENTRY` target=workspace, op=update, constraints=[commitMessage, filesIncluded, signedOff, author], riskTier=medium, maxRetries=0. (3) `REPO_MERGE_COMPLETED_AFFORDANCE_ENTRY` target=workspace, op=update, constraints=[sourceBranch, targetBranch, strategy, fastForward, squash], riskTier=high (Phase 6 PolicyGate Stage 4 enforces maintainer role on protected refs), maxLatencyMs=120_000, maxRetries=0. (4) `REPO_DIFF_OBSERVED_AFFORDANCE_ENTRY` target=workspace|unspecified, op=observe, constraints=[baseRef, headRef, pathFilter, includeStatus], riskTier=low (read-only), maxRetries=1. NEW done-predicates `done-predicate-repo-*.ts` reading `state.repo?.records` for matching kind+repoOperationId from delta. Closed missing-key set: `repo.slice_absent` / `repo.records.empty` / `repo_record_missing:<id>` / `repo_record_kind_mismatch:<id>:<expected>:<actual>`. NEVER throws. Tests: registry extended, `findByFamily('repo', target, op)` resolves correctly per shape; branching factor >1 (canary preserved); per-predicate ~8 cases incl. invariant #9 sentinel-proxy."
    status: pending
  - id: c4-phase-5-runtime-adapter-and-emit-sites
    content: "Phase 5 — Runtime adapter + emit sites + new lint rule. NEW `src/agents/pi-embedded-runner/run/repo-runtime-adapter.ts` (mirrors Cutover-3 `artifact-runtime-adapter.ts`): `recordRepoOperation({collector, sessionId, turnId, kind, branchName?, commitSha?, baseSha?, mergeBaseSha?, filesChanged?, insertions?, deletions?, repoRoot?, repoOperationId?})`. Closed failure set: `transport_error`/`repo_root_missing`/`kind_unsupported`/`observer_unavailable`/`git_binary_unavailable`/`branch_name_invalid`. NEVER throws (#15 defense-in-depth). NEW gated `runRepoCommand({kind, args, repoRoot, timeoutMs, logger})` — ONLY sanctioned path for user-facing git invocation per NEW invariant; uses `node:child_process` `execFile` with `windowsHide: true`. NEW thin gated tool wrapper `src/agents/tools/repo-tool.ts` accepts CLOSED `kind` enum + per-kind structured args (NOT free-form shell strings — invariant #5/#6). Calls `runRepoCommand` → `recordRepoOperation` after success. Existing `apply_patch` (Cutover-3 P5) intact for single-hunk; multi-file refactor commits via `repo-tool.ts kind='commit_landed'`. NEW `recordRepoOperationOnCommitmentSatisfied.ts` (sibling of slice E/F/Cutover-3 hooks). Wired through `memory-wiring.ts` fan-out. NEW lint rule `lint:commitment:no-direct-git-outside-adapter` enumerates grandfathered sites exactly. Frozen layer untouched (all in `src/agents/pi-embedded-runner/run/` + `src/agents/tools/`). Tests: adapter round-trip, closed failure set, tmp-dir git fixtures (init/commit/branch/merge/diff); per-kind tool execution; hook ~11 cases mirroring slice E/F/Cutover-3 P5; lint rule reverse-test enumerates allow-list."
    status: pending
  - id: c4-phase-6-policy-gate-full-integration
    content: "Phase 6 — PolicyGate Full integration (Stages 2-6). Hard dependency on PolicyGate Full landed this session. Evaluation chain on every repo turn: `affordance allowlist → approval (Stage 2) → budget (Stage 3) → role (Stage 4) → retry (Stage 5) → escalation (Stage 6) fan-out on any denial`. Stage 2 (Approval): `repo.merge_completed` consults `ApprovalPolicy.evaluate({intent, affordance, identityId})`; config `policy.approvals[]` gains `{effect: 'repo.merge_completed', target: {protectedBranches: ['main','master','release/*']}}`. Stage 3 (Budget): per-channel commit-count cap (`policy.budgets.repo.commit_landed.perChannelHourly=5`), per-effect for merge (`1/identity/day`); `repo.diff_observed` exempt or generous. Stage 4 (Role): `policy.roles[<role>].allowedEffects[]` — `maintainer`→all, `developer`→branch_created+commit_landed+diff_observed (no merge), `viewer`→diff_observed only; anonymous→fail-closed. Stage 5 (Retry): `repo.diff_observed` 2 retries with backoff; mutation effects ZERO retries (mutation idempotency unsafe — duplicate branch/commits/partial merges = disasters). Stage 6 (Escalation): any denial fires `escalationHook.fire(...)` with `escalationOrigin: 'repo-operation-policy-denial'`. `RuntimeAttestation.policyDenialReasons?` if PolicyGate P2 added it; else carry in `terminalState`. Tests: per-stage denial fixtures (~5 cases per stage); chain ordering (denial at Stage 2 short-circuits 3/4/5; escalation always fans out). Frozen layer: zero touches (impls landed via PolicyGate Full slice; this phase only ADDS config + wiring — `runTurnDecision` already consumes readers). Defense-in-depth: PolicyGate denial → commitment NOT executed → `commitmentSatisfied=false` with structured reason → `terminalState=policy_denied` + `acceptanceReason='policy_gate_denied:<stage>:<reason>'` (#13 orthogonality preserved)."
    status: pending
  - id: c4-phase-7-cutover-policy-flip
    content: "Phase 7 — `cutoverPolicy` flip: extend `CUTOVER_2` in-place (Cutover-3 precedent). Add 4 entries: `{effect: REPO_BRANCH_CREATED_EFFECT, effectFamily: REPO_EFFECT_FAMILY}` × 4 effects. Production-routing flip: cutover-eligible repo turns → `productionDecision !== legacyDecision` when (a) `desiredEffectFamily=repo`, (b) target.kind=workspace (or `unspecified` for diff_observed), (c) operation.kind matches family, (d) ALL FIVE PolicyGate stages pass (Phase 6), (e) commitmentSatisfied=true via Phase 4 done-predicate over `RepoWorldState`. Bit-identical legacy fallback when cutover-off OR PolicyGate denies. Tests: production-routing contract test (mirrors `run-turn-decision.cutover2.test.ts` + Cutover-3 acceptance) — 4 positive (one per effect) with kernel-derived `productionDecision`; reverse cases — cutover-off → legacy; PolicyGate denial → legacy + `terminalState=policy_denied`; cutoverPolicy reverse-test extended (12 entries, frozen, push throws). Frozen layer additive only."
    status: pending
  - id: c4-phase-8-acceptance-and-live-verify
    content: "Phase 8 — Acceptance + Telegram live-verify + classifier prompt-hint flip. NEW `cutover4-repo-operation.acceptance.test.ts` (~8 cases): (1) «создай ветку feature/X» → kernel-derived `repo.branch_created` turn; (2) «закоммить с сообщением fix bug» → `repo.commit_landed`; (3) «слей feature/X в main» → `repo.merge_completed` AFTER ApprovalPolicy approves AND RolePolicy permits (fixture identity has maintainer role); (4) «покажи git diff» → `repo.diff_observed`; (5) Reverse: viewer-role attempting commit → RolePolicy denies + escalation fires + Telegram structured denial + zero git issued; (6) Reverse: anonymous → fail-closed; (7) Reverse: cutover-off → legacy; (8) Reverse: budget exceeded → BudgetPolicy denies + escalation. **Live-verify (REQUIRED — invariant #15 + handoff)**: gateway restart → operator (maintainer role) sends 4 Telegram prompts: «(1) создай ветку feature/cutover4-test», «(2) добавь README-test.md и закоммить с сообщением 'cutover-4 live verify'», «(3) покажи git diff последнего коммита», «(4) слей feature/cutover4-test в main». live-verifier asserts: (a) `[commitment] repo.* effectFamily=repo decision=kernel productionDecision !== legacyDecision`; (b) `[repo-runtime-adapter] recordRepoOperation kind=branch_created → kind=commit_landed → kind=diff_observed → kind=merge_completed` lines in order; (c) `[policy-gate] event=approval_checked stage=2 effect=repo.merge_completed approved=true`; (d) `[policy-gate] event=role_checked stage=4 role=maintainer allowed=true` for all 4; (e) `[memory-write-on-satisfied] effectFamily=repo wrote=true` per turn (slice E `repo` slot LIT first time); (f) Telegram structured success messages per turn; (g) zero `Provider finish_reason: error`; (h) zero direct git from outside adapter. Reverse runs with viewer/anonymous identities. **IntentContractor prompt-hint flip**: allowlist gains `repo` family (current 4: `persistent_session`, `communication`, `web_research`, `artifact` post-Cutover-3 P8 + Search-Composer 4c → 5 with `repo`). Standalone phase per Cutover-3 / Search-Composer 4c discipline (classifier flip AFTER runtime + affordances + PolicyGate + production routing live)."
    status: pending
isProject: false
---

# Cutover-4 — repo_operation effects routing through AffordanceRegistry

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_master.plan.md` (§8.5 cutover-4 row; §8.5.1 PolicyGate split — full PolicyGate is gating dependency; §16 final direction lock — cutover sequence closure) |
| Inherits | 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc` (NEW structural invariant proposed: «no direct `execFile('git', ...)` outside gated `repo-runtime-adapter.ts`») |
| Predecessors | Cutover-1 (PR-4a #103). Cutover-2 (PR-4b #104). Slices D / E / F / I CLOSED. Cutover-3 Artifacts SLICE COMPLETE this session. **PolicyGate Full SLICE COMPLETE** this session (PRs #196-#210). Search-Composer pipeline COMPLETE (PR #211). Dev SHA `735f65c019` |
| Trigger | Master §16 final direction lock — cutover-4 was last gated cutover in v1 sequence, blocked on full PolicyGate. PolicyGate Full landed 2026-05-06 (this session); cutover-4 unblocked. Closure of cutover sequence: `persistent_session.created` (cutover-1) → chat-bound subset (cutover-2) → artifact bundle (cutover-3) → repo operation (cutover-4) |
| Out of scope | NEW-A/B/C/D (master §0.5.6); Slice K reminder query reading `repo` episodic slot; concurrent broker (PR-MT); bundle-as-contract enforcement; IntentContractor freshness; routing `update-runner.ts` self-update through kernel (predates kernel, gated separately); routing `workspace-probe.ts` git probes (orchestrator-internal); stash/reflog/cherry-pick/rebase/push (future cutover-5); persistent repo-state across /new (slice K may add); Slack/Discord live-verify (Telegram-only); modifying 5 frozen contracts |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05 |

## 1. Hard invariants this slice keeps

- **#1**: `ExecutionCommitment` tool-free. New affordances reference effect ids/target shapes only, NOT tool names.
- **#2**: Affordances selected by (effect + target + preconditions + policy + budgets) only. No phrase matching. `BRANCH_NAME_VALID_PRECONDITION` is structural resolver reading workspace state via runtime adapter, never raw user text.
- **#3**: Production success requires `commitmentSatisfied(...) === true`. Done-predicates over `WorldStateSnapshot.repo` are the gate.
- **#4**: Success requires observed state-after fact. `RepoWorldStateObserver` is read-side; runtime adapter is write-side.
- **#5, #6**: No new readers of raw user text. `repo-tool.ts` schema accepts CLOSED `kind` enum + per-kind structured args (branchName, commitMessage, etc.) — never free-form shell strings. IntentContractor remains sole reader; classifies `desiredEffectFamily=repo` and emits structured `constraints`.
- **#7**: ShadowBuilder accepts `SemanticIntent` only — unchanged.
- **#8**: `src/platform/commitment/` does NOT import from `decision/`. Hook + adapter + tool live in `src/agents/pi-embedded-runner/run/` + `src/agents/tools/` (established bridge boundary, slice E/F/Cutover-3 P5 precedent).
- **#9, #10**: No new done-predicates outside per-affordance pattern. Each predicate sees state/delta/receipts/trace only. Closed missing-key set per Cutover-3 precedent.
- **#11**: 5 frozen contracts BYTE-IDENTICAL. Frozen-layer touches (`effect-family-registry.ts`, `affordance-registry.ts`, `cutover-policy.ts`, `world-state.ts`) all ADDITIVE — Cutover-2/3 precedent.
- **#12**: No emergency phrase patches. Repo-effect classification = structural prompt-hint allowlist flip (Phase 8) + structural `constraints.branchName` binding (Phase 4).
- **#13**: `terminalState` ⊥ `acceptanceReason`. Both populated by runtime adapter on emit + by PolicyGate chain on denial (`terminalState=policy_denied`, `acceptanceReason='policy_gate_denied:<stage>:<reason>'`).
- **#14**: `ShadowBuildResult` typed shape unchanged.
- **#15**: Blanket signoff. Live verify mandatory at Phase 8. Defense-in-depth: adapter failures degrade gracefully (warn + commitment STILL satisfies on observer write); PolicyGate denials short-circuit BEFORE adapter execution.
- **#16**: `EffectFamilyId` ⊥ `EffectId` preserved. PolicyGate brands (`ApprovalRequestId`, `BudgetWindowId`, `RoleId`) preserved.

**NEW structural invariant (Phase 1 audit §i)**: «no direct `execFile('git', ...)` / `spawn('git', ...)` outside gated `repo-runtime-adapter.ts runRepoCommand(...)`». Grandfathered: workspace-probe.ts (predates kernel), update-runner.ts (predates kernel), test-only files. Enforced via NEW lint rule shipped in Phase 5 with reverse-test enumerating allow-list exactly.

## 2. Audit findings (TO BE FILLED IN BY PHASE 1)

> Phase 1 produces `extensions/AUDIT-cutover4-repo-operation.md`. Sketches:

### 2.1. Existing git-command call sites
- `workspace-probe.ts:103,109` (read-only probe) — grandfathered
- `update-runner.ts:522,734,791` (self-update) — grandfathered
- Test files — test-only
- NO existing user-facing `git`/`exec_shell` tool wrapper (slice ships first as gated `repo-tool.ts`)

### 2.2. Family extensions
`EFFECT_FAMILY_REGISTRY` 5 entries → add `repo`. `EpisodicEffectFamily` 10 members → add `repo` + `RepoOperationCompletedPayload`. Cutover-2/3 precedent.

### 2.3. WorldState repo slice
Currently `sessions, artifacts, workspace (empty stub), deliveries, webEvidence`. NEW orthogonal `repo` slice (preserves `workspace` stub for future slices like Slice K).

### 2.4. CutoverPolicy
`CUTOVER_2` 8 entries; comment lines 42-43 anticipates this slice. Phase 7 extends in-place.

### 2.5. PolicyGate Full integration
All 5 policy readers landed via PolicyGate Full this session. Phase 6 ADDS config entries only (no new factories, no new orthogonal `*POLICY_REASONS` tuples).

### 2.6. RuntimeAttestation
PolicyGate Full P2 audit noted optional `policyDenialReasons?` carry-field; if NOT landed, Phase 6 carries via `terminalState=policy_denied` + `acceptanceReason`.

## 3. Hypothesis

Five forces:
1. **Cutover-2/3 precedent** — additive-extension pattern for new effect-families, affordances, world-state slices, cutoverPolicy. Cutover-4 mirrors field-for-field.
2. **PolicyGate Full landing this session** unblocks the slice. Phase 6 consumes existing readers without introducing new ones.
3. **Slice E typed-but-inert artifact slot precedent** — Cutover-3 P5 lit `artifact`; Cutover-4 introduces NEW `repo` member of `EpisodicEffectFamily` lit by THIS Phase 5 hook.
4. **Risk-tier asymmetry** within family — `repo.diff_observed` (read-only, low) vs `repo.merge_completed` (history-altering, high) is >2-step gradient. Per-affordance `riskTier` + per-stage PolicyGate config (Phase 6) — no slice-level shortcut.
5. **NEW structural invariant** — slice is natural place to introduce «no direct git outside adapter» rule because it creates first sanctioned git-command surface.

## 4. Acceptance criteria

1. `repo` effect-family registered with `allowedOperationKinds=['create','observe','update','cancel']`.
2. 4 affordances registered. `findByFamily('repo', target, op)` resolves correctly. Branching factor >1.
3. `WorldStateSnapshot.repo` slice present and populated by observer. Per-(sessionId, turnId) keying; perTurnLimit=8.
4. Done-predicates read structured state/delta/receipts/trace only; closed missing-key set; never throw.
5. PolicyGate Full integration: every repo turn consults all 5 stages in order; denial at any stage short-circuits; escalation always fans out.
6. Production-routing flip: cutover-eligible repo turns → `productionDecision !== legacyDecision` when chain passes + commitment satisfies + cutover-on. Bit-identical legacy fallback when cutover-off OR PolicyGate denies.
7. Slice E `repo` slot LIT: hook emits episodic event on commitmentSatisfied=true.
8. Frozen-layer integrity: 16 invariants reverse-tests pass; 5 frozen contracts byte-identical; NEW lint rule ships with reverse-test enumerating grandfathered sites exactly.
9. `repo-tool.ts` is sole sanctioned user-facing git surface: schema accepts closed `kind` enum + structured args; rejects free-form shell (invariant #5/#6 reverse-test).
10. Live-verify: 4 Telegram prompts succeed end-to-end on maintainer role; reverse runs with viewer/anonymous confirm fail-closed.

## 5. Per-phase tests

- Fail-first per phase.
- No `vi.spyOn` on function under test; spies for clock + injected hooks only.
- Negative case explicit per phase.
- Phase 8 acceptance uses real tmp-dir git repo + real PolicyGate readers.

## 6. Implementation notes

- New file: `src/agents/tools/repo-tool.ts` — FIRST sanctioned user-facing git surface.
- Frozen-layer touches all additive (Cutover-2/3 precedent): `effect-family-registry.ts`, `affordance-registry.ts`, `cutover-policy.ts`, `world-state.ts`.
- NO `intent-contractor-impl.ts` constructor extension (Cutover-3 P6 already added `inboundMediaResolver?`; cutover-4 reuses existing structural seam — repo-effect classification is prompt-only change in Phase 8).
- NO PolicyGate frozen-layer touches in Phase 6.
- Hook lives outside frozen layer: `recordRepoOperationOnCommitmentSatisfied.ts` sibling of slice E/F/Cutover-3 hooks, wired through `memory-wiring.ts` fan-out.
- Producer registry (`src/platform/produce/registry.ts:172-188`) NOT redefined — existing repo_operation entries stay; new `repo-tool.ts` is structured-args alternative, NOT competing producer.
- PolicyGate Full reuse, NOT re-implementation.
- Per-tool emit-site discipline: ONE `recordRepoOperation(...)` call after each successful execution.
- Memory cross-reference via `IdentityId` (slice D); slice K reminder may consume in future.
- Defense-in-depth: post-execution observer write failure → warn + commitment STILL satisfies (observability); PolicyGate denials BEFORE adapter execution → `terminalState=policy_denied` (gating). Orthogonal surfaces.
- NO per-provider hacks (handoff doc forbids).
- NEW lint rule `lint:commitment:no-direct-git-outside-adapter`.

## 7. Maintainer signoff

GRANTED via blanket authorization 2026-05-05. Admin-merge.

## 8. Deferred / out-of-scope

| Item | Why deferred |
| --- | --- |
| NEW-A/B/C/D | Master §0.5.6 — separate sub-plans |
| Slice K reminder reading `repo` episodic slot | Slice K consumer; cutover-4 lights slot |
| Stash/reflog/cherry-pick/rebase/push | Future cutover-5 if demand |
| Persistent repo-state across /new | Observer per-(sessionId, turnId); slice K may add |
| Routing `update-runner.ts` through kernel | Predates kernel, gated separately |
| Routing `workspace-probe.ts` through kernel | Orchestrator-internal |
| Bug A.2/F | Slice I follow-up / TBD |
| Concurrent broker (PR-MT) | v2 |
| Bundle-as-contract enforcement | Separate slice |
| IntentContractor freshness/recency | Separate slice |
| Slack/Discord live-verify | Telegram-only |
| Cross-tenant repo registry | v2 |

## 9. Handoff Log

(Empty — filled by handoff-writer post-phase-merge.)

## 10. References

- Master plan: `.cursor/plans/commitment_kernel_v1_master.plan.md` (§8.5 cutover-4; §8.5.1 PolicyGate split; §16 final direction lock; §0 row 2026-05-06)
- Cutover-3 sub-plan (structural template): `.cursor/plans/commitment_kernel_cutover3_artifacts.plan.md`
- Cutover-2 sub-plan: `.cursor/plans/commitment_kernel_pr4_chat_effects_cutover.plan.md`
- PolicyGate Full sub-plan (closure dependency): `.cursor/plans/commitment_kernel_policy_gate_full.plan.md`
- Slice E/F templates
- Hard invariants `.cursor/rules/commitment-kernel-invariants.mdc`
- AffordanceRegistry, EFFECT_FAMILY_REGISTRY, WorldState, CutoverPolicy, IntentContractor (all in `src/platform/commitment/`)
- EpisodicEffectFamily `src/platform/memory/episodic-memory-event.ts`
- Slice E/F/Cutover-3 hook precedents `src/agents/pi-embedded-runner/run/`
- Cutover-3 runtime adapter precedent `artifact-runtime-adapter.ts`
- Cutover-3 observer precedent `artifact-world-state-observer.ts`
- PolicyGate readers `approval-policy.ts` / `budget-policy.ts` / `role-policy.ts` / `retry-policy.ts` / `escalation-hook.ts`
- Memory wiring fan-out `src/platform/decision/memory-wiring.ts`
- Producer registry `src/platform/produce/registry.ts:172-188`
- Existing direct-git sites (grandfathered): `workspace-probe.ts:103,109`, `update-runner.ts:522,734,791`
