# Orchestrator v1.1 — P1.5 (Workspace & Identity Self-Awareness)

**Мастер-план:** `orchestrator_v1_1_master.plan.md`.
**Статус:** PENDING — открыт 2026-04-21 после ручного смоука. Этапы A/B/C готовы к
исполнению по очереди.
**Зависимости:** P1.4 закрыт (Intent Ledger / SessionContext store / Progress Bus уже
есть — переиспользуем). Не блокирует P1.2 ensureCredentials, идёт независимо.

---

## Контекст

Ручной Telegram-смоук 2026-04-21 показал, что оркестратор **не знает сам про себя**:

1. На запрос `запусти "kitty vs banana" на свободном порту` бот выбрал `cwd =
   C:\Users\Tanya\.openclaw\workspace-dev`, выполнил `npm run …` и упал ENOENT —
   потому что `package.json` лежит в другом репо. Бот **угадывал** cwd.
2. На `подготовь catalog entry для figlet` бот создал заготовку JSON в
   workspace-dev, не зная, что catalog живёт в `god-mode-core`.
3. На `в /media картинки есть?` бот ушёл в clarify (`дай доступ`), хотя `ls /media`
   — read-only операция, которую можно было просто попробовать.
4. На `четверостишье Пушкина на англ` бот выдал собственный стих «в духе Пушкина»
   вместо того, чтобы сходить в `web_search`.

Все четыре симптома — одна архитектурная дыра: **classifier и planner получают
prompt без фактов про среду**. Они не знают, какая cwd, какие repo-roots, какие
tools реально подключены, какая сейчас активна персона. Они вынуждены либо
угадывать, либо переспрашивать, либо галлюцинировать.

P1.5 закрывает эту дыру **тремя независимыми этапами**:
- **A** — `WorkspaceProbe` producer + расширение `SessionContext` (in-memory, lazy).
- **B** — Conditional injection `<workspace>` / `<identity>` в classifier prompt
  (только когда turn реально требует workspace; платим токенами по факту).
- **C** — Live smoke сценарии, повторяющие проблемные ручные кейсы.

---

## Философия

> Оркестратор должен знать о среде **факты**, а не **правила**. Мы не учим его
> «если запрос про код — иди в репо X». Мы кладём в его prompt объективное
> описание среды, и он сам выбирает контракт. Контракты остаются свободными.

Инварианты P1.5 (должны держаться после всех трёх этапов):

1. **Никакого парсинга user-input** — guard `lint:routing:no-prompt-parsing`
   должен оставаться зелёным. Probe смотрит **на FS и ENV**, не на promtp.
2. **Lazy и условно.** Workspace snapshot строится **только** когда classifier
   первым проходом сказал «нужен workspace» (`needs_workspace_mutation` или
   `requestedTools` содержит `exec`/`apply_patch`/`process`/`bootstrap`).
   На turn'ах clarify/respond_only мы платим **0 токенов** на workspace.
3. **Один источник правды, две проекции.** Внутри — структурированный JSON
   (`WorkspaceSnapshot`, `IdentityFacts`). Наружу для GPT-5.4 — короткий
   текстовый блок `<workspace>…</workspace>` ≤ 200 токенов. Когда появится своя
   модель — добавим вторую проекцию (или скормим JSON через function-calling),
   producer и storage не меняются.
4. **Только факты, никаких инструкций.** В блоке `<workspace>` нет фраз вида
   «запускай в первом roots» или «никогда не делай X». Только: какая cwd, какие
   roots, что в них лежит, какая ветка. Бот сам решает.
5. **In-memory, без новых внешних deps.** Никакого MCP / Memplace / БД.
   Хранилище — то же `SessionContext`, что у `IntentLedger` (P1.4 A).
   Future-trained-model заменит storage через тот же интерфейс.

---

## Этапы

### Этап A — WorkspaceProbe + SessionContext extension

**Цель.** Сделать дешёвый локальный probe, который собирает факты про среду, и
расширить session-store полем `workspace`/`identity`. Без интеграции в classifier
prompt — это этап B.

