---
name: Subagent-await — cross-turn lifecycle gate (PR-G)
overview: |
  Закрывает один из трёх независимых багов orchestrator UX (см.
  `commitment_kernel_smart_orchestrator_roadmap.plan.md` todo `pr-g-subagent-await`):
  на turn N+1 главный агент эмиттит финальный reply («пнул Валеру ещё раз»,
  «передал заново», «он в процессе») в external channel, ХОТЯ subagent,
  спавненный на turn N, ещё в процессе и `terminalState` не достигнут.
  Существующий PR-aggregation gate (`subagent-aggregation.ts`,
  `applyAggregationOverride`) срабатывает ТОЛЬКО когда `runResult` текущего
  turn'а содержит `sessions_spawn` (in-turn), и поэтому пропускает text-only
  reply на turn N+1.

  Симптом (gateway log `terminals/264924.txt`, 2026-04-29 13:38–13:58):
  - 4 раза за час: `[ws] ⇄ res ✗ sessions.patch errorCode=INVALID_REQUEST errorMessage=label already in use: Валера` (строки 569, 589, 666, 763).
  - Каждое вхождение следует за parent text-only reply («пнул Валеру», «передал заново», «Валера сейчас в процессе») на turn N+1 при незакрытом child из turn N. Reply text триггерит classifier → planner → новый `sessions_spawn` с тем же label'ом → конфликт label.

  ЖЁСТКО (do NOT violate):
  - Trogue ТОЛЬКО `src/auto-reply/reply/**` (frozen layer не затрагивается).
    Опционально `src/platform/decision/trace.ts` (frozen — требует PR-body checkbox `compatibility`); в этом PR observability marker НЕ добавляется, чтобы остаться вне frozen surface'а.
  - НЕ трогать `src/platform/commitment/**`, 4 frozen call-sites
    (`src/platform/plugin.ts:80`, `:340`, `src/platform/decision/input.ts:541`, `:578`),
    или 5 frozen decision contracts (TaskContract / OutcomeContract /
    QualificationExecutionContract / ResolutionContract / RecipeRoutingHints).
  - Все 16 hard invariants (`.cursor/rules/commitment-kernel-invariants.mdc`).
    В частности:
    — invariant #5 (no phrase / text-rule matching на UserPrompt / RawUserTurn
      outside whitelist): gate РЕШАЕТ исключительно по lifecycle-полям
      `SubagentRunRecord` (`spawnMode`, `expectsCompletionMessage`,
      `endedAt`, `createdAt`, `runId`) и literal-полям `DeliveryContext`
      исходного канала. НИКАКОГО доступа к classifier output text,
      assistant text, raw user prompt;
    — invariant #6 (`IntentContractor` is the only reader of raw user text):
      gate не вызывается из `IntentContractor` и не получает на вход
      raw user text;
    — invariant #11 (5 frozen decision contracts): не затронуты;
    — invariant #15 (PR-1 / PR-1.5 / PR-2 / PR-3 require maintainer signoff):
      этот PR — narrow bug-fix slice (см. roadmap §1 для PR-G), signoff
      не требуется.

  Forward-compat (см. roadmap §4):
  1. State per (parentSessionKey, childRunId) + 30-сек idempotency window — никакого глобального state'а или module-level mutex'а.
  2. Mandatory timeout: после > 120s без terminal + 2 предыдущих holding в окне 5min — passthrough с telemetry.
  3. Idempotent gate evaluation: один и тот же (parent, child) в окне 30s не должен дублировать holding.
  4. No cross-session leakage: `findOldestPendingContinuationChild(parentSessionKey, ...)` фильтрует ТОЛЬКО records с этим `requesterSessionKey`.
  5. Telemetry: события `[subagent-aggregation] event=pending_child_holding_sent`, `event=pending_child_timeout`, `event=pending_child_idempotent_skip`.

audit_gaps_closed:
  - O5 (parent text-only reply на turn N+1 при незакрытом child из turn N утекает в external channel и через classifier → planner → дублирует sessions_spawn → label-collision)

