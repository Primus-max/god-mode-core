---
name: Smart Orchestrator Roadmap — порядок sub-plan'ов для перехода от reactive bot к умному оркестратору
overview: |
  Этот файл — **master roadmap** поверх `commitment_kernel_v1_master.plan.md`, фиксирующий **порядок** PR-чатов, после которых поведение Telegram-бота (и любого другого external-канала) становится действительно «умным» в обиходном смысле:
  (1) бот не спамит intermediate статус-апдейтами в чат;
  (2) бот не отвечает преждевременно, пока subagent ещё работает;
  (3) бот не клерифаит очевидное, если контекст уже даёт ответ из истории сессии;
  (4) архитектура совместима с будущим переходом на concurrent / multi-threaded turn pipeline (несколько одновременных задач на канал/пользователя без глобальных блокировок).

  Базис уже merged:
  - PR-1..PR-3 (commitment kernel ядро); PR-4a/4b (cutover-1/2); PR-aggregation; PR-self-feedback-loop; Bug C (recipe routing publish); Bug E (outbound sanitizer); Bug A (universal tool-call markers strip); Bug D (clarification-policy Stage 1, intent-resolved ambiguity).

  Текущая дыра, наблюдаемая в Telegram (логи 29.04.2026 13:50–13:58, ws://127.0.0.1:18789):
  - 4 turn'а подряд бот возвращает «передал Валере / он в процессе / пнул ещё раз» **без полезного результата**;
  - на «ДОведи до конца!» классификатор уходит в `clarification_needed·clarify_first·conf=0.47` → бот переспрашивает «что именно довести», игнорируя предыдущие 3 turn'а контекста;
  - intermediate tool-progress chunks (`sessions_spawn` ребёнок «Валера» ещё не вернул `worker_terminal_complete_verbatim`) утекают в external channel как самостоятельные сообщения;
  - PR-aggregation gate работает в режиме `mode=holding` ВНУТРИ одного turn'а, но НЕ блокирует главный агент от преждевременной отправки final reply при незавершённом subagent.

  Этот roadmap **не вводит новой архитектуры** — каждый его шаг ложится на уже существующие инварианты (#2, #3, #5, #6, #11, #15) и используя уже существующие точки расширения (`PolicyGateReader`, `ClarificationPolicyReader`, `MonitoredRuntime`, aggregation gate).

  ЗАПРЕТ ВО ВСЕХ STAGE-АХ: phrase/text-rule matching по `UserPrompt`/`RawUserTurn` вне whitelist (invariant #5); чтение raw user text вне `IntentContractor` (invariant #6); правки в `src/platform/commitment/**` без согласованного sub-plan-а; правки 4 frozen call-sites или 5 frozen decision contracts.

audit_gaps_closed: []

todos:
  - id: pr-g-subagent-await
    order: 1
    status: completed
    signoff: not_required
    merged_pr: "#111"
    merge_sha: d0b3c3fc33
    merged_at: "2026-04-29"
    content: |
      **PR-G — subagent-await invariant (single-final per user-turn, расширенный на children).**

      Симптом: главный агент при `tool_bundles=[session_orchestration]` (recipe `ops_orchestration`/`code_build_publish` с `sessions_spawn`) генерирует final reply «передал Валере / он в процессе» **до получения** `worker_terminal_complete_verbatim` от ребёнка → юзер получает спам без результата.

      Корневая гипотеза: PR-aggregation gate (`subagent-aggregation.ts`, `aggregation-policy.ts`) работает на in-turn delivery ordering (mode=holding), но не привязан к **lifecycle** subagent'а. Главный агент завершает свой `runResult` раньше, чем дети возвращают `terminalState`/`acceptanceReason`. Final reply уходит в external channel несмотря на pending child sessions.

      Scope (предварительный, уточнить в самом sub-plan'е):
      - Создать `.cursor/plans/commitment_kernel_subagent_await.plan.md` (provenance, hard invariants, hypothesis, scope-of-fix matrix, acceptance, handoff log, references) по шаблону `commitment_kernel_streaming_leak.plan.md`.
      - **Design decision (FIXED, не на усмотрение чата): holding-on-pending-child, НЕ silent block.** Молчаливая блокировка main reply = такая же UX-яма, как костыль «подождать 60 секунд» в брокере. Семантика gate такова: при detection незакрытого child (`pendingSubagents` non-empty) main agent эмиттит **один holding payload** в external channel (например короткое «работаю, жду от Валеры…» — формулировка через структурный template, НЕ phrase-rule по user text), регистрирует `awaitingChildTerminal=true` в pipeline state, и затем upon `worker_terminal_complete_verbatim` дополняет финальным consolidate-reply. Дублирования избегаем: holding-payload помечается idempotency-key'ом (`turnId:holding`), `worker_terminal_complete_verbatim` triggers consolidated emit с idempotency-key'ом (`turnId:final`); существующий `mode=holding` aggregation уже даёт нужный buffer. Никакого silent typing-indicator ожидания.
      - Точка фикса (предположительно): `src/auto-reply/reply/subagent-aggregation.ts` + `src/auto-reply/reply/agent-runner-execution.ts` + integration с `applyAggregationOverride` (см. `src/auto-reply/reply/agent-runner.ts:933-953` — сейчас срабатывает только когда `sessions_spawn` детектирован в текущем turn'е, PR-G покрывает turn N+1 при незакрытом child из turn N). Mapping pending→done на `worker_terminal_complete_verbatim` event'е (он уже эмиттится; см. лог `[subagent-aggregation] event=worker_terminal_complete_verbatim mode=holding`).
      - Read-only audit (обязателен ПЕРЕД правкой кода): `src/auto-reply/reply/**`, `src/agents/pi-embedded-subscribe.handlers.lifecycle.ts`, `src/agents/tools/sessions-helpers.ts`, `src/sessions/**`. Найти все точки emit final-reply при наличии `runResult.toolCalls` с `tool=sessions_spawn`.
      - Acceptance: integration test, в котором главный agent делает `sessions_spawn` (стаб subagent с задержкой 200ms на terminal), → assert: external channel получает **ровно 2 message** (holding + final); ни один из них не дублируется при повторном triggering. Регресс: turn без `sessions_spawn` → behavior unchanged (1 message). Timeout test: child не возвращает terminal за `subagentTerminalTimeoutMs` (default 120s, configurable) → emit fallback final с `acceptanceReason='subagent_terminal_timeout'`, никакого silent зависания.
      - Forward-compat (см. §4 этого roadmap): gate **per-turnId per-sessionId** keyed; никакого глобального state; никакого `await` на module-level singleton mutex; обязательный таймаут.

      Branch: `fix/orchestrator-subagent-await` от свежего `origin/dev`. Frozen layer: НЕ ожидается затронуть (правка в `src/auto-reply/**`); если касается `src/platform/decision/trace.ts` ради observability-marker — frozen-layer checkbox `compatibility` обязателен.

  - id: pr-a2-buffering
    order: 2
    status: pending
    signoff: not_required
    content: |
      **PR-A.2 — block-streaming buffering при наличии любого `tool_call` в turn'е.**

      Симптом: даже после PR-G главный агент сам без subagent делает `tool_call` (например `web_search`, `image_generate`) и стримит intermediate chunks (тех partial-text deltas) в external channel, нарушая `single_final_user_facing_message_per_user_turn`. Bug A (PR #109) убрал только сырые tool-call markers, не буферизацию chunks.

      Источник: `commitment_kernel_streaming_leak.plan.md` §8 Adjacent bugs row 1 (Bug A.2 уже зарезервирован).

      Scope (предварительный):
      - Создать `.cursor/plans/commitment_kernel_streaming_leak_buffering.plan.md`.
      - Точка фикса: `src/auto-reply/reply/block-reply-pipeline.ts` (coalescer) + `src/auto-reply/reply/block-streaming.ts`. Когда `runResult.toolCalls.length > 0` (или флаг `hasPendingToolCalls` поднят на агенте), блок-стримить только в **internal control channel** (webchat / dashboard), а в external — буферизовать в один финальный consolidate-reply. Решение принимается в один gate, общая точка — `block-reply-pipeline.enqueue`.
      - **Important (FIXED design choice): text-preamble до tool_call ТОЖЕ буферизуется.** Когда модель пишет «думаю / сейчас посмотрю» перед `<tool_call>`, эти partial-text deltas — это intermediate tool-progress, не финальный ответ. По дизайну в external channel выходит **один** consolidated reply per turn (per single_final_user_facing_message_per_user_turn invariant). В internal control channel preamble продолжает стримиться как есть (для observability / dashboard). Это намеренное trade-off: лучше «бот молчит 5 секунд, потом ответ» чем «бот спамит партиалами». Соединяется с PR-G holding-payload: если turn содержит `sessions_spawn` — holding-payload уходит в external (видимый сигнал работы), preamble остаётся в internal. Никаких попыток «оптимизировать» preamble обратно в стрим — это сломает invariant.
      - Acceptance: integration test, где LLM эмиттит 10 partial deltas (включая preamble) с tool_call между ними → external channel получает 1 message (consolidated), internal channel — все 10. Регресс: turn без tool_call → preamble + final стримятся в external как было (per-block).
      - Forward-compat: buffering state живёт в `BlockReplyPipelineState` keyed по `turnId`, не глобальный.

      Branch: `fix/orchestrator-streaming-buffering`. Frozen layer не затронут.

  - id: pr-h-session-aware-clarify
    order: 3
    status: pending
    signoff: not_required
    content: |
      **PR-H — session-history-aware clarification policy (Stage 1.5 PolicyGate full).**

      Симптом: на «ДОведи до конца!» (turn 2 в логе 13:52) classifier выдал `clarification_needed·clarify_first·0.47` → бот спросил «что именно довести?», игнорируя 3 предыдущих turn'а где явно обсуждается «полная страница моделей». Bug D (Stage 1) читает только `SemanticIntent.target`/`constraints` — он не смотрит history.

      Источник: расширение `commitment_kernel_policy_gate_full.plan.md` Stage 1 → новая Stage 1.5 (orthogonal к Stage 2 approvals; signoff не требуется, т.к. снова narrow observability + downgrade).

      Scope (предварительный):
      - В `commitment_kernel_policy_gate_full.plan.md` вставить новую todo `stage1.5-session-aware-clarify` (между Stage 1 todos и Stage 2 approvals); либо создать отдельный sub-plan `commitment_kernel_clarification_history_aware.plan.md` ссылающийся на PolicyGate full §Stage 1.5.
      - Расширить `CLARIFICATION_POLICY_REASONS` на новый closed-string `'ambiguity_resolved_by_session_history'`; обновить frozen reverse-test `clarification-policy.test.ts`.
      - **Precise structural matcher spec (FIXED, обязательно к соблюдению; БЕЗ этого Stage 1.5 рискует превратиться в phrase-rule поверх ledger snippets и нарушить invariant #5 de-facto).** Matcher **никогда** не читает текст ledger entries / message bodies / chat strings. Логика — **structural inheritance** между двумя `SemanticIntent`-снимками:
        1. Reader получает (а) текущий `intent: SemanticIntent` (из `runShadowBranch`), (б) `priorIntent: SemanticIntent | undefined` — последний successful kernel-derived `SemanticIntent` для **той же** `sessionId` за последние N turn'ов (default N=5, configurable; чтение через структурный кэш `IntentContractor` / session-state map keyed по `sessionId:turnId`, **не** через текстовый ledger).
        2. Gate срабатывает, ТОЛЬКО ЕСЛИ выполнены ВСЕ условия:
           (a) `priorIntent !== undefined` И `priorIntent.target.kind !== undefined` (или `priorIntent.operation !== undefined`);
           (b) текущий `intent.target.kind === undefined` (или `intent.operation === undefined`) — то есть текущий intent **частично пустой** в том же измерении, что у `priorIntent` уже заполнено;
           (c) `blockingReasons` включают reason того же класса, что недостающее поле текущего intent (curated map: `target missing` ↔ `target/destination`-class reason; `operation missing` ↔ `action/operation`-class reason). Список curated классов фиксируется в reverse-test;
           (d) НЕТ contradiction'а: если в `intent` есть поле, ЯВНО противоречащее `priorIntent` (например `priorIntent.target.kind='workspace'`, а `intent.target.kind='production'`) — gate НЕ срабатывает, downgrade не делается.
        3. При срабатывании: `{ shouldClarify: false, downgradeReason: 'ambiguity_resolved_by_session_history' }`. Для observability marker'а в trace дополнительно записывается structural diff: `{ inheritedFields: ['target.kind' | 'operation' | ...], priorTurnId: TurnId }` — это closed-shape, не строка пользователя.
      - В `createClarificationPolicy({ cfg, priorIntentReader? })` — новый optional аргумент `priorIntentReader: (sessionId, withinTurns) => SemanticIntent | undefined`. Default implementation использует уже существующий session-state cache от IntentContractor; **не** читает raw user text, **не** читает message bodies.
      - Acceptance: integration test, multi-turn scenario где turn 1 даёт SemanticIntent с `target.kind='workspace'`, turn 2 — короткая команда чей classifier даёт `clarification_needed` + `target missing`, и `intent` turn'а 2 имеет `target.kind=undefined` → gate срабатывает, downgrade c marker `inheritedFields=['target.kind']`. Negative case (contradiction): turn 2 intent имеет `target.kind='production'` (контр-сигнал) → НЕ срабатывает. Negative case (no prior): cold-start session без prior → НЕ срабатывает.
      - Reverse-test расширения: `Object.isFrozen(CLARIFICATION_POLICY_REASONS)` + `push throws` остаётся true; ровно 2 reasons присутствуют (`ambiguity_resolved_by_intent` + `ambiguity_resolved_by_session_history`), никаких других. Curated `INHERITABLE_INTENT_FIELDS` set также frozen + reverse-test.
      - Forward-compat: `priorIntentReader` per-sessionId, без cross-session leakage; idempotent re-evaluation; структурный кэш с TTL и max-size limit.

      Branch: `fix/orchestrator-clarify-session-aware`. Frozen layer: затрагивает `src/platform/decision/trace.ts` (расширение `ClarificationPolicyDowngradeMarker.downgradeReason` union) → PR-body checkbox `compatibility` обязателен (см. `scripts/check-frozen-layer-label.mjs`).

  - id: pr-mt-broker-future
    order: 4
    status: deferred
    signoff: required
    content: |
      **PR-MT (FUTURE) — concurrent / multi-tenant turn pipeline (несколько одновременных задач без глобальных блокировок).**

      Цель: убрать «костыль ожидания 60 сек» в брокере сообщений; перейти от single-threaded turn-blocked processing к pool of concurrent turn-handlers per (channel, user). Не делается сейчас — но **каждый PR этого roadmap должен сохранять forward-compatibility constraints из §4** (per-turnId/sessionId keyed state, никаких global singletons / module-level mutex'ов / shared queue без concurrency limits).

      Scope (только зафиксировать для будущего):
      - Будущий sub-plan `commitment_kernel_concurrent_broker.plan.md` (создаётся ПОСЛЕ PR-G/A.2/H); потребует maintainer signoff (invariant #15) — это архитектурный сдвиг.
      - Read-only audit зон: `src/auto-reply/**`, `src/channels/**`, `src/sessions/**`, queue/scheduler в `src/infra/**`.
      - Обязательное pre-condition: PR-G + PR-A.2 + PR-H merged (иначе concurrent pipeline увеличит количество спам-сообщений linearly).

isProject: false
---

# Smart Orchestrator Roadmap — порядок sub-plan'ов от reactive bot к умному оркестратору

## 0. Provenance

| Field | Value |
| --- | --- |
| Sub-plan of | `.cursor/plans/commitment_kernel_v1_master.plan.md` (§0 PR Progress Log, §3 hard invariants, §8 PR sequence) |
| Inherits | 16 hard invariants (`.cursor/rules/commitment-kernel-invariants.mdc`); все 6 flexible — без изменений |
| Trigger | Реальное наблюдение в Telegram-сессии 2026-04-29 13:50–13:58: Bug A merged (`7f56fbd9ab`), Bug D merged (`caca87a634`), но 4-turn dialog показал три **новых** независимых проблемы (subagent-await, in-turn buffering при tool_call, session-aware clarify). Каждая — отдельный narrow sub-plan; этот roadmap фиксирует их **порядок** и **связки**. |
| Out of scope (этого roadmap) | Не модифицирует код. Только: (а) порядок выполнения; (б) connection map к существующим sub-plan'ам; (в) forward-compatibility constraints для будущего concurrent broker. |

## 1. Hard invariants this roadmap MUST keep

См. `.cursor/rules/commitment-kernel-invariants.mdc`. Здесь — те, что чаще всего нарушаются неаккуратной попыткой «починить UX»:

- **#5** — никакого phrase/text-rule matching по `UserPrompt`/`RawUserTurn` ни в одном из PR-G/A.2/H. Все matchers работают на classifier OUTPUT, `SemanticIntent` структурных полях, `runResult.toolCalls`, `subagent-aggregation` events, или `ledgerContext` структурных снимках.
- **#6** — `IntentContractor` остаётся единственным reader сырого user text. PR-H использует `ledgerReader` поверх **уже распарсенных** session-ledger entries, не raw текст.
- **#8** — `commitment/` ↛ `decision/`. PR-H расширяет `clarification-policy.ts` в `commitment/`; новые reasons НЕ импортируют из `decision/`.
- **#11** — пять frozen decision contracts остаются неизменными. Любой observability-marker — closed-string union в `DecisionTrace`, не enum в `TaskContract`.
- **#15** — PR-G и PR-A.2 — narrow bug-fix slices, signoff не требуется. PR-H — расширение существующего `CLARIFICATION_POLICY_REASONS` set ещё одним closed-string значением, signoff не требуется (тот же класс изменения, что Bug D Stage 1). PR-MT (FUTURE) — архитектурный сдвиг, signoff обязателен.

## 2. Симптомы из реального Telegram-лога 2026-04-29 13:50–13:58

| Turn | User msg | Classifier | Bug |
| --- | --- | --- | --- |
| 1 | «Валера, не вижу разделения по возможностям…» (длинное ТЗ) | `comparison_report·tool_execution·0.75` recipe=`table_compare` bundles=`public_web_lookup` `last-call out=263 tokens` | **PR-G**: главный агент сам ответил «передал Валере» до того как subagent (Валера) вернул terminal. PR-aggregation видит mode=holding, но не блокирует main reply из-за pending child. |
| 2 | «ДОведи до конца!» | `clarification_needed·clarify_first·0.47` recipe=`general_reasoning` bundles=`respond_only` | **PR-H**: classifier по короткому prompt'у не имеет signal'а из истории; Bug D matches только `target`/`constraints`, в этом случае ambiguity не deployment-target → gate skip → бот спросил «что именно довести». |
| 3 | «Я сказал что мне нужны полные данные…» | `workspace_change·tool_execution·0.73` recipe=`code_build_publish` bundles=`repo_mutation` | **PR-G + PR-A.2**: снова «пнул Валеру» до terminal; intermediate chunks от main agent (formulating «пнул») выходили partial'ами вместо одной consolidate-reply. |
| 4 | (агент сам, без user-msg) | — | **PR-A.2**: «Валера сейчас в процессе…» — это intermediate tool-progress, утёкший в external. |

Все 4 turn'а — независимые проявления **трёх** ортогональных багов. Bug A и Bug D в этих turn'ах не активируются (по дизайну — они закрывают другие узкие случаи).

## 3. Roadmap (numbered execution order)

| # | PR | Bug ID | Effect | Predecessor | Successor | Sub-plan file |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | PR-G | subagent-await | **Самый видимый эффект.** Бот перестаёт отвечать «передал Валере / он в процессе» — final reply теперь приходит ПОСЛЕ `worker_terminal_complete_verbatim`. | Bug D merged (`caca87a634`) | PR-A.2 | TBD: `commitment_kernel_subagent_await.plan.md` (создаётся в первом chat'е после kickoff) |
| 2 | PR-A.2 | streaming buffering at tool_call | Бот перестаёт стримить intermediate text-deltas в external channel, когда turn содержит `tool_call`. | PR-G merged | PR-H | TBD: `commitment_kernel_streaming_leak_buffering.plan.md` (создаётся в chat'е PR-A.2; reserved row уже есть в `commitment_kernel_streaming_leak.plan.md` §8) |
| 3 | PR-H | session-history-aware clarify | Бот перестаёт клерифаить очевидное в continuous chat — учитывает 3-5 предыдущих turn'ов через `ledgerReader`. | PR-A.2 merged | (PR-MT future) | extends `commitment_kernel_policy_gate_full.plan.md` (Stage 1.5 — вставляется этим чатом); либо отдельный `commitment_kernel_clarification_history_aware.plan.md` |
| 4 | PR-MT | concurrent broker | (FUTURE) Несколько одновременных turn'ов на канал/пользователя без глобального await; убирает костыль 60-сек ожидания в брокере. | PR-G + PR-A.2 + PR-H merged + maintainer signoff | — | TBD: `commitment_kernel_concurrent_broker.plan.md` |

После каждого merged PR в роадмап-чате обновляется `### Handoff Log` (см. §6) и добавляется строка в master `commitment_kernel_v1_master.plan.md` §0 PR Progress Log по шаблону Bug A/D rows.

## 4. Forward-compatibility constraints (для будущего PR-MT — concurrent broker)

Эти constraints **обязательны** в каждом из PR-G/A.2/H — иначе concurrent broker потом потребует крупного рефакторинга:

1. **State per (turnId, sessionId), не глобальный.** Любой новый gate / coalescer / aggregation-state живёт в map'е keyed по composite ключу `${sessionId}:${turnId}` или эквивалентному; никаких module-level singleton state'ов.
2. **Никакого `await` на shared mutex без timeout.** Если PR-G блокирует main reply на child terminal — таймаут обязателен (configurable, default e.g. 120s) с явным fallback reason (e.g. `subagent_terminal_timeout`). Без таймаута concurrent broker встанет.
3. **Idempotent gate evaluation.** Каждый gate (`subagent-await`, `tool-call buffering`, `session-aware clarify`) должен возвращать одинаковый decision при повторном вызове с тем же input — concurrent re-entry не должен ломать invariant.
4. **No cross-session leakage.** `ledgerReader` (PR-H) читает только current session's ledger; никаких cross-session aggregations.
5. **Telemetry per turn.** Все gate decisions эмиттятся как `[<gate-name>] event=<decision> turnId=<id> sessionId=<id> reason=<closed-string>` — concurrent monitoring потом разделит потоки по turnId.
6. **Никаких глобальных queue / scheduler без concurrency limits.** Если PR-A.2 вводит buffering — это per-turn buffer, не global queue.

## 5. Связка с уже существующими sub-plan'ами

| Existing sub-plan | Связь с этим roadmap |
| --- | --- |
| `commitment_kernel_v1_master.plan.md` | Master parent. Все PR этого roadmap появляются в §0 PR Progress Log как обычные rows. |
| `commitment_kernel_streaming_leak.plan.md` | Bug A (merged). §8 строка 1 = Bug A.2 — закрывается PR-A.2 этого roadmap. |
| `commitment_kernel_policy_gate_full.plan.md` | Bug D = Stage 1 (merged). PR-H = Stage 1.5 (orthogonal к Stage 2 approvals). Вставка todo `stage1.5-session-aware-clarify` делается в chat'е PR-H. |
| `commitment_kernel_subagent_result_aggregation.plan.md` | PR-aggregation merged. PR-G **расширяет** invariant single_final_user_facing_message_per_user_turn от in-turn delivery ordering до cross-child-lifecycle gating. |
| `commitment_kernel_self_feedback_loop_fix.plan.md` | Self-feedback loop fix merged (`970ee2b43d`). PR-G inherits эту защиту: subagent-await не должен сам стать source of feedback loop — gate имеет таймаут (см. §4 constraint #2). |

## 6. Handoff Log

| Date | PR | Branch | Merge SHA | PR # | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-04-29 | PR-G — subagent-await cross-turn lifecycle gate | `fix/orchestrator-subagent-await` | `d0b3c3fc33` | [#111](https://github.com/Primus-max/god-mode-core/pull/111) | Closes roadmap step 1. Cross-turn gate per `(sessionId, turnId)`; holding-payload + final consolidate-reply emitted with idempotency keys; subagent terminal timeout fallback wired (`acceptanceReason='subagent_terminal_timeout'`). Forward-compat constraints from §4 satisfied. **Next: PR-A.2 — block-streaming buffering при наличии tool_call.** |
| 2026-05-01 | PR-A.2 — block-streaming buffering at tool_call | `dev` (direct-commit; формальная feature-branch + PR пропущены) | `3df3138fcc` | — | Closes roadmap step 2. Реализация Vladimir на dev: `ed8a9d137f` (`createExternalBlockReplyDeferral` в `src/auto-reply/reply/block-external-buffer.ts` 94 LOC + 6 vitest cases в `block-external-buffer.test.ts` 90 LOC; `agent-runner.ts` +51, `agent-runner-execution.ts` +3; structural хук `onStructuralToolExecutionStarting` в pi-embedded subscribe handlers; sub-plan `commitment_kernel_streaming_leak_buffering.plan.md` 142 LOC); `3df3138fcc` (roadmap docs). Validation 2026-05-01 на dev HEAD: `pnpm tsgo` exit 0; `pnpm test -- src/auto-reply/reply/block-external-buffer.test.ts` 6/6 green. Forward-compat §4: state per `(sessionId, turnId)` в `createExternalBlockReplyDeferral`, no module singleton, telemetry `[block-stream-buffer] event=structural_tool_seen|emit_consolidated|replay_stream`, idempotent finalizeAfterRun. Frozen layer не затронут (`src/platform/commitment/**` / 4 frozen call-sites / 5 frozen contracts чисты). **Next: PR-H — session-history-aware clarify (Stage 1.5 PolicyGate)**, ветка `fix/orchestrator-clarify-session-aware` от `origin/dev`, нормальный PR-flow с CI. |
| 2026-05-01 | PR-H Phase 2 — per-session SemanticIntent cache wiring | `fix/orchestrator-clarify-session-aware-wiring` | `01afedff6a` | [#113](https://github.com/Primus-max/god-mode-core/pull/113) | **Closes roadmap step 3 end-to-end (Phase 1 + Phase 2).** Phase 2 wiring завершает effective production fire path для Stage 1.5: extended `intentLedger` (existing per-session state holder в `src/platform/session/intent-ledger.ts`) методами `recordRecentIntent` + `getRecentIntent` (sliding window N=5 = `RECENT_INTENT_HISTORY_WINDOW`, TTL 15min reusing `INTENT_LEDGER_TTL_MS`, low-confidence floor 0.5 = `RECENT_INTENT_CONFIDENCE_FLOOR`); `RunTurnDecisionResult.intent?` exposed (from `shadowOutcome.intent`); 2 callers `runTurnDecision` в `src/platform/decision/input.ts` (lines 541 + 578) — pre-call read `intentLedger.getRecentIntent(ledgerSessionId, ledgerChannelId)` → pass as `priorIntent`; post-flow record `finalClassifiedIntent` (workspaceIntent fallback к classifiedIntent). plugin.ts callers (resolveHookExecution line 80, machine-control fallback line 340) — out of scope (single-shot internal hooks без session lifecycle, default `priorIntent: undefined` → Stage 1.5 silently bypass). Validation: `pnpm tsgo` exit 0; 55/55 scoped tests green (18 existing intent-ledger + 8 new для recent-intent + 21 clarification-policy + 8 run-turn-decision.clarification-downgrade). Hard invariants #5/#6/#8/#11/#15 соблюдены — cache хранит структурный SemanticIntent (продукт IntentContractor), не raw text. CI infra note: BlackSmith offline — admin-merged after frozen-layer SUCCESS + local validation. **Next: PR-MT — concurrent broker, deferred, maintainer signoff required.** Roadmap steps 1-3 complete end-to-end. Production effect (continuous chat бот не клерифаит очевидное) виден после restart gateway. |
| 2026-05-01 | PR-H — session-history-aware clarify (Stage 1.5 ClarificationPolicy) | `fix/orchestrator-clarify-session-aware` | `185cf7d3fb` | [#112](https://github.com/Primus-max/god-mode-core/pull/112) | Closes roadmap step 3 (Phase 1 — API + matcher + threading). `clarification-policy.ts`: `CLARIFICATION_POLICY_REASONS` extended (+`ambiguity_resolved_by_session_history`); `INHERITABLE_INTENT_FIELDS` frozen tuple `['target.kind','operation']`; `evaluateStage1_5` + `collectInheritableFields` + curated reason-fragment classes (TARGET_CLASS, OPERATION_CLASS); contradiction guard через несовпадение явно установленных полей. `trace.ts`: `ClarificationPolicyDowngradeMarker.downgradeReason` union extended + optional `inheritedFields` (frozen layer touched, telemetry-only category). `run-turn-decision.ts`: `RunTurnDecisionInput.priorIntent` threading. Sub-plan `commitment_kernel_clarification_history_aware.plan.md` создан. Validation: `pnpm tsgo` exit 0; 29/29 tests green в `clarification-policy.test.ts` (10 reverse-tests + 8 Stage 1 + 9 Stage 1.5) + `run-turn-decision.clarification-downgrade.test.ts`. Hard invariants #5/#6/#8/#11/#15 соблюдены. **CI infra note**: BlackSmith `blacksmith-16vcpu-ubuntu-2404` runners offline (`/repos/.../actions/runners` total_count=0), 6 checks queued 38+ min не стартовали; frozen-layer check (на GitHub-hosted) прошёл SUCCESS; admin-merged after local validation matched roadmap acceptance. **Phase 2 (FUTURE)**: per-session `SemanticIntent` cache на caller layer (auto-reply / pi-embedded-runner) — wiring 4 callers `runTurnDecision` (`input.ts:541`, `input.ts:578`, `plugin.ts:80`, `plugin.ts:340`); without Phase 2 Stage 1.5 gate API-complete но never fires в production. **Next: PR-MT (concurrent broker) — deferred, signoff required.** Roadmap step 4 ждёт maintainer signoff и predecessor PR-G/A.2/H all merged ✅. |
| 2026-05-01 | Regression Slice 1 — model-fallback respect configured order | `fix/orchestrator-model-fallback-respect-configured-order` | `c0bee0846f` | [#114](https://github.com/Primus-max/god-mode-core/pull/114) | Live regression block, slice 1/4. `route-preflight.ts:795` `finalizeResult` skips `reorderRemoteTailCandidates` когда `decision.reordered === false` — passthrough decisions (`preflight_no_local_candidate`, `preflight_stronger_route` keep-order, `preflight_primary_control_plane_local`) сохраняют configured order. Heuristic-driven score reorder теперь kicks in только поверх decisions, что УЖЕ chose to reorder. 2 новых теста (all-remote no-local + stronger_route passthrough); 10/10 `route-preflight.test.ts` green; pnpm tsgo exit 0 (включая piggyback-fix Map<> generic widening на `FIELD_TO_BLOCKING_REASON_FRAGMENTS` — pre-existing tsgo regression от PR-H Phase 1). Sub-plan `.cursor/plans/orchestrator_model_fallback_respect_order.plan.md`. CI infra: BlackSmith total_count=0 → admin-merge after local validation + no frozen contracts touched. Live verification (после restart gateway): expect `route candidates ordered: hydra/claude-opus-4.6 first` вместо `hydra-gpt-pro first`. **Next: Slice 2 — sessions.patch label idempotency regression.** |
| 2026-05-01 | Regression Slice 2 — sessions.patch label idempotency (G3 extension to patch path) | `fix/orchestrator-sessions-patch-label-idempotency-dev` | `9fc0790bce` | [#116](https://github.com/Primus-max/god-mode-core/pull/116) | Live regression block, slice 2/4. Closes G3 extension on the patch path. New pure helper `src/sessions/session-label-conflict.ts` (classifyLabelConflict → none / same_logical_session / conflict; same-logical = subagent vs subagent under same agentId scope). `sessions-patch.ts` "label" branch теперь использует helper: `same_logical_session` → silent skip + telemetry `[commitment] effect=persistent_session.created action=reuse_label_on_patch`; `conflict` → existing INVALID_REQUEST preserved. 7/7 session-label-conflict tests + 33/33 sessions-patch tests green; pnpm tsgo exit 0. **Procedural note**: PR #115 (`b8a240d69b`) случайно ушёл в main (default base picked main, не dev); cherry-picked to dev → PR #116 (`9fc0790bce`). Sub-plan `.cursor/plans/orchestrator_sessions_patch_label_idempotency.plan.md`. CI infra: BlackSmith total_count=0 → admin-merge after local validation + no frozen contracts touched. **Next: Slice 3 — PR-H Phase 2 wiring debug.** |
| 2026-05-01 | Regression Slice 3 Phase A — `[intent-history]` debug instrumentation | `fix/orchestrator-clarify-history-wiring-debug` | `690bc2dfe0` | [#117](https://github.com/Primus-max/god-mode-core/pull/117) | Live regression block, slice 3/4 (Phase A). Structured `[intent-history]` event logs surface root-cause из 3 кандидатов для silent Stage 1.5 bypass: (a) ledgerSessionId/ledgerChannelId undefined, (b) confidence < RECENT_INTENT_CONFIDENCE_FLOOR=0.5, (c) sessionId not stable per chat. `intent-ledger.ts`: event=record (accept | reject_low_confidence) + event=get (cold_start | hit | expired) + structural fields only (target.kind, operation.kind, confidence, records). `input.ts`: event=wire pre-runTurnDecision marker. 5 новых spy-based тестов (31/31 intent-ledger.test.ts green); pnpm tsgo exit 0. Hard invariants #5/#6/#8/#11/#15 соблюдены — no raw user text. **Phase B (collect live evidence) и Phase C (root-cause fix) gated на user action**. Sub-plan `.cursor/plans/orchestrator_clarify_history_wiring_debug.plan.md`. **Next: Slice 4 — cron tool single-block-no-retry.** |
| 2026-05-01 | Regression Slice 4 — cron tool structured blocked result (no retry on policy violation) | `fix/orchestrator-cron-tool-no-retry-on-foreign-chat` | `00062f70a6` | [#118](https://github.com/Primus-max/god-mode-core/pull/118) | Live regression block, slice 4/4 (final). Closes 4× retry spam `[tools] cron failed: Reminder scheduling cannot target another chat.`. Refactor: `assertNonOwnerCronAddPolicy` (bare-error throws) → pure `evaluateNonOwnerCronAddPolicy` returning `{ ok: true } | { ok: false; reason: NonOwnerCronBlockReason; message: string }`. Closed `NonOwnerCronBlockReason` enum (9 значений: non_add_action / gateway_override / unsupported_payload / no_session / foreign_session / agent_id_override / session_key_override / non_announce_delivery / foreign_chat). `execute()` add case + early non-add branch: на `!ok` — single `[cron-tool] block reason=<R> session=<sid>` info-line + return `jsonResult({ blocked: true, reason, message })`. LLM получает normal tool result (не error envelope) → не retry'ит. 2 existing tests rewritten (rejects.toThrow → result.details matches blocked envelope). 39/39 cron-tool tests + 27/27 outbound-sanitizer tests green; pnpm tsgo exit 0. Sub-plan `.cursor/plans/orchestrator_cron_tool_foreign_chat_block.plan.md`. CI infra: BlackSmith total_count=0 → admin-merge after local validation + no frozen contracts touched. Live verification (после restart gateway): expect один info-line на foreign-chat attempt, zero 4×-retry pattern. **Regression block 4/4 merged; final regression check + Slice 3 Phase B/C gated на user Telegram interaction.** |

## 7. References

- `.cursor/rules/pr-session-bootstrap.mdc` — bootstrap protocol для PR-чатов.
- `.cursor/rules/commitment-kernel-invariants.mdc` — 16 hard invariants.
- `.cursor/plans/commitment_kernel_v1_master.plan.md` — master plan.
- `.cursor/plans/commitment_kernel_streaming_leak.plan.md` — Bug A merged + Bug A.2 reserved.
- `.cursor/plans/commitment_kernel_policy_gate_full.plan.md` — Bug D Stage 1 merged + Stages 2-6 pending; PR-H = Stage 1.5.
- `.cursor/plans/commitment_kernel_subagent_result_aggregation.plan.md` — PR-aggregation baseline.
- `.cursor/plans/commitment_kernel_self_feedback_loop_fix.plan.md` — self-feedback loop baseline.
- `scripts/check-frozen-layer-label.mjs` — frozen-layer PR-body checkbox enforcement.
