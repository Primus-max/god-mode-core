---
name: Commitment Kernel v1 — Release Roadmap
overview: "Roadmap of 11 sub-plans that close v1: smart orchestrator with cross-channel memory, multi-task scheduling per user, subagent registry, channel-agnostic session persistence, and the architectural completion of Search-Composer dispatch (closing the Option ε disable-flag pragmatism). Connects evidence-driven UX bug list (B1..B7 from 2026-05-04 Telegram transcript) to the architectural slices that fix them. All slices require maintainer signoff per invariant #15."
todos:
  - id: v1-architecture-signoff
    content: Maintainer signs off on the v1 scope (11 sub-plans below) and the execution order in §3. Without signoff, autonomous /loop pauses (no slice in §4 has authorization).
    status: pending
  - id: v1-bug-evidence-codified
    content: B1..B7 from 2026-05-04 Telegram transcript are evidence anchors for the v1 slices. Each sub-plan's Phase 1 (kickoff) MUST link the bug ID(s) it claims to close and reproduce the symptom in a failing test before fixing.
    status: pending
  - id: v1-slice-1-search-composer-prod-dispatch
    content: A. Search-Composer production dispatch — replace Option ε `disableWebSearchTool` flag with polymorphic dispatch on `isWebResearchFamilyEffect`. Closes G6.c. Removes the prag-fix that hides external web tools by flag and replaces it with the architecturally-clean two-affordance flow that doesn't expose them by design.
    status: pending
  - id: v1-slice-2-bundle-as-contract
    content: B. Bundle-as-contract enforcement at LLM schema layer. Thread `toolBundles` into tool-list construction so the planner's bundle assertion is a contract, not a hint. Closes audit §0.5.1 row 1.
    status: pending
  - id: v1-slice-3-intent-contractor-freshness
    content: C. IntentContractor `freshness` constraint surface. Extend SemanticIntent constraints; route-preflight + prefetch decisions also gate on `intent.constraints.freshness`. Closes audit §0.5.1 row 2.
    status: pending
  - id: v1-slice-4-channel-agnostic-session-persistence
    content: D. Channel-agnostic session persistence. Refactor session keying from `chat_id` (Telegram-specific) to `(channel, externalId, sessionScope)`. Foundation for cross-channel memory. Infrastructure, not feature.
    status: pending
  - id: v1-slice-5-memory-layer
    content: E. Memory layer. Wrap mem0 (Apache 2.0) behind a project interface so it can be swapped later. Two surfaces: episodic (per-user task history, agent registry, reminders) and semantic (recall across `/new`). Closes B1, B3 (memory persistence), feeds B7 (task scheduler context).
    status: pending
  - id: v1-slice-6-task-ledger
    content: F. Per-user task scheduler — TaskLedger. New module mirroring intent-ledger pattern. Persists active+recent tasks per `(channel, externalId)`. Tasks injected into LLM prompt as `<active_tasks>` block. Resolves user references ("отмени", "как там PDF?", "первое") through LLM via IntentContractor. Closes B7.
    status: pending
  - id: v1-slice-7-subagent-registry
    content: G. Subagent registry persistence + reply routing. Subagent metadata (id, label, parent session, status, last activity) persisted to memory (slice 5). Reply routing: subagent's terminal output is routed as subagent's reply attached to its label, NOT as the bot's own reply. Closes B3 (Валера disappeared after /new), B6 (subagent reply mis-attributed).
    status: pending
  - id: v1-slice-8-stream-edit-ordering
    content: H. Stream/edit ordering for external channels. Audit `block-streaming-buffering` (PR-A.2 baseline) for residual cases observed in 2026-05-04 transcript (message edits flicker). Likely fix in `external-channel-buffering` flush ordering at tool_call boundaries when subagent ack races with main reply. Closes B4.
    status: pending
  - id: v1-slice-9-reply-sanitizer
    content: I. Reply sanitizer — English reasoning leak. Internal English meta-text ("Let me check memory for any context") is reaching external channels. Fix in `reply-language` detector or in the assistant-reply layer that emits to channel. Closes B5.
    status: pending
  - id: v1-slice-10-cron-query-surface
    content: J. Cron query / list / cancel surface. Existing `cron` tool can create but not list / inspect / cancel from chat. Add tool surfaces and wire IntentContractor to recognize "напомни список" / "отмени напоминание X" / "что у меня на завтра" patterns. Closes B2.
    status: pending
  - id: v1-slice-11-cutover-3-4-artifact-repo-effects
    content: K. cutover-3 / cutover-4 — artifact effects + repo operation effects via commitment-kernel. Wires PDF / image / git operations through the same effect → affordance → done-predicate flow as chat. Closes audit §0.5.3 cutover rows.
    status: pending