**Scope (что ДА).**
- Новый модуль `src/platform/session/workspace-probe.ts`:
  - Тип `WorkspaceSnapshot { defaultCwd, roots: WorkspaceRoot[], capturedAt, ttlMs }`.
  - Тип `WorkspaceRoot { path, hasGit?: { remote?, branch? }, marker?:
    "package.json"|"pyproject.toml"|"Cargo.toml"|"openclaw" }`.
  - Pure-функция `probeWorkspace(opts: { extraRootsEnv?: string; cwd?: string;
    fs?: WorkspaceProbeFs }): Promise<WorkspaceSnapshot>`. `fs` инжектится для
    тестов; в продакшене дефолт — `node:fs/promises`.
  - Resolution roots: `process.cwd()` бота **+** запятые/`;` из
    `OPENCLAW_WORKSPACE_ROOTS` (если задано). Дубликаты убираем по абсолютному
    нормализованному пути.
  - Для каждого root: presence-флаги (`package.json` / `pyproject.toml` /
    `Cargo.toml` / `.openclaw/workspace.json`), `.git` → `git remote get-url
    origin` + `git rev-parse --abbrev-ref HEAD` (через спавн `git`,
    timeout 1s, fail-soft = поле просто отсутствует).
  - Top-level entries: только имена директорий первого уровня, **не более 20**;
    если больше — обрезаем и добавляем флаг `truncated:true`.
  - Без рекурсии. Без чтения содержимого файлов.
  - Бюджет: одна локальная FS-операция на root + один `git`-вызов на root.
    На 2 roots — < 50ms типично.
- Новый модуль `src/platform/session/identity-facts.ts`:
  - Тип `IdentityFacts { persona?: string; availableTools: string[];
    availableCapabilities: string[]; capturedAt, ttlMs }`.
  - `buildIdentityFacts(opts: { personaResolver?: () => string | undefined;
    toolRegistry: ToolRegistry; capabilityRegistry: CapabilityRegistry }):
    IdentityFacts`. Источники — уже существующие реестры
    (`ProducerRegistry`, `Trusted_Capability_Catalog`).
- Расширение `SessionContext` (если уже есть central store) или
  `intent-ledger.ts` namespace map: добавить опциональные поля
  `workspace?: WorkspaceSnapshot` и `identity?: IdentityFacts` рядом с
  ledger-entries. **Не плодить новый Map** — переиспользуем тот же
  in-memory store по `sessionId+channelId`.
- API на чтение/запись:
  - `getOrProbeWorkspace(session, channel, opts): Promise<WorkspaceSnapshot>` —
    если кэш свеж (TTL по умолчанию 5 мин), возвращает кэш; иначе зовёт
    `probeWorkspace`, кэширует, возвращает.
  - `invalidateWorkspace(session, channel)` — для будущей инвалидации после
    `apply_patch` (этап B/C).
  - `getOrBuildIdentity(session, channel, opts)` — аналог для identity, TTL
    дольше (например, 30 мин — реестры меняются редко).
- Лог-тег `[workspace-probe]` в gateway log:
  `[workspace-probe] session=<id8> roots=<n> probedMs=<ms> cached=<0|1>`.

**Scope (что НЕТ).**
- Нет инжекции в prompt — это этап B.
- Нет инвалидации после `apply_patch`/`exec` — заведём в этап B/C.
- Нет персиста на диск.
- Нет чтения содержимого файлов (только `existsSync` / `stat` / `readdir`).
- Нет parsing prompt'а или env с whitelist'ами вида «если в repo Trader — то X».

**Где трогаем.**
1. `src/platform/session/workspace-probe.ts` — новый файл.
2. `src/platform/session/workspace-probe.test.ts` — юнит-тесты.
3. `src/platform/session/identity-facts.ts` — новый файл.
4. `src/platform/session/identity-facts.test.ts` — юнит-тесты.
5. `src/platform/session/intent-ledger.ts` (или эквивалентный store-модуль) —
   расширить in-memory map значениями `workspace?`, `identity?` без поломки
   существующих API. **Обратная совместимость:** read-API
   `peekPending(...)` поведение не меняется.
6. Сам реестр capabilities: если он не экспортирует «список того, что включено»
   как pure read — добавить тонкий read-only адаптер в `src/platform/produce/`
   или `src/agents/` (без изменения логики регистрации).

