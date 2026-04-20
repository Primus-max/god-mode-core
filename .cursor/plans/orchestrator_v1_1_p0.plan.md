# Orchestrator v1.1 — P0 (latency / safety / invariants)

**Мастер-план:** `orchestrator_v1_1_master.plan.md`.
**Статус:** COMPLETED (2026-04-20).
**Ветка:** `dev` (локальные коммиты ahead origin).

---

## Задачи

### P0.1 — убрать double-planning [x]

**Симптом.** На каждом user turn в `.gateway-dev.log` ровно два `[planner] selected`:

```text
12:40:36.132 [task-classifier] classified
12:40:36.134 [planner] selected ... caller=auto-reply-runtime-plan
...
12:40:36.449 [planner] selected ... caller=plugin-platformContext
```

Разрыв 300–800ms. Второй вызов делает тот же plan и добавляет latency на каждом turn.

**Корневая причина.** `src/agents/pi-embedded-runner/run.ts` при вызове `runEmbeddedAttempt`
**не передавал** `platformExecutionContext`. Внутри `attempt.ts::buildAttemptHookContext`
`ctx.platformExecution` оставался `undefined`, и `resolveHookExecution`
(`src/platform/plugin.ts`) уходил в путь «нет контекста → реклассифицировать →
`resolvePlatformRuntimePlan({ callerTag: "plugin-platformContext" })`».

**Фикс.** `src/agents/pi-embedded-runner/run.ts` теперь пробрасывает
`platformExecutionContext: params.platformExecutionContext` в `_runAttempt({...})`.

**Регрессионный тест.** `src/agents/pi-embedded-runner/run.overflow-compaction.test.ts` —
расширен существующий тест `"passes structured platform execution context into hook
evaluation"`: теперь он **дополнительно** ожидает, что `mockedRunEmbeddedAttempt` получил
`platformExecutionContext` в params. Без фикса тест валится.

**Ожидаемый эффект.** В `.gateway-dev.log` на каждый user turn — ровно одно
`[planner] selected` с `caller=auto-reply-runtime-plan`. `plugin-platformContext` не должен
появляться в нормальном пути.

---

### P0.2 — low-conf workspace mutations → clarify [x]

**Симптом.** Classifier возвращает `primaryOutcome=workspace_change`, `confidence=0.35`,
`ambiguities=["scope unclear"]` — и планнер всё равно выбирает tool-путь с `apply_patch`.
Пользователь получает мутацию файлов на догадках.

**Корневая причина.** `taskContractLowConfidenceStrategy`
(`src/platform/decision/task-classifier.ts`) возвращал `"clarify"` ТОЛЬКО если классификатор
сам сказал `primaryOutcome=clarification_needed` или `interactionMode=clarify_first`. Комбо
«низкая уверенность + мутация + ambig» не обрабатывалось.

**Правило.** Вводим строгий инвариант:

```ts
if (confidence < 0.5 && needs_workspace_mutation && ambiguities.length > 0) {
  return "clarify";
}
```

Порог 0.5 совпадает с верхней границей `qualificationConfidence = "low"` и согласован с
`resolveLowConfidenceStrategy` в `src/platform/decision/qualification-confidence.ts`.

**Фикс.** `src/platform/decision/task-classifier.ts::taskContractLowConfidenceStrategy`
расширен новым правилом (с комментарием «P0.2 safety rule»).

**Тесты.**
- `src/platform/decision/task-classifier.test.ts`:
  - `"P0.2: routes low-confidence workspace mutation with ambiguities through clarify"` —
    `confidence=0.35` + `needs_workspace_mutation` + 2 ambig ⇒ `lowConfidenceStrategy="clarify"`,
    `executionContract.requiresTools=false`, `requestedTools=[]`.
  - `"P0.2: keeps high-confidence workspace mutation on the tool path"` — `confidence=0.92`,
    без ambig ⇒ `lowConfidenceStrategy=undefined`, `requestedTools` содержит `apply_patch`.

---

### P0.3 — clarify ⇒ respond_only (invariant) [x]

**Симптом.** Когда classifier выдаёт `interactionMode=clarify_first`, в планнер всё равно
идут `requestedTools=[apply_patch, pdf, ...]`, `artifactKinds=["document"]`,
`executionContract.requiresTools=true`. Планнер получает противоречивый контракт:
«спроси пользователя, но одновременно подготовь артефакт». В логе это мы видели как
`clarification_needed ... requiresTools=true toolBundles=[artifact_authoring]`.

