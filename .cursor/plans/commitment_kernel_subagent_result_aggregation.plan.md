---
name: Subagent result aggregation — final consolidated reply per user turn (commitment kernel side-plan)
overview: |
  Архитектурный фикс orchestrator-flow: после того как persistent_worker / one-shot subagent завершил свою работу, parent-сессия должна доставить пользователю в external channel ОДНУ финальную консолидированную аргегированную выдачу с полным результатом воркера, а не ранний partial-update + lossy LLM-summary поверх announce.

  Симптом (gateway log `terminals/466813.txt`, 2026-04-28 19:38–19:48):
  - User → TG: «Давай создадим агента. Он каждый день должен предоставлять список моделей с открытыми весами…»
  - Parent classifier → `persistent_worker·tool_execution·0.87` (корректно).
  - Parent spawn'ит subagent `open-models-daily`, тот стартует первый прогон.
  - Parent посреди работы worker'а отправляет в TG `«Пока есть только частичный результат…»` (DeepSeek-only fragment) и закрывает первый turn — это ранний partial-deliver, до завершения worker'а.
  - Worker завершает полный first_pass и возвращает в parent через `subagent_announce` обширную сводку S/M/L (10+ моделей, лог:619-735).
  - Provenance gate (PR self-feedback-loop) корректно перехватывает announce: classifier НЕ запускается на receipt'е, planner получает baseline `respond_only`/`requestedTools=[]`, никакого повторного `sessions_spawn`.
  - Parent делает **второй turn**, через который LLM пересказывает worker'овский результат сжатой формой (лог:744-772) — пользователь видит **сокращённую** версию без полной таблицы и без хвостов.
  - Итого: пользователь получил два неполных сообщения вместо одного финального с полным content'ом воркера; продукт ощущается «агент не отдал результат».

  ЖЁСТКО (do NOT violate):
  - НЕ трогать `src/platform/commitment/**` (PR-4b frozen).
  - НЕ трогать 4 frozen call-sites: `src/platform/plugin.ts:80`, `:340`, `src/platform/decision/input.ts:444`, `:481`.
  - НЕ откатывать provenance gate из PR self-feedback-loop (`src/platform/decision/input.ts:362-431, 449-470`); опираемся на него.
  - НЕ нарушать 16 hard invariants (`/.cursor/rules/commitment-kernel-invariants.mdc`). В частности:
    - invariant #5 (no phrase / text-rule matching на UserPrompt outside whitelist) — фикс работает по типу `InputProvenance`, `subagent_announce` source-tag и terminal-state, а не по тексту;
    - invariant #6 (`IntentContractor` is the only reader of raw user text) — мы НЕ скармливаем announce-content классификатору; для финальной доставки используем структурный hand-off, а не классификацию.
  - НЕ регрессировать PR-4a/PR-4b cutover routing для `persistent_session.created`, `answer.delivered`, `clarification_requested`, `external_effect.performed` на user-prompt'ах.
  - НЕ ширить scope в delivery sanitizer (Bug E), recipe routing (Bug C), ambiguity policy (Bug D), streaming-leak (Bug A) — для каждого отдельный sub-plan. См. §8.

  Фикс выпускается single-PR'ом ПОСЛЕ human signoff. Ожидаемый scope ~250–400 LOC поверх 4–6 файлов; превышает порог «ship without plan» (<300 LOC / <5 files), поэтому стандартная последовательность plan + signoff first.
