---
name: PR-MT — concurrent broker (multi-turn parallelism)
slice: pr-mt-concurrent-broker
status: in_progress
signoff: GRANTED via blanket authorization 2026-05-05
predecessor: 97efd72c38
overview: "PR-MT — четвёртый шаг roadmap commitment-kernel v1: in-process `ConcurrentTurnBroker`, который позволяет ходам разных `(identityId, channelKey)` обрабатываться ПАРАЛЛЕЛЬНО, сохраняя FIFO внутри одной пары. Сегодня все turns сериализованы на уровне процесса (`FOLLOWUP_QUEUES` drain + `runTurnDecision` dispatch), так что turn от identity B ждёт окончания turn'а identity A даже если они не разделяют состояния. Архитектура: (a) NEW `ConcurrentTurnBroker` (process-scoped singleton, mirrors `delivery-receipt-registry.ts` / `web-evidence-collector` precedent) с per-`(identityId, channelKey)` FIFO-очередью; (b) NEW `BrokerQueueKey` brand + `BrokerEntry` + `BrokerCapacityConfig` types; (c) NEW pure helper `decideQueuePlacement(entry, state)` (deterministic, clock-injected); (d) wiring в `run-turn-decision.ts` dispatch: turn enqueues, broker планирует с round-robin fairness; (e) capacity caps + backpressure → reverse-defense overflow → structured envelope (NEVER drop); (f) telemetry `[broker] queueKey=<...> queueDepth=<...> waitMs=<...> processedTurnId=<...>`. Pure additive; 16 invariants preserved; in-process only (no cross-process distribution); `IntentContractor` ordering semantics untouched; 5 frozen contracts byte-identical. Non-goals: cross-process broker, replacement of existing FOLLOWUP_QUEUES drain (broker sits ABOVE drain, не вместо), persistent broker state, prioritization beyond round-robin fairness."
todos:
  - id: pr-mt-phase-1-audit
    content: "Phase 1 — Audit (read-only). Output `extensions/AUDIT-pr-mt-concurrent-broker.md`. Map: dispatch entry path `runTurnDecision` callers (`src/platform/decision/input.ts:541+578`, `src/platform/plugin.ts:80+340`, `src/auto-reply/reply/agent-runner-execution.ts`); existing serial points (`FOLLOWUP_QUEUES` drain at `src/auto-reply/reply/queue/drain.ts`, `piEmbeddedQueueRuntimePromise` at `src/auto-reply/reply/agent-runner.ts:105`, `enqueueFollowupRun` at `src/auto-reply/reply/queue/enqueue.ts`); identity/channel resolution surfaces (`originatingChannel` + `originatingTo` + `originatingAccountId` + `originatingThreadId` tuple in `FollowupRun`; `ledgerSessionId/ledgerChannelId` in `input.ts`); confirm absence of per-`(identity, channel)` mutex (today drain key is `queueKey` string built ad-hoc); operator-impact estimate: scrape `[reply]` + `[agent-runner]` log 7-day window for `queueKey` distribution + median wait time when concurrent identities active. NO source changes."
    status: pending
  - id: pr-mt-phase-2-types
    content: "Phase 2 — Types + schemas. NEW branded `BrokerQueueKey` (template-built `${identityId}::${channelKey}`); NEW `BrokerEntry = {turnId, queueKey, enqueuedAtMs, runTurn: () => Promise<void>}` (closure carries dispatch); NEW `BrokerCapacityConfig = {maxQueueDepthPerKey?:number, maxConcurrentKeys?:number, queueWaitTimeoutMs?:number, fairnessMode?:'round_robin'|'fifo_global'}`. Defaults: `maxQueueDepthPerKey=8` (back-pressure), `maxConcurrentKeys=32` (process headroom), `queueWaitTimeoutMs=120_000` (2 min), `fairnessMode='round_robin'`. NEW Zod `BrokerCapacityConfigSchema.strict()` — все поля optional positive integers. NEW closed reason set `BrokerOverflowReason = 'queue_depth_exceeded' | 'wait_timeout' | 'broker_shutdown'`. Tests fail-first: schema round-trip; reject negative/zero; brand discipline; default-application; reverse — unknown fairnessMode rejected at decode."
    status: pending
  - id: pr-mt-phase-3-pure-policy
    content: "Phase 3 — Pure broker placement helper. NEW `decideQueuePlacement(params: {entry: BrokerEntry, state: BrokerState, config: Required<BrokerCapacityConfig>, nowMs: number}): BrokerPlacement`. `BrokerPlacement = {kind:'admit', queueDepth:number} | {kind:'reject', reason:BrokerOverflowReason}`. Function pure: NEVER mutates input state, returns a decision; broker implementation Phase 4 applies the decision. Round-robin: `state.lastServedKey` + `state.keyOrder` deterministic ranking. NEVER throws (#15). Tests fail-first (~9 cases): admit on empty state; admit when depth < cap; reject queue_depth_exceeded when at cap; reject broker_shutdown when state.shutdown=true; round-robin chooses next key after lastServedKey; FIFO within a single key preserved; clock determinism (no Date.now() inside helper); input non-mutation; reverse — wait_timeout rejection when entry age > queueWaitTimeoutMs."
    status: pending
  - id: pr-mt-phase-4-broker-impl
    content: "Phase 4 — `ConcurrentTurnBroker` implementation (process-scoped singleton). NEW `src/platform/broker/concurrent-turn-broker.ts`: per-key FIFO `Map<BrokerQueueKey, BrokerEntry[]>` + global `keyOrder: BrokerQueueKey[]` (round-robin cursor) + `inFlight: Set<BrokerQueueKey>`. Public surface: `submit(entry): Promise<BrokerSubmitResult>` (resolves when turn completes OR rejects with `BrokerOverflowReason`), `getQueueDepth(queueKey): number`, `getActiveKeys(): readonly BrokerQueueKey[]`. Internal scheduler: when entry admitted via `decideQueuePlacement`, push to per-key queue; if key not `inFlight`, kick async loop that drains its queue serially while marking `inFlight`. Cross-key: when scheduler tick runs, pick next non-inFlight key from `keyOrder` round-robin; multiple keys process concurrently bounded by `maxConcurrentKeys`. Telemetry: emit `[broker] enqueued queueKey=<...> depth=<N>` + `[broker] dispatch queueKey=<...> waitMs=<N> turnId=<...>` + `[broker] complete queueKey=<...> turnId=<...>` + `[broker] rejected queueKey=<...> reason=<...>`. Tests fail-first (~10 cases): single-key serial FIFO preserved; two-key concurrency observed (Promise.all start ts < both finish ts); round-robin fairness across 3 keys; queue_depth_exceeded rejection; wait_timeout rejection; shutdown rejects new submits; in-flight set bounded by maxConcurrentKeys; reverse — broker NEVER drops on overflow (always returns structured rejection); telemetry log lines emitted; clock-injectable for deterministic timing tests."
    status: pending
  - id: pr-mt-phase-5-wiring
    content: "Phase 5 — Wire broker into dispatch. ADDITIVE thread at `runTurnDecision` callers OR at a single chokepoint. Decision (Phase 1 audit confirms): wrap dispatch at `src/auto-reply/reply/agent-runner-execution.ts` + `src/auto-reply/reply/agent-runner.ts:queueEmbeddedPiMessage` — both production callers feed inbound channel turns and converge to `runTurnDecision`. NEW helper `dispatchTurnViaBroker(entry, broker)` resolves `BrokerQueueKey` from `(identityId, originatingChannel, originatingTo, originatingAccountId, originatingThreadId)` via stable JSON-tuple serialization (mirrors `enqueue.ts:buildRecentMessageIdKey` precedent). Plugin.ts callers (`plugin.ts:80+340`) — single-shot internal hooks without session lifecycle; OUT OF SCOPE for v1 (use direct dispatch as today). Cross-context isolation preserved: identity boundary structurally enforced by queueKey shape. Tests fail-first (~6 cases): same-(identity, channel) two-turn FIFO unchanged vs pre-broker baseline; different-identity two-turn parallel observable via Promise.race; identity-isolation reverse — turn from identity B never sees turn-A state; plugin.ts callers untouched (byte-identical dispatch); `intentLedger.recordRecentIntent` ordering preserved within key; reverse — broker disabled via `concurrentBroker: undefined` falls back to current serial path byte-identical."
    status: pending
  - id: pr-mt-phase-6-backpressure
    content: "Phase 6 — Capacity caps + backpressure + reverse-defense. When `decideQueuePlacement` returns `kind:'reject'`, broker NEVER drops the turn; instead returns structured envelope `BrokerRejectedTurnEnvelope = {kind:'broker_overflow', reason:BrokerOverflowReason, queueKey:BrokerQueueKey, retryAfterMs?:number}` to caller. Caller surface choices: (a) inbound-channel callers (agent-runner-execution) translate envelope → user-facing structured reply (`[broker] перегружен — повторите через ${retryAfterMs}мс`) + telemetry log; (b) internal callers (NONE in v1 — plugin.ts deferred Phase 5) would surface as deterministic error. `retryAfterMs` derived from current min(queueWaitMs across keys). Defense-in-depth: shutdown gracefully drains in-flight without admitting new, exposes `broker.shutdown(): Promise<void>`. Tests fail-first (~7 cases): overflow → envelope (not throw, not silent drop); envelope round-trip via Zod; user-facing reply path produced when caller is channel; retry-after computed deterministically; shutdown drains in-flight before resolving; shutdown rejects new submit with `broker_shutdown`; reverse — capacity 0 → all submits rejected immediately with `queue_depth_exceeded`."
    status: pending
  - id: pr-mt-phase-7-acceptance
    content: "Phase 7 — Acceptance + log-line evidence + live-verify runbook + master plan entry + sub-plan flip. NEW `src/platform/broker/__tests__/concurrent-turn-broker.acceptance.test.ts` (~6 cases): (1) 3 identity-distinct turns dispatched simultaneously — assert all three start before any finish (mock-clock evidence: each turn awaits 100ms work, broker schedule observable via timeline `t0:start_A t0:start_B t0:start_C t100:end_*`); (2) Same-(identity, channel) 2-turn FIFO preserved (turn-2 starts only after turn-1 satisfied); (3) Round-robin fairness — 3 identities each enqueue 5 turns; observed dispatch sequence interleaves rather than draining one identity first; (4) Backpressure overflow returns envelope; user reply contains structured retry hint; (5) Reverse — broker disabled / undefined → byte-identical to pre-Phase-5 serial dispatch path (regression guard); (6) Shutdown drains in-flight, rejects new, log line `[broker] shutdown drained=<N>` emitted. **Live-verify runbook (REQUIRED — invariant #15 + handoff)**: NEW `extensions/RUNBOOK-pr-mt-concurrent-broker.md` — gateway restart + 3 live identity-distinct operator turns (different Telegram chats / different operators) sent within 1s window; live-verifier asserts: `[broker] enqueued queueKey=...` ×3 distinct keys; observed wallclock turn completions overlap (not strictly serialized); coherent replies in all three chats; no cross-identity bleed in `<memory>` / `<active_tasks>` blocks. Reverse: same-chat 2 rapid turns process FIFO. Master plan §0 PR Progress Log row + §16 PR-MT row updated. Slice CLOSED."
    status: pending