**Acceptance.**
- [x] Юнит: `probeWorkspace` корректно собирает 6 кейсов (2026-04-22):
  (a) только cwd без `.git`,
  (b) cwd с `.git` и `package.json`,
  (c) `OPENCLAW_WORKSPACE_ROOTS` с двумя путями (и дубликат cwd дедуплицируется),
  (d) root с > 20 top-level entries → `truncated:true`,
  (e) `git` упал/timeout → `hasGit` отсутствует, snapshot всё равно валидный,
  (f) несуществующий root в env → silently skipped, лог `[workspace-probe]
  skipped=<n>`.
- [x] Юнит: `getOrProbeWorkspace` возвращает кэш в окне TTL без второго FS-вызова
  (мокаем `fs`); после `invalidateWorkspace` — повторный probe.
- [x] Юнит: `buildIdentityFacts` возвращает стабильный список tools/capabilities
  из переданных реестров; пустой реестр → пустые массивы (не undefined).
- [x] Юнит: TTL workspace = 5 мин (env-override `OPENCLAW_WORKSPACE_TTL_MS`),
  identity = 30 мин (env `OPENCLAW_IDENTITY_TTL_MS`).
- [x] `pnpm tsgo --noEmit` не добавляет новых ошибок в файлах этапа A.
- [x] `pnpm lint:routing:no-prompt-parsing` зелёный (probe в `session/`,
  не в `decision/`).

**Неочевидные нюансы / ловушки.**
- **`process.cwd()` бота ≠ workspace пользователя.** В live-проде gateway
  стартует из `god-mode-core`, а workspace-dev — отдельная директория. Probe
  должен брать **обе**: cwd + ENV. `OPENCLAW_WORKSPACE_ROOTS` — это и есть
  способ пользователя сказать «у меня вот эти корни».
- **`git` не везде установлен.** Обязательно fail-soft, иначе probe падает на
  чистой Linux-сборке без git. Timeout 1s, поглощаем все ошибки в warn-лог.
- **Не складывать в snapshot полный `git status`** — это уже не «факт среды»,
  это состояние работы, и оно меняется на каждый `apply_patch`. Только remote
  и branch.
- **Probe не знает про логические workspaces** (например, «trader» внутри
  workspace-dev). Это намеренно: логические подпространства появляются позже
  как отдельный концерн, через `IntentLedger` и/или identity (когда у нас
  будет multi-persona запуск).

**Verify команды.**
```powershell
pnpm vitest run src/platform/session/workspace-probe.test.ts src/platform/session/identity-facts.test.ts
pnpm tsgo --noEmit
pnpm lint:routing:no-prompt-parsing
```

---

### Этап B — Conditional injection в classifier prompt

**Цель.** Положить факты этапа A в prompt classifier'а **только когда turn
действительно их требует**. Никаких regex по prompt, никаких whitelist'ов
интентов — решение основано на **выходе первого classifier-прохода** или на
явном экспрессированном tool-requirement.

**Сцена.** Сейчас `classifier.classifyTask(...)` идёт одним проходом и сразу
выдаёт TaskContract. Мы оставляем это как есть для большинства turns. Когда
первый contract говорит «нужен workspace», мы используем уже существующий
механизм **hard-replan budget=1** (этап P1.4 B) для **второго прохода
classifier+planner с обогащённым context'ом**. Это не новый pathway, а
переиспользование существующего.

**Scope (что ДА).**
- В `src/platform/decision/task-classifier.ts` — добавить опциональные поля в
  билдер запроса:
  - `workspaceContext?: string` — текстовая проекция `WorkspaceSnapshot`
    (≤ 200 токенов).
  - `identityContext?: string` — текстовая проекция `IdentityFacts` (≤ 50
    токенов: persona + первые 8 tools).
  - Прошивка в system prompt отдельными блоками `<workspace>…</workspace>` и
    `<identity>…</identity>`, **строго перед** `<pending_commitments>`.
- В `src/platform/decision/input.ts` (или эквивалентной точке, где сейчас
  собираем classifier-input) — функция `shouldInjectWorkspaceContext(taskContract)`:
  - true, если `taskContract.deliverable.kind ∈
    {"code_change","repo_operation","external_delivery/tool_execution"}`
  - **или** `taskContract.executionContract.requestedTools`
    содержит хоть одно из `["exec","apply_patch","process","bootstrap"]`
  - **или** `taskContract.deliverable.subkinds` указывает на
    workspace mutation.
  - false — для `clarification_needed`, `answer/respond_only`,
    pure `image_generate`/`web_search`.