isProject: true
---

# Commitment Kernel v1 — Release Roadmap

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0 PR Progress Log; §0.5 Audit Findings; §16 умный оркестратор vision) |
| Inherits | 16 hard invariants (`.cursor/rules/commitment-kernel-invariants.mdc`); all 6 flexible — without changes |
| Trigger | (a) Search-Composer Phase 4c complete + live-verified at PR-#145 (turn `6d9d80e8`, `gateway-pr145.log`, 2026-05-04). Pickup queue for autonomous work is empty; remaining items require maintainer signoff per invariant #15. (b) Live UX evidence from 2026-05-04 19:38–19:42 Telegram session (B1..B7 below): "он не умный даже после Phase 4c". v1 release requires closing both the architectural debt (Option ε prag-fix) and the UX bugs visible to the user. |
| Out of scope (this roadmap) | (a) PolicyGate Stages 2-6 (approvals/budgets/role-based) — deferred to v2; pairing already covers production access. (b) PR-MT (concurrent broker for multi-USER concurrency) — deferred to v2; v1 covers per-USER multi-task via TaskLedger (slice F), which is a different problem. (c) Web UI — separate roadmap, blocked on stable v1 backend API surface. |
| Maintainer signoff | **REQUIRED** at the level of the whole roadmap (one signoff = approval of v1 scope) AND per-slice on the architectural changes per invariant #15. This document captures the scope so the signoff decision is concrete. |

## 1. Hard invariants this roadmap MUST keep

All 16 invariants from `.cursor/rules/commitment-kernel-invariants.mdc` are in force. Specific call-outs that recur across slices below:

- **#1, #2, #16**: New effects (memory, task, subagent-registry) are added through the EffectFamily registry and Affordance registry, never inline; `EffectId` and `EffectFamilyId` remain distinct branded types.
- **#5, #6**: No new code reads raw user text outside IntentContractor. Reference resolution ("first", "cancel that") is LLM-mediated, not regex.
- **#8**: `src/platform/commitment/` does not import from `src/platform/decision/`. Slices below that touch both layers (E memory, F task-ledger) put the bridge in `src/agents/pi-embedded-runner/` or `src/auto-reply/` per existing convention.
- **#9, #10**: New done-predicates live on Affordance, not on ExecutionCommitment, and read only `state` / `delta` / `receipts` / `trace`.
- **#11**: The 5 frozen contracts stay read-only. Slice A (Search-Composer dispatch) does NOT need to amend them; the dispatch happens at the decision layer over the kernel-derived ExecutionCommitment, not the TaskContract.
- **#15**: Each slice below requires explicit maintainer signoff before the first code commit on its branch.

## 2. Live evidence — bugs B1..B7 from 2026-05-04 Telegram session

Source: 2026-05-04 19:38–19:42 transcript provided by Vladimir.