todos:
  - id: bootstrap-and-confirm-bug
    content: |
      Прочитан master plan §0/§0.5/§16, `.cursor/rules/commitment-kernel-invariants.mdc`,
      `commitment_kernel_smart_orchestrator_roadmap.plan.md` (todo `pr-g-subagent-await`),
      `commitment_kernel_subagent_result_aggregation.plan.md` (предыдущая
      in-turn aggregation gate, merged через PR #106). Получено evidence
      из `terminals/264924.txt` (4 occurrences `label already in use: Валера`
      строки 569 / 589 / 666 / 763 за один час).
    status: completed
  - id: design-fix-before-coding
    content: |
      Design зафиксирован в §3 (rules ниже verbatim). Per (sessionId, turnId)
      keyed, без global state. Lifecycle-only decision rule. Mandatory
      timeout. Idempotency 30s window.
    status: completed
  - id: implement-find-pending-child
    content: |
      Добавить read-only helper
      `findOldestPendingContinuationChild(parentSessionKey, nowMs, lookbackMs)`
      в `src/auto-reply/reply/subagent-aggregation.ts`. Reuse существующих
      `listSubagentRunsForRequester` queries.
    status: pending
  - id: implement-evaluate-pending-child-override
    content: |
      Добавить `evaluatePendingChildOverride(params)` — same shape как
      `evaluateAggregationOverride`, но триггерится БЕЗ требования
      `sessions_spawn` в текущем `runResult`. Только pending continuation
      child + user-channel target. Включает 30s idempotency + 120s+2x timeout.
    status: pending
  - id: wire-apply-aggregation-override
    content: |
      `applyAggregationOverride` сначала пробует in-turn check (existing
      behavior, unchanged), при passthrough fallback'ом вызывается
      `evaluatePendingChildOverride`. Order matters: in-turn first → cross-turn fallback.
    status: pending
  - id: tests-pending-child
    content: |
      Tests в `src/auto-reply/reply/subagent-aggregation.pending-child.test.ts`:
      (1) turn N spawns persistent child → existing holding fires (regression);
      (2) turn N+1 без sessions_spawn при running child → новый holding fires;
      (3) turn N+1 без sessions_spawn после child terminal (endedAt set) → passthrough;
      (4) cross-session isolation: pending child в другой сессии не влияет;
      (5) timeout: child > 120s + 2 prior holdings в 5min → passthrough + telemetry;
      (6) idempotency: same (parent, child) в 30s → второй call не дублирует holding.
    status: pending
  - id: tsgo-and-scoped-tests
    content: |
      `pnpm tsgo` green. Targeted: `pnpm test -- src/auto-reply/reply/subagent-aggregation src/auto-reply/reply/subagent-aggregation.pending-child` — все green.
    status: pending
  - id: commit-and-pr
    content: |
      Commits на русском, без Co-authored-by, без Made-with footers. Через
      scripts/committer (если доступен). PR off `fresh origin/dev`, branch
      `fix/orchestrator-subagent-await`. PR body — без `compatibility` checkbox
      (frozen layer не затрагивается).
    status: pending
  - id: post-merge-docs
    content: |
      После merge (отдельный `docs(plan):` коммит): добавить строку в master §0
      PR Progress Log + handoff log §6 этого плана + handoff log §6
      `commitment_kernel_smart_orchestrator_roadmap.plan.md`.
    status: pending
isProject: false
---

# Subagent-await — cross-turn lifecycle gate (PR-G)

## 0. Provenance

| Field | Value |
| --- | --- |
| Bug report ts | 2026-04-29 |
| Repo / branch | `god-mode-core` / `dev` (HEAD `171ed39ccc`, после merge'а Bug D `caca87a634`) |
| Detected via | live TG session, persistent worker `Валера`; gateway log `terminals/264924.txt:569,589,666,763` |
| Final merge target | `dev`, single PR `fix(orchestrator): cross-turn lifecycle gate for pending subagent` |
| Production routing change | YES (parent на turn N+1 при незакрытом child выдаёт holding-сообщение вместо text-reply) |
| Out-of-scope | `src/platform/commitment/**`; 4 frozen call-sites; provenance gate из PR self-feedback-loop; recipe routing (Bug C); ambiguity policy (Bug D); raw-error sanitizer (Bug E); streaming-leak chunker (Bug A.2); cron-driven persistent_worker push'ы (Bug F); session-history-aware clarify (PR-H) |
| Sub-plan of | `commitment_kernel_v1_master.plan.md`; ROADMAP `commitment_kernel_smart_orchestrator_roadmap.plan.md` (todo `pr-g-subagent-await`); depends on `commitment_kernel_subagent_result_aggregation.plan.md` (PR-aggregation in-turn gate) + `commitment_kernel_self_feedback_loop_fix.plan.md` (provenance gate как safety-net) + `commitment_kernel_policy_gate_full.plan.md` Stage 1 (Bug D — clarification policy frozen reverse-test) |

## 1. Hard invariants this fix MUST keep

Перечень из `.cursor/rules/commitment-kernel-invariants.mdc`:

1. `ExecutionCommitment` tool-free — фикс не трогает kernel.
2. `Affordance` selector unchanged.
3. Production success requires `commitmentSatisfied(...) === true` — gate
   не подменяет `commitmentSatisfied`; aggregation policy расширяется
   lifecycle-условием «ровно 1 final user-facing message per user turn».
4. State-after fact requirement unchanged.
5. **No phrase / text-rule matching на UserPrompt outside whitelist** —
   gate работает по `SubagentRunRecord.spawnMode/expectsCompletionMessage/endedAt/createdAt/runId`
   enum / number values + `DeliveryContext.channel`/`to` literals. БЕЗ
   парсинга classifier output text, assistant text, raw user prompt.
6. `IntentContractor` is the only reader of raw user text — gate не
   получает на вход и не вызывает `IntentContractor`.
7. `ShadowBuilder` unchanged.
8. `commitment` ↛ `decision` import direction — фикс правит только
   в `src/auto-reply/reply/**`.
9. `DonePredicate` text-blind — не трогается.
10. `DonePredicate` lives on Affordance — не трогается.
11. Five legacy decision contracts frozen.
12. Emergency phrase / routing patches with retire deadline — фикс
    не emergency, structural.
13. `terminalState` / `acceptanceReason` orthogonality — оба populated
    на parent-final reply.
14. `ShadowBuildResult` typed union — не трогается.
15. PR human signoff — narrow bug-fix slice (per roadmap §1 PR-G),
    signoff не требуется.
16. `EffectFamilyId` ≠ `EffectId` — не трогается.

## 2. Bug repro & evidence

### 2.1. Repro

1. `agents.defaults.model=hydra/gpt-5.4`, `gateway.mode=local`.
2. Telegram → длинное ТЗ, требующее spawn'а persistent_worker `Валера`.
3. После spawn'а сразу прислать второе сообщение (turn N+1) типа «доведи до конца», «как там Валера», ИЛИ ничего не присылать (parent сам генерит follow-up через subagent_announce который попадёт в classifier).
4. Наблюдать в logs: повторяется `sessions_spawn` для уже существующего child label → `INVALID_REQUEST errorMessage=label already in use: Валера`.

### 2.2. Evidence (gateway log `terminals/264924.txt`)

| Time | Line | Что видно |
| --- | --- | --- |
| 13:38:08.634 | 569 | `errorMessage=label already in use: Валера` (первый turn N+1 после spawn'а на turn N) |
| 13:38:24.481 | 589 | то же |
| 13:52:36.361 | 666 | то же, после turn'а 13:50:46 (Валера снова стартован, но parent на 13:52:36 шлёт «Валера не довёл» text-reply без `sessions_spawn` в run-результате — однако parent на 13:52:30 уже снова вошёл в planner=respond_only → дальше повторно появляется sessions_spawn) |
| 13:58:47.568 | 763 | то же, после `Валера сейчас в процессе…` reply на line 757 |

В каждом случае parent text-only reply на turn N+1 утекает в TG, а на следующем round-trip'е (через провенанс на announce / classifier на user prompt) — повторно эмиттится `sessions_spawn` с тем же label'ом. Существующий aggregation gate (in-turn) НЕ срабатывает: `runResult.meta.executionVerification.receipts` на этих turn'ах не содержит `sessions_spawn` (parent не спавнит на этом конкретном turn'е, child уже есть в registry).

### 2.3. Где сейчас НЕТ нужного контракта

| Контракт | Где должен быть | Текущее состояние |
| --- | --- | --- |
| Cross-turn pending-child gate | `src/auto-reply/reply/subagent-aggregation.ts::applyAggregationOverride` | Существующий gate срабатывает только если `detectSpawnToolInvocation(runResult) === true`, т.е. на turn'е, где LLM сам только что вызвал `sessions_spawn`. На turn N+1 этого нет → `passthrough` → text-reply утекает. |
| Mandatory timeout per (parent, child) | (тот же модуль) | Не существует. |
| 30s idempotency на повторное emission holding | (тот же модуль) | Не существует — существующий holding в `applyAggregationOverride` опирается на in-turn detection, поэтому повторно за один turn не сработает; cross-turn — другая история. |

## 3. Design (FIXED — не на усмотрение чата)

Зафиксировано до начала кодинга. Любое отклонение — отдельный sub-plan / signoff.

1. **Per (sessionId, turnId), без global state.** Gate evaluates only the records returned by `listSubagentRunsForRequester(parentSessionKey)`. Никакого module-level mutex'а / shared queue / global counter'а. Idempotency state — in-process map, keyed по `(parentSessionKey, childRunId)` с TTL=30s; map ограничен по размеру (LRU-style cleanup), не растёт неограниченно.
2. **Decision rule.** В точке генерации parent reply payload (перед `applyAggregationOverride` в `agent-runner.ts:938`):
   - Сначала вызывается существующий **in-turn** check (`evaluateAggregationOverride`). Если он вернул `holding` — используется его payload (regression-safe, поведение не меняется).
   - Если in-turn check вернул `passthrough` — вызывается **cross-turn** check (`evaluatePendingChildOverride`). Тот срабатывает, ЕСЛИ ВСЕ условия:
     (a) есть хотя бы один `SubagentRunRecord` с `record.requesterSessionKey === parentSessionKey`,
         `record.endedAt === undefined` (still running),
         `record.createdAt` в окне `LOOKBACK_MS` (default 10min, configurable);
     (b) `record.spawnMode === "session"` (persistent) ИЛИ
         (`record.spawnMode === "run"` И `record.expectsCompletionMessage === true`) (followup expecting completion);
     (c) текущий `runResult` НЕ содержит `sessions_spawn` (`detectSpawnToolInvocation === false`) — иначе in-turn check бы уже сработал.
     (d) есть deliverable user-channel target (`hasUserChannelTarget(userChannelOrigin) === true`).
   - Из всех matching records берётся самый старый (`oldestPendingContinuationChild`) — он представляет "primary" pending work.
3. **Идемпотентность.** Replay safety: одна и та же пара `(parentSessionKey, childRunId)` не должна породить два holding'а в окне 30s. Реализуется in-process map `pendingChildHoldingHistory` с записями `{ runId: string; emittedAtMs: number[] }`. Перед эмитом: clean stale entries (>5min), посмотреть последний emit'нутый ts; если `nowMs - lastEmittedMs < IDEMPOTENCY_MS` (30000) → telemetry `event=pending_child_idempotent_skip` + passthrough.
4. **Mandatory timeout.** Если pending child running > 120s И в `pendingChildHoldingHistory[childRunId]` УЖЕ ≥ 2 emission в последние 5 минут → passthrough + telemetry `event=pending_child_timeout reason=child_terminal_pending_too_long childRunId=<id>`. Это даёт UX safety-valve: если Валера завис больше чем на 2 минуты после 2 holding'ов — даём parent reply пройти, даже если оно потенциально trigger'нёт label collision (которая уже purely server-side stale state).
5. **Holding text.** Используется тот же `HOLDING_MESSAGE_TEXT`-style русский генерический шаблон. Чтобы НЕ путать пользователя с in-turn holding'ом ("Запустил воркера. Полный результат..."), для cross-turn используется СВОЙ текст: `"Все ещё работаю над предыдущей задачей. Напишу когда будет готово."`. Этот текст экспортируется как `PENDING_CHILD_HOLDING_MESSAGE_TEXT` из `aggregation-policy.ts` (не phrase-rule — это outbound template, не классификатор-input).
6. **Telemetry.** Новое событие `event=pending_child_holding_sent parent=<id> child=<id> runId=<id> [label=<l>]`. Существующее `event=holding_sent` для in-turn пути не меняется. Дополнительные события: `pending_child_timeout`, `pending_child_idempotent_skip`.
7. **Никакого text-matching.** Все условия — на typed enum / number values из `SubagentRunRecord` и `DeliveryContext`. Phrase-rules НЕ вводятся (invariant #5).

## 4. Scope-of-fix matrix

| # | Layer | Файл | Изменение | LOC оценка | Invariant |
| - | ----- | ---- | --------- | ---------- | --------- |
| 1 | Aggregation policy | `src/auto-reply/reply/aggregation-policy.ts` | export `PENDING_CHILD_HOLDING_MESSAGE_TEXT`; helper-builder для idempotency-key (re-use `buildHoldingIdempotencyKey` с suffix `:cross-turn`) | ~15 | #5 |
| 2 | Subagent aggregation | `src/auto-reply/reply/subagent-aggregation.ts` | новый helper `findOldestPendingContinuationChild`; новая `evaluatePendingChildOverride`; module-level idempotency map `pendingChildHoldingHistory`; orchestration: `applyAggregationOverride` сначала in-turn → потом cross-turn | ~150 | #5, #11 |
| 3 | Tests | `src/auto-reply/reply/subagent-aggregation.pending-child.test.ts` (новый) | 6 тестов из плана | ~250 | — |

Итого: ~165 LOC implementation + 250 LOC tests = ~415 LOC, 3 файла.

## 5. Acceptance criteria mapping

| Criterion | Закрывается через |
| --- | --- |
| 1. На turn N+1 при незакрытом child из turn N parent не выпускает text-only reply в external channel; вместо этого ОДНО holding-сообщение `PENDING_CHILD_HOLDING_MESSAGE_TEXT`. | §3 #2 + §3 #5 + tests (1)(2). |
| 2. Если child в registry достиг terminal (`endedAt` set), parent reply на следующем turn'е идёт через — passthrough. | §3 #2 condition (a) + test (3). |
| 3. Cross-session isolation: pending child в session A не влияет на parent reply в session B. | §3 #2 condition (a) `record.requesterSessionKey === parentSessionKey` + test (4). |
| 4. Timeout: child running > 120s + 2 prior holdings в 5min → passthrough + telemetry `pending_child_timeout`. | §3 #4 + test (5). |
| 5. Idempotency: same (parent, child) в 30s окно → второй call → `pending_child_idempotent_skip` + passthrough; pendingChildHoldingHistory не дублирует holding. | §3 #3 + test (6). |
| 6. Regression: in-turn check (turn N со spawn'ом) продолжает срабатывать как раньше. | §3 #2 (in-turn first) + test (1). |

## 6. Handoff Log

(пусто — заполняется этим чатом после merge)

## 7. References

- `.cursor/rules/commitment-kernel-invariants.mdc` — 16 hard invariants.
- `.cursor/plans/commitment_kernel_v1_master.plan.md` — master plan.
- `.cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md` — roadmap, todo `pr-g-subagent-await`.
- `.cursor/plans/commitment_kernel_subagent_result_aggregation.plan.md` — PR-aggregation baseline (in-turn gate, merged через PR #106).
- `.cursor/plans/commitment_kernel_self_feedback_loop_fix.plan.md` — provenance gate (safety-net).
- `src/auto-reply/reply/subagent-aggregation.ts` — module под расширение.
- `src/auto-reply/reply/aggregation-policy.ts` — pure helpers + telemetry formatter.
- `src/auto-reply/reply/agent-runner.ts:929-956` — единственная точка вызова `applyAggregationOverride`.
- `src/agents/subagent-registry.types.ts` — `SubagentRunRecord` shape.
- `terminals/264924.txt:569,589,666,763` — bug evidence.
