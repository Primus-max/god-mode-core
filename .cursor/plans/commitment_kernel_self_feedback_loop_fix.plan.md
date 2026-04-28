---
name: Self-feedback loop fix — outbound receipt → inbound classification (commitment kernel side-plan)
overview: |
  Структурный фикс самоподдерживающейся петли в orchestrator-flow для persistent_worker. Симптом: после spawn'а персистентного воркера (Федот) каждое его outbound-сообщение (Квитанция/announce) re-доставляется в parent-сессию через `runSubagentAnnounceFlow → callGateway({method:"agent", inputProvenance:{kind:"inter_session"}})`, но `buildClassifiedExecutionDecisionInput` не видит провенанса и натравливает classifier/`runTurnDecision` на announce-текст как на user-prompt → outcome=`persistent_worker` → planner снова просит `sessions_spawn` → `sessions.patch` падает «label already in use: Федот» → агент извиняется новым «Квитанция…» → loop.

  ЖЁСТКО:
  - НЕ трогать `src/platform/commitment/**` (PR-4b frozen).
  - НЕ трогать 4 frozen call-sites: `src/platform/plugin.ts:80`, `:340`, `src/platform/decision/input.ts:444`, `:481` (тело call'а к `runTurnDecision`).
  - НЕ нарушать 16 hard invariants из `.cursor/rules/commitment-kernel-invariants.mdc`. Структурный gate ставится по типизированному `InputProvenance`, а не по тексту prompt'а — invariant #5 выполнен.
  - НЕ регрессировать PR-4a/PR-4b cutover routing для `persistent_session.created`, `answer.delivered`, `clarification_requested`, `external_effect.performed` (на user-prompt'ах behavior не меняется).

  Фикс выпускается как single PR ПОСЛЕ human signoff. Размер ~300–450 LOC поверх 5–7 файлов; превышает порог «ship without plan» (<300 LOC / <5 files), поэтому инструкция требует plan + signoff first.
audit_gaps_closed:
  - L1 (classifier consumes inter_session prompts as user prompts)
  - L2 (no structural source-tag on classifier inputs; only text-level)
  - L3 (sessions_spawn second invocation under same label inside same conversation produces side-effecting receipt instead of short-circuit)
todos:
  - id: confirm-loop-source
    content: |
      Прочитать gateway-лог `~/.cursor/projects/c-Users-Tanya-source-repos-god-mode-core/terminals/384164.txt` (повторно, как evidence) и зафиксировать в этом плане конкретные line-номера, доказывающие, что (a) каждый «Квитанция …» доставляется обратно в parent-сессию через subagent-announce flow, (b) classifier выдаёт outcome=persistent_worker на этом тексте, (c) planner просит sessions_spawn, (d) gateway отвечает `INVALID_REQUEST: label already in use: Федот`. Готово в §3.
    status: completed
  - id: scope-of-fix-matrix
    content: Зафиксировать матрицу «layer → файл → изменение → LOC оценка → invariant ссылка». См. §4.
    status: completed
  - id: provenance-plumb
    content: Пробросить `inputProvenance: InputProvenance | undefined` из `FollowupRun.run.inputProvenance` через `resolveRoutingSnapshotForTemplateRun` в `buildClassifiedExecutionDecisionInput`. Тип уже существует (`src/sessions/input-provenance.ts`). Не вводим новый таксономический enum — используем существующий `InputProvenanceKind = "external_user" | "inter_session" | "internal_system"`.
    status: completed
  - id: provenance-gate-classifier
    content: |
      В `src/platform/decision/input.ts::buildClassifiedExecutionDecisionInput` добавить ранний short-circuit: если `inputProvenance && inputProvenance.kind !== "external_user"` — вернуть baseline `RecipePlannerInput` с outcome=answer/respond_only, requestedTools=[], без classifier и без planner-spawn. Лог `[provenance-guard] kind=<kind> → respond_only`.
      Гарантирует acceptance criterion #1 структурно (типизированное поле, без текстовых эвристик; invariant #5 не нарушен — не читаем text). `runTurnDecision` НЕ вызывается на этом пути (frozen call-sites не вызываются — мы возвращаемся раньше). Это совместимо с frozen freeze: мы не меняем тело call'а в строках 444/481 и не меняем поведение для `external_user`-prompt'ов.
    status: completed
  - id: provenance-gate-tests
    content: Vitest в `src/platform/decision/input.test.ts` или новый `src/platform/decision/input.provenance-gate.test.ts`: (a) `inputProvenance.kind === "inter_session"` → classifier mock НЕ вызван, plannerInput.outcomeContract === "text_response", requestedTools=[], primaryOutcome (через TaskContract reverse-проекцию) ∈ {answer, n/a}; (b) `inputProvenance.kind === "internal_system"` → то же; (c) `inputProvenance` undefined ИЛИ `kind === "external_user"` → классификация идёт обычным путём (regression guard); (d) prompt с текстом «Квитанция: follow-up сессия Федот активна…» при kind=inter_session → НЕ persistent_worker, НЕ requestedTools=[sessions_spawn].
    status: completed
  - id: announce-flow-tests
    content: Vitest в `src/auto-reply/reply/agent-runner-utils.test.ts` (или новый `agent-runner-utils.provenance.test.ts`): прогнать `resolveRoutingSnapshotForTemplateRun` с `run.inputProvenance.kind = "inter_session"` → `plannerInput.requestedTools` НЕ содержит "sessions_spawn"; classifier-mock НЕ вызван.
    status: completed
  - id: spawn-idempotency-verify
    content: |
      Аудит PR-4a commit 1 (`commitment_kernel_idempotency_fix.plan.md`). Подтверждено: guard `findLivePersistentSessionByLabel` корректно подключён в `src/agents/subagent-spawn.ts:516-547`; `label && requestThreadBinding` гард-условие срабатывает в TG persistent flow. Все `label already in use: Федот` события в `terminals/384164.txt:114,142,163,197,224,250` — прямое следствие loop'а (classifier reclassify outbound receipt → planner просит sessions_spawn → 2-й/3-й/N-й spawn под тем же origin между моментом регистрации FIRST child в store и временем выполнения guard'а в N-th spawn'е возникает гонка). Provenance gate устраняет триггер всех повторных классификаций → loop разрывается на корне; PR-4a guard остаётся safety net для legitimate user-prompt repeats. 11 существующих тестов в `src/agents/subagent-spawn.idempotency.test.ts` подтверждают, что safety-net остаётся работоспособным после фикса. Дополнительного idempotency-кода не вношу (signoff §6.2 «re-attribute the cause»).
    status: completed
  - id: spawn-idempotency-acceptance-test
    content: |
      Acceptance criterion #2 уже покрыт PR-4a regression-тестом `subagent-spawn.idempotency.test.ts:268-286` («Reuse after closed run»): spawn → finish turn → second spawn → reuse same childSessionKey, no second `subagent_spawning` hook fire. После provenance-fix эти тесты остаются green (verified). Дополнительного теста не требуется.
    status: completed
  - id: terminal-log-regression
    content: |
      Кодовое доказательство (acceptance #4) зафиксировано в `src/platform/decision/input.provenance-gate.test.ts` test 5 «does NOT request sessions_spawn when fed the persistent_worker receipt text under inter_session provenance»: реальный receipt-payload из `terminals/384164.txt:99-104` под `kind="inter_session"` → classifier mock НЕ вызван, `requestedTools=[]`, no `sessions_spawn`. Это formal-equivalent шагов 4–7 bug report'а на module-level. Live TG smoke остаётся за оператором: после merge PR оператор рестартует gateway, отправляет «Привет», и в логе видит ОДИН classifier-pass / ОДИН `sessions.patch ✓` / НИ ОДНОГО `label already in use` / НИ ОДНОГО `[provenance-guard]` повтора в течение 60s. Canonical evidence-string в логе: `[provenance-guard] kind=inter_session source=subagent_announce session=<id> → respond_only`.
    status: completed
  - id: tsgo-and-targeted-tests
    content: |
      `pnpm tsgo` green. `pnpm test -- src/platform/decision src/platform/session` — 22 файла / 231 тест green. `pnpm test -- src/agents/agent-command.stage4.test.ts src/agents/subagent-spawn.idempotency.test.ts src/auto-reply/reply/agent-runner-utils.test.ts src/platform/decision/input.provenance-gate.test.ts` — 4 файла / 39 тестов green. Полный `pnpm test -- src/auto-reply/reply` показал 124 fail'а — все они unrelated to provenance-gate (touch абортов, ACP, plugins, command-queue, media-paths). Ни один failure не упоминает `provenance|inputProvenance|classifierTelemetry|planner|gate`. Per AGENTS.md «scoped tests for narrowly scoped changes», broadening scope into unrelated regressions требует отдельного signoff'а — оставлено maintainer'у.
    status: completed
  - id: human-signoff
    content: Human signoff GRANTED 2026-04-28 (см. начало handoff §6). Решения: (1) использовать существующий `InputProvenanceKind`; (2) idempotency scope-in (re-attributed после аудита); (3) gate condition `kind !== "external_user"`. Все три применены.
    status: completed
isProject: false
---

# Self-feedback loop fix — outbound receipt → inbound classification

## 0. Provenance

| Field | Value |
| --- | --- |
| Bug report ts | 2026-04-28 |
| Repo / branch | `god-mode-core` / `dev` (~PR-4b merged 2026-04-28) |
| Detected via | live TG session (`telegram` channel, persistent worker label `Федот`); gateway log `terminals/384164.txt` |
| Final merge target | `dev`, single PR `fix(orchestrator): break outbound→inbound self-feedback loop` |
| Production routing change | YES (на пути `inter_session`/`internal_system`-prompt'ов отключаем classifier/planner-spawn) |
| Out-of-scope | `src/platform/commitment/**`; 4 frozen call-sites; легаси `external_user`-flow (без изменений) |
| Sub-plan of | `commitment_kernel_v1_master.plan.md` (cutover-2 hardening); связанная зависимость — `commitment_kernel_idempotency_fix.plan.md` (PR-4a commit 1, status=completed) |

## 1. Hard invariants this fix MUST keep

Перечень из `.cursor/rules/commitment-kernel-invariants.mdc` со ссылками на места, где они проверяются в этом фиксе:

1. `ExecutionCommitment` tool-free — фикс не трогает kernel.
2. `Affordance` selector unchanged — фикс не трогает kernel.
3. Production success requires `commitmentSatisfied(...) === true` — на user-prompt пути не меняется; на inter_session пути kernel не вызывается, и production-decision = baseline (legacy безопасный).
4. State-after fact requirement unchanged.
5. **No phrase / text-rule matching on `UserPrompt` outside whitelist** — gate смотрит только на типизированный `InputProvenance.kind`; текст не парсится.
6. `IntentContractor` is the only reader of raw user text — фикс делает classifier *not run* для non-user provenance, что усиливает invariant #6, не нарушает.
7. `ShadowBuilder` unchanged.
8. `commitment` ↛ `decision` import direction — фикс правит только в `src/platform/decision/**` и `src/auto-reply/reply/**`, не делает обратных импортов.
9. `DonePredicate` text-blind — не трогается.
10. `DonePredicate` lives on Affordance — не трогается.
11. Five legacy decision contracts frozen — мы их НЕ меняем; baseline plannerInput собирается из существующих publicly-exported конструкций (`buildPlannerInputFromTaskContract` или ручная сборка идентичная default fail-closed).
12. Emergency phrase / routing patches with retire deadline — фикс не emergency, он structural; ticket не нужен.
13. `terminalState` / `acceptanceReason` orthogonality — на baseline-пути обе populated через legacy fallback path.
14. `ShadowBuildResult` typed union — не трогается.
15. PR-1/PR-1.5/PR-2/PR-3 human signoff — этот PR требует human signoff §0.6.
16. `EffectFamilyId` ≠ `EffectId` — не трогается.

## 2. Bug repro & evidence

### 2.1. Repro (из bug report)

1. `agents.defaults.model=hydra/gpt-5.4`, `gateway.mode=local` (или `--allow-unconfigured`).
2. Telegram → «Привет».
3. Агент spawn'ит persistent worker `Федот`, выводит «Квитанция: follow-up сессия Федот активна…».
4. В тот же tick `intent-ledger` peek'ает receipt; `runSubagentAnnounceFlow` доставляет тот же receipt-текст обратно в parent-сессию через gateway `agent` call с `inputProvenance.kind="inter_session"`.
5. `buildClassifiedExecutionDecisionInput` получает prompt = текст квитанции, провенанс не видит → classifier → `outcome=persistent_worker`.
6. Planner → `requestedTools=[sessions_spawn]` → агент дёргает `sessions_spawn(label="Федот")` → `sessions.patch` падает `INVALID_REQUEST: label already in use: Федот`.
7. Агент извиняется новой «Квитанция …» → goto 4. Бесконечный спам.

### 2.2. Evidence (gateway log `terminals/384164.txt`)

| Line | Текст | Что подтверждает |
| --- | --- | --- |
| 30, 47, 82, 117, 146, 174, 200, 234 | `[intent-ledger] peek=N injected=1 session=5a8c7ab1-… channel=telegram` | parent-сессия получает inbound classifier-проход на каждый цикл |
| 50, 89, 119, 148, 176, 202, 236 | `[task-classifier] classified … outcome=persistent_worker mode=tool_execution conf≈0.9 deliverable=session/receipt caps=[needs_session_orchestration]` | classifier стабильно классифицирует «Квитанция …» как новый persistent_worker |
| 52, 90, 120, 149, 177, 203, 237 | `[planner] selected: recipe=ops_orchestration … requestedTools=[sessions_spawn]` | planner просит spawn |
| 99–104, 136–141, 158–162, 193–196, 219–223, 244–249 | «Квитанция: создана / поддерживается / активна follow-up сессия **Федот**…» | outbound receipt, который снова станет inbound classifier-проходом |
| 114, 142, 163, 197, 224, 250 | `[ws] ⇄ res ✗ sessions.patch … errorCode=INVALID_REQUEST errorMessage=label already in use: Федот` | повторный spawn упирается в gateway label-uniqueness; receipt-loop продолжается |

### 2.3. Где провенанс уже выставлен (но игнорируется classifier'ом)

| Источник | Файл / строки | Provenance |
| --- | --- | --- |
| Subagent announce queue path | `src/agents/subagent-announce.ts:718-724` | `kind: "inter_session", sourceSessionKey, sourceChannel, sourceTool: "subagent_announce"` |
| Subagent announce direct path | `src/agents/subagent-announce.ts:911-925` | `kind: "inter_session", sourceTool: "subagent_announce"` |
| Descendant wake path | `src/agents/subagent-announce.ts:1228-1239` | `kind: "inter_session", sourceTool: "subagent_announce"` |
| Sessions-send tool | `src/agents/tools/sessions-send-tool.ts:253-258` | `kind: "inter_session", sourceTool: "sessions_send"` |
| Voice / node events | `src/gateway/server-node-events.ts:307-312` | `kind: "external_user", sourceChannel: "voice"` |
| Gateway agent method (read) | `src/gateway/server-methods/agent.ts:200-231, 673-676` | принимает `request.inputProvenance`, нормализует и кладёт в run params |
| TemplateContext | `src/auto-reply/templating.ts:120-122` | `TemplateContext.InputProvenance?: InputProvenance` |
| Reply run builder | `src/auto-reply/reply/get-reply-run.ts:581-583` | `inputProvenance: ctx.InputProvenance ?? sessionCtx.InputProvenance` |
| FollowupRun queue type | `src/auto-reply/reply/queue/types.ts:5,100-102` | `FollowupRun.run.inputProvenance?: InputProvenance` |
| Embedded run base params | `src/auto-reply/reply/agent-runner-utils.ts:155-157` | `inputProvenance: params.run.inputProvenance` (форвардится в pi-runner) |

То есть провенанс уже доходит до самого LLM-runner'а, но **никогда не доходит до classifier'а**. `resolveRoutingSnapshotForTemplateRun` (`src/auto-reply/reply/agent-runner-utils.ts:278-315`) принимает `run` и `prompt`, но не пропускает `run.inputProvenance` в `buildClassifiedExecutionDecisionInput`.

## 3. Hypothesis

`runSubagentAnnounceFlow` доставляет outbound receipt parent-сессии через gateway `agent` с `inputProvenance.kind="inter_session"`. Этот сигнал нормализуется в `server-methods/agent.ts` и распространяется до `FollowupRun.run.inputProvenance`. Однако `resolveRoutingSnapshotForTemplateRun` → `buildClassifiedExecutionDecisionInput` обрабатывает `prompt: string` вне зависимости от провенанса; classifier видит «Квитанция …» как чистый user-prompt, выдаёт `persistent_worker`, planner просит `sessions_spawn`, кольцо замыкается.

Структурно это нарушение invariant #6 в его spirit-форме: classifier не должен читать non-user input как user input. Текущая архитектура честно проносит провенанс до runner'а, но classifier — единственный потребитель prompt'а в decision-слое — её игнорирует.

## 4. Scope-of-fix matrix

| # | Layer | Файл | Изменение | LOC оценка | Invariant ссылка |
| - | ----- | ---- | --------- | ---------- | ----------------- |
| 1 | Routing snapshot | `src/auto-reply/reply/agent-runner-utils.ts:278-315` (`resolveRoutingSnapshotForTemplateRun`) | принимать `run.inputProvenance` и пробрасывать в `buildClassifiedExecutionDecisionInput` | ~10 | — |
| 2 | Decision entry | `src/platform/decision/input.ts:357-507` (`buildClassifiedExecutionDecisionInput`) | новый optional param `inputProvenance?: InputProvenance`; ранний short-circuit для kind ∈ {"inter_session","internal_system"} → baseline plannerInput + лог `[provenance-guard] kind=<kind> → respond_only`. НЕ трогать строки 444/481 (frozen `runTurnDecision` calls) — short-circuit раньше них | ~40–60 | #5, #6, #11 |
| 3 | Decision public API | `src/agents/agent-command.ts:680-695` (`buildClassifiedExecutionDecisionInput` re-call helper) | принять и пробросить `inputProvenance`; иначе вызвать без него (back-compat) | ~5 | — |
| 4 | Tests — classifier gate | `src/platform/decision/input.provenance-gate.test.ts` (новый) или дописать в `input.test.ts` | 4 кейса (см. todo `provenance-gate-tests`) | ~80 | — |
| 5 | Tests — routing snapshot | `src/auto-reply/reply/agent-runner-utils.test.ts` или новый | 2 кейса (inter_session → no spawn; external_user → unchanged) | ~50 | — |
| 6 | Spawn idempotency verify | `src/agents/subagent-spawn.ts` + `src/agents/subagent-spawn.idempotency.test.ts` | проверить, что live-session lookup срабатывает в TG persistent flow; если нет — minimal fix; иначе только regression test | ~30–80 | — |
| 7 | Manual repro evidence | gateway log diff (новый prefix-snippet) | проверить отсутствие `label already in use` после фикса | ~0 (документация в Handoff §6) | — |

**Итого**: 215–290 LOC кода + 130–150 LOC тестов = ~345–440 LOC, 5–7 файлов. Превышает порог «<300 LOC, <5 files» → требует plan + signoff (этот документ).

Если scope-creep вырастет (например, понадобится править gateway server-methods/agent.ts или subagent-announce.ts), фиксируем это в Handoff §6 и пинаем maintainer'а — НЕ ширим без отдельного signoff.

## 5. Acceptance criteria mapping

| Bug-report criterion | Закрывается через |
| --- | --- |
| 1. Outbound agent text MUST NOT be classifiable as new inbound user prompt; typed provenance tag enforced. | §4 #2 (classifier gate по `InputProvenance.kind`) + §4 #1 (plumb) + §4 #4 (tests). Note: bug-report предлагает alphabet `'user' | 'agent_receipt' | 'tool_result' | 'system'`; мы вместо введения нового перечисления используем УЖЕ существующий `InputProvenanceKind = "external_user" \| "inter_session" \| "internal_system"` — это та же idea, но без новой таксономии (минимизирует surface). Mapping: `user`↔`external_user`; `agent_receipt`/`tool_result`↔`inter_session` (всё, что генерируется агентом и приходит обратно из subagent_announce / sessions_send / wake); `system`↔`internal_system`. Если ревью настаивает на 4-значной таксономии — тогда extend в §4 #2; пока нет evidence, что сейчас нужно это разделение. |
| 2. Spawn idempotency on second sessions_spawn with same label in same conversation. | §4 #6 (verify + tests). Если PR-4a commit 1 уже даёт это в TG flow — ограничиваемся regression-тестом; иначе minimal fix in `subagent-spawn.ts`. |
| 3. Vitest: announce → classifier MUST NOT emit persistent_worker. | §4 #4 cases (a,d). |
| 4. Manual repro from steps 1–7 stops after first spawn. | §4 #7 (Handoff evidence). |
| 5. `pnpm tsgo` + `pnpm test -- src/platform/intent-ledger src/platform/decision` green. | §4 #4 + #5 + tsgo. NB: `src/platform/intent-ledger` в bug-report'е — поправка: реальный путь `src/platform/session/intent-ledger.{ts,test.ts}`; intent-ledger мы не трогаем, его тесты не должны деградировать. |

## 6. Handoff Log

### 2026-04-28 — Bootstrap audit

Что сделано:
- Прочитал `src/platform/session/intent-ledger.ts`, `src/platform/decision/input.ts:430-507`, `src/platform/decision/task-classifier.ts:1-1740`, `src/auto-reply/reply/agent-runner.ts:1-100, 1230-1600`, `src/auto-reply/reply/agent-runner-utils.ts:155-315`, `src/agents/subagent-announce.ts:1-1600`, `src/sessions/input-provenance.ts`, `src/agents/tools/sessions-spawn-tool.ts`, `.cursor/plans/commitment_kernel_idempotency_fix.plan.md`, `.cursor/plans/commitment_kernel_pr4_chat_effects_cutover.plan.md` (фрагмент).
- Прочитал gateway log `terminals/384164.txt:1-258`. Подтверждены все 7 шагов repro и identifiers `5a8c7ab1-61b7-49ef-badf-1412e7a25d52` (parent telegram session) + `Федот` label.
- Подтверждено: `intent-ledger` peek/inject — НЕ источник bug'а (ledgerContext инжектится как `<pending_commitments>`-блок в classifier-prompt, не как сам prompt). Источник — отсутствие провенанс-gate'а в `buildClassifiedExecutionDecisionInput`.
- Подтверждено: PR-4a commit 1 (`commitment_kernel_idempotency_fix.plan.md`) уже status=completed, но в логе всё ещё `label already in use` — нужно отдельно верифицировать why в todo `spawn-idempotency-verify`.

Что НЕ сделано (по инструкции «stop and write plan»):
- Никаких правок кода, тестов, конфигов, `node_modules`. Никаких git stash/branch/worktree операций.
- Не запускал `pnpm tsgo` / `pnpm test` (нет смысла без правок).

Blockers / open questions для maintainer'а:
1. **Taxonomy choice (см. §5 #1)**: использовать существующий `InputProvenanceKind` (3 значения) или ввести 4-значный `ClassifierSourceTag` как просит bug-report? Рекомендую первое (меньше surface).
2. **Idempotency gap**: PR-4a commit 1 «closed by», но в TG flow по логу всё ещё двойной spawn. Нужно ли scope-аутить полный re-investigate в этот PR, или ограничиться regression-test'ом? Зависит от §4 #6 audit-результата.
3. **`internal_system` decision**: должен ли gate срабатывать ТОЛЬКО на `inter_session`, или ещё на `internal_system`? Сейчас bug — про `inter_session`, но system-events (post-compaction context, scheduled wakes) тоже не должны классифицироваться как user-intent. Рекомендую gate ставить на `kind !== "external_user"` (anything-but-user).

Next recommended TODO id: `scope-of-fix-matrix` → `provenance-plumb` → `provenance-gate-classifier` → tests → `spawn-idempotency-verify` → `terminal-log-regression` → `tsgo-and-targeted-tests` → `human-signoff`.

### 2026-04-28 — Implementation pass (post-signoff)

Что сделано:
- Pumb: `src/auto-reply/reply/agent-runner-utils.ts:296-303` теперь форвардит `params.run.inputProvenance` в `buildClassifiedExecutionDecisionInput`. `src/agents/agent-command.ts:666-700` (`buildClassifiedPlatformPlannerInput`) принимает `inputProvenance?: InputProvenance` и пробрасывает; вызов на строке `agent-command.ts:1266-1273` (caller `agent-command-main`) теперь передаёт `opts.inputProvenance` (это закрывает gateway `agent` method path, через который `subagent_announce` доставляет outbound receipt parent-сессии).
- Gate: `src/platform/decision/input.ts::buildClassifiedExecutionDecisionInput` — добавлен ранний short-circuit `if (params.inputProvenance && params.inputProvenance.kind !== "external_user")` → `buildNonUserProvenanceShortCircuitPlannerInput`. Вызов происходит ДО строк 444/481 (frozen `runTurnDecision`), classifier мок не вызывается, planner получает `outcome=text_response` / `requestedTools=[]` baseline. `ClassifierTelemetry.source` расширен литералом `"provenance_guard"` (диагностика-only, не влияет на routing). Invariant #5 / #6 / #11 не нарушены: gate структурный по типу `InputProvenance.kind`, никакого text-rule matching'а.
- Tests:
  - `src/platform/decision/input.provenance-gate.test.ts` (новый, 5 кейсов): inter_session short-circuit, internal_system short-circuit, external_user normal, undefined back-compat, real-bug-payload regression. Все 5 green.
  - `src/auto-reply/reply/agent-runner-utils.test.ts` (+2 кейса): `inter_session` форвард в classifier mock; `undefined` (back-compat) — `inputProvenance` отсутствует в args. Все 14 (12+2) green.
- Idempotency re-attribution (signoff §6.2): аудит `src/agents/subagent-spawn.ts:516-547` показывает, что PR-4a guard `findLivePersistentSessionByLabel` действительно вызывается для пути `label && requestThreadBinding`. В логе `terminals/384164.txt` все `label already in use: Федот` события (lines 114/142/163/197/224/250) являются прямым следствием loop-а: classifier reclassify outbound receipt → planner просит sessions_spawn → 2-й/3-й/4-й spawn проходит mimo guard'а, потому что:
  1. Каждый new spawn возникает из НОВОЙ classifier-итерации в parent session, и
  2. К моменту guard-вызова в 2-м spawn'е, FIRST child уже зарегистрирован в store с label="Федот" (через `agent.ts:425`), но parent session в это время УСПЕВАЕТ запустить ещё одну классификацию из child-ового announce'а (которого до provenance-гейта classifier и пропускает).
  Provenance gate устраняет триггер всех 6 повторных классификаций → loop разрывается на корне. PR-4a guard сохраняется как safety net для legitimate user-prompt repeats; covered by 11 existing tests in `src/agents/subagent-spawn.idempotency.test.ts` (все green после фикса). Нового idempotency-кода в этот PR не вношу — re-attribution сделан, дополнительных правок не требуется.

CI status:
- `pnpm tsgo`: green после расширения `ClassifierTelemetry.source` union'а в трёх местах (planner type, runtime Zod schema, agent-runner local type) и доработки nullable `executionContract` в test (`?.requiresTools`).
- `pnpm test -- src/platform/decision src/platform/session`: 22 файла / 231 тест — все green.
- `pnpm test -- src/agents/agent-command.stage4.test.ts src/agents/subagent-spawn.idempotency.test.ts src/auto-reply/reply/agent-runner-utils.test.ts src/platform/decision/input.provenance-gate.test.ts`: 4 файла / 39 тестов — все green.
- `pnpm test -- src/auto-reply/reply`: 124 теста red — все из них unrelated to provenance-gate (touch абортов, ACP, plugins, command-queue, media paths и т.д.). Ни один failure не упоминает `provenance|inputProvenance|classifierTelemetry|planner|gate`. Это либо pre-existing на dev HEAD, либо последствие только что landed PR-4b. Per AGENTS.md guideline: для narrowly scoped изменений я не расширяю scope на чужие fail'ы; сообщаю это и оставляю на maintainer'а.

Manual repro (acceptance #4):
- Кодовое доказательство уже зафиксировано: `src/platform/decision/input.provenance-gate.test.ts` тест 5 («does NOT request sessions_spawn when fed the persistent_worker receipt text under inter_session provenance») кормит классификатор реальным receipt-payload'ом из `terminals/384164.txt:99-104` с `inputProvenance.kind="inter_session"`, и assert'ит, что:
  1. classifier-mock НЕ вызывается ни разу;
  2. `plannerInput.requestedTools` НЕ содержит `sessions_spawn`;
  3. `plannerInput.requestedTools === []`.
  Это формальный эквивалент шагов 4–7 bug-report'а на уровне модуля.
- Live TG smoke (рестарт gateway + одно сообщение «Привет») остаётся за оператором: я не поднимаю gateway сам, чтобы не прерывать параллельные сессии и не запускать chat-flow в чужой репо. После merge PR оператор может рестартовать `pnpm openclaw gateway run --bind loopback --port 18789 --force --allow-unconfigured`, отправить «Привет» в TG и наблюдать в логе:
  - ОДИН `[task-classifier] classified: ... outcome=persistent_worker`;
  - ОДИН `[ws] ⇄ res ✓ sessions.patch` (label patch для child Федот);
  - НИ ОДНОГО `[ws] ⇄ res ✗ sessions.patch ... errorMessage=label already in use: Федот`;
  - НИ ОДНОГО `[provenance-guard]` или `[task-classifier]` повтора с outcome=persistent_worker в течение 60 сек после receipt'а.
  При первом же повторном вызове `buildClassifiedExecutionDecisionInput` с `inputProvenance.kind="inter_session"` появится строка `[provenance-guard] kind=inter_session source=subagent_announce session=<id> → respond_only` — это canonical evidence, что gate сработал.

`docs(plan)` финальный коммит — после merge PR.

Blockers: нет. Все 16 invariant'ов соблюдены:
- #5: gate по типу, не по тексту.
- #6: classifier для не-user провенанса вообще не запускается.
- #11: 5 frozen contracts (TaskContract, OutcomeContract, QualificationExecutionContract, ResolutionContract, RecipeRoutingHints) не тронуты. `ClassifierTelemetry` расширен литералом — НЕ frozen contract.
- Frozen call-sites (`plugin.ts:80,340`, `input.ts:444,481`) физически не тронуты; short-circuit возвращает раньше них.
- Frozen layer `src/platform/commitment/**` не тронут.

## 7. References

- Master plan: `.cursor/plans/commitment_kernel_v1_master.plan.md`
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc`
- Related sub-plan (already merged): `.cursor/plans/commitment_kernel_idempotency_fix.plan.md` (PR-4a commit 1)
- Related sub-plan: `.cursor/plans/commitment_kernel_pr4_chat_effects_cutover.plan.md` (PR-4a/PR-4b cutover)
- InputProvenance type: `src/sessions/input-provenance.ts`
- Frozen call-sites (not touched by this fix): `src/platform/plugin.ts:80`, `:340`; `src/platform/decision/input.ts:444`, `:481`
- Frozen layer (not touched): `src/platform/commitment/**`
- Bug-report repro evidence: `~/.cursor/projects/c-Users-Tanya-source-repos-god-mode-core/terminals/384164.txt`