- Для **первого turn** в сессии: identity injectится на любом turn
  (дёшево, ≤ 50 токенов), workspace — нет (платим за него только когда нужен).
- Проекция в текст:
  - `projectWorkspaceForPrompt(snapshot, opts: { maxTokens=200 }): string` —
    строит блок:
    ```text
    default_cwd: <abs path>
    roots:
      - <path> [git=<remote>@<branch>] [has=package.json,.git,...]
      - <path> [...]
    ```
    Усечение по приоритету: сначала отбрасываем `truncated` top-level dirs,
    потом дальние roots.
  - `projectIdentityForPrompt(facts, opts: { maxTokens=50 }): string` —
    `persona: ...\ntools: a, b, c, ...`. Truncate по списку tools.
- Лог-тег `[workspace-inject] session=<id8> turn=<id8>
  reason=<contract|tools> tokens=<n>` — на каждый turn, где мы инжектим.
  Для skipped — не логируем (шум).
- Hard-replan trigger: если первый classifier-проход выдал
  `clarification_needed` **и** `ambiguities` явно указывают на «не знаю где»
  (это уже есть в `IntentLedger.peekClarifyCount`), мы можем единожды
  обогатить prompt workspace-контекстом и переклассифицировать.
  **Опционально для этапа B**, но фигурирует в acceptance C.

**Scope (что НЕТ).**
- Нет нового LLM-вызова сверх существующих. Если первый classifier выдал ОК —
  второго прохода нет.
- Нет **записи** в snapshot из classifier (read-only consumer).
- Нет авто-инвалидации workspace после `apply_patch` — это этап C.
- Нет инжекции в planner prompt напрямую (planner получает уже
  классифицированный contract — этого достаточно).

**Где трогаем.**
1. `src/platform/decision/input.ts` — добавить:
   - вызов `getOrBuildIdentity(...)` всегда,
   - вызов `getOrProbeWorkspace(...)` условно по `shouldInjectWorkspaceContext`,
   - проекции в текст,
   - проброс в `classifyTask` через новые опциональные поля.
2. `src/platform/decision/task-classifier.ts` — поддержка новых полей
   в билдере, прошивка в system prompt.
3. `src/platform/decision/task-classifier.test.ts` — кейсы:
   - identity всегда инжектится (token budget),
   - workspace инжектится для exec-турна, не инжектится для clarify,
   - проекция корректно усекается до budget'а.
4. `src/platform/session/workspace-probe.ts` — экспорт
   `projectWorkspaceForPrompt`.
5. `src/platform/session/identity-facts.ts` — экспорт
   `projectIdentityForPrompt`.
6. `src/platform/decision/input.test.ts` — кейсы `shouldInjectWorkspaceContext`
   (8 веток true/false).

**Acceptance.**
- [ ] Юнит: `shouldInjectWorkspaceContext` корректно различает 8 кейсов
  contract'ов.
- [ ] Юнит: `projectWorkspaceForPrompt` укладывается в 200 токенов на снапшоте
  с 3 roots × 20 top-level entries; для пустого snapshot — пустая строка
  (а не `<workspace></workspace>`).
- [ ] Юнит (classifier): при наличии `workspaceContext` с двумя roots
  classifier (mock) получает его в system prompt в правильном порядке
  (`<workspace>` → `<identity>` → `<pending_commitments>`).
- [ ] Юнит: identity injected даже на `respond_only`-турн (бот должен знать,
  какие tools у него есть, чтобы не отказывать).
- [ ] `pnpm vitest run src/platform/decision src/platform/session` — без
  регрессий относительно текущей baseline (баг-листа того же масштаба).
- [ ] `pnpm tsgo --noEmit` не добавляет новых ошибок в файлах этапа B.
- [ ] `pnpm lint:routing:no-prompt-parsing` зелёный.
- [ ] `[workspace-inject]` появляется в `.gateway-dev.log` ровно на тех turn'ах,
  где мы реально инжектим (проверяется в этапе C live-смоуком).