| ID | Symptom | Root cause hypothesis | Closes via |
| --- | --- | --- | --- |
| **B1** | Memory does not persist across `/new`. After `/new`, bot says: «у меня нет возможности просмотреть список запланированных напоминаний... В памяти тоже ничего о завтрашних напоминаниях не нашлось». | Cross-session memory layer missing. Auto-memory (this Claude Code's) exists; bot's runtime memory doesn't. | E + J |
| **B2** | Cron tool is unidirectional: can `create`, can't `list` / `inspect` / `cancel` from chat. Bot literally says: «доступ к cron-списку из этого чата ограничен только созданием новых напоминаний». | Tool surface gap. Cron tool author exposed only the `schedule` action. | J |
| **B3** | Subagent registry not in memory. Vladimir creates Валера, then in the next session bot says Валера doesn't exist. | Subagent metadata not persisted; query-side missing. | E + G |
| **B4** | Stream/edit out-of-order: «то отправляет сообщение потом удаляет, потом показывает финальное». | Block-streaming flush ordering at tool_call boundaries (residual case past PR-A.2). Possibly racing with subagent ack. | H |
| **B5** | Internal English reasoning leaks to user: «Let me check memory for any context about Vladimir's preferences for agents». | Assistant-reply layer doesn't filter the meta-thinking pre-tool-call text when channel=Telegram. | I |
| **B6** | Subagent reply mis-attributed to bot. After «давай создадим Валера», the next reply is «Привет, Владимир, я ваш новый агент» — that's Валера's first turn, but it surfaces as if the bot said it. | Subagent terminal-output routing: result is delivered into the user channel without the «agent: Валера» framing, reading as if the parent bot said it. | G |
| **B7** | Cannot give a second task while the first is running, or status-query a running one. («Я не должен ждать пока он мне PDF сгенерирует»). | Per-user multi-task scheduling missing. Each turn currently blocks on the prior turn's terminal effect. | F |

**Acceptance for v1 release**: every B1..B7 must have a passing live-verify replay against a fresh gateway log (a turn or sequence of turns that reproduces the original symptom and now produces the correct outcome). Tests must reproduce the symptom in fixture form before the fix lands (per `AGENTS.md` "Tests must catch real bugs").

## 3. Slice catalog — A through K

Each slice listed below will get its own dedicated sub-plan when picked up. This roadmap's purpose is to make the SCOPE + DEPENDENCIES + ACCEPTANCE decisions reviewable in one place. Detailed per-phase decomposition lives in each child sub-plan.

### A. Search-Composer production dispatch (closes G6.c)

| Field | Value |
| --- | --- |
| Sub-plan file | `commitment_kernel_search_composer_prod_dispatch.plan.md` (TBD) |
| Closes | Master §0.5.2 G6.c. Removes the Option ε `disableWebSearchTool` flag pragmatism currently in `attempt.ts` + `params.ts` + `web-evidence-prefetch.ts`. |
| Scope | Replace flag-based filtering with polymorphic dispatch: when `commitment.effect` matches `isWebResearchFamilyEffect`, route through `runWebResearchTurn` (specialist + composer adapters from PR-#137). Composer's tool catalog is constructed from the affordance's `requiredEvidence`/`requiredPreconditions` — `web_search`/`web_fetch`/`browser` are not in catalog by design, not by filter. |
| Files | `src/platform/decision/run-turn-decision.ts` or `src/platform/decision/web-research-dispatch.ts` (caller wiring); deletion of disable-flag plumbing in `src/agents/pi-embedded-runner/run/{attempt.ts,params.ts}`. |
| Tests | (a) Reverse test: feeding a `WEB_RESEARCH_SUMMARIZED_EFFECT` commitment through the new dispatch path, the composer transport never sees `web_search`/`web_fetch`/`browser` in `allowedTools`. (b) Live verify: the same prompt as PR-#145 turn — `recordCount > 0`, no `disableWebSearchTool` in logs, composer output identical or better. |
| Predecessor | None (Phase 4c complete). |
| Risk | The dispatch site at `input.ts` returns `{ productionDecision: TaskContract, intent: SemanticIntent }` and currently doesn't surface ExecutionCommitment beyond the optional `derivedCommitment` field added in PR-#134. Wiring the polymorphic branch may require an additional `RunTurnDecisionResult.directResponse?` or moving delivery into the orchestrator (Path B options from §8.5 4b''-c). The architectural choice is part of this slice. |
| Signoff | REQUIRED. |

### B. Bundle-as-contract enforcement (closes audit §0.5.1 row 1)

| Field | Value |
| --- | --- |
| Sub-plan file | `commitment_kernel_bundle_as_contract.plan.md` (TBD) |
| Closes | Audit §0.5.1 row 1. The 2026-05-02 turn `355ae135` showed `bundles=[respond_only]` while the model autonomously called `web_search` — bundle was advisory, not contract. |
| Scope | Thread `toolBundles` from `SemanticIntent` through `attempt.ts:1915` `createOpenClawCodingTools(...)` so the bundle gates the tool catalog at construction time. |
| Files | `src/agents/tools/openclaw-coding-tools.ts` (or equivalent); `src/agents/pi-embedded-runner/run/attempt.ts`. |
| Tests | (a) Given `bundles=[respond_only]`, the constructed tool list has only the message tool. (b) Given `bundles=[artifact_authoring]`, only artifact tools (pdf/image/audio/...) plus message. (c) Live verify: a `respond_only` turn cannot crash by autonomously calling `web_search`. |
| Predecessor | None. |
| Risk | Heartbeat-class turns currently depend on bundle being advisory. Need to audit heartbeat path before tightening. |
| Signoff | REQUIRED. |

### C. IntentContractor freshness constraint (closes audit §0.5.1 row 2)

| Field | Value |
| --- | --- |
| Sub-plan file | `commitment_kernel_intent_freshness.plan.md` (TBD) |
| Closes | Audit §0.5.1 row 2. Currently route-preflight + web-evidence-prefetch fire on `requestedTools.includes("web_search")` OR `bundles.includes("public_web_lookup")`. Both are tool-shape proxies for the underlying semantic concept "user wants fresh information". |
| Scope | Extend `SemanticIntent.constraints` with `freshness?: "current" \| "recent" \| "any"`. IntentContractor populates it from prompt; route-preflight + prefetch consult `intent.constraints.freshness === "current"` first. |
| Files | `src/platform/commitment/semantic-intent.ts`; `src/platform/commitment/intent-contractor-impl.ts`; `src/platform/decision/web-evidence-prefetch.ts`; `src/platform/decision/route-preflight.ts`. |
| Tests | (a) Reverse: prompt "что было вчера в новостях?" → `freshness=current`. (b) Reverse: prompt "напиши хайку про снег" → `freshness=any`, prefetch does NOT fire. (c) Live verify: a heartbeat turn does not trigger sonar prefetch. |
| Predecessor | None. |
| Risk | Frozen layer (`semantic-intent.ts` is in `src/platform/commitment/`). This MAY need a master-plan amendment depending on whether `SemanticIntent.constraints` shape is itself frozen. Verify before writing the sub-plan. |
| Signoff | REQUIRED, possibly with frozen-layer amendment. |

### D. Channel-agnostic session persistence (foundation for cross-channel memory)

| Field | Value |
| --- | --- |
| Sub-plan file | `commitment_kernel_channel_agnostic_persistence.plan.md` (TBD) |
| Closes | Architectural prerequisite for E (memory layer). Today: session keying uses Telegram-shaped `chat_id`. Goal: `(channel, externalId, sessionScope)` so Slack / Discord / Web users get the same memory, task, and agent state. |
| Scope | Refactor session keying. Audit all readers of `chat_id` / `telegram_session` and migrate to the new key. SQLite schema migration with backfill from existing Telegram data. |
| Files | `src/session/*`; `~/.openclaw-dev/memory/dev.sqlite` schema; channel adapters under `extensions/*` (Telegram is the reference; Slack/Discord/etc. need parallel updates). |
| Tests | (a) Same memory readable from a Telegram and Slack user with matching identity claim. (b) Migration: existing Telegram sessions retain history under the new key. (c) Live verify: send the same message from two channels, both see the same session state. |
| Predecessor | None. |
| Risk | Schema migration on user data. Backfill must be idempotent and reversible. |
| Signoff | REQUIRED. |

### E. Memory layer (mem0 wrapper)

| Field | Value |
| --- | --- |
| Sub-plan file | `commitment_kernel_memory_layer.plan.md` (TBD) |
| Closes | B1 (memory across `/new`) and partially B3 (registry persistence). |
| Scope | Wrap **mem0** (`@mem0ai/mem0-ts` or fork; Apache 2.0; LLM-driven extraction + semantic recall + episodic) behind a project interface `MemoryStore { store, recall, forget, list }`. Two stores: episodic (events: tasks created, agents created, reminders set) and semantic (recall by similarity). Both keyed by the `(channel, externalId)` from slice D. Memory entries are written from the IntentContractor / Affordance side after `commitmentSatisfied`. |
| Files | `src/platform/memory/memory-store.ts` (interface); `src/platform/memory/mem0-store.ts` (mem0 impl); `src/platform/memory/in-memory-store.ts` (test impl); integration in `src/platform/commitment/monitored-runtime.ts` to emit memory writes on success. |
| Tests | (a) Round-trip: store + recall returns the entry. (b) Recall after `/new` (simulated by clearing the in-process turn cache but keeping the SQLite). (c) Recall is semantic — different wording of the same query returns the same entry. (d) Live verify: B1 replay — set reminder, `/new`, ask "какие напоминания", bot answers from memory. |
| Predecessor | D (channel-agnostic persistence). |
| Risk | mem0 alpha-y; LLM extraction may be slow / costly. Wrap it so it can be replaced without surface change. Provide a sync fallback for hot-path. |
| Signoff | REQUIRED, including dependency add. |

### F. Per-user task scheduler — TaskLedger

| Field | Value |
| --- | --- |
| Sub-plan file | `commitment_kernel_task_ledger.plan.md` (TBD) |
| Closes | B7 (parallel tasks). Reframed from the original "concurrent broker (multi-user)" — multi-user is v2; v1 covers per-user multi-task. |
| Scope | New `TaskLedger` per `(channel, externalId, sessionScope)` mirroring the intent-ledger pattern. Each task: `{ id, label, status: "running" \| "completed" \| "failed" \| "cancelled" \| "scheduled", started, completed?, intent_summary, result?, abort_signal? }`. Injected into IntentContractor's prompt as a `<active_tasks>` block (same mechanism as `<web_evidence>`). The LLM resolves user references ("отмени", "первое", "PDF про новости") to a specific `task.id`. Completion delivers result with the label as anchor: «Готово: <label> — <result>». |
| Files | `src/platform/task/task-ledger.ts`; `src/platform/task/active-tasks-block.ts` (prompt-injection helper); `src/platform/commitment/semantic-intent.ts` (extend `target` with `task` kind + `taskRef`); IntentContractor prompt updates; orchestrator dispatch wires task lifecycle to commitment effects. |
| Tests | (a) Two parallel tasks: user can ask "как там?" and get status of the running one. (b) Reference resolution: with two running tasks, "отмени PDF" cancels the matching one (LLM-mediated). (c) Ambiguity: with two running and prompt "отмени" → `clarification_needed` (B6 reverse-test). (d) Persistence: tasks survive `/new` per slice D's keying. (e) Live verify: B7 replay. |
| Predecessor | C (freshness; not strictly required but cleaner with), D (channel-agnostic), E (memory). |
| Risk | LLM may mis-resolve references under load. Mitigation: bot asks for clarification when score is below threshold (existing clarification-policy infra from PR-H). |
| Signoff | REQUIRED. |

### G. Subagent registry persistence + reply routing

| Field | Value |
| --- | --- |
| Sub-plan file | `commitment_kernel_subagent_registry.plan.md` (TBD) |
| Closes | B3 (Валера disappears after `/new`), B6 (subagent reply mis-attributed). |
| Scope | (1) Subagent metadata (id, label, parent session, status, last activity, capabilities) persisted to memory layer (slice E). Query surface for "какие у нас агенты?", "что делает Валера?". (2) Subagent reply routing: the subagent's terminal output is delivered with explicit framing (e.g. «Валера: <text>») instead of as the bot's own reply. |
| Files | `src/subagents/*`; `src/auto-reply/reply/agent-runner-execution.ts` (delivery framing); IntentContractor recognizes `target.kind = "subagent"` for queries. |
| Tests | (a) After `/new`, query "какие агенты" returns Валера. (b) Subagent's own reply has the agent label prefix (or appropriate framing per channel). (c) Reverse: when subagent is the active speaker, parent bot's voice is suppressed for that turn. (d) Live verify: B3 + B6 replay from 2026-05-04 transcript. |
| Predecessor | E (memory layer). |
| Risk | Reply framing affects channel UX. May need per-channel formatting (Telegram italic prefix vs Slack thread vs etc.). |
| Signoff | REQUIRED. |

### H. Stream/edit ordering at tool_call boundaries

| Field | Value |
| --- | --- |
| Sub-plan file | `commitment_kernel_stream_ordering_followup.plan.md` (TBD; extends PR-A.2 baseline) |
| Closes | B4 (out-of-order edits/deletes). |
| Scope | Audit residual cases past PR-A.2 (`commitment_kernel_streaming_leak_buffering.plan.md`). The 2026-05-04 transcript shows: bot starts streaming → tool_call inserts subagent ack → flush of buffered text comes after subagent reply → user sees "send → delete → final" pattern. |
| Files | `src/auto-reply/reply/block-buffering.ts` (or equivalent); flush ordering at `onStructuralToolExecutionStarting` callback. |
| Tests | (a) Reverse: a turn with subagent ack does NOT delete and re-send messages. (b) Live verify: B4 replay. |
| Predecessor | F (task scheduler) — task ack timing affects this. |
| Risk | Streaming layer is timing-sensitive. Need stress test (load + race conditions). |
| Signoff | REQUIRED. |

### I. Reply sanitizer — English reasoning leak

| Field | Value |
| --- | --- |
| Sub-plan file | `commitment_kernel_reply_sanitizer.plan.md` (TBD) |
| Closes | B5 (English meta-text reaching user). |
| Scope | Audit the assistant-reply layer. The 2026-05-04 transcript shows lines like "Let me check memory for any context about Vladimir's preferences" reaching the channel. These are pre-tool-call meta-text from opus's reasoning. Either: (a) prompt opus to keep meta in `<thinking>` blocks and strip them in the sanitizer, or (b) post-filter via language detection (transcript lang = ru, drop blocks where lang = en that look like meta). Likely (a) is the principled fix. |
| Files | `src/agents/pi-embedded-runner/run/{attempt.ts, prompt-builders.ts}`; `src/auto-reply/reply/assistant-reply-sanitizer.ts` (if not exists). |
| Tests | (a) Reverse: a turn that produces English meta-text in the model output emits empty user-facing reply if the meta is the only block. (b) Reverse: `cyr=0 lat=>30 head="Let me ..."` is filtered or wrapped. (c) Live verify: B5 replay. |
| Predecessor | None. |
| Risk | False positives — English content that user actually wanted (e.g. code, quotes) must not be filtered. Heuristic must be specific to "meta-thinking" patterns. |
| Signoff | REQUIRED. |

### J. Cron query / list / cancel surface

| Field | Value |
| --- | --- |
| Sub-plan file | `commitment_kernel_cron_query_surface.plan.md` (TBD) |
| Closes | B2 (cron is unidirectional). |
| Scope | Extend the cron tool with `list`, `inspect`, `cancel`, `update` actions. Wire IntentContractor to recognize natural-language patterns: «какие напоминания на завтра», «отмени напоминание про обед», «перенеси напоминание на 13:00». Memory entries (slice E) mirror cron state for cross-session recall. |
| Files | `src/agents/tools/cron-tool.ts` (or equivalent); IntentContractor prompt; `src/platform/cron/cron-store.ts` for persistence (likely already exists, expose query API). |
| Tests | (a) Round-trip create → list → cancel. (b) IntentContractor classifies "что у меня на завтра" → `target.kind = "cron"` operation `list`. (c) Live verify: B2 replay. |
| Predecessor | E (memory). |
| Risk | Existing cron tool may have hidden coupling to a specific store; refactor budget unclear. |
| Signoff | REQUIRED. |

### K. cutover-3 / cutover-4 — artifact effects + repo operation effects

| Field | Value |
| --- | --- |
| Sub-plan file | `commitment_kernel_cutover_3_4_artifact_repo.plan.md` (TBD) |
| Closes | Audit §0.5.3 cutover-3 + cutover-4 rows. |
| Scope | Wire artifact (PDF / image / audio) generation and repo operations (git commit / branch / file write at user request) through the commitment-kernel: declared effects, affordances with done-predicates, evidence facts, monitored runtime. Today these are tool-call side effects without commitment satisfaction. |
| Files | `src/platform/commitment/effect-family-registry.ts` (new families: `artifact`, `repo_operation`); `src/platform/commitment/affordance-registry.ts` (new affordances); `src/platform/commitment/done-predicate-artifact-created.ts`; `src/platform/commitment/done-predicate-repo-operation-completed.ts`. |
| Tests | (a) An artifact-creation turn emits commitment with `effect=artifact.created`; predicate satisfies on `artifactRegistry` evidence. (b) Reverse: an artifact tool failure surfaces as `commitmentSatisfied=false`. (c) Live verify: PDF turn → predicate satisfied. |
| Predecessor | None directly, but bigger sense after A (Search-Composer dispatch) lands so the dispatch pattern is established. |
| Risk | Touches the frozen layer (`src/platform/commitment/`). Requires master-plan amendment per invariant #11. |
| Signoff | REQUIRED, with frozen-layer amendment. |

## 4. Execution order + parallelism groups

The order respects dependencies; slices in the same group can run in parallel (independent worktrees, non-overlapping files).

```
Group 0 (foundations — sequential):
  D. Channel-agnostic session persistence            (all later memory/task work depends on this)

Group 1 (parallel after D):
  E. Memory layer (mem0 wrapper)
  I. Reply sanitizer (English-leak)                   (independent, low-risk)
  H. Stream/edit ordering                              (independent, but timing-sensitive)

Group 2 (parallel after E):
  F. Per-user task scheduler (TaskLedger)
  G. Subagent registry persistence
  J. Cron query / list / cancel surface

Group 3 (parallel; can start after Group 0 in principle, but reviewed last for v1 cleanup):
  A. Search-Composer production dispatch              (closes the Option ε prag-fix; high-risk; needs Path A vs B decision)
  B. Bundle-as-contract enforcement
  C. IntentContractor freshness                       (may be part of A's natural sequence)

Group 4 (last — frozen-layer touch + biggest scope):
  K. cutover-3 / cutover-4
```

**Slice signoff order recommendation**: D first (foundation), then I (lowest-risk, fast UX win), then E (unlocks F+G+J), then F+G+J in parallel, then A+B+C as the architectural cleanup batch, then K.

## 5. Acceptance criteria (whole roadmap)

v1 release is shippable when:

1. **All 11 slices A..K merged on dev** with their per-slice live-verify acceptance passing.
2. **B1..B7 replay sequence**: a single live Telegram session reproduces the 2026-05-04 transcript scenario and produces correct outcomes — agent created and remembered after `/new`; reminder set, listed, and cancelable; two parallel tasks managed correctly; no English meta-text leaks; subagent replies framed correctly.
3. **Cross-channel parity**: same scenarios pass via Slack + Discord + Web. (Or, at minimum: backend test fixtures show identical behaviour per channel; full E2E may be deferred to a release-candidate cycle.)
4. **Frozen-layer integrity**: the 16 invariants reverse-tests pass on dev HEAD. Any frozen-layer amendments under K are documented in master §0 + invariants.mdc.
5. **Architectural debt closed**: `disableWebSearchTool` flag is gone (slice A). Bundle is contract (slice B). Freshness is semantic (slice C). No prag-fixes remain marked TODO/HACK in code touched by v1 slices.
6. **Memory layer is the only memory layer**: in-process intent-ledger continues to exist for hot-path latency; mem0 (slice E) is the persistent store; no third "shadow" memory mechanism added.

## 6. Decisions (closed 2026-05-05 — maintainer signoff at roadmap level)

The 6 questions previously open are now closed. Each decision is binding for the v1 sub-plans below; deviation in a child sub-plan requires explicit re-opening here.

### D1. Memory backend → **mem0 (Apache 2.0) + sqlite-vec for embedded vector store**

Rationale: mem0's LLM-driven extraction (auto-decide what to remember + de-dupe + semantic recall) would cost 2-3 months to build ourselves. mem0 is 30k+ stars, weekly commits, has a TS SDK. Wrapping it behind a project `MemoryStore` interface keeps it swappable. Vector-store backend: **sqlite-vec** instead of mem0's default Qdrant — keeps everything in one embedded SQLite file, no external service. Slice E ships the wrapper; if mem0 turns out wrong in production, the swap takes a day inside the wrapper.

Rejected:
- **letta**: forces its own agent runtime; loses architectural freedom.
- **Build-our-own**: extraction pipeline alone is 3-4 weeks; not in v1 budget.
- **chromadb / pure sqlite-vec**: vector store only; we'd still write extraction.
- **zep**: license recently moved to open-core; dependency risk.

### D2. Slice A — Search-Composer dispatch → **Path A** (`RunTurnDecisionResult.directResponse?`)

Rationale: existing reply-pipeline (channel adapters with all their accumulated logic — Telegram caption split, Slack threading, Web UI streaming, etc.) is the right delivery layer. Path A reuses it; Path B duplicates it inside the orchestrator and creates two delivery code paths. The `directResponse?` field is small additive surface area; it scales for future dispatchers (memory query, task query) without touching delivery logic each time.

### D3. Slice K split → **K1 (artifacts) + K2 (repo operations)** as separate sub-plans

Rationale: standard practice — small cohesive PRs per evidence shape (artifact: filepath/size/mimetype; repo: SHA/branch/files-changed). Independent test surfaces. K2 can wait if K1 reveals issues. Both touch the frozen layer and need explicit master-plan amendment per invariant #11.

### D4. TaskLedger persistence → **shared SQLite, dedicated `tasks` table**

Rationale: every production app (Slack, Linear, Notion) uses a single transactional store with multiple tables. Critical reason: atomicity — moving a task from "running" → "completed" while writing the memory entry must be a single transaction. Separate stores make this hard. Scale concerns (millions of ops/sec) don't apply to us. Migration path to a separate store later is straightforward if it's ever needed.

### D5. Reply sanitizer → **defense in depth (prompt-side + post-filter, both)**

Rationale: this is the standard approach (called "defense in depth"). Prompt-side primary: instruct Opus to put internal reasoning in `<thinking>` blocks; we strip those before delivery. Post-filter safety net: detect English-meta-text patterns at the assistant-reply boundary and either drop them or wrap them so they don't reach the channel. Single-layer defense fails when the model occasionally ignores the prompt; both layers together hit zero leak in observation.

**Channel-aware visibility** (added 2026-05-05): different channels have different "show reasoning" rules. The sanitizer has a per-channel policy:
- **Telegram**, **Max** (RU messenger), **iMessage**, **Signal**, **WhatsApp**: never show reasoning. Strip `<thinking>` and meta-text completely.
- **Web UI** (when implemented): may show reasoning collapsibly per its UX. Sanitizer keeps `<thinking>` blocks structured (JSON-tagged) so the UI can render them; doesn't strip.
- **Slack**, **Discord**: hide by default, surface in a sidebar / thread on user request.

The sanitizer is one component, but its policy is parameterized by channel.

### D6. Cross-channel parity at v1 release → **Telegram full E2E + Web UI full E2E (when ready); other channels backend-fixture parity; Max joins in v1.1**

Rationale: Telegram is the primary channel today; Web UI is the priority companion. Both must be exhaustively tested at v1. Slack/Discord/iMessage/Signal/WhatsApp adapters: backend code paths covered by integration tests, UI not exhaustively rehearsed. Max (RU messenger) is added in v1.1 once a Max channel adapter exists. Reasoning: shipping a "perfect everywhere" v1 means v1 never ships; "perfect for primary channels, working everywhere else" is industry standard.

**Implication for slice I (reply sanitizer)**: sanitizer policy is channel-keyed (see D5). Web UI explicit support is part of slice I's acceptance.

**Implication for slice D (channel-agnostic persistence)**: the new keying `(channel, externalId, sessionScope)` MUST cover at minimum: `telegram`, `web`, `max` (placeholder), `slack`, `discord`, `imessage`, `signal`, `whatsapp`. Adding new channels later is a one-row registry addition, not a schema change.

## 7. References

- Master plan: `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0 PR Progress Log; §0.5 Audit Findings; §11 WorldState; §13 effect-family registry; §16 умный оркестратор vision).
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc`.
- Smart-orchestrator roadmap: `.cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md` (§3 numbered execution order; §6 handoff log).
- Search-Composer pipeline: `.cursor/plans/commitment_kernel_search_composer_pipeline.plan.md` (Phase 4c live-verified at PR-#145, `06baa2d364`).
- Live evidence baseline: `gateway-pr145.log` turn `6d9d80e8-cd35-4ff4-b6ce-7bc2eed08682` (Phase 4c PASS); 2026-05-04 19:38–19:42 Telegram transcript (B1..B7).
- Team protocol: `AGENTS.md` "Commitment Kernel v1 — Subagent Team Protocol" section + `.claude/agents/*.md` role specs (local).
- mem0: https://github.com/mem0ai/mem0 (Apache 2.0).

## 8. Forward-deferred (NOT in v1)

| ID | Item | Why deferred |
| --- | --- | --- |
| v2-PG | PolicyGate Stages 2-6 (approvals / budgets / role-based) | Pairing already covers production access. Approvals + budgets are operational concerns once prod load exists. |
| v2-MT | PR-MT — concurrent broker (multi-USER concurrent turns) | Different problem from B7 (per-user multi-task). v1 covers per-user via TaskLedger. Multi-user infra cost is high. |
| v2-UI | Web UI | Blocked on stable v1 backend API surface. Separate roadmap. |
| v2-FED | Cross-installation agent federation (a la ruflo issue #1669) | Not needed for v1. Single-install bot. |
| v2-OBS | Observability dashboard | Existing structured logs are enough for v1 ops. |

---

**Stop gate**: maintainer signoff REQUIRED before any slice in §3 begins coding. This document captures the v1 contract for review.