audit_gaps_closed:
  - O1 (parent-сессия не дожидается subagent.terminalState=complete до закрытия user-facing turn'а)
  - O2 (announce-content переписывается через дополнительный LLM-pass вместо verbatim hand-off в user channel)
  - O3 (нет invariant'а «один user-facing final message per logical user-turn»)
  - O4 (telemetry: нет `[subagent-aggregation]` события, видно только косвенно через provenance-guard и planner timeline)
todos:
  - id: bootstrap-and-confirm-bug
    content: |
      Прочитан мастер-план (§0, §0.5, §3, §8.5), sub-plan'ы predecessor'ов (PR-4a/4b cutover, self-feedback-loop fix), invariants, gateway log `terminals/466813.txt:619-820`. Все 16 invariant'ов учтены.
    status: completed
  - id: trace-subagent-announce-flow
    content: |
      Аудит проведён. Подтверждено: announce-flow доставляет worker-completion через `runSubagentAnnounceFlow` → `deliverSubagentAnnouncement` → `callGateway({method:"agent"})`, что вызывает второй LLM-pass parent'а на announce-content'е. Active children retrieval — через `listSubagentRunsForRequester` из `subagent-registry.ts`; `SubagentRunRecord` уже содержит `spawnMode`, `expectsCompletionMessage`, `runId`, `childSessionKey`, `label`, `createdAt`, `endedAt`. Дополнительный proboring spawn-time-context'а не понадобился: `userChannelOrigin` берётся из `sessionCtx.OriginatingChannel/OriginatingTo/AccountId/MessageThreadId`, `completionDirectOrigin` уже доступен в `subagent-announce.ts` через `targetRequesterOrigin` resolution.
    status: completed
  - id: define-final-reply-invariant
    content: |
      Invariant `single_final_user_facing_message_per_user_turn` зафиксирован в `src/auto-reply/reply/aggregation-policy.ts`. Структурный gate работает по `SpawnSubagentMode` enum + `SubagentRunRecord.spawnMode/expectsCompletionMessage` + literal-полям `DeliveryContext`, БЕЗ парсинга user-prompt-текста (invariant #5). Default mode = `holding` (Option A); `await` зарезервирован за future cron sub-plan'ом (Bug F).
    status: completed
  - id: parent-await-subagent-terminal-state
    content: |
      Gate реализован в `src/auto-reply/reply/subagent-aggregation.ts::evaluateAggregationOverride`/`applyAggregationOverride`. Подключён в `src/auto-reply/reply/agent-runner.ts:929-955` ПЕРЕД точкой генерации parent reply. Detection — по `executionVerification.receipts[].name === "sessions_spawn" && status === "success"`. Active continuation child выбирается из registry с window=5min для защиты от ложного срабатывания на легаси active-children'ах. Frozen call-sites не тронуты.
    status: completed
  - id: subagent-announce-verbatim-forward
    content: |
      Verbatim forward path реализован в `src/agents/subagent-announce.ts::tryDeliverVerbatimToUserChannel` через `callGateway({method:"send"})` (НЕ через `method:"agent"`). Подключён в `runSubagentAnnounceFlow` ПЕРЕД `deliverSubagentAnnouncement`. Условия (`shouldVerbatimForwardCompletion`): `expectsCompletionMessage=true` + requester НЕ subagent + completionDirectOrigin указывает на user-channel + `outcome.status === "ok"`. Idempotency keys прибиты к `childRunId+childSessionKey`. На любую failure возвращаем false → fallback на legacy announce-flow + provenance gate как safety-net.
    status: completed
  - id: telemetry-and-logging
    content: |
      Telemetry-events добавлены в обоих гейтах через `formatAggregationLog`:
      — `[subagent-aggregation] event=holding_sent mode=holding parent=… child=… runId=… [label=…]`
      — `[subagent-aggregation] event=worker_terminal_complete_verbatim mode=holding parent=… child=… runId=… [label=…] content_bytes=…`
      — `[subagent-aggregation] event=verbatim_skipped child=… runId=… [label=…] reason=…` (для empty_reply / no_user_channel_target / gateway_send_failed)
      — `[subagent-aggregation] event=policy_passthrough mode=await reason=await_mode_reserved_for_future_subplan` (для будущего Bug F).
    status: completed
  - id: tests-aggregation-policy
    content: |
      Vitest implemented:
      (a) `src/auto-reply/reply/aggregation-policy.test.ts` — pure helpers (decideAggregationMode / shouldVerbatimForwardCompletion / formatVerbatimWorkerContent / idempotency-key builders / log formatter) — 5 тестов green;
      (b) `src/auto-reply/reply/subagent-aggregation.test.ts` — gate evaluation + override application — 13 тестов green (включая регресс на stale-children, ended-children, await-mode passthrough, multiple-active-children с pick-most-recent);
      (c) `src/agents/subagent-announce.aggregation.test.ts` — verbatim forward path — 38 тестов green (включая legacy announce-flow regression);
      (d) regression: `src/platform/decision/input.provenance-gate.test.ts` — 5 тестов green (provenance gate работает как safety-net);
      (e) regression: `src/agents/subagent-spawn.idempotency.test.ts` — все 11 тестов green.
    status: completed
  - id: tsgo-and-targeted-tests
    content: |
      `pnpm tsgo` green; ReadLints clean. Targeted run `pnpm test -- src/auto-reply/reply/aggregation-policy.test.ts src/auto-reply/reply/subagent-aggregation.test.ts src/agents/subagent-announce.aggregation.test.ts src/platform/decision/input.provenance-gate.test.ts src/agents/subagent-spawn.idempotency.test.ts` — 5 файлов / 61 тест green. Полный `pnpm test -- src/auto-reply/reply` НЕ запускался по умолчанию (там 124 unrelated failures на dev HEAD per AGENTS.md «scoped tests for narrowly scoped changes»).
    status: completed
  - id: live-smoke-evidence
    content: |
      После merge оператор перезапускает gateway, шлёт в TG: «Создай агента который каждый день к 9:00 присылает мне краткую сводку open-source AI релизов за прошлые сутки. Запусти первый прогон сейчас». Ожидаемое поведение в логе:
      — ОДИН classifier-pass (`outcome=persistent_worker`),
      — ОДИН `[subagent-aggregation] event=holding_sent mode=holding`,
      — ОДНО holding-сообщение в TG («Запустил воркера. Полный результат пришлю отдельным сообщением, когда будет готов.»),
      — Worker завершает first_pass, log: `[subagent-aggregation] event=worker_terminal_complete_verbatim mode=holding`,
      — ОДНО финальное сообщение в TG с полной сводкой воркера verbatim (с префиксом «Готово:»),
      — НИ ОДНОГО partial-update в TG между ними,
      — НИ ОДНОГО `provenance-guard kind=inter_session → respond_only` для announce'а worker'а в happy path (verbatim path срабатывает ДО announce-method'а).
    status: pending
  - id: human-signoff
    content: |
      Production routing-adjacent change поверх freeze layer (`src/auto-reply/reply/**`, `src/agents/subagent-announce.ts`). Invariant #15 — нужен явный maintainer signoff ДО merge. Все 16 invariant'ов соблюдены: §1 фиксирует места проверки. Frozen call-sites не тронуты, frozen layers не тронуты, scope-creep не произошёл (всё уложилось в §4 matrix).
    status: pending
  - id: final-docs-commit
    content: Final commit `docs(plan): mark subagent-result-aggregation completed`. Append PR row в master §0 PR Progress Log; mark §0.5 audit gaps O1-O4 как `closed by <merge-SHA>`; append handoff-log entry в §6 этого плана.
    status: pending
isProject: false
---

# Subagent result aggregation — final consolidated reply per user turn

## 0. Provenance

| Field | Value |
| --- | --- |
| Bug report ts | 2026-04-28 |
| Repo / branch | `god-mode-core` / `dev` (~PR self-feedback-loop merged 2026-04-28, commit `970ee2b43d`) |
| Detected via | live TG session, persistent worker `open-models-daily`; gateway log `terminals/466813.txt:619-820` |
| Final merge target | `dev`, single PR `fix(orchestrator): single final consolidated reply per user turn for subagent results` |
| Production routing change | YES (parent выдаёт holding-message + verbatim subagent forward вместо early-partial + LLM-summary) |
| Out-of-scope | `src/platform/commitment/**`; 4 frozen call-sites; provenance gate из self-feedback-loop PR; recipe routing (Bug C); ambiguity policy (Bug D); raw-error sanitizer (Bug E); streaming-leak chunker (Bug A); subsequent persistent_worker push'ы (cron-driven daily reports) — каждый отдельный sub-plan |
| Scope clarifier | Aggregation-policy касается ТОЛЬКО **first_pass'а** (immediate continuation после spawn'а в том же user-turn'е). Cron-driven daily push'ы из персистентного воркера в внешний канал — другой codepath (scheduler → worker → channel) и отдельный future sub-plan `commitment_kernel_persistent_worker_push.plan.md`. |
| Sub-plan of | `commitment_kernel_v1_master.plan.md`; depends on `commitment_kernel_self_feedback_loop_fix.plan.md` (provenance gate as safety-net), `commitment_kernel_pr4_chat_effects_cutover.plan.md` (Wave B `answer.delivered` affordance) |

## 1. Hard invariants this fix MUST keep

Перечень из `.cursor/rules/commitment-kernel-invariants.mdc`:

1. `ExecutionCommitment` tool-free — фикс не трогает kernel.
2. `Affordance` selector unchanged.
3. Production success requires `commitmentSatisfied(...) === true` — для `answer.delivered` уже работает; aggregation policy дополняет это lifecycle-условием «ровно 1 final message per user turn».
4. State-after fact requirement unchanged.
5. **No phrase / text-rule matching на UserPrompt outside whitelist** — aggregation gate смотрит на `InputProvenance.kind`, `subagent.terminalState`, `continuation` enum; никакой парсинг user-prompt-текста.
6. `IntentContractor` is the only reader of raw user text — verbatim forward worker→user НЕ кормит content в classifier; усиливает invariant.
7. `ShadowBuilder` unchanged.
8. `commitment` ↛ `decision` import direction — фикс правит только в `src/auto-reply/reply/**`, `src/agents/subagent-announce.ts`, `src/agents/subagent-spawn.ts`.
9. `DonePredicate` text-blind — не трогается.
10. `DonePredicate` lives on Affordance — не трогается.
11. Five legacy decision contracts frozen.
12. Emergency phrase / routing patches with retire deadline — фикс не emergency, structural.
13. `terminalState` / `acceptanceReason` orthogonality — оба populated на parent-final reply.
14. `ShadowBuildResult` typed union — не трогается.
15. PR human signoff — этот PR требует human signoff §0.6.
16. `EffectFamilyId` ≠ `EffectId` — не трогается.

## 2. Bug repro & evidence

### 2.1. Repro

1. `agents.defaults.model=hydra/gpt-5.4`, `gateway.mode=local` (или `--allow-unconfigured`).
2. Telegram → «Создай агента, который каждый день в это время присылает мне краткую сводку open-source AI-релизов за прошлые сутки. Запусти первый прогон сейчас».
3. Наблюдать в TG-чате последовательность сообщений parent'а.

### 2.2. Evidence (gateway log `terminals/466813.txt`)

| Stage | Lines | Что видно |
| --- | --- | --- |
| User-prompt classified | (ранее в логе) | parent classifier → `persistent_worker·tool_execution·0.87`, planner → `recipe=ops_orchestration` + `requestedTools=[sessions_spawn,...]` |
| Parent first reply (early partial) | (ранее в логе) | TG message «Пока есть только частичный результат… DeepSeek-R1 …» отправлено ДО завершения worker'а |
| Worker generates full S/M/L summary | 619-735 | Полная сводка: 10+ моделей, S/M/L разбивка, hardware estimates, ссылки — внутри worker, в parent ещё не ушло |
| Worker announce arrives at parent | ~736 | `[provenance-guard] kind=inter_session source=subagent_announce session=2943df22 → respond_only` — gate работает корректно: classifier не вызван, no re-spawn |
| Parent second user-facing turn | 737-743 | Planner → `recipe=general_reasoning`/`requestedTools=[]`/`outcomeContract=text_response`; LLM-pass пересказывает worker.content сжатой формой |
| TG получает сжатую LLM-summary | 744-772 | «Да, можем. Коротко…» — это lossy summary из 10+ моделей в 5 буллетов, не verbatim worker.content |

### 2.3. Где сейчас НЕТ нужного контракта

| Контракт | Где должен быть | Текущее состояние |
| --- | --- | --- |
| `subagent.terminalState` enum (`pending` / `running` / `complete` / `paused_with_deliverable` / `failed`) | `src/agents/subagent-types.ts` | TBD: проверить в §3 audit, есть ли уже схема terminalState; если нет — ввести как часть PR. |
| `userChannelHints` в spawn-time-context | `src/agents/subagent-spawn.ts` | TBD: проверить, доходит ли исходный TG-channel до worker'а / возвращается ли в announce. |
| Aggregation policy (when to publish final user-facing reply) | `src/auto-reply/reply/aggregation-policy.ts` | НЕ существует. |
| Verbatim forward path (worker.content → external channel) | `src/agents/subagent-announce.ts` queue/direct paths | Сейчас announce → callGateway({method:"agent"}) → новый turn → LLM-summarize. |

## 3. Hypothesis

В parent-сессии нет lifecycle-привязки между «закрыть user-facing turn» и «дождаться worker.terminalState=complete». Поэтому parent посреди работы worker'а закрывает свой first turn ранним partial-сообщением, а worker'овский full content приходит позже как announce → второй parent-turn → LLM-summarize → пользователь видит сжатую форму вместо verbatim'а.

Provenance gate (PR self-feedback-loop) корректно перехватывает announce и не даёт ему превратиться в новую `persistent_worker`-классификацию, но **не препятствует** самой LLM-summarize-фазе: `respond_only` baseline planner всё равно собирает text reply на announce-content. Нам нужен **более ранний** structural gate: announce от worker'а должен идти verbatim в external channel БЕЗ участия LLM, а parent должен заранее (ещё на исходном user-prompt'е) выпустить holding-message и не публиковать второй финальный pass.

## 4. Scope-of-fix matrix

| # | Layer | Файл | Изменение | LOC оценка | Invariant |
| - | ----- | ---- | --------- | ---------- | --------- |
| 1 | Aggregation policy | `src/auto-reply/reply/aggregation-policy.ts` (новый) | export `single_final_user_facing_message_per_user_turn` decision; helper `decideAggregationMode(spawnResult, channelHints): 'await' \| 'holding'` | ~80 | #5, #6 |
| 2 | Parent spawn → holding | `src/auto-reply/reply/agent-runner.ts` (или helper `subagent-aggregation.ts`) | если последний tool-call turn'а — `sessions_spawn` с continuation∈{followup,persistent_worker}, parent шлёт в external channel ОДНО holding-сообщение через delivery layer без LLM-pass; closing turn без второго reply | ~50–80 | — |
| 3 | Subagent metadata | `src/agents/subagent-types.ts` или `src/agents/subagent-announce.ts` | подтвердить/добавить `userChannelHints?: ChannelHints` в spawn-time-context и в announce payload; добавить `terminalState` enum если отсутствует | ~30 | — |
| 4 | Verbatim forward | `src/agents/subagent-announce.ts:queue/direct paths` | branch: если announce-target = original user channel + worker.terminalState ∈ {complete,paused_with_deliverable} → доставка через delivery layer verbatim, не через `callGateway({method:"agent"})` | ~50–80 | #5, #6 |
| 5 | Telemetry | `src/auto-reply/reply/aggregation-policy.ts` + `src/agents/subagent-announce.ts` | log events `[subagent-aggregation] mode=…`, `worker_terminal=…`, `delivered=…` | ~20 | — |
| 6 | Tests | новые: `aggregation-policy.test.ts`, `subagent-aggregation.test.ts`, `subagent-announce.aggregation.test.ts` | см. todo `tests-aggregation-policy` | ~150 | — |

**Итого**: ~230–310 LOC кода + 150 LOC тестов = ~380–460 LOC, 4–6 файлов. Превышает порог «<300 LOC, <5 files» → требует plan + signoff.

## 5. Acceptance criteria mapping

| Criterion | Закрывается через |
| --- | --- |
| 1. На каждый external_user-prompt parent-сессия выпускает ровно ОДНО финальное user-facing сообщение в исходный канал. | §4 #1 + #2 (aggregation policy + holding-message gate). |
| 2. Если turn спавнит subagent с continuation, parent выпускает либо holding-message, либо awaited-final, не оба, не partial-summary. | §4 #2 (gate) + tests `aggregation-policy.test.ts`. |
| 3. Когда worker.terminalState=complete, parent доставляет worker.content **verbatim** в исходный external channel ОДНИМ сообщением (минимальная обёртка allowed: «Готово:\n\n…»). | §4 #3 + #4 (userChannelHints + verbatim forward) + tests `subagent-announce.aggregation.test.ts`. |
| 4. Provenance gate (PR self-feedback-loop) НЕ срабатывает для worker.complete announce под happy path (verbatim path рулит ДО того как announce уйдёт через agent-method). Если safety-net всё-таки нужен — gate работает как раньше, regression covered. | §4 #4 + existing `input.provenance-gate.test.ts`. |
| 5. Live TG smoke (todo `live-smoke-evidence`): ОДИН holding + ОДИН verbatim final, ноль partial, ноль `provenance-guard kind=inter_session` повторов. | §4 #5 (telemetry) + manual smoke. |

## 6. Handoff Log

### 2026-04-28 — Bootstrap audit (trace-subagent-announce-flow)

Что прочитано:

- Master plan §0 / §0.5 / §3 (16 hard invariants) / §8.5 / §8.5.1.
- Sub-plan этот, full.
- Predecessor `commitment_kernel_self_feedback_loop_fix.plan.md` (provenance gate intact, line 736 evidence: `[provenance-guard] kind=inter_session source=subagent_announce session=2943df22 → respond_only`).
- Predecessor `commitment_kernel_pr4_chat_effects_cutover.plan.md` Wave B (`answer.delivered` affordance — frozen, не трогаем).
- `.cursor/rules/commitment-kernel-invariants.mdc`.
- Gateway log `terminals/466813.txt:619-820` (worker S/M/L summary 619-735, provenance-guard 736, второй turn planner=respond_only 737-743, lossy LLM-summary 744-772).
- Code: `src/agents/subagent-announce.ts` (1598 LOC), `src/agents/subagent-spawn.ts` (1042 LOC, focus on lines 382-547, 686-1018), `src/auto-reply/reply/agent-runner-utils.ts` (333 LOC), `src/auto-reply/reply/agent-runner.ts` фрагмент 990-1230 (общий 1636 LOC), `src/sessions/input-provenance.ts`, `src/agents/tools/sessions-spawn-tool.ts`, `src/gateway/server-methods/send.ts`.

Audit findings (плотно):

1. `userChannelHints` УЖЕ plumb'ится без необходимости новых слоёв.
   - `SpawnSubagentContext` (`subagent-spawn.ts:76-88`) содержит `agentChannel/agentAccountId/agentTo/agentThreadId`.
   - `spawnSubagentDirect` (line 382) собирает `requesterOrigin` через `normalizeDeliveryContext({channel,accountId,to,threadId})` (line 421-426).
   - `registerSubagentRun({...,requesterOrigin,...})` (line 929-947) персистит origin в run-store.
   - `runSubagentAnnounceFlow` принимает `params.requesterOrigin` и далее use'ает как `targetRequesterOrigin` / `directOrigin` / `completionDirectOrigin` (lines 1290-1534).
   → **НЕТ scope-creep**: §4 #3 `userChannelHints` уже доходит куда нужно.

2. `terminalState` уже представлен в `SubagentRunOutcome.status ∈ {ok,error,timeout,unknown}` (`subagent-announce.ts:1128-1131`). Mapping для нашей цели:
   - `terminalState=complete` ≡ `outcome.status === "ok"`.
   - `terminalState=failed` ≡ `outcome.status ∈ {error,timeout}`.
   - `paused_with_deliverable` НЕ нужен на cutover-1 first_pass scope (§0 scope clarifier).
   → **НЕТ scope-creep**: новый enum не нужен; верифицируем `outcome.status === "ok"` для verbatim path gate.

3. Текущий announce-flow (3 пути) — все идут через parent-LLM:
   - `sendAnnounce` queue path (`subagent-announce.ts:694-728`): `callGateway({method:"agent",inputProvenance:{kind:"inter_session"},deliver:!requesterIsSubagent})`.
   - `sendSubagentAnnounceDirectly` direct (lines 839-939): тот же агент-вызов с `inputProvenance.kind="inter_session"`.
   - `wakeSubagentRunAfterDescendants` wake (lines 1194-1256): то же, но `deliver:false` (intra-subagent, не наш кейс).
   - Каждый запускает `agent` runtime → провенанс-gate отрезает classifier (PR self-feedback-loop), но planner=respond_only LLM-pass всё равно запускается → lossy summary в TG.

4. Verbatim target — gateway `send` method (`src/gateway/server-methods/send.ts:91-334`):
   - Принимает `{to,message,channel,accountId,threadId,sessionKey,idempotencyKey}`.
   - `deliverOutboundPayloads` доставляет в внешний канал.
   - `mirror:{sessionKey,agentId,text,idempotencyKey}` пишет результат в session-store (mirror-side effect).
   - НЕ запускает LLM, НЕ запускает classifier/planner/runtime. Это **существующий контракт** verbatim-доставки.
   → §4 #4 verbatim path реализуется через `callGateway({method:"send", params:...})` БЕЗ новых server-methods.

5. Parent early-partial reply (TG message «Пока есть только частичный результат…»):
   - В turn'е, где LLM выдаёт `sessions_spawn` toolCall, LLM же эмитит assistant prose alongside.
   - Prose поднимается из `runResult.payloadArray` → `buildReplyPayloads` (`agent-runner.ts:1057-1078`) → `replyPayloads` → `deliverPayloads` (downstream).
   - Holding-message gate должен встать после получения `runResult` (где известно, что toolCalls включают `sessions_spawn` со status=accepted, mode=session) и заменить `payloadArray` на holding-template payload.

6. Provenance gate (PR self-feedback-loop, `0de967a51c`) сохраняется как safety-net:
   - На verbatim-path provenance-guard НЕ срабатывает потому что `callGateway({method:"send"})` НЕ запускает classifier (он запускается только из `agent` runtime).
   - На fallback-path (если verbatim-условия не сошлись и announce-flow доставляет через `agent` method), provenance-guard продолжает рубить inter_session → respond_only.

Scope check vs §4:

- §4 #1 aggregation-policy module — новый файл, без зависимостей от scope-creep.
- §4 #2 parent gate — единственное касание `agent-runner.ts` это post-LLM filter на `payloadArray` (≈30-50 LOC), либо выноска в helper `subagent-aggregation.ts`. НЕ касается frozen 4 call-sites (`plugin.ts:80,340`, `decision/input.ts:444,481`).
- §4 #3 userChannelHints / terminalState — проверено, изменений типов не требуется.
- §4 #4 verbatim forward — добавляется как branch в `runSubagentAnnounceFlow` ПЕРЕД `deliverSubagentAnnouncement` call'ом; на success — early return с `didAnnounce=true`.
- §4 #5 telemetry — log lines в обеих точках.
- §4 #6 tests — 3 новых файла + regression на существующие.

Hard invariants check (16):

- #5 (no phrase/text-rule matching на UserPrompt): gate работает по `outcome.status` enum + `runResult.toolCalls[].toolName` enum + `requesterOrigin?.channel/to` literals. Никакого парсинга prompt-text.
- #6 (IntentContractor sole reader of raw user text): verbatim path обходит parent-LLM, prose не идёт через classifier; усиливает invariant.
- #11 (5 frozen decision contracts): не трогаем `TaskContract/OutcomeContract/QualificationExecutionContract/ResolutionContract/RecipeRoutingHints`.
- #15 (human signoff): требуется до merge; будет запрошен после реализации + tests + tsgo (todo `human-signoff`).

Дальнейший order: define-final-reply-invariant → parent-await-subagent-terminal-state → subagent-announce-verbatim-forward → telemetry-and-logging → tests → tsgo → human-signoff → final-docs-commit. Никаких scope-блокеров.

### 2026-04-28 — Implementation pass

Что сделано:

- Branch: `fix/orchestrator-subagent-aggregation` от `origin/dev` (HEAD `0de967a51c`, после merge'а PR #105 self-feedback-loop).
- Новый module `src/auto-reply/reply/aggregation-policy.ts` (~250 LOC): структурный invariant `single_final_user_facing_message_per_user_turn`, helpers `decideAggregationMode` / `shouldVerbatimForwardCompletion` / `formatVerbatimWorkerContent` / idempotency-key builders / `formatAggregationLog` telemetry. Default mode = `holding` (Option A); `await` зарезервирован за future cron sub-plan'ом (Bug F).
- Новый helper `src/auto-reply/reply/subagent-aggregation.ts` (~230 LOC): `evaluateAggregationOverride` / `applyAggregationOverride` — gate на parent reply-flow. Detection через `executionVerification.receipts[].name === "sessions_spawn" && status === "success"` + `listSubagentRunsForRequester` для active continuation child (window=5min). При holding-decision возвращает `{ payloads: [{ text: HOLDING_MESSAGE_TEXT }] }` + emits telemetry `[subagent-aggregation] event=holding_sent`.
- `src/auto-reply/reply/agent-runner.ts` (+30 LOC): подключение `applyAggregationOverride` ПЕРЕД точкой генерации parent reply (frozen call-sites не тронуты).
- `src/agents/subagent-announce.ts` (+136 LOC): новая функция `tryDeliverVerbatimToUserChannel` использует `callGateway({method:"send"})` вместо `method:"agent"` — НЕ запускает classifier/planner/agent runtime; интегрирована в `runSubagentAnnounceFlow` ПЕРЕД `deliverSubagentAnnouncement`. Provenance gate из PR self-feedback-loop остаётся safety-net для fallback path-а. Idempotency keys прибиты к `childRunId+childSessionKey`.
- Tests: 5 файлов / 61 тест green (`aggregation-policy.test.ts` 5; `subagent-aggregation.test.ts` 13; `subagent-announce.aggregation.test.ts` 38; `input.provenance-gate.test.ts` 5 regression; `subagent-spawn.idempotency.test.ts` 11 regression).

Что НЕ сделано (по scope rules):

- Не трогали `src/platform/commitment/**` (PR-4b frozen).
- Не трогали 4 frozen call-sites (`plugin.ts:80,340`, `decision/input.ts:444,481` — теперь логически в frozen теле call'ов к `runTurnDecision` после insertion provenance gate).
- Не откатывали provenance gate из PR self-feedback-loop (опираемся на него как safety-net).
- Не ширили scope в Bug A/C/D/E/F — каждый получит свой sub-plan.

CI / quality gates:

- `pnpm tsgo` green.
- ReadLints clean.
- Targeted tests green (5 файлов / 61 тест).
- Полный `pnpm test` НЕ запускался; per AGENTS.md «scoped tests for narrowly scoped changes».

Manual repro (acceptance #4 / live-smoke-evidence):

- Кодовое доказательство покрыто: `subagent-aggregation.test.ts` тест `returns 'holding' override for persistent_session continuation in current turn` + `subagent-announce.aggregation.test.ts` verbatim forward.
- Live TG smoke остаётся за оператором после merge — оператор перезапускает gateway, шлёт промпт «Создай агента … запусти первый прогон» и наблюдает в логе ОДИН holding + ОДИН verbatim final без partial-update'ов.

Blockers: нет. Scope не превышен (~616 LOC = 480 implementation + 136 в subagent-announce). Все 16 invariant'ов соблюдены: §1 фиксирует места проверки.

Adjacent bugs (трекинг §8) — НЕ покрываются этим PR'ом. Приоритет следующих sub-plan'ов: **E > C > A > D > F** (см. §8 — приоритеты пересмотрены: E elevated до invariant-level; F добавлен).

## 7. References

- Master plan: `.cursor/plans/commitment_kernel_v1_master.plan.md`
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc`
- Predecessor (depended on as safety-net): `.cursor/plans/commitment_kernel_self_feedback_loop_fix.plan.md` (PR commit `970ee2b43d`)
- Predecessor (Wave B affordances): `.cursor/plans/commitment_kernel_pr4_chat_effects_cutover.plan.md`
- Predecessor (idempotency): `.cursor/plans/commitment_kernel_idempotency_fix.plan.md`
- InputProvenance type: `src/sessions/input-provenance.ts`
- Frozen call-sites (not touched): `src/platform/plugin.ts:80`, `:340`; `src/platform/decision/input.ts:444`, `:481`
- Frozen layer (not touched): `src/platform/commitment/**`
- Bug-report repro evidence: `terminals/466813.txt:619-820`

## 8. Adjacent bugs (NOT in scope; tracked for future sub-plans)

Порядок строго по приоритету (сверху вниз — order-of-execution для следующих PR'ов):

| Order | Bug | Симптом | Приоритет | Будущий sub-plan |
| ----- | --- | ------- | --------- | ----------------- |
| 1 | **E — Raw error утечка** (invariant-level) | Gateway-level отказы (например `[tools] cron failed: Only reminder scheduling is allowed from this chat`) утекают в external channel как сырая строка. **Invariant**: никакие raw tool errors / classifier dumps / debug strings / kernel rejections не должны попадать в external channel. | **high (invariant-level)** | `commitment_kernel_outbound_sanitizer.plan.md` (TBD) — отдельный invariant + delivery sanitizer. Делать в первую очередь — это invariant-уровень и виден пользователю на любом сбое. |
| 2 | **C — Recipe routing для `intent=publish`** | Planner для `intent=publish` выбирает `integration_delivery` без `exec`/`site_pack`; на второй итерации правильный `ops_orchestration`. Ранний refusal до правильной recipe. | high (UX-blocker) | `commitment_kernel_recipe_routing_publish.plan.md` (TBD) — самостоятельный быстрый PR; часть будущего `commitment_kernel_policy_gate_full.plan.md` (Master §8.5.1). |
| 3 | **A — Streaming-leak в external channel** | Tool-progress / intermediate assistant chunks утекают в TG как отдельные сообщения вместо буферизации в один final reply. | medium | `commitment_kernel_streaming_leak_fix.plan.md` (TBD). Частично смягчён нашим fix'ом (single-final invariant), но не полностью: tool-progress messages всё ещё могут утекать. |
| 4 | **D — Ambiguity over-blocking** | Classifier помечает `hosting unspecified` как `blocking` даже когда юзер явно сказал «локально». Должен быть `clarifying` либо вообще не возникать. | medium | часть `commitment_kernel_policy_gate_full.plan.md` (Master §8.5.1) — clarification-policy ветвь. |
| 5 | **F — Persistent worker subsequent push** | Cron-driven daily push'ы из persistent_worker'а в внешний канал (например ежедневная сводка open-source AI-релизов в TG в 09:00). Отдельный codepath (scheduler → worker.run → delivery), отдельные lifecycle-инварианты, отдельная политика (per-channel rate limits, опциональный summarize, idempotency). | medium | `commitment_kernel_persistent_worker_push.plan.md` (TBD). |

При работе по этому sub-plan'у НЕ ширить scope на A/C/D/E/F. Если в ходе реализации обнаружится коррелированный баг — фиксировать в Handoff §6 и пинать maintainer'а перед расширением.
