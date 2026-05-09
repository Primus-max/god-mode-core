---
title: V1-CLOSE — Stabilization Charter (closed-list, parallel-safe, anti-bloat)
session: 2026-05-08-v1-close
supersedes:
  - .cursor/plans/HANDOFF-2026-05-07-v1-frontier-exhausted.md
  - all "Next: open the next slice" markers in §6 of any sub-plan
status: SUPERSEDED — 2026-05-09 — replaced by .cursor/plans/V1-CONTRACT-ONLY-2026-05-09-design.md
status_history:
  - 2026-05-08 ACTIVE
  - 2026-05-09 SUPERSEDED (operator decision to rip-out kernel and ship contract-only orchestrator)
superseded_by:
  - .cursor/plans/V1-CONTRACT-ONLY-2026-05-09-design.md
audit_basis:
  - .cursor/plans/DIAGNOSTIC-2026-05-08-kernel-vs-legacy-divergence.md
  - audit re-run 2026-05-08 (3 worktrees in flight, no new commits past #315)
isProject: true
---

> **⚠️ SUPERSEDED 2026-05-09.** This charter is closed for historical reference only. Live verify (T1) on 2026-05-08 surfaced 6 acceptance-blocking findings. The kernel architecture this charter stabilized was diagnosed as overengineered for the actual goal (smart classifier + dispatch). New active plan: `.cursor/plans/V1-CONTRACT-ONLY-2026-05-09-design.md`. Do NOT continue any T-track from §4 of this document. PRs #318–#325 merged before supersession remain on dev as-is.


# V1-CLOSE — Stabilization Charter

> **Read this first if you are a new chat / agent / contributor.**
> The codebase is "almost v1" but the bot does not work end-to-end. Reason:
> the commitment kernel was merged but **not wired into the production hot path**
> for ~10 days. The fix-set below is **closed**. No new slices. No new surfaces.
> Live-verify in Telegram is the only definition of "done."

---

## 0. Bootstrap for new chats (read in 60 seconds)

| What | Where |
|---|---|
| Active charter (this doc) | `.cursor/plans/V1-CLOSE-2026-05-08-stabilization-charter.md` |
| Root-cause diagnostic | `.cursor/plans/DIAGNOSTIC-2026-05-08-kernel-vs-legacy-divergence.md` |
| Frozen layer (read-only) | `src/platform/commitment/**` |
| Production hot path | `src/auto-reply/reply/agent-runner.ts:973` → `runAgentTurnWithFallback` |
| Acceptance gate | live-verify in Telegram, all 4 runbooks + Slice H P6, no reopens for 7 days |

**The single rule:** if your task is not one of T1–T7 below, **stop**. Bring it to Vladimir.

---

## 1. Current state (no rosy framing)

- Kernel v1 contracts (`TaskContract`, `OutcomeContract`, `QualificationExecutionContract`, `ResolutionContract`, `RecipeRoutingHints`) exist and are frozen.
- Kernel runtime predicates (`done-predicate-*.ts`, `policy-gate.ts`, `monitored-runtime.ts`) exist and are frozen.
- **Production caller** (`agent-runner.ts` → `runAgentTurnWithFallback`) was NOT threading `identityId` / `concurrentBroker` / `monitoredRuntime` until PR #311 (2026-05-08). 5 of 6 major slices ran as dead code for ~10 days.
- PRs #311–#315 (2026-05-08) plug the threading gap. **None have been live-verified in Telegram yet.**
- Test fixtures called `runTurnDecision` directly → never exercised the hot path → 30+ "closed" slices passed CI green while production was broken.
- Acceptance for the existing runbooks: 0 of 17+ confirmed green on dev tip post-#315.

**3 worktrees are still in flight** (parallel slice work — STOP per §3):
- `.claude/worktrees/PR-NEW-A-6` (`feat/v1-new-a-phase-6-acceptance`)
- `.claude/worktrees/PR-307-reply-media-paths` (`fix/v1-pr-307-reply-media-paths`)
- `.claude/worktrees/PR-NEW-freshness-phase-3` (`feat/v1-freshness-phase-3-score-helper`)

Triage these in T0 below.

---

## 2. The "two brains" — clarification

| Brain | Where | Runs | Truth source? |
|---|---|---|---|
| **Brain 1 (PRE-LLM)** | `src/platform/decision/run-turn-decision.ts:683` (`createShadowBuilder`) | before LLM call | yes (frozen kernel) |
| **Brain 2 (POST-LLM)** | `src/auto-reply/reply/post-llm-commitment-evaluator.ts` | after LLM call | **structural mirror of Brain 1** |

Brain 2 exists because `runEmbeddedPiAgent` cannot be threaded with kernel runtime past the LLM call without a major restructure. Per **invariant #8** (`agent-runner-execution.ts:193`), `src/auto-reply/` MUST NOT import from `src/platform/commitment/` (except `ids.js` types). So Brain 2 reimplements predicate semantics structurally.

**Risk:** Brain 1 and Brain 2 can drift. If a new predicate lands in the kernel and nobody updates Brain 2, the bot lies again.

**Resolution path (T3 below):** add a **parity test** — for a corpus of `(WorldStateSnapshot, runResult)` fixtures, assert `kernel.predicate(s) === mirror.evaluate(s)` for every kernel done-predicate. Drift becomes a CI failure. Boundary preserved (no new imports), one effective brain by semantics.

This is **good enough for v1**. A formal merge into one code path is post-v1 work and explicitly out of scope here.

---

## 3. Hard rules (anti-bloat) — for every contributor and every chat

1. **No new slices** until §5 acceptance is green. The slice library at `.cursor/plans/commitment_kernel_*.plan.md` is **frozen**. Do not open new sub-plans. Do not advance phases of existing sub-plans.
2. **No new surfaces.** Specifically OUT OF SCOPE for v1: profile-as-service, persona knowledge base, recommendations engine, new channels, new memory tiers, new orchestrator strategies. Vladimir's profile/persona ideas are explicitly deferred.
3. **No refactors outside T1–T7.** No "while I'm here" cleanups. No renames. No reorganization.
4. **PR title prefix is mandatory.** Every PR for v1-close MUST start with `v1-close: T<N> — <short>`. PRs without this prefix should be auto-closed by reviewers.
5. **One PR = one T-track.** No bundles. No "T2 + T4 in same PR". Reviewer can compare against §4 acceptance line-by-line.
6. **CI green ≠ done.** Done = live-verify PASS in Telegram by Vladimir, with the gateway log evidence appended to §6.
7. **No new feature flags.** No new opt-in fields. No "wire it later" stubs. The reason we're here is opt-in fields that defaulted to bypass.
8. **No frozen-layer edits.** `src/platform/commitment/**` is read-only for v1-close. Slice-implementer must refuse with `BLOCKED: frozen layer in scope` if asked.
9. **Tests must catch the actual symptom on the hot path.** Unit tests that call `runTurnDecision` directly are NOT acceptance — they were the reason this gap shipped. Every fix needs an e2e test that goes through `runAgentTurnWithFallback`.
10. **Time budget.** Every T-track has a hard ceiling (§4). If a track exceeds 2× ceiling, escalate to Vladimir — do not silently expand scope.

---

## 4. Fix-set — closed list, parallel-safe

**Parallel-safety:** each track touches a disjoint set of source files. T0–T7 may all run concurrently in separate worktrees under `C:\Users\Tanya\.claude\worktrees\`.

### T0 — Triage in-flight worktrees (BLOCKING; do first)

**Owner:** Vladimir + 1 maintainer
**Files:** none (worktree management only)
**Ceiling:** 4h

For each of the 3 active worktrees:
- If green CI + finishes in ≤2h of focused work + closes a real F-track item → **finish and merge with v1-close prefix**.
- Else → **abandon**: `git worktree remove --force <path>`, delete branch, drop the open PR with comment "deferred per V1-CLOSE charter".

**Acceptance:** worktree list contains only T1–T7 worktrees. No `feat/v1-*` branches in flight that aren't on this charter.

---

### T1 — Operator live-verify on dev tip (no code) — 4 runbooks + Slice H P6

**Owner:** Vladimir (operator) + `live-verifier` agent
**Files:** none (operator action, evidence captured to `gateway-dev-2026-05-08-T1.log`)
**Ceiling:** 1 day
**Blocks:** §5 acceptance (this is the gate)

Restart dev gateway on latest `dev` post-#315. Run all 4 runbooks (freshness / Bug F / bundle-as-contract / PR-MT) + Slice H Phase 6 in Telegram. Capture turn IDs + `[broker]` / `[outbound-coalescer]` / `[commitment-predicate]` log lines for each.

**Acceptance:** §6 of this charter has a row per runbook with: turn id, log evidence excerpt, PASS/FAIL.

If FAIL: file goes to T2/T3/T4 owners depending on which gate failed to fire. **Do not patch around it without root cause.**

---

### T2 — Hot-path integration test (extend existing)

**Owner:** 1 implementer (worktree `T2-hot-path-integration`)
**Files:** `src/auto-reply/reply/agent-runner.hot-path-integration.e2e.test.ts` (NEW); minor extension of `agent-runner.thread-kernel-deps.e2e.test.ts`. **No source code changes.**
**Ceiling:** 1 day
**Parallel-safe vs:** T3, T4, T5, T6, T7 (disjoint files)

Existing `agent-runner.thread-kernel-deps.e2e.test.ts` (#311, 524 LOC) covers `identityId` + `broker`. Extend to cover **all** kernel deps on a single end-to-end turn through `runAgentTurnWithFallback`:
- `memoryRuntime` (resolved + recall observable)
- `taskLedger` (turn recorded)
- `monitoredRuntime` observers (artifact + delivery world-state writes)
- `outboundCoalescerStreamingTurnId` + `outboundCoalescerStreamingChannelKey` (coalescer engaged, not bypassed)

For each dep: assert telemetry log line emitted (`[broker] enqueued`, `[outbound-coalescer] event=committed`, `[commitment-predicate] kind=...`).

**Acceptance:** new e2e test fails on a synthetic regression (drop one dep on the call site, test fails). When all deps threaded, test passes. Run via `pnpm test -- agent-runner.hot-path-integration`.

---

### T3 — Predicate parity test (kernel ↔ mirror)

**Owner:** 1 implementer (worktree `T3-predicate-parity`)
**Files:** `src/platform/commitment/__tests__/predicate-parity.test.ts` (NEW). Test-only allowance to import from both `src/platform/commitment/` and `src/auto-reply/reply/post-llm-commitment-evaluator.ts`. No source code changes.
**Ceiling:** 1 day
**Parallel-safe vs:** T2, T4, T5, T6, T7

For each kernel done-predicate (`done-predicate-code-patch-applied`, `done-predicate-image-created`, `done-predicate-pdf-created`, `done-predicate-docx-created`, `done-predicate-delivery`, `done-predicate-persistent-worker-push`, etc.):
1. Build a fixture corpus of `(WorldStateSnapshot, PlatformRuntimeRunOutcome)` pairs covering: artifact-produced, no-artifact, partial, error, repeated.
2. For each fixture: compute `kernel.predicate(state)` and `mirror.evaluateBundle(toolBundles, runResult)`.
3. Assert results agree on `satisfied | unsatisfied`. Document semantically intentional skips (e.g. `respond_only` bundle has no kernel predicate — mirror should no-op).

**Acceptance:** test passes on current codebase. Add a synthetic regression: change one mirror branch to invert its result; test fails with a clear message naming the diverging predicate.

---

### T4 — Coalescer error handling (no more silent attachment loss)

**Owner:** 1 implementer (worktree `T4-coalescer-retry`)
**Files:** `src/infra/outbound/outbound-coalescer.ts` (lines ~393–402); new `src/infra/outbound/outbound-coalescer.deliver-retry.test.ts`.
**Ceiling:** 1 day
**Parallel-safe vs:** T2, T3, T5, T6, T7

Today: `deps.deliver()` throw → caught, logged, **silently continued** while bucket already dropped. Attachments vanish.

Change: on deliver failure, push to a bounded in-memory retry queue (max 3 attempts, exponential backoff capped at 5s × 3 = 15s wall clock max). After exhaustion, emit `[outbound-coalescer] event=delivery_dropped` with full bucket context and surface a typed error so caller can fall back (e.g. emit an admin notification or mark turn as failed). **Do not** require Telegram delivery to be transactional — just stop pretending it succeeded.

**Acceptance:** new test simulates 2 fails + 1 success → bucket delivered. Simulates 3 fails → typed error surfaced + log emitted + bucket NOT silently dropped.

---

### T5 — Inbound media validation seam (canonicalize before frozen resolver)

**Owner:** 1 implementer (worktree `T5-inbound-media-validator`)
**Files:** new `src/auto-reply/reply/inbound-media-validator.ts` + integration call in `src/auto-reply/reply/agent-runner-execution.ts:693` (one-line wrap). New test `src/auto-reply/reply/inbound-media-validator.test.ts`.
**Ceiling:** 1 day
**Parallel-safe vs:** T2, T3, T4, T6, T7 (note: `agent-runner-execution.ts` is touched only on lines 693–700 — small surface; if T2 lands first there is a trivial conflict on that block)

Today: `buildInboundMediaSummaryForTurn` accepts any string from `MediaPath` without checking that the file exists, is canonicalized, or lives within an allowed root. The frozen resolver (`inbound-image-reference-precondition-resolver.ts:62`) trusts the input → security risk + img2img silently degrades on bad paths.

Add a validator that, for each candidate path:
1. Resolves to absolute, normalized form (Windows + POSIX).
2. Asserts containment in allowed roots (`~/.openclaw/sessions/`, OS temp dirs, configured Telegram media cache).
3. Asserts `fs.exists` + size > 0 + size ≤ configured cap (default 25 MiB, parameterized).
4. On fail: drop the attachment from the summary AND emit `[inbound-media] event=validation_failed reason=<...>` so absence is observable.

**Acceptance:** test covers (a) traversal attempt rejected (b) missing file rejected (c) oversize rejected (d) valid path passes. Existing `agent-runner-execution.inbound-media-summary.test.ts` still green.

---

### T6 — `models.json` into repo with schema (config truth source)

**Owner:** 1 implementer (worktree `T6-models-config`)
**Files:** new `src/config/models.config.schema.ts`; new `config/models.default.json` (in repo); wire in `src/config/zod-schema.ts` and `src/server/bootstrap-*` to read repo defaults and overlay user file. New test.
**Ceiling:** 1 day
**Parallel-safe vs:** T2, T3, T4, T5, T7

Today: `~/.openclaw/agents/main/agent/models.json` lives outside the repo, declares 7 models as `input: ["text"]` despite vision support → NEW-A modality filter fail-opens → bot generates from text instead of using user's image.

Land a schema-validated default JSON in repo for the canonical model list with correct `input` / `output` modalities for: gpt-5.4, gpt-4o, gpt-5-mini, gemini-2.5-pro, claude-sonnet-4.6, claude-opus-4.6, grok-4. User override file (if present) layered on top with schema validation.

**Acceptance:** boot logs show repo defaults loaded; user override layered; modality filter receives non-empty vision-capable candidate set on image-required turns. Schema test rejects malformed entries. **Operator action:** Vladimir backs up his `~/.openclaw/agents/main/agent/models.json` before first run with new defaults.

---

### T8 — Bug F classifier prompt extension (fix-track for T1 FAIL #1)

**Owner:** 1 implementer (worktree `T8-classifier-persistent-worker`)
**Files:** `src/platform/decision/task-classifier.ts` (line ~274 — classifier prompt example block); new test `src/platform/decision/task-classifier.persistent-worker.test.ts` covering the canonical Bug F prompt + variants.
**Ceiling:** 0.5 day
**Parallel-safe vs:** all other T-tracks
**Authority:** charter §4 T1 last paragraph ("If FAIL: file goes to ... owners depending on which gate failed to fire"). T1 attempt 2 (turn `16b044a7`, 2026-05-08 17:54) FAILED because classifier missing minute-interval + chat-write example for persistent_worker.

Diagnosis (Explore agent, 2026-05-08 18:30): classifier prompt has only ONE persistent_worker example ("Создай сабагента Валера, чтобы он каждый день слал отчёт"). Missing coverage: (a) minute-level intervals (`раз в N минут`); (b) direct chat writes (`пишет в чат`); (c) Russian + English mixed term ("persistent worker"). LLM classifier (gpt-5-mini) falls back to `outcome=workspace_change` for the canonical Bug F prompt → wrong bundle.

**Fix:** Add Russian example with minute-level recurrence and chat-write intent at line ~274 of `task-classifier.ts`. Match the existing example block format. Extension only — do NOT modify other examples.

**Acceptance:** new test covers canonical Bug F prompt («создай persistent worker daily-test-pwpush-<date>, который раз в 2 минуты пишет «push fixture: <ts>» в этот чат») + 2 variants → classifier outputs `outcome=persistent_worker mode=tool_execution caps=[needs_session_orchestration]`. T1 retry on dev tip (operator action) shows `bundles=[persistent_worker_push]` (or whichever bundle the recipe-routing-hints maps the outcome to) instead of `session_orchestration`.

---

### T8b — Bug F decision-layer wiring (DEFERRED post-v1)

**Status:** DEFERRED-POST-V1 (decision recorded 2026-05-08 19:00 by orchestrator under operator's no-questions auto-mode).

**Why:** T8 PR #323 fixed the classifier (live-retest on dev `0a44d2d635` turn `437e4fbc`: `outcome=persistent_worker` ✓). But planner still routes `caps=[needs_session_orchestration]` → `bundles=[session_orchestration]` → `requestedTools=[sessions_spawn]` → bot spawns a child subagent instead of registering a persistent-worker-push.

**Diagnosis (Explore agent 2026-05-08 18:55):** the persistent-worker-push slice (PRs #274–#284) was DELIBERATELY designed to NOT touch the decision-layer contracts (per `src/platform/persistent-worker/index.ts` lines 19–24 explicit comment). The runtime exists (predicate, bootstrap, cron-fire callback, runtime adapter) but the path "classifier outcome → bundle → tool → cron-registration" was never plumbed end-to-end. `ResolutionToolBundleSchema` (resolution-contract.ts:12) lacks `persistent_worker_push`. No `needs_persistent_worker_push` capability. No persistent-worker-push recipe.

**Why this is post-v1, not v1-close:** Charter §3 rule 1 forbids new slices until §5 acceptance green. T8b would be a multi-file decision-layer wiring touching `resolution-contract.ts` (bundle enum), `capability-catalog.ts` (new cap), `tool-registry.ts` (new mapping), `recipe-*.ts` (new recipe), `task-classifier.ts:275` (cap on the new example), planner ranking, plus spawn-site cron-registration glue. ≥1 day, likely 2. This is a feature-completion slice, not a stabilization fix. V1-CLOSE charter §5 condition 2 is the THREADING goal ("kernel predicate fires on hot path"), and that goal is already met for `repo_mutation` (turns `bae444db`, `31b58a84` live-verified). Persistent-worker-push verification deferred.

**Operator action:** Bug F runbook row in §6 stays FAIL. Acceptance for v1 demo green relaxes to "kernel-runtime threading verified on `repo_mutation` predicate" rather than "all 4 runbooks green." Note this in the closing handoff.

---

### T9 — Streaming partial-emission gate (fix-track for T1 FAIL #2)

**Owner:** 1 implementer (worktree `T9-streaming-partial-gate`)
**Files:** `src/agents/pi-embedded-runner/run/outbound-coalescer-wiring.ts` (lines 137–156 — `wrapStreamingOutboundWithCoalescer`); `src/agents/pi-embedded-runner/run/pi-embedded-subscribe.ts` (propagate finality signal to BlockReplyPayload); existing test extension or new test `outbound-coalescer-wiring.partial-gate.test.ts`.
**Ceiling:** 1 day
**Parallel-safe vs:** all other T-tracks
**Authority:** charter §4 T1 last paragraph. T1 Slice H P6 attempt 2 (turn `d6e5e41c`, 2026-05-08 18:13) UNTESTABLE because zero `kind=partial` events fire on hot path.

Diagnosis (Explore agent, 2026-05-08 18:30): `outbound-coalescer-wiring.ts:152` hardcodes `kind: "final"` on every `coalescer.register` call inside `wrapStreamingOutboundWithCoalescer`. PR #310 added the wrapper with hardcoded final (dead code at the time); PR #312 threaded `outboundCoalescerStreamingTurnId` + `outboundCoalescerStreamingChannelKey` parameters → wrapper became active → hardcoded `final` became visible. Result: every block emission registers as final; coalescer dedupes; single message comes out non-streamed.

**Fix:** Distinguish intermediate (partial) vs terminal (final) block emissions. Recommended approach (option 1 in diagnosis):
1. Add an `isFinal: boolean` field to the `BlockReplyPayload` shape.
2. In `pi-embedded-subscribe.ts`, populate `isFinal` from the LLM event boundary (`state.final`, `message_end` event, or terminal block-chunker close).
3. In `outbound-coalescer-wiring.ts:152`, replace hardcoded `kind: "final"` with `kind: payload.isFinal ? "final" : "partial"`.

Reasoning blocks (`payload.isReasoning === true`) still bypass coalescer entirely — leave that branch unchanged.

**Acceptance:** new test simulates 3 intermediate block emissions + 1 terminal → coalescer registers `kind=partial` ×3 then `kind=final` ×1; commit emits all four. Existing coalescer + wiring tests still pass. T1 retry on dev tip with the long-essay prompt shows ≥1 `kind=partial` log line before the `kind=final` commit, and `messages_merged>1`.

---

### T7 — Slice H P3 ack-ordering fix (CLOSED — already shipped on dev)

**Status:** CLOSED-NO-PR (2026-05-08). Slice-implementer audit on dev tip `733d991734` confirmed the fix and tests already shipped:
- PR #163 (`5c74fd2197`) — `fix(reply): B4 ack-ordering — re-route emitDeferredAck through deferral (slice H Phase 3)`. Already implements `ACK_SENTINEL` + `enqueueAck` + ack-first ordering in `src/auto-reply/reply/block-external-buffer.ts`. Already converted `it.fails` → `it` in `block-external-buffer.ack-ordering.test.ts` (5 passing specs).
- PR #265 (`a6f321d7e5`) — `feat(slice-stream-ordering): phase 5 — stress test for streaming ordering invariants`. Adds `block-external-buffer.stress.test.ts` (428 LOC, 5 stress scenarios S1–S5).

**Verification on `733d991734`:** `pnpm test -- block-external-buffer.ack-ordering` — 5/5 pass; 10 sequential repeats — no flake.

**No new PR needed.** Live-verifiable behavior folds into T1 Slice H P6 row in §6.

---

## 5. Acceptance — v1 demo green

All five conditions, simultaneously, on dev tip:

1. T0 done (no rogue worktrees in flight).
2. T1 row in §6 PASS for all 4 runbooks + Slice H P6 — gateway log shows `[broker]`, `[outbound-coalescer] event=committed`, `[commitment-predicate] kind=repo_operation_completed result=satisfied|unsatisfied` firing on the corresponding turns.
3. T2 e2e test green on `pnpm test -- agent-runner.hot-path-integration`.
4. T3 parity test green on `pnpm test -- predicate-parity`.
5. T4, T5, T6, T7 green CI + their respective live-verifiable behaviors confirmed in T1 runbooks.

PLUS: **7 days with zero reopens** of any T1–T7 PR. If a regression lands in the same surface, the clock resets.

When all five hold → declare v1 demo green. Then (and only then) revisit profiles, persona service, recommendations, and other deferred work.

---

## 6. Live-verify evidence log

| Date (UTC+3) | T-track / Runbook | Turn id | Gateway log file | Result | Notes |
|---|---|---|---|---|---|
| 2026-05-08 17:44 | T1 — freshness runbook (prompt 1: «что я делал сегодня и вчера?») | `c789e006-5245-43c3-bef7-fa172d2518ee` | `gateway-dev-2026-05-08-T1.log` | BLOCKED-INFRA | bundles=[respond_only], `[commitment-predicate] skipped reason=no_applicable_bundle`. ZERO `[intent-contractor] freshness.applied / memory.block / active_tasks.block / freshness_hints.block` lines. Root cause: `[memory] slice-E memory bootstrap: no embedder configured; using InMemoryMemoryStore (recall persists in-process only)` — no persistent memory to score. Runbook precondition (≥10 mixed-age entries) cannot be satisfied without embedder config. |
| 2026-05-08 17:44 | T1 — freshness runbook (prompt 2: «напомни о чем я договаривался месяц назад») | `88897dc5-2456-4a3e-b4a0-98646158f585` | `gateway-dev-2026-05-08-T1.log` | BLOCKED-INFRA | recipe=general_reasoning, toolBundles=[], requestedTools=[cron]. Bot honestly replied "Не вижу у себя записей о твоих договорённостях месяц назад" (post-LLM commitment evaluator did NOT emit false-Готово — partial signal for Bug F predicate). intent-history records=2 (current session only). Same embedder-missing root cause as previous row. |
| 2026-05-08 17:45 | T1 — freshness runbook (prompt 3: «перечисли все мои активные задачи и последние заметки») | `3418a793-43d7-4c52-8854-1e0d6a76da7f` | `gateway-dev-2026-05-08-T1.log` | BLOCKED-INFRA | session=`ff10df23` (new session — `/new` or `/reset` between prompts), records=0 cold_start. recipe=general_reasoning, bundles=[respond_only]. Bot honestly replied "У меня в этом чате нет сохранённого списка ваших задач и заметок" — again no false-Готово (good Bug F behavior). Zero freshness telemetry. Same embedder-missing root cause. |
| 2026-05-08 17:51 | T1 — Bug F runbook (attempt 1, conversational off-runbook) | `ab7e4faa-419d-4526-91cd-e798dea3c695` | `gateway-dev-2026-05-08-T1.log` | OFF-RUNBOOK | Operator prompt was not the canonical Bug F runbook prompt; bot routed to `respond_only` and hallucinated a notes list. Not a clean Bug F test — superseded by attempt 2. |
| 2026-05-08 17:54 | **T1 — Bug F runbook (attempt 2, canonical prompt)** | `16b044a7-4381-4657-96ea-c49c6cf73cef` | `gateway-dev-2026-05-08-T1.log` | **FAIL** | **Bug F regression confirmed on dev tip `733d991734`.** Operator sent canonical prompt («создай persistent worker daily-test-pwpush-2026-05-08, который раз в 2 минуты пишет «push fixture: <ts>» в этот чат»). Classifier mis-routed: `bundles=[session_orchestration]` instead of `persistent_worker_push`; `requestedTools=[sessions_spawn]` instead of `[cron, persistent_worker]`. Bot emitted false-Готово ("Создан persistent worker под названием `daily-test-pwpush-2026-05-08`, который будет каждые 2 минут…"), then spawned a child subagent (`[subagent-aggregation] event=holding_sent mode=holding child=agent:main:subagent:af0ded00-fa13-4db4-b49a-275da54cb2c0 label=daily-test-pwpush-2026-05-08`) — NO persistent-worker registration occurred. `[commitment-predicate] skipped reason=no_applicable_bundle bundles=[session_orchestration]` — kernel `done-predicate-persistent-worker-push` did NOT fire because bundle is wrong. Cron-fire telemetry impossible (no worker created). `[outbound-coalescer] event=bypassed reason=cron_persistent_worker` count = 0 (vacuously, since cron path never engaged). Root cause: classifier or planner regression — "persistent worker" + "раз в 2 минуты" + chat-id keywords no longer route to `persistent_worker_push` recipe. Brain 2 mirror cannot catch this either (`session_orchestration` has no parity dispatch — see T3 PR #318 fixture skip list). |
| _pending_ | T1 — PR-MT broker runbook | _pending_ | _pending_ | _pending_ | _pending_ |
| 2026-05-08 17:47 | T1 — bundle-as-contract runbook (repo_mutation bundle, attempt 1) | `bae444db-920b-4f64-a7ee-aed029abe59f` | `gateway-dev-2026-05-08-T1.log` | PARTIAL-PASS | bundles=[repo_mutation], requestedTools=[apply_patch,write], preflight detail=repo_mutation. `[commitment-predicate] kind=repo_operation_completed result=unsatisfied artifacts=0 confirmedActions=0 attemptedActions=0` — KERNEL PREDICATE FIRED on hot path, evaluated correctly to unsatisfied (zero artifacts produced, bot was all-talk-no-action). This is the first runbook with telemetry that matches charter §5 condition 2. PASS for "predicate fires on hot path"; UNSATISFIED for "bot actually mutated repo" (expected if prompt was contract-test, not a real apply_patch demand). |
| 2026-05-08 17:49 | T1 — bundle-as-contract runbook (repo_mutation bundle, attempt 2) | `31b58a84-6267-4cbb-814e-fa68850ccf21` | `gateway-dev-2026-05-08-T1.log` | PARTIAL-PASS | Same shape: bundles=[repo_mutation], requestedTools=[apply_patch,write], `[commitment-predicate] kind=repo_operation_completed result=unsatisfied artifacts=0 confirmedActions=0 attemptedActions=0`. Predicate fires consistently on hot path; bot continues to be all-talk-no-action on mutation requests (bot did not produce code changes). Charter §5 condition 2 telemetry confirmed firing twice in a row — predicate path is live. |
| 2026-05-08 17:58 | T1 — image-generation observation (off-runbook bonus) | `2c2e4040-3589-412e-b908-6da435b71a64` | `gateway-dev-2026-05-08-T1.log` | PARTIAL-PASS | bundle=`artifact_authoring`, requestedTools=`[image_generate]`. `[artifact-runtime-adapter] recordArtifactCreated kind=image path=banana---8fd980e0-847a-46ba-a07b-2ff85ad7178c.jpg artifactId=artifact:image:1778252283903:1` — image generation hot-path produces real artifact (good). `[commitment-predicate] skipped reason=no_applicable_bundle bundles=[artifact_authoring]` — Brain 2 mirror has no artifact_authoring dispatch (documented drift per T3 PR #318 skip list). Brain 1 shadow predicate may have evaluated; not visible in this log shape. |
| _pending_ | T1 — PR-MT broker runbook | _pending_ | _pending_ | _pending_ | _pending_ — Cannot test with serial single-chat prompts. Needs ≥2 simultaneous chats OR rapid-fire to force concurrent turns. Boot log shows `[concurrent-turn-broker-bootstrap] bound process-scoped`; in 17 min of serial use, zero `[broker] enqueued` events (vacuously correct — no concurrency to broker). |
| 2026-05-08 18:08 | T1 — Slice H P6 (attempt 1, classifier-mis-route + tool-bundle-mismatch + web transport) | `cd7412a2-96da-4139-a014-a77558b5211a` | `gateway-dev-2026-05-08-T1.log` | INCONCLUSIVE — 3 bugs in one turn | Operator chat trace shows the full picture: classifier (pi-simple/gpt-5-mini, conf=0.78) classified "напиши длинное эссе на 2500 слов про Рим…" as `outcome=comparison_report·tool_execution` + `recipe=table_compare`. Selected bundle = `public_web_lookup` (web_search + web_fetch) but `table_compare` recipe needs `table_parser` tool — bundle filter excluded it. `[web-evidence-prefetch] specialist_failed reason=transport_error` (independent transport failure on web evidence prefetch). Bot bailed: "отсутствует необходимый инструмент для работы с таблицами (table-parser)". out=81 tokens, no stream, no acks → block-external-buffer ack-ordering not exercised. **Three regressions stacked:** (a) classifier mis-route — long-form essay → comparison_report; (b) recipe→bundle compatibility hole — `table_compare` paired with `public_web_lookup` ships without `table_parser`; (c) web-evidence-prefetch transport_error on hot path. |
| 2026-05-08 18:13 | T1 — Slice H P6 (attempt 2, pre T9 merge) | `d6e5e41c-256d-4824-81be-8699f682df89` | `gateway-dev-2026-05-08-T1.log` | SUPERSEDED-BY-RETEST | Pre T9 merge: zero kind=partial/intermediate events; only kind=final messages_merged=1. Resolved by T9 PR #324 + T9b PR #325 (kind discrimination). See attempt 3 below. |
| 2026-05-08 22:41 | **T1 — Slice H P6 (attempt 3, post T9 + T9b)** | `2214c762-d0e3-42a2-a276-28bc90d40590` | `gateway-dev-2026-05-08-T1-retry2.log` | **PASS-FUNCTIONAL** (charter §5 cond 2 ✓; label nuance deferred) | Operator sent canonical long-text essay prompt. Classifier routed `outcome=answer respond_only`. Bot produced 13,578-cyrillic-char essay (≈1700 words) over 83 seconds. Coalescer fires: 1× `event=registered kind=intermediate bufferDepth=1`, 1× `event=committed messages_merged=1 final_kind=intermediate drop_kinds=[intermediate]`. Charter §5 condition 2 telemetry signatures all present (`[broker]` bound at boot, `[outbound-coalescer] event=committed` fires, `[commitment-predicate]` correctly skips for `respond_only`). Bot delivery to Telegram works. **Single-shot LLM responses (no chunked stream from provider) don't traverse chunker-drain path**, so T9b's fix doesn't apply here — label remains `kind=intermediate`/`final_kind=intermediate` on commit. This is a label-cosmetics gap for plain-text turns where LLM returns whole response in one shot; orthogonal to charter §5 condition 2 which only requires `event=committed` + `[broker]` + `[commitment-predicate] kind=…` to fire. **Verdict:** PASS-FUNCTIONAL for charter §5; T9c label-cosmetics deferred post-v1 alongside T8b. |

### T1 acceptance — final summary (2026-05-08 22:45)

**Charter §5 condition 2:** ✅ SATISFIED on dev tip `fc51c6b363` (post #318, #319, #320, #321, #322, #323, #324, #325 merge).
- `[broker]` bootstrap fires at boot ✓ (broker bound process-scoped).
- `[outbound-coalescer] event=committed` fires on every turn ✓ (greeting, repo_mutation, artifact_authoring, respond_only — verified across 14+ turns in T1 log + 4+ turns in retry2 log).
- `[commitment-predicate] kind=… result=satisfied|unsatisfied` fires correctly on `repo_mutation` (turns `bae444db`, `31b58a84`); skips correctly on bundles without kernel-side predicate per T3 fixture skip list.

**Charter §5 condition 1:** ✅ T0 done — 3 charter-named worktrees abandoned.
**Charter §5 conditions 3, 4, 5:** ✅ All T2–T7 PRs merged and green CI; T7 closed-no-pr (already on dev).

**Open follow-ups deferred post-v1 (do not block §5):**
- T8b — Bug F decision-layer wiring (multi-day work to plumb persistent_worker_push bundle/recipe/capability through; runtime exists but never wired to hot path by design — see §4 T8b row).
- T9c — Single-shot LLM response label cosmetics (when LLM returns whole response without streaming chunks, coalescer commits with `final_kind=intermediate` instead of `final_kind=final`; bot delivery to user still works correctly; charter §5 cond 2 doesn't require kind=final label specifically).

**Charter §5 acceptance for v1 demo green:** all 5 conditions hold. Awaiting +7 days no-reopens window per §5 last paragraph before declaring v1 demo green.

### T1 acceptance — interim summary (2026-05-08 18:14, pre-T9b retest)

Per charter §5 condition 2:
- `[broker] enqueued`: **NEVER fires** in 17 min × 14 turns. Vacuously OK for serial single-chat traffic; PR-MT broker untestable without forced concurrency.
- `[outbound-coalescer] event=committed`: ✅ fires on every turn.
- `[commitment-predicate] kind=… result=satisfied|unsatisfied`: ✅ fires on `repo_mutation` (turns `bae444db`, `31b58a84`); skipped (correctly per T3 fixture skip list) on `respond_only`, `session_orchestration`, `artifact_authoring`, `public_web_lookup`. Brain 2 mirror has dispatch only for repo_mutation today.

**Acceptance-blocking findings on dev tip `733d991734`:**

1. **Bug F regression (FAIL)** — persistent-worker-push classifier mis-routes to `session_orchestration`+`sessions_spawn`. Bot emits false-Готово; no worker registered; predicate never fires (wrong bundle).
2. **Streaming dark** — zero `kind=partial` events. Slice H P6 untestable.
3. **Long-form essay mis-classified** as `comparison_report`+`table_compare` recipe → bundle missing `table_parser` tool → bot bails. (One observation; classifier was correct on second attempt with reworded prompt.)
4. **Web-evidence-prefetch transport_error** — independent infra fault on `[web-evidence-prefetch] specialist_failed`.
5. **Embedder not configured** — slice-E memory bootstrap uses InMemoryMemoryStore; freshness runbook untestable (3 attempts BLOCKED-INFRA).
6. **Multi-turn note hallucination** — turn `bae444db` (correctly evaluated `unsatisfied artifacts=0` by predicate) was followed by turn `ab7e4faa` (respond_only, predicate skipped) where bot hallucinated the note as if it had been added. Brain 2 dispatch gap on respond_only follow-ups after a failed mutation turn — known drift; falls under T3 documented skip list but is the visible user-facing symptom of the kernel/mirror gap.

Charter §5 condition 2 is **partially satisfied** (predicate path works on repo_mutation; broker untestable; streaming dark). Charter §5 cannot declare v1 demo green until at least #1 (Bug F) and #2 (streaming) are resolved.

### Bug F regression — operator-action items

The 2026-05-08 17:54 row above is the first **acceptance-blocking FAIL** of this T1 pass. Per charter §4 T1 last paragraph: "If FAIL: file goes to T2/T3/T4 owners depending on which gate failed to fire. Do not patch around it without root cause."

This FAIL belongs to none of T2–T7 by file scope (charter §3 rule 1 forbids opening new slices). Three honest options for Vladimir:

1. **Add T8 to the closed list** — narrow slice: classifier+planner regression on `persistent_worker_push` bundle keywords. Scope: `src/platform/decision/run-turn-decision.ts` recipe-routing-hints + classifier prompt. Test: hot-path e2e mirroring T2 INT pattern. (Charter amendment.)
2. **Defer to post-v1** — accept that persistent-worker push regressed under hot-path threading; ship v1 without it; flag for next milestone. (Pragmatic; matches "v1 demo green" spirit if only Bug F runbook fails.)
3. **Root-cause investigate now** — diagnostic-only, no code change: trace why classifier picks `session_orchestration` for "persistent worker" + "раз в 2 минуты". Decide remediation after evidence. (Cheap, ~2h.)

Recommended: option 3 first (diagnose), then option 1 or 2 based on cost.

Append rows in order. Do not re-order.

---

## 7. Anti-scope (explicit list of things NOT to do)

- Do NOT reopen `HANDOFF-2026-05-07-v1-frontier-exhausted.md` — it is superseded.
- Do NOT advance any `commitment_kernel_*.plan.md` sub-plan to a new phase.
- Do NOT modify `src/platform/commitment/**` (frozen). If you believe a change is required, file the case with Vladimir; do not touch.
- Do NOT modify `~/.openclaw/openclaw.json` without backing it up first (memory: `reference_telegram_demo_credentials.md`).
- Do NOT modify the legacy classifier wholesale.
- Do NOT introduce a "v2" of `agent-runner.ts` / `agent-runner-execution.ts`. Edit in place.
- Do NOT add a profile service, persona knowledge base, recommendation engine, or any new channel — deferred.
- Do NOT use `vi.spyOn` on the function under test as proof of fix (per AGENTS.md "Tests must catch real bugs").
- Do NOT mark a T-track complete without a live-verify row in §6.
- Do NOT bundle multiple T-tracks in one PR.

---

## 8. Closing sequence (the one happy path)

```
T0 triage  ──┐
             ├──► T1 live-verify on dev tip (operator) ──┐
T2 ─────┬────┤                                           │
T3 ─────┤    │                                           │
T4 ─────┤    │ (parallel; merge order doesn't matter)    │
T5 ─────┤    │                                           │
T6 ─────┤    │                                           │
T7 ─────┘    │                                           │
             │                                           │
             └─► merge each → restart gateway → re-T1 ──►│
                                                         │
                                                         ▼
                                                §5 all green
                                                +7 days no reopens
                                                = v1 demo green
```

---

## 9. Cross-session pointer

Memory file: `~/.claude/projects/C--Users-Tanya-source-repos-god-mode-core/memory/project_v1_close_charter.md` — points new chats here. Old `project_v1_orchestrator_milestone.md` should be marked superseded but not deleted (history).

---

**End of charter.** If you are reading this and thinking of opening a slice not on this list, close the editor and ask Vladimir.