**Неочевидные нюансы / ловушки.**
- **Порядок блоков важен.** `<workspace>` и `<identity>` — это «глобальный
  контекст», должны идти раньше `<pending_commitments>` (turn-state) и тем
  более раньше user-message. Иначе LLM воспринимает их как добавочную
  команду, а не как фон.
- **Если snapshot пустой** (probe не нашёл ни одного root — мало вероятно,
  но возможно) — **не инжектим вообще**. Лучше тишина, чем `<workspace>
  default_cwd: /\nroots: []\n</workspace>` (это формирует у LLM ложное
  впечатление пустоты).
- **Identity без persona** (например, internal smoke без активной личности)
  — печатаем `tools: …` без строки `persona`, не пишем `persona: undefined`.
- **Изменения env между turn'ами** (пользователь добавил
  `OPENCLAW_WORKSPACE_ROOTS` через `/reload`) — для MVP мы пересобираем
  snapshot по TTL (5 мин), реактивности не делаем. Документируем.

**Verify команды.**
```powershell
pnpm vitest run src/platform/decision src/platform/session
pnpm tsgo --noEmit
pnpm lint:routing:no-prompt-parsing
```

**Зависимости.** Этап A (probe + storage). Не начинать без него.

---

### Этап C — Live smoke + invalidation на mutate

**Цель.** Доказать, что в реальном Telegram-чате повторяются ручные кейсы
**без угадывания** cwd и без галлюцинаций про tools, и что после `apply_patch`
snapshot актуализируется.

**Scope (что ДА).**
- В `scripts/live-routing-smoke.mjs` — два новых сценария:
  - `17-workspace-aware-exec`:
    - 1 turn: задаём `OPENCLAW_WORKSPACE_ROOTS` с двумя roots (один — этот
      репо, второй — sibling-папка без `package.json`).
    - User-prompt: `запусти "node --version" в проекте god-mode-core`.
    - Pass: gateway log содержит `[workspace-inject] reason=tools` для этого
      turn; финальный assistant turn содержит `toolCall name=exec` с
      `command="node --version"`; в metadata receipt'а cwd = первый root
      (тот, где есть `package.json` и `.git`), а не второй.
  - `18-identity-aware-recall`:
    - User-prompt: `четверостишье Пушкина на английском` (или похожий
      «нужен факт извне»).
    - Pass: бот **либо** дёргает `web_search` tool (если в identity он есть),
      **либо** честно говорит «не уверен в каноническом переводе, могу
      сходить в web_search?» — но НЕ выдаёт собственный стих в духе.
    - Acceptance — наличие либо `tool_call name=web_search`, либо
      `clarification_needed` с упоминанием web_search в ambiguities.
      Ни в коем случае не respond_only с прозой «в духе».
- Инвалидация snapshot после `apply_patch`:
  - В `src/platform/runtime/service.ts` (или ближайшая точка post-tool):
    после успешного `apply_patch` receipt'а вызвать
    `invalidateWorkspace(session, channel)`.
  - Лог `[workspace-probe] invalidated reason=apply_patch session=<id8>`.
- Юнит-тест на инвалидацию: после симуляции `apply_patch` receipt next
  `getOrProbeWorkspace` пере-зовёт probe (мок).

**Scope (что НЕТ).**
- Нет инвалидации на `exec` (exec может ничего не менять; тот же
  `node --version` снапшот не трогает). Делаем только на `apply_patch`.
- Нет регулярного fs-watcher'а — это overkill для MVP.
- Нет UI для пользователя «вот твои roots». Сейчас факты живут только в
  prompt-контексте.

**Где трогаем.**
1. `scripts/live-routing-smoke.mjs` — два новых сценария + переменные
   окружения для setup roots.
2. `src/platform/runtime/service.ts` — `invalidateWorkspace` вызов после
   `apply_patch`-success-receipt.
3. `src/platform/runtime/service.test.ts` — кейс на инвалидацию (если
   pre-existing failures позволяют, иначе — отдельный mini-test файл).

**Acceptance.**
- [ ] Live: `SMOKE_ONLY=17-workspace-aware-exec pnpm live:routing:smoke` —
  passed; в metadata `exec`-receipt cwd соответствует root с `package.json`.
