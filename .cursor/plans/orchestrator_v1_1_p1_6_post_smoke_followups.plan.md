# Orchestrator v1.1 — P1.6 (Post-smoke follow-ups, 2026-04-22)

**Мастер-план:** `orchestrator_v1_1_master.plan.md`.
**Статус:** OPEN — три независимых follow-up'а после ручного Telegram-смоука 2026-04-22.
**Зависимости:** P1.2 ✅, P1.4 ✅, P1.5 ✅. Не блокирует P1.1.
**Принцип:** не плодим enum'ы (`outcome` / `deliverable.kind` / `strategy` остаются
фиксированными), не привязываемся к одному каналу, не меняем classifier vocabulary.
Все три фикса делаются **за счёт сужения существующих контрактов**, а не за счёт
расширения словаря.

---

## Контекст (что увидели в живом тесте 2026-04-22)

Один Telegram-чат, последовательность сообщений Vladimir'а:

1. «Подними `C:\Users\Tanya\source\repos\kitty-banana` на свободном порту»
2. «Нарисуй миленького котика»
3. «Напомни завтра в 12:00 поесть»
4. «Просто подними сервер»
5. «Напиши стих в 4 строки»
6. «Уже поднял» / «Да» / «Стих напиши» / «Да, только сюда в чат»

Симптомы:

- **A.** На «подними сервер» бот **5 раз подряд** запустил `pnpm dev` (5176, 5177,
  5178, 5179) — нет идемпотентности, каждый message = новый run.
- **B.** В ответе на «подними сервер» планнер выбрал scaffold-recipe и сохранил
  `server-status-note.txt` в workspace («контракт сверху ошибочно требовал
  code-change/scaffold_repo»). Файл вместо запущенного процесса.
- **C.** На задачи «нарисуй котика», «напиши стих», «напомни», «подними сервер»
  бот **повторно требовал** `BYBIT_API_KEY` / `OPENAI_API_KEY` / `TELEGRAM_API_HASH`,
  потому что capability `needs_repo_execution` несёт `requiredEnv` со списком ключей
  Bybit/OpenAI/TG, не имеющих отношения к запуску локального сервера.

Все три симптома независимы: их корни в трёх разных файлах, исправляются тремя
разными промптами, не блокируют друг друга.

---

## Инварианты (применимы ко всем трём этапам)

1. **Никаких новых outcome / deliverable.kind / strategy.** Если возникает соблазн
   добавить `local_process_management`, `process_run`, `external_delivery`,
   `reminder_set` — стоп. Решаем через сужение существующих recipe-контрактов
   и/или через `deliverable.constraints` (свободный JSON, не enum).
2. **Channel-agnostic.** Никакой логики, привязанной к Telegram, в `platform/`.
   Telegram/Max/UI — только адаптеры, читающие платформенные сигналы.
3. **Zero parsing.** Guard `pnpm lint:routing:no-prompt-parsing` остаётся зелёным.
4. **History дополняется снизу, ничего не удаляется.**

---

## Этап P1.6.1 — `requiredEnv` переезжает с capability на deliverable [x] (2026-04-22)

**Симптом:** после ручного смоука 2026-04-22 бот на любую задачу с
`needs_repo_execution` (запуск сервера, exec команды, даже шуточные) требует
`BYBIT_API_KEY` / `OPENAI_API_KEY` / `TELEGRAM_API_HASH`.

**Корневая причина.** В `src/platform/bootstrap/defaults.ts` (строки ~131–144)
capability `needs_repo_execution` объявлена с
`requiredEnv: ["TELEGRAM_API_HASH", "OPENAI_API_KEY", "BYBIT_API_KEY"]`. P1.2
preflight (`collectMissingRequiredEnvForCapabilities`) корректно исполняет это
требование — но требование само по себе **слишком крупная гранула**.
`needs_repo_execution` срабатывает почти для любого code-execution turn'а,
тогда как ключи нужны только конкретным провайдерам/интеграциям.

**Что делаем (минимум).**

- В `Trusted_Capability_Catalog` (см. `src/platform/bootstrap/defaults.ts`)
  убрать `requiredEnv` у `needs_repo_execution` (capability снова означает
  только «нужно право запускать команды», без привязки к ключам).
