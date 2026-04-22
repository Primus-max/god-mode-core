# Orchestrator v1.1 — P1 (kinds + credentials preflight)

**Мастер-план:** `orchestrator_v1_1_master.plan.md`.
**Статус:** IN_PROGRESS (P1.3 ✅, P1.2 ✅, P1.1 PENDING — 2026-04-22).
**Зависимости:** P0 закрыт.

---

## Контекст

После P0 оркестратор стабилен на уровне «classify → plan → execute». Но **виды
результата** (`DeliverableSpec.kind`) остаются слишком грубыми:

- «Сделай Trader как отдельного агента» → `kind=code_change` (создал JS-сервис в
  `.openclaw/workspace-dev/trader`, а не зарегистрировал `agent:persona:trader`).
- «Закоммить всё с сообщением X» / «запусти тесты и положи результат» → тоже
  `kind=code_change`, хотя это **`repo_operation`**, а не авторство кода.
- Нет `ensureCredentials()` — скаффолд Trader стартует без проверки `TELEGRAM_API_HASH`,
  `BYBIT_API_KEY`. Падает позже в runtime, когда уже создано 22 файла.

Цель P1 — **расширить словарь kinds** и **добавить credentials preflight**, чтобы
оркестратор отличал «напиши код» от «запусти git/tests» от «заведи нового агента», и не
начинал скаффолд без ключей.

---

## Задачи

### P1.1 — `DeliverableSpec.kind = "agent_persona"` [ ]

**Что.** Новый тип deliverable для «заведи агента X с задачей Y».

**Где трогаем.**
- `src/platform/produce/deliverable.ts` (или где лежит `DeliverableSpec` union) —
  добавить `kind: "agent_persona"` с полями `personaId`, `role`, `entryPoint`,
  `capabilities[]`.
- `src/platform/decision/task-classifier.ts` — schema `TaskContract.deliverable` принимает
  новый kind. Добавить few-shot пример в classifier prompt (если есть), иначе добавить
  rule в normalize-шаг.
- `src/platform/produce/registry.ts` — зарегистрировать producer для
  `agent_persona / json` (или какой formatted у нас для agent configs) — пока может быть
  stub, который пишет `agents/<id>/config.yaml` через `apply_patch` и возвращает путь.
- `src/platform/runtime/execution-intent-from-plan.ts` — if `kind=agent_persona`, то
  deliverable.path = `agents/<personaId>/config.yaml`.

**Acceptance.**
- Новый юнит-тест в `task-classifier.test.ts`: промпт «создай отдельного агента Trader,
  который мониторит Telegram» ⇒ `primaryOutcome=agent_persona`, `deliverable.kind="agent_persona"`.
- Live smoke: прогнать через `live:routing:smoke`, добавив кейс в набор сценариев.
- Документировать в `.cursor/docs/deliverables.md` (если есть; иначе создать).

**Неочевидные нюансы.**
- Не смешивать с `code_change`. `agent_persona` — это **регистрация сущности в
  `.openclaw/agents/`**, а не создание проекта. Если у persona есть runtime-код — он
  идёт отдельным `code_change` deliverable в следующем turn.
- У `DeliverableSpec` поле `format` должно остаться строгим union — не стринг.

---

### P1.2 — `ensureCredentials()` preflight [x] (2026-04-22)

**Что.** Перед запуском любого deliverable, требующего внешних креденшалов
(`TELEGRAM_API_HASH`, `BYBIT_API_KEY`, `OPENAI_API_KEY` etc.), оркестратор проверяет
наличие **в .env / secrets vault** и, если нет — уходит в `clarification_needed` с
`clarifyReasons=["missing_credentials: TELEGRAM_API_HASH"]`.

**Где трогаем.**
- Новый модуль `src/platform/bootstrap/ensure-credentials.ts`:
  - `ensureCredentials(required: string[], env: NodeJS.ProcessEnv): EnsureCredentialsResult`.
  - Читает `.env`, `.env.local`, `process.env`. Не логирует значения, только имена.