- [ ] Live: `SMOKE_ONLY=18-identity-aware-recall pnpm live:routing:smoke` —
  passed по одному из двух правил выше (web_search либо явный clarify
  с упоминанием web_search).
- [ ] Юнит: invalidation после `apply_patch` приводит к повторному probe
  на следующий `getOrProbeWorkspace`.
- [ ] `pnpm live:routing:smoke` (полный прогон) не регрессирует существующие
  16 сценариев — те же passed остаются passed.
- [ ] `[workspace-probe] invalidated reason=apply_patch` появляется в
  gateway log на live-турне, который содержит реальный `apply_patch`.

**Неочевидные нюансы / ловушки.**
- Сценарий `17` чувствителен к порядку roots в `OPENCLAW_WORKSPACE_ROOTS` —
  ставим тестируемый root первым, проверяем, что бот выбрал именно его, а
  не дефолт.
- Сценарий `18` зависит от поведения LLM — для стабильности можно сделать
  его двух-проходным с retry budget=1, как `15-clarify-budget`. Это
  не «жёсткие рамки» — это smoke-flakiness mitigation.
- Инвалидация **не должна** быть синхронной в hot-path (после `apply_patch`
  пользователь ждёт ответа). Делаем через `setImmediate(() =>
  invalidateWorkspace(...))` или эквивалент — побочный эффект.
- Не забыть: при инвалидации **identity** не трогается (реестры tools не
  меняются от `apply_patch`).

**Verify команды.**
```powershell
pnpm vitest run src/platform/session src/platform/decision src/platform/runtime
pnpm tsgo --noEmit
pnpm lint:routing:no-prompt-parsing
SMOKE_ONLY=17-workspace-aware-exec,18-identity-aware-recall pnpm live:routing:smoke
pnpm live:routing:smoke   # полный прогон, регрессия проверяется
```

**Зависимости.** Этапы A и B. Live-сценарии бессмысленны без injection.

---

## Будущее (out of scope P1.5, для записи)

- **Логические workspaces** (несколько проектов внутри одного root) —
  отдельная история, появится с multi-persona и persona-specific scope.
- **Persistent workspace map** — когда у нас будет своя модель и/или
  мульти-host gateway. Текущий MVP — in-memory.
- **fs-watcher для авто-инвалидации** — даст «свежесть» без зависимости от
  TTL, но добавляет subscription-overhead. Сейчас не нужен.
- **UI «твой текущий контекст»** — для пользователя видеть, какие roots
  активны и что бот про них знает. Это плагин/UI-задача, не ядро.

---

## История

- 2026-04-21 — план создан после ручного Telegram-смоука P1.4 D.2,
  выявившего три симптома self-knowledge gap (кейс «kitty vs banana» ENOENT,
  кейс `/media` clarify-вместо-ls, кейс «Пушкин на англ» галлюцинация).
  Открыты 3 этапа: A (probe + storage), B (conditional injection),
  C (live smoke + apply_patch invalidation). Не блокирует P1.2.
- 2026-04-22 — **Этап A закрыт (scope A)**. Добавлены `src/platform/session/workspace-probe.ts`
  (+ unit `workspace-probe.test.ts`, 8 кейсов: 6 probe + cache/invalidate + TTL override),
  `src/platform/session/identity-facts.ts` (+ unit `identity-facts.test.ts`, стабильные
  tools/capabilities, empty-registry, identity TTL override), расширен in-memory store в
  `src/platform/session/intent-ledger.ts` полями `workspace?` и `identity?` рядом с ledger
  entries и API `getOrProbeWorkspace` / `invalidateWorkspace` / `getOrBuildIdentity`
  без изменения поведения `peekPending`. Лог `[workspace-probe]` добавлен
  (`session`, `roots`, `probedMs`, `cached`, `skipped`). Verify:
  `pnpm vitest run src/platform/session/workspace-probe.test.ts src/platform/session/identity-facts.test.ts` ✅,
  `pnpm lint:routing:no-prompt-parsing` ✅, `pnpm tsgo --noEmit` остаётся красным по
  pre-existing baseline вне scope A (новых ошибок в затронутых файлах нет).