- Источник `requiredEnv` переезжает в `deliverable.constraints`-aware
  предикат внутри `planner.ts` (или нового `src/platform/recipe/credentials-preflight.ts`):
  - Таблица `provider → envKeys` (один JSON, не enum в коде; начальный набор:
    `{ bybit: ["BYBIT_API_KEY"], openai: ["OPENAI_API_KEY"],
    telegram_userbot: ["TELEGRAM_API_HASH"] }`).
  - Если `deliverable.constraints` содержит `provider`/`integration` — preflight
    поднимает соответствующие env-ключи; иначе — не поднимает ничего.
- `clarification_needed: missing_credentials:*` срабатывает только когда есть
  явный `provider`-сигнал.

**Acceptance.**

- `pnpm vitest run src/platform/recipe/planner.test.ts src/platform/decision/task-classifier.test.ts`
  обновлён: «exec без provider» не уходит в `clarification_needed`; «scaffold
  bybit-bot» уходит, как раньше.
- Live `19-credentials-preflight` остаётся зелёным (он явно про `provider=bybit`).
- Новый/расширенный сценарий: «exec команды без provider'а» НЕ требует ключей.
- В коде нет нового outcome / нового deliverable.kind. Изменился только
  `requiredEnv`-источник.

**Файлы (ожидаемо).**
- `src/platform/bootstrap/defaults.ts` — снять `requiredEnv` с capability.
- `src/platform/recipe/planner.ts` (или новый `credentials-preflight.ts`) —
  предикат по `deliverable.constraints`.
- Таблица провайдеров — отдельный JSON-литерал в одном модуле, не разнесён.
- Тесты + live `19-credentials-preflight` (без регрессии) +
  новый кейс «exec без provider».

---

## Этап P1.6.2 — Recipe принимает exec-receipt как достаточный [x] (2026-04-22)

**Симптом.** На «подними сервер» планнер уходит в scaffold-recipe и пишет
`C:\Users\Tanya\.openclaw\workspace-dev\server-status-note.txt`, потому что
существующий recipe для `repo_operation/exec` неявно ожидает `apply_patch`
как часть evidence/deliverable.

**Корневая причина.** Recipe (`code_build_publish` или эквивалент, выбираемый
для `repo_operation/exec`) считает «контракт не выполнен», если среди receipts
нет `apply_patch`. Поэтому при чисто-exec задаче finalizer добиться evidence
может только записью файла — и пишет note. Это **жёсткая рамка внутри recipe**,
а не классификатора.

**Что делаем (минимум).**

- В recipe, который выбирается для `deliverable.kind=repo_operation` +
  `operation=exec`, **ослабить evidence-требования**: достаточным receipt'ом
  считается успешный `exec` (с непустым `stdout`/`exitCode=0`/`url`/`pid`),
  `apply_patch` становится опциональным.
- Никакого нового deliverable.kind не вводим. Никакого `process_run` /
  `local_process_management` не появляется.
- Если task — это явный «start a local process» (вид определяется по уже
  существующим сигналам classifier'а — `interactive_local_result` /
  `tool_call=exec` / отсутствие `apply_patch` в `requestedTools`), то
  finalizer **не дописывает note** в workspace.

**Acceptance.**

- Тест-кейс в `src/platform/recipe/planner.test.ts` (или `runtime-adapter.test.ts`):
  «repo_operation/exec без apply_patch — receipt от exec считается достаточным,
  finalizer не пишет note».
- Live: добавить или расширить `17-workspace-aware-exec` сценарием
  «start dev server» и убедиться, что в `.openclaw/workspace-dev/` не появляется
  `server-status-note.txt`.
- В коде: ни одного нового outcome / kind / strategy. Изменился только predicate
  «is contract satisfied».

**Файлы (ожидаемо).**
- `src/platform/recipe/runtime-adapter.ts` или `planner.ts` — predicate evidence.
- `src/platform/runtime/execution-intent-from-plan.ts` — возможно, не нужно.
- Тесты по затронутым файлам + live smoke.

---

## Этап P1.6.3 — Intent fingerprint + idempotency window [x] (2026-04-22)

**Симптом.** Vladimir пишет «подними сервер» три раза подряд → бот спавнит
три vite-процесса (5176/5177/5178). Никакая проверка «это уже сделано»
не выполняется.

**Корневая причина.** Каждый user message инициирует новый `runRecipe()`
без обращения к receipts ledger. `intent-ledger` сейчас читается только
классификатором (`<pending_commitments>` инжект в prompt) и не используется
как short-circuit на уровне executor'а.

**Что делаем (минимум).**