- `src/platform/bootstrap/service.ts` — новая фаза `credentialsPreflight` между
  `ensureCapability` и `execute`. Если `missing.length > 0` → outcome
  `clarification_needed`, telemetry `preflight_blocked`.
- `src/platform/decision/task-classifier.ts` — classifier может аннотировать
  `requiredCredentials` в `TaskContract` по контексту (опционально — более сложный путь).
- Producers, требующие креденшалов, декларируют их через
  `capabilityManifest.requiredCredentials: string[]`.

**Acceptance.**
- Юнит-тест `ensure-credentials.test.ts`: отсутствует `TELEGRAM_API_HASH` ⇒
  `EnsureCredentialsResult.ok=false`, `missing=["TELEGRAM_API_HASH"]`.
- Интеграционный тест: Trader scaffold запрошен без `.env` ⇒ orchestrator уходит в
  clarification вместо `apply_patch`.
- В `.gateway-dev.log` появляется запись `[preflight] credentials missing=[...]`.

**Неочевидные нюансы.**
- НИКОГДА не логировать значения переменных. Только имена.
- Учесть, что у capability могут быть альтернативные имена env (например,
  `TELEGRAM_API_HASH` OR `TG_API_HASH`) — поддержать `alternatives: string[][]`.

---

### P1.3 — `kind: "code_change"` vs `"repo_operation"` [x] (2026-04-20)

**Реальность после аудита.** Разделение в union, реестре producers и classifier-bridge
**уже было в коде**. Недоставало:
1. защитного инварианта в `normalizeTaskContract` — если LLM ошибочно добавит
   `needs_workspace_mutation` к git-операции, она утечёт в P0.2 guard и
   `apply_patch`;
2. покрытия тестами, фиксирующими, что git-путь не идёт через `apply_patch` и
   P0.2 не срабатывает на «просто закоммить».

**Что есть в коде (код ref):**

- `DeliverableKind` включает `"code_change"` и `"repo_operation"`
  (`src/platform/produce/registry.ts` строки 18–30).
- Producers: `code_change/{patch,workspace,edit}` → `apply_patch|write`;
  `repo_operation/{exec,test-report,script}` → `exec`
  (`src/platform/produce/registry.ts` строки 152–188).
- Classifier prompt few-shots **уже** разделяют
  `run_command|run_tests → deliverable.kind=repo_operation` и
  `refactor → deliverable.kind=code_change`
  (`src/platform/decision/task-classifier.ts` строки 220–222).
- `mapTaskContractToBridge` не добавляет `apply_patch`, если
  `deliverable.kind==="repo_operation"` (строки 733–738).
- `inferDeliverableFallback` на `workspace_change + needs_repo_execution` без
  мутации даёт `repo_operation` (строки 578–585).

**Что добавлено в P1.3:**

- **Инвариант в `normalizeTaskContract`** (`task-classifier.ts` строки 503–514):
  если `primaryOutcome==="workspace_change"` и `deliverable.kind==="repo_operation"`,
  из capabilities принудительно удаляется `needs_workspace_mutation`. Это защищает
  P0.2 safety rule и бранч `apply_patch` от LLM-дрейфа.

- **Тесты** (`task-classifier.test.ts`): три новых кейса в
  `describe("contract-first task contract routing")`:
  - `"P1.3: repo_operation builds an exec-only bridge without apply_patch or
    workspace mutation"` — `requestedTools` содержит `exec`, не содержит
    `apply_patch`; `requiresWorkspaceMutation=false`.
  - `"P1.3: low-confidence repo_operation with ambiguities does NOT trigger P0.2
    clarify"` — `confidence=0.32`, ambig≠∅, но `lowConfidenceStrategy=undefined`
    (P0.2 guard не срабатывает на git-операции).
  - `"P1.3 normalize: strips needs_workspace_mutation when
    deliverable.kind=repo_operation"` — защитный инвариант: LLM-дрейф
    нейтрализуется в normalize-step.

**Что НЕ сделано (осознанно отложено):**