isProject: false
---

# PR-MT — concurrent broker

## 0. Provenance & Context

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0 PR Progress Log line 70: «PR-MT — concurrent broker (deferred, signoff required); roadmap step 4 ждёт maintainer») |
| Predecessor (dev) | `97efd72c38` (post bundle-as-contract slice closure) |
| Inherits | 16 hard invariants from `.cursor/rules/commitment-kernel-invariants.mdc` |
| Predecessors merged | PR-H Phase 1 `185cf7d3fb` (#112) — Stage 1.5 ClarificationPolicy; PR-H Phase 2 `01afedff6a` (#113) — per-session SemanticIntent cache; Slice K cron-fire callback wiring CLOSED; bundle-as-contract slice CLOSED. |
| Architectural step | Roadmap step 4 — следующий после PR-H per master §0 line 70. |
| Trigger | Operator-impact: при concurrent operator turns (multiple Telegram chats / multiple identities) ходы сериализуются на уровне процесса; turn от identity B ждёт окончания turn'а identity A даже если состояния не пересекаются. |
| Out of scope | Cross-process distribution (in-process broker only); persistent broker state across restarts; per-provider hacks; openclaw.json wholesale overwrite; revert of slices E/F/I; `IntentContractor` ordering semantics; 5 frozen contracts; `MemoryStore` interface; `TaskLedger` interface; replacement of existing `FOLLOWUP_QUEUES` drain (broker sits ABOVE the dispatch entry, drain ниже). |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05 ("until orchestrator demos green"). |

## 1. Symptom + Root Cause

**Symptom.** Конкретный наблюдаемый кейс: операторы A и B шлют ходы в РАЗНЫЕ Telegram-чаты в окне 1с. Turn-B ждёт `await runTurnDecision(turn-A)` целиком (включая `IntentContractor.classify` LLM-call ~1-3s + кернел dispatch + outbound delivery), хотя turn-A и turn-B не разделяют ни `SessionWorldState`, ни `<memory>` cohort, ни `<active_tasks>`. Wallclock-задержка для turn-B = wallclock turn-A + own latency.

**Root cause (architectural).** Process-scope serial dispatch без per-`(identity, channel)` broker. `FOLLOWUP_QUEUES` (`src/auto-reply/reply/queue/state.ts`) keyed по composite string `queueKey`, но drain executes serially — единственный `kickFollowupDrainIfIdle` per key, и все `runTurnDecision` calls на process'е делят single async stack. Identity boundary не структурно изолирует scheduling.

## 2. Constraints (Hard Invariants)

- **#1**: `ExecutionCommitment` tool-free — broker сидит ВЫШЕ commitment-layer; не модифицирует `ExecutionCommitment` shape.
- **#2**: Структурный отбор. `BrokerQueueKey` строится из `(identityId, channelKey)` — структурные id, не текст.
- **#3**: Production success unchanged — `commitmentSatisfied` не меняется; broker меняет ТОЛЬКО порядок/concurrency dispatch, не семантику done-predicate.
- **#4**: State-after observers untouched.
- **#5, #6**: NO new readers raw user text. Broker oblivious к содержимому turn'а; queueKey строится из routing metadata (`originatingChannel` / `originatingTo` / `originatingAccountId` / `originatingThreadId` + `identityId`). `IntentContractor` остаётся sole sanctioned `RawUserTurn` reader.
- **#7**: ShadowBuilder unchanged.
- **#8**: `src/platform/broker/` импортирует identity types + Zod + stdlib; `commitment ↛ decision` направление сохранено (broker НЕ импортируется из `src/platform/commitment/`).
- **#9, #10**: `DonePredicate` неизменён.
- **#11**: 5 frozen contracts BYTE-IDENTICAL. Broker — новый module под `src/platform/broker/`; не трогает `TaskContract` / `OutcomeContract` / `QualificationExecutionContract` / `ResolutionContract` / `RecipeRoutingHints`.
- **#12**: NO emergency phrase patches.
- **#13**: `terminalState` ⊥ `acceptanceReason` сохранены.
- **#14**: `ShadowBuildResult` unchanged.
- **#15**: Broker overflow → структурный envelope (NEVER throws, NEVER silent drop). Live-verify mandatory at Phase 7.
- **#16**: `EffectFamilyId` ⊥ `EffectId` сохранены. Broker не вводит new branded effect ids; единственный новый бренд — `BrokerQueueKey`, орthogonal id-space.

**Cross-identity isolation:** `BrokerQueueKey` структурно содержит `identityId` — broker НЕ может промотать turn между identity boundaries.

**Turn ordering within identity-channel:** FIFO внутри per-key queue гарантировано — same-identity-same-channel sequential ordering preserved.

## 3. Architecture sketch

```
                   ┌────────────────────────────────────────┐
inbound turn ────► │  agent-runner-execution / agent-runner │
                   └─────────────────┬──────────────────────┘
                                     │
                                     ▼
                   ┌────────────────────────────────────────┐
                   │  dispatchTurnViaBroker(entry, broker)  │  ← NEW (Phase 5)
                   └─────────────────┬──────────────────────┘
                                     │ submit({turnId, queueKey, runTurn})
                                     ▼
        ┌────────────────────────────────────────────────────────┐
        │  ConcurrentTurnBroker (process-scoped singleton)       │
        │                                                        │
        │  per-key FIFO Map<BrokerQueueKey, BrokerEntry[]>       │
        │  keyOrder: BrokerQueueKey[]   (round-robin cursor)     │
        │  inFlight: Set<BrokerQueueKey> (≤ maxConcurrentKeys)   │
        │                                                        │
        │  decideQueuePlacement(entry, state, config, nowMs)     │
        │  → admit | reject(queue_depth_exceeded|wait_timeout|   │
        │                  broker_shutdown)                      │
        │                                                        │
        │  telemetry: [broker] enqueued|dispatch|complete|       │
        │             rejected|shutdown                          │
        └─────────────┬───────────────────────────────┬──────────┘
                      │ admit                         │ reject
                      ▼                               ▼
            runTurnDecision(...)            BrokerRejectedTurnEnvelope
                                            → channel reply with retry hint
```

- **Process scope only.** Singleton mirrors `delivery-receipt-registry.ts` / `web-evidence-collector` precedent.
- **Per-`(identityId, channelKey)` queue.** `channelKey = JSON.stringify([originatingChannel, originatingTo, originatingAccountId, originatingThreadId])` — stable serialization (precedent: `enqueue.ts:buildRecentMessageIdKey`).
- **Fairness — round-robin across keys.** Простой deterministic policy; weighted-fair вынесен в roadmap (см. §10).
- **Wired в `agent-runner-execution.ts` + `queueEmbeddedPiMessage` callers.** `runTurnDecision` сам остаётся неизменным; broker оборачивает dispatch.
- **Capacity caps + backpressure.** `maxQueueDepthPerKey=8`, `maxConcurrentKeys=32`, `queueWaitTimeoutMs=120_000`. Overflow → structured envelope.
- **Telemetry.** `[broker] queueKey=<...> queueDepth=<...> waitMs=<...> processedTurnId=<...>` — deterministic log shape.

## 4. Phase-by-phase TODOs

См. `todos:` в frontmatter. Резюме:

1. **Phase 1 — AUDIT** (read-only). Map существующих serial points, identity/channel surfaces, operator-impact estimate. NO source changes.
2. **Phase 2 — Types**. `BrokerQueueKey` brand, `BrokerEntry`, `BrokerCapacityConfig`, Zod schemas, closed reason set.
3. **Phase 3 — Pure policy helper**. `decideQueuePlacement` deterministic, clock-injected, never-throws. ~9 fail-first cases.
4. **Phase 4 — Broker implementation**. Process-scoped singleton, per-key FIFO, round-robin, `inFlight` bounded, telemetry. ~10 fail-first cases.
5. **Phase 5 — Wiring**. `dispatchTurnViaBroker` helper at `agent-runner-execution.ts` + `queueEmbeddedPiMessage`. Plugin.ts callers OUT OF SCOPE v1. ~6 fail-first cases.
6. **Phase 6 — Backpressure + reverse-defense**. Overflow → `BrokerRejectedTurnEnvelope` (NEVER drop). Channel-side caller surfaces user reply with retry hint. Shutdown semantics. ~7 fail-first cases.
7. **Phase 7 — Acceptance + live-verify runbook + sub-plan flip + master plan entry**. 3-identity parallel timing-evidence test. `extensions/RUNBOOK-pr-mt-concurrent-broker.md`. Master §0 PR Progress Log + §16. Slice CLOSED.

## 5. Out-of-scope

- ❌ Per-provider hacks или openclaw.json wholesale overwrite.
- ❌ Revert или modification slices E/F/I.
- ❌ Frozen-layer breaking changes (additive new module under `src/platform/broker/` only).
- ❌ Cross-process distribution (Redis / IPC). In-process broker only — sufficient for current single-process gateway topology.
- ❌ `IntentContractor` ordering semantics (Slice K precedent untouched).
- ❌ 5 frozen decision contracts.
- ❌ `MemoryStore` / `TaskLedger` interface widening.
- ❌ Persistent broker state across process restarts (queue state lost on restart by design — same as current `FOLLOWUP_QUEUES` in-memory portion).
- ❌ Replacement of `FOLLOWUP_QUEUES` drain — broker sits ABOVE dispatch, drain остаётся below.
- ❌ Plugin.ts callers (`plugin.ts:80+340` — single-shot internal hooks without `(sessionId, channelId)` lifecycle context; deferred to v2).
- ❌ Weighted-fair / priority queues (round-robin only; weighted policy → roadmap).

## 6. Handoff Log

(Empty — заполняется handoff-writer'ом post-phase-merge.)

## 7. Test plan

Fail-first per phase. No `vi.spyOn` on function under test.

- **Phase 1**: audit md (`extensions/AUDIT-pr-mt-concurrent-broker.md`).
- **Phase 2**: schema round-trip + brand discipline + reject negative/zero + reject unknown fairnessMode.
- **Phase 3**: 9 helper cases (admit/reject paths × clock-determinism × non-mutation × round-robin × shutdown × wait_timeout).
- **Phase 4**: 10 broker cases (FIFO single-key × concurrency two-key × round-robin three-key × queue_depth_exceeded × wait_timeout × shutdown × maxConcurrentKeys cap × NEVER drop reverse × telemetry × clock-injectable).
- **Phase 5**: 6 wiring cases (same-key FIFO byte-identical baseline × different-identity parallel × identity-isolation reverse × plugin.ts byte-identical × intentLedger ordering × broker-undefined regression).
- **Phase 6**: 7 backpressure cases (envelope-not-throw × Zod round-trip × channel reply path × retry-after deterministic × shutdown drains × shutdown rejects new × capacity-0 reverse).
- **Phase 7**: 6 acceptance + live Telegram verify (3-identity parallel timing × same-key FIFO × round-robin fairness × overflow envelope × broker-disabled regression × shutdown drained log).

**Log-line evidence (Phase 4 emits, Phase 7 asserts):**
- `[broker] enqueued queueKey=<...> depth=<N>`
- `[broker] dispatch queueKey=<...> waitMs=<N> turnId=<...>`
- `[broker] complete queueKey=<...> turnId=<...>`
- `[broker] rejected queueKey=<...> reason=<queue_depth_exceeded|wait_timeout|broker_shutdown>`
- `[broker] shutdown drained=<N>`

## 8. Live-verify runbook gist

NEW `extensions/RUNBOOK-pr-mt-concurrent-broker.md` (Phase 7 deliverable):

1. Gateway restart on dev branch carrying Phase 6 merge.
2. Two operators (или один оператор с двумя Telegram-аккаунтами) шлют по одному ходу в свои чаты в окне 1с. Третий ход — отдельная identity в третьем чате.
3. Live-verifier асёртит:
   - Лог `[broker] enqueued queueKey=...` ×3 distinct keys.
   - Wallclock-времена `[broker] dispatch ...` overlap (не strict serial).
   - All three chats получают coherent replies.
   - No cross-identity bleed в `<memory>` / `<active_tasks>` blocks.
4. Reverse leg: same chat 2 rapid turns — `[broker] dispatch` serialized, FIFO order preserved.
5. Backpressure: synthetic overflow scenario (`maxQueueDepthPerKey=1` override) — turn-2 same-key получает structured envelope reply.

## 9. Maintainer signoff

GRANTED via blanket authorization 2026-05-05 ("until orchestrator demos green").

## 10. Adjacent / deferred

| Item | Why deferred |
|---|---|
| Cross-process distribution (Redis / IPC) | Current gateway topology single-process; slice scope minimal |
| Persistent broker state across restarts | In-memory drain precedent; out-of-scope v1 |
| Weighted-fair / priority queues per identity | Round-robin sufficient for v1; weighted needs telemetry feedback loop |
| Plugin.ts callers wired to broker | Single-shot internal hooks without `(sessionId, channelId)` lifecycle |
| Adaptive capacity caps tuned per operator cohort | v2 — needs telemetry feedback |
| Broker-aware retry policy on overflow envelope | Caller-side surface; v1 returns structured envelope only |
| Telemetry dashboard `[broker]` aggregates | Observability roadmap |
| Cross-broker promotion when multi-process | Roadmap; tied to cross-process distribution |

## 11. References

- Master plan §0 PR Progress Log line 70 (PR-MT row).
- Hard invariants `.cursor/rules/commitment-kernel-invariants.mdc`.
- PR-H Phase 1/2 sub-plans (per-session SemanticIntent cache precedent — same architectural step direction).
- Bundle-as-contract sub-plan (predecessor; signoff blanket).
- IntentContractor freshness sub-plan (sister, recently CLOSED — shape reference).
- `src/platform/decision/run-turn-decision.ts` (dispatch entry).
- `src/agents/pi-embedded-runner/run/attempt.ts` (turn execution).
- `src/auto-reply/reply/queue/enqueue.ts` + `drain.ts` (existing serial-queue surface).
- `src/auto-reply/reply/agent-runner-execution.ts` + `agent-runner.ts:queueEmbeddedPiMessage` (Phase 5 wiring sites).
- `src/platform/session/intent-ledger.ts` (per-session state precedent).
- Web-evidence-collector + delivery-receipt-registry (process-scoped singleton precedent).