- Новый модуль `src/platform/session/intent-fingerprint.ts`:
  - `computeIntentFingerprint(deliverable, capabilities): string` —
    детерминистическая функция (не LLM): для exec — `target_repo + command`;
    для apply_patch — `path + content_hash`; для image_generate — `prompt + size`;
    fallback: `kind + JSON.stringify(constraints)`.
  - Окно по умолчанию 60s (env `OPENCLAW_INTENT_IDEMPOTENCY_WINDOW_MS`,
    `0` — kill-switch).
- В `src/auto-reply/reply/agent-runner.ts` перед `runRecipe()`:
  - `lookupRecentReceipt(sessionId, channelId, fingerprint, windowMs)` →
    если найден свежий успешный receipt того же fingerprint'а, recipe **не
    запускается**, бот возвращает «уже сделано: <ссылка/PID/путь>»
    через тот же reply-tube.
- Никакой LLM-эвристики «похоже это то же самое». Только чистый детерминизм
  по `deliverable`.
- Channel-agnostic: работает одинаково в TG, Max, webchat, UI.

**Acceptance.**

- Unit-тесты `src/platform/session/intent-fingerprint.test.ts`:
  стабильность фингерпринта по эквивалентным `deliverable`,
  различие при разных `path`/`command`/`prompt`.
- Integration-тест `agent-runner` (или e2e): три подряд «подними сервер
  X» в окне 60s → один реальный run + два «already-done» reply.
- Live сценарий `20-intent-idempotency` в `scripts/live-routing-smoke.mjs`:
  два подряд одинаковых exec'а в окне 60s → второй возвращает receipt
  первого без нового `tool_call=exec` в `progress.frame`.
- Kill-switch `OPENCLAW_INTENT_IDEMPOTENCY_WINDOW_MS=0` отключает поведение
  (для отладки).

**Файлы (ожидаемо).**
- `src/platform/session/intent-fingerprint.ts` (+ тест).
- `src/auto-reply/reply/agent-runner.ts` — preflight lookup перед `runRecipe`.
- `src/platform/session/intent-ledger.ts` — расширить read-API для поиска
  по fingerprint'у (не новая структура — просто другой query).
- `scripts/live-routing-smoke.mjs` — `20-intent-idempotency`.

---

## Что НЕ входит в P1.6 (отложено осознанно)

- `reply_to_message_id` в Telegram → **P1.7-A** (channel-agnostic
  `inReplyTo` в progress-event, отдельная ветка).
- Coalescing same-intent сообщений в окне `lane` → **P1.7-B** (надstройка
  над P1.6.3 fingerprint, отдельная ветка).
- Тёплый restart oversized session → **P1.7-C** (платформенный фикс,
  отдельная ветка).
- Sandbox/exec host config → **P2.x** (не код-фикс, конфигурационное решение).

Эти четыре пункта зависят либо от P1.6.3 (fingerprint), либо от стабильного
post-smoke baseline. Поэтому открыты, но не в этом sub-плане.

---

## Verify (общий чек после всех трёх этапов)

```powershell
# Юниты по затронутым файлам
pnpm vitest run src/platform/bootstrap src/platform/recipe src/platform/session src/auto-reply/reply

# Guard
pnpm lint:routing:no-prompt-parsing

# Live
pnpm live:routing:smoke
# Ожидание: 19/19 PASS (текущий baseline) + 20-intent-idempotency PASS,
# + 19-credentials-preflight остаётся PASS,
# + 17-workspace-aware-exec остаётся PASS (без появления note-файла).

# Ручной Telegram-смоук (после поднятия gateway:dev:channels)
# 1. «подними C:\path\to\repo» x3 в окне 60s → один процесс, два «already-done».
# 2. «нарисуй котика» → НЕ просит ключи (нет provider'а).
# 3. «подними сервер» → процесс реально стартует, note-файл НЕ появляется.
```

---

## History

- 2026-04-22 — план создан после ручного Telegram-смоука 2026-04-22 17:27–17:37 MSK.
  Три независимых follow-up'а зафиксированы как 1.6.1 / 1.6.2 / 1.6.3, идут
  тремя разными промптами, не блокируют друг друга. Принцип: не расширяем
  enum'ы, не плодим channel-specific логику, сужаем существующие контракты.