**Корневая причина.** `mapTaskContractToBridge` в `task-classifier.ts` выводил
`requestedTools` из `contract.deliverable` через `resolveProducer(...)` и из
`requiredCapabilities`, не учитывая `interactionMode`. Результат уходил прямо в планнер.

**Правило.** Когда `lowConfidenceStrategy === "clarify"` (любой источник: либо
`clarification_needed`, либо `clarify_first`, либо новое правило P0.2), bridge в планнер
должен быть respond-only:

```ts
const CLARIFY_RESPOND_ONLY_BRIDGE = {
  intent: "general",
  artifactKinds: [],
  requestedTools: [],
  publishTargets: [],
  outcomeContract: "text_response",
  executionContract: {
    requiresTools: false,
    requiresWorkspaceMutation: false,
    requiresLocalProcess: false,
    requiresArtifactEvidence: false,
    requiresDeliveryEvidence: false,
    mayNeedBootstrap: false,
  },
};
```

Плюс `deliverable` не пробрасывается в планнер.

**Фикс.** `buildPlannerInputFromTaskContract` в `task-classifier.ts` теперь выбирает
`CLARIFY_RESPOND_ONLY_BRIDGE` при `lowConfidenceStrategy === "clarify"` и не включает
`deliverable` в planner input.

Это закрывает инвариант целиком (обе ветки — «классификатор сам сказал clarify» и «P0.2
вывод»), потому что подстановка происходит в одной точке.

**Тесты.**
- `src/platform/decision/task-classifier.test.ts`:
  - `"P0.3: clarify_first turn never smuggles tool requests into the planner input"` —
    `interactionMode=clarify_first`, `deliverable=document/pdf` ⇒ всё очищено,
    `requestedTools=[]`, `artifactKinds=[]`, `deliverable=undefined`, `outcomeContract="text_response"`.

---

## Проверка (verify checklist)

- [x] `pnpm vitest run src/platform/decision/task-classifier` — 28/28 passed (было 25).
- [x] `pnpm vitest run src/platform/recipe/planner src/platform/decision/input
      src/platform/decision/qualification-confidence src/platform/plugin.classifier` —
      51/51 passed.
- [x] `pnpm vitest run src/agents/pi-embedded-runner/run.overflow-compaction
      src/agents/pi-embedded-runner/run.overflow-compaction.loop` — 22/22 passed.
- [x] `pnpm tsgo --noEmit` (через `ReadLints` на изменённых файлах) — 0 ошибок.
- [ ] **Ручная проверка live:** перезапустить `pnpm gateway:dev`, подать Trader-подобный
      промпт, убедиться в `.gateway-dev.log`, что на turn ровно одна строка
      `[planner] selected` с `caller=auto-reply-runtime-plan`. Latency должен упасть на
      300–800ms.
- [ ] **Ручная проверка safety:** подать двусмысленный промпт («почини баг»), убедиться,
      что оркестратор уходит в clarify, а не в `apply_patch`.
- [ ] **Ручная проверка consistency:** проверить, что на clarify-turn в планнер уходит
      `requestedTools=[]` (в plannerSelection лог-строке).

Ручные проверки — для следующего шага (см. мастер-план §5). Автоматика закрыта.

---

## Что НЕ включено в P0 (перенесено дальше)

- «Сделай X как отдельного агента» не распознаётся отдельно от `code_change` → P1.1
  (`DeliverableSpec.kind = "agent_persona"`).
- Проверка наличия API hash / ключей перед стартом code-change scaffold → P1.2
  (`ensureCredentials`).
- Гранулярные `kind = "code_change"` / `"repo_operation"` для git-потоков → P1.3.
- Pre-existing 10 failures в `runtime-adapter.test.ts` — НЕ фиксятся здесь, это legacy,
  адресовано в Track C v1 handoff и повторно в P3.

---

## History

- 2026-04-20 — P0.1/P0.2/P0.3 реализованы, 3 юнит-теста добавлены, 1 регрессионный
  расширен. Задачи закрыты автоматикой; ручная verify-серия в §Проверка — следующий
  шаг владельца `dev`.
