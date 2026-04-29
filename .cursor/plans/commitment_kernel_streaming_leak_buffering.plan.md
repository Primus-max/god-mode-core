---
name: Bug A.2 — block-streaming buffering at tool_call (PR-A.2)
overview: |
  Узкий фикс поверх Bug A (strip универсальных tool-call markers): при `blockStreamingEnabled` промежуточные assistant-text блоки до/во время tool execution всё ещё уходят в external channel как отдельные сообщения (coalescer), нарушая single-final UX для turn'ов с любым structural tool_call.

  Gate решения — только structural: `runResult.toolCalls.length > 0`, событие execution-time `handleToolExecutionStart` (toolCallId/toolName), или явный флаг состояния пайплайна; запрещено сопоставление текста partial deltas или UserPrompt (invariant #5).

  External vs internal: partial deltas продолжают доставляться в internal/control lane (`onPartialReply` / observability); external (`onBlockReply` → originating channel) буферизуются в один consolidated reply на turn при наличии tool_call.

  Составление с PR-G (holding-payload) и PR-aggregation (`mode=holding`): не дублировать финальные сообщения; не подавлять holding-сигнал; буферизация chunk-stream относится к block-reply path, не заменяет aggregation gate.

audit_gaps_closed: []

todos:
  - id: bootstrap-readonly-audit
    content: Прочитаны roadmap `pr-a2-buffering`, Bug A §8, PR-aggregation baseline, PR-G plan, `block-reply-pipeline.ts`, `block-streaming.ts`, `reply-delivery.ts`, `agent-runner-execution.ts`, точка `handleToolExecutionStart` + flush.
    status: completed
  - id: implement-buffering-state
    content: Расширить состояние рядом с `BlockReplyPipeline` / delivery handler (см. §4 matrix); ключ turnId + sessionKey/runId; без module singleton.
    status: completed
  - id: implement-external-buffer-and-replay
    content: Structural buffering external chunks от первого block до решения gate; replay через существующий coalescer при turn без tool_calls (§3).
    status: completed
  - id: telemetry
    content: `[block-stream-buffer] event=... turnId=... sessionId=... reason=<closed-string>` per roadmap §4.5.
    status: completed
  - id: integration-tests
    content: Пять тестов из §5 Acceptance (Vitest в `src/auto-reply/reply/**`).
    status: completed
  - id: tsgo-scoped-tests
    content: `pnpm tsgo`; `pnpm test --` scoped paths only.
    status: completed
  - id: branch-pr-docs-commit
    content: Ветка `fix/orchestrator-streaming-buffering`; финальный коммит roadmap + master §0 row по протоколу.
    status: pending

isProject: false
---

# Bug A.2 — block-streaming buffering at tool_call (PR-A.2)

## 0. Provenance

| Field | Value |
| --- | --- |
| Parent roadmap | `.cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md` — todo `pr-a2-buffering`, §3 row 2 |
| Baseline Bug A | `.cursor/plans/commitment_kernel_streaming_leak.plan.md` — §8 Adjacent bugs row 1 (Bug A.2) |
| Predecessors merged | PR-G [#111](https://github.com/Primus-max/god-mode-core/pull/111) `d0b3c3fc33`; Bug A `7f56fbd9ab`; PR-aggregation; self-feedback `970ee2b43d` |
| Target branch | `dev`; git branch `fix/orchestrator-streaming-buffering` off fresh `origin/dev` |
| Frozen layer | **Не затрагивается** (`src/platform/commitment/**` не трогать; 4 frozen call-sites; 5 frozen contracts) |

## 1. Hard invariants this fix MUST keep

Ссылка: `.cursor/rules/commitment-kernel-invariants.mdc` (все 16). Для PR-A.2 критично:

| # | Invariant | Как соблюсти |
| --- | --- | --- |
| 5 | Нет phrase/text-rule на `UserPrompt` / `RawUserTurn` вне whitelist | Решение о буферизации external partial **только** от structural сигналов: событие tool execution start (`handleToolExecutionStart`), итоговый `runResult.toolCalls`, флаги состояния пайплайна keyed по `(sessionId, turnId)`. **Запрещено** эвристики по содержимому text_delta / partial chunks. |
| 6 | `IntentContractor` — единственный reader сырого user text | Буферизация не читает user text. |
| 11 | Пять frozen decision contracts | Не трогать `TaskContract` / `OutcomeContract` / `QualificationExecutionContract` / `ResolutionContract` / `RecipeRoutingHints`. |
| Прочие | 1–4, 7–10, 12–14, 16 | Kernel и frozen contracts не менять; PR-H (`CLARIFICATION_POLICY_REASONS`) вне scope — не добавлять reasons. |

## 2. Hypothesis

**H1:** При включённом block-streaming coalescer отправляет каждый flushed блок в `onBlockReply` → external delivery. Для turn'ов с хотя бы одним structural tool_call это нарушает «один consolidated user-facing ответ» до финала (после Bug A остаётся проблема «спама партиалами», не только markers).

**H2:** Чтобы буферизовать и **preamble до первого tool_call** (fixed в roadmap), недостаточно включить буферизацию только после `handleToolExecutionStart`: к тому моменту часть partial уже ушла во external. Значит нужна стратегия **defer external delivery** для всех block-chunks до определения режима turn'а, с **replay** через существующий coalescer для ветки «tool_calls отсутствуют» (регресс Test 2).

**H3:** PR-G holding-payload эмитится отдельным путём (`applyAggregationOverride`); PR-A.2 не должен вызывать второй финальный hold или глушить holding telemetry.

## 3. Design (fixed совместимо с roadmap todo)

1. **Structural gate only:** режим «буферизовать external для всего turn'а» включается при первом **известном** факте tool_call в этом user-turn execution (как минимум событие перед выполнением инструмента — см. `handleToolExecutionStart` → flush path). Флаг `toolCallObservedInTurn` хранится в **экземпляре** состояния, привязанном к `(sessionKey или sessionId, turnId/runId)` текущего run; не глобально.

2. **Preamble до первого tool:** все external block payloads (после coalescer flush → `onBlockReply`) **деферятся** до `finalizeAfterRun` после `blockReplyPipeline.flush({ force: true })`. Так preamble до первого `handleToolExecutionStarting` не уходит в originating channel. При завершении run **без** structural tool — sequential **replay** тем же `streamingAwareBlockReply` (тот же текст и порядок блоков, что и без defer; **временная** дискретизация «burst в конце» вместо live streaming — осознанный trade-off против невозможности lookahead tool без oracle). При **с** structural tool — **один** merged payload (`mergeExternalDeferredReplyPayloads`).

3. **Internal lane:** `onPartialReply` (и связанные control/observability callbacks) **без изменения семантики** — каждый partial уходит как сейчас.

4. **Один consolidated external при tool_turn:** после наблюдения tool_call — все последующие external block replies для этого turn'а сливаются до одного финального emit (после финального текста ассистента / закрытия delivery по существующему контракту flush); конкретная точка склейки — в sub-plan implementation notes после аудита call graph (`flush`, `deliverPayloads`).

5. **Composition PR-G:** если aggregation уже отправил holding для `sessions_spawn`, буферизация chunk-stream не должна отправлять те же partial'ы в external до финала; порядок вызовов **in-turn aggregation first** (как сейчас в `agent-runner`), затем block-path — не дублировать final idempotency keys (`turnId:holding` / `turnId:final` из PR-G).

6. **Composition PR-aggregation `mode=holding`:** не вводить второй holding layer; при активном holding буферизация partial относится только к LLM block-stream, не к verbatim worker forward.

## 4. Scope-of-fix matrix

| # | Layer | Файл (ожидаемо) | Изменение | Invariant |
| --- | --- | --- | --- | --- |
| 1 | Pipeline state | `block-reply-pipeline.ts` или соседний helper | Экспорт типа `BlockReplyPipelineState`: буферы external chunk, `toolCallObserved`, `turnId`/`sessionKey`, join к coalescer flush | §4 roadmap (per-turn state) |
| 2 | Delivery split | `reply-delivery.ts` `createBlockReplyDeliveryHandler` | Развести external vs internal delivery для block payloads при активной буферизации; internal без блокировки | #5 |
| 3 | Embedded wiring | `agent-runner-execution.ts` / subscribe params | Проброс structural callback или установка флага при tool start + при финале run с пустым toolCalls для replay | #5 |
| 4 | Telemetry | `globals` / subsystem logger | Одна строка на решение gate | roadmap §4.5 |
| 5 | Tests | `*.test.ts` в `src/auto-reply/reply/**` | См. §5 | — |

**Запрещено:** `src/platform/commitment/**`; frozen call-sites; новые `CLARIFICATION_POLICY_REASONS`.

### 4.1 Forward-compatibility (roadmap §4)

1. Состояние per `(sessionId, turnId)` (или эквивалент composite key на уже существующих run/turn id из runner), не singleton.
2. Никакого `await` на shared mutex без timeout в новом коде.
3. Повторная оценка gate с тем же input → тот же режим (idempotent).
4. Нет cross-session leakage буферов.
5. Telemetry на turn (`[block-stream-buffer] event=... turnId=... sessionId=...`).
6. Никакой глобальной очереди без лимита concurrency — только per-turn buffer.

## 5. Acceptance criteria (integration tests)

| ID | Описание |
| --- | --- |
| T1 | LLM эмитит 10 partial deltas (включая preamble), между ними structural tool_call → **external** получает ровно **1** consolidated сообщение; **internal** получает все **10** partials (через mock `onPartialReply` или эквивалент observability lane). |
| T2 | Turn без tool_calls → replay/coalescer восстанавливает прежнее per-block streaming в external (**регресс**). |
| T3 | Turn с `sessions_spawn` + tool_call → external получает PR-G **holding** и один **final** после terminal subagent; нет double-final и нет leak partial'ов мимо holding semantics. |
| T4 | Двукратный вызов gate с тем же snapshot состояния → то же решение (idempotency hook для будущего concurrent broker). |
| T5 | Два concurrent turn'а на разных sessionId → буферы не смешиваются. |

Все сценарии — без проверки текста user prompt на ключевые слова; мок tool/stream только structural.

## 6. Exit criteria (before merge)

- [ ] `pnpm tsgo` green
- [ ] Scoped tests green (§5)
- [ ] Нет правок frozen слоёв / call-sites / пяти контрактов
- [ ] Sub-plan §3 design соблюдён (включая preamble + replay для no-tool)
- [ ] Отдельный `docs(plan)` коммит: `commitment_kernel_smart_orchestrator_roadmap.plan.md` todo `pr-a2-buffering` → `completed` + `merged_pr` / `merge_sha` / `merged_at`; §6 Handoff; master `commitment_kernel_v1_master.plan.md` §0 PR Progress Log row

## 7. Handoff Log

### 2026-04-29 — Implementation (branch `fix/orchestrator-streaming-buffering`)

- Реализация: `createExternalBlockReplyDeferral` + wrap вокруг `streamingAwareBlockReply` только для originating+routable; finalize после `blockReplyPipeline.flush`; structural notification `onStructuralToolExecutionStarting` до `flushBlockReplyBuffer` в `handleToolExecutionStart`.
- Тесты: `block-external-buffer.test.ts`; `pnpm tsgo` green.
- Остаётся после merge PR: `docs(plan)` roadmap todo `pr-a2-buffering` + master §0 row по протоколу пользователя.

## 8. References

- `.cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md` — §4 forward-compat, todo `pr-a2-buffering`
- `.cursor/plans/commitment_kernel_streaming_leak.plan.md` — Bug A baseline, §8 Bug A.2
- `.cursor/plans/commitment_kernel_subagent_result_aggregation.plan.md` — aggregation / holding
- `.cursor/plans/commitment_kernel_subagent_await.plan.md` — PR-G holding + lifecycle
- `.cursor/plans/commitment_kernel_v1_master.plan.md`
- `src/agents/pi-embedded-subscribe.handlers.tools.ts` — `handleToolExecutionStart`
- `src/auto-reply/reply/block-reply-pipeline.ts`, `reply-delivery.ts`, `agent-runner-execution.ts`