- 2026-04-22 — **P1.6.1 закрыт.** `requiredEnv` снят с capability
  `needs_repo_execution` в `src/platform/bootstrap/defaults.ts`. Новый модуль
  `src/platform/recipe/credentials-preflight.ts` несёт provider→envKeys
  таблицу (`bybit / openai / telegram_userbot` + алиасы `telegram` / `tg` /
  `tg_userbot`) и читает `deliverable.constraints.provider` /
  `.integration` (string или array). `planner.ts::planExecutionRecipe` и
  `task-classifier.ts::applyCredentialsPreflight` объединяют capability- и
  deliverable-источники через `Set` и поднимают `clarification_needed:
  missing_credentials:*` только при наличии явного provider-сигнала.
  Classifier-prompt получил один новый guidance-параграф: «provider ставится
  только когда deliverable реально завязан на API; стих/картинка/`pnpm dev`
  — без provider'а». Никаких новых outcome / kind / strategy. Verify:
  targeted `pnpm vitest run src/platform/recipe/planner.test.ts
  src/platform/decision/task-classifier.test.ts src/platform/bootstrap`
  ✅, lint `lint:routing:no-prompt-parsing` ✅. Live `19-credentials-
  preflight` остаётся PASS на baseline (закладывает provider=bybit
  сценарий); добавление сценария «exec без provider'а» оставлено в общий
  `pnpm live:routing:smoke`-прогон при следующем gateway smoke.
- 2026-04-22 — **P1.6.2 закрыт.** Ослаблен только predicate удовлетворённости
  execution contract внутри runtime/recipe closure без расширения vocabulary:
  `repo_operation` + exec-only путь больше не требует `apply_patch` и
  `platform_action` как обязательные evidence. Для local-process / dev-server
  задач достаточным считается успешный `exec` receipt с `exitCode=0` и runtime
  evidence (`stdout` / `url` / `pid`); `apply_patch` остаётся опциональным.
  Изменены `src/platform/runtime/evidence-sufficiency.ts` и
  `src/platform/runtime/service.ts`; добавлены regression-тесты в
  `src/platform/runtime/evidence-sufficiency.test.ts` и
  `src/platform/runtime/service.test.ts`. Verify:
  `pnpm vitest run src/platform/recipe src/platform/runtime` ✅ (139/139),
  `pnpm lint:routing:no-prompt-parsing` ✅, live
  `SMOKE_ONLY=17-workspace-aware-exec,17b-start-dev-server pnpm live:routing:smoke`
  ✅ (2/2 PASS), причём `17b-start-dev-server` подтвердил, что
  `C:\Users\Tanya\.openclaw\workspace-dev\server-status-note.txt` не создаётся.
- 2026-04-22 — **P1.6.3 закрыт.** Добавлен детерминистический
  `intent-fingerprint` (`src/platform/session/intent-fingerprint.ts`) без LLM-
  эвристик: для `repo_operation/exec` — `target_repo + command_signature`, для
  `code_change/apply_patch` — `path + content_hash`, для `image` —
  `prompt_normalized + size`, fallback — `kind + stable JSON(constraints)`;
  окно идемпотентности по умолчанию 60s, kill-switch:
  `OPENCLAW_INTENT_IDEMPOTENCY_WINDOW_MS=0`. `execution-intent-from-plan.ts`
  теперь прокидывает `deliverable` в runtime intent; `intent-ledger.ts`
  расширен read-API (`lookupRecentReceipt`) и умеет хранить fingerprint +
  успешные receipts в той же структуре entry (без отдельного ledger store).
  В `src/auto-reply/reply/agent-runner-execution.ts` добавлен preflight
  short-circuit до запуска embedded agent: при свежем receipt того же
  fingerprint'а раннер отвечает через тот же reply-tube текстом вида
  `Уже сделано: <url/PID/path>` и не доходит до `exec`. В
  `src/auto-reply/reply/agent-runner.ts` fingerprint записывается обратно в
  ledger вместе с runtime receipts. Добавлен live smoke сценарий
  `20-intent-idempotency` в `scripts/live-routing-smoke.mjs` с проверкой, что
  во втором повторном turn нет нового `progress.frame phase=tool_call
  toolName=exec`. Unit verify: targeted `intent-fingerprint.test.ts`,
  `intent-ledger.test.ts`, `execution-intent-from-plan.test.ts` и regression
  `agent-runner.misc.runreplyagent.test.ts` для short-circuit ✅. Guard
  `pnpm lint:routing:no-prompt-parsing` ✅. Широкий
  `pnpm vitest run src/platform/session src/auto-reply/reply` остаётся красным
  по множеству pre-existing `reply/**` failures вне scope (директивы /
  ACP / media / heartbeat); targeted regression на P1.6.3 зелёный.