- **Отдельный family `repo_ops`** — нет. `workspace_change` c `repo_operation`
  планируется в `code_build` family, это ок: family — про рантайм, а не про
  операцию. Plus `code_build` уже умеет в `exec`. Дополнительное семейство
  = breaking change в `CandidateExecutionFamilySchema`.
- **Отдельные tools `git_commit`/`git_push`** — не нужно. Всё идёт через
  `exec` + `constraints.operation`. Производный `deriveToolBundles` в
  `resolution-contract.ts` уже различает `repo_run` vs `repo_mutation`.
- **Флаг `requiresRepoMutation`** — не понадобился. P0.2 guard и
  `apply_patch` обa keying по `needs_workspace_mutation`; удаление его из
  capabilities для `repo_operation` закрывает обе точки.
- **`inferExecutionContract` для legacy-пути** (`execution-contract.ts`)
  не видит `deliverable`. Classifier-first путь (основной) не использует его.
  Legacy путь используется только при отсутствии TaskContract и не генерирует
  git-операции — правка перенесена в P3 (hardening), если понадобится.

**Verify.**

- [x] `pnpm vitest run src/platform/decision/task-classifier.test.ts` — 31/31 passed
      (было 28, +3 P1.3).
- [x] `pnpm vitest run src/platform/decision src/platform/recipe/planner` —
      92/92 passed.
- [x] `ReadLints` на изменённых файлах — 0 ошибок.
- [ ] Live smoke: добавить 2 сценария (`git commit`, `run tests`) — отложено
      до P1 verify-серии.

---

## Порядок выполнения

1. ~~P1.3~~ — закрыт 2026-04-20. См. §P1.3 выше.
2. **P1.2 следующий** — инфраструктурно, нужен до P1.1 (persona часто завязана на
   креденшалы).
3. P1.1 последним — зависит от P1.3 нормализации и P1.2 preflight.

---

## Verify checklist

- [ ] `pnpm tsgo --noEmit` — 0 ошибок.
- [ ] `pnpm vitest run src/platform/decision src/platform/recipe src/platform/bootstrap
      src/platform/produce` — зелёный.
- [ ] `pnpm lint:routing:no-prompt-parsing` — зелёный.
- [ ] `pnpm live:routing:smoke` — все 8 старых + ≥3 новых сценария.
- [ ] Проверить в `.gateway-dev.log`: отсутствие скаффолда при missing credentials.
- [ ] Обновить `orchestrator_v1_1_master.plan.md` §0 — статус P1 → `DONE`.

---

## Что НЕ входит в P1

- Поддержка Discord / Slack producers (это отдельный delivery-plan).
- Интерактивный сбор креденшалов через чат (в P1 — только clarification с указанием
  имени переменной).
- Полноценный agent lifecycle (start/stop/tail) — в P1 только регистрация persona.

---

## History

- 2026-04-20 — саб-план создан, задачи декомпозированы. Исполнитель не назначен.
- 2026-04-20 — P1.3 закрыт. Аудит показал, что большинство механики уже в коде;
  добавлен защитный инвариант в `normalizeTaskContract` и 3 новых теста
  в `task-classifier.test.ts`. P1.2 и P1.1 остаются pending. Изменённые файлы:
  `src/platform/decision/task-classifier.ts`,
  `src/platform/decision/task-classifier.test.ts`.
- 2026-04-22 — P1.2 закрыт. Добавлен credential preflight для scaffold-turn:
  `Trusted_Capability_Catalog` расширен capability `needs_repo_execution` с
  `requiredEnv`, planner получил preflight guard по `deliverable.constraints.operation=scaffold_repo`
  (missing env ⇒ fail-closed в clarification), а classifier/runtime переписывает
  `TaskContract` в `clarification_needed` с `missing_credentials:*` и инвариантом
  clarify=`respond_only` (`requestedTools=[]`, `requiresTools=false`). Добавлены unit-тесты
  в `src/platform/recipe/planner.test.ts` (env missing/present) и live smoke
  сценарий `19-credentials-preflight` в `scripts/live-routing-smoke.mjs`.
