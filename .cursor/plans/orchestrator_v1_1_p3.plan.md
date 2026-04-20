# Orchestrator v1.1 — P3 (hardening / stress)

**Мастер-план:** `orchestrator_v1_1_master.plan.md`.
**Статус:** PENDING (2026-04-20).
**Зависимости:** P0 закрыт; P1 / P2 желательно перед стрессом (чтобы не ловить их
баги в шуме).

---

## Контекст

v1.1 — это про **долговременную стабильность**. P0/P1/P2 убрали видимые баги.
P3 — убедиться, что оркестратор **не деградирует** под повторной нагрузкой,
в разных языках/фразировках, при параллельных запросах и что
`ensureCapability` идемпотентен.

Цель — получить «100-пакетный» smoke, который гоняется ночью и не флейкит.

---

## Задачи

### P3.1 — stress `live:routing:smoke` ×10 [ ]

**Что.** Сейчас `pnpm live:routing:smoke` прогоняет 8 сценариев один раз. Мы не знаем
стабильность классификатора под повтором: температура, контекст-утечки, модель-кэш.

**План.**
- Новый скрипт `scripts/live-routing-smoke-stress.mjs`:
  - Прогоняет базовый набор × 10 итераций (настраивается).
  - Собирает разброс `plan.selectedRecipeId`, `executionContract`, `confidence` по
    итерациям.
  - Флейки определяет как: для одного и того же prompt в N итераций получено ≥ 2
    различных `selectedRecipeId`.
  - Выдаёт summary: `flakeRate = flakeScenarios / totalScenarios`.
- Порог приёмки: `flakeRate ≤ 0.05` (не более 5% сценариев дают разные recipes).

**Acceptance.**
- `pnpm live:routing:smoke:stress -- --iterations=10` завершается с
  `flakeRate ≤ 0.05`.
- Артефакт: `.openclaw/test-artifacts/live-smoke-stress-<ts>.json` с breakdown по
  сценариям.
- CI step `nightly` (если есть pipeline) — добавлен, но помечен `continue-on-error` для
  первой недели.

---

### P3.2 — variant prompts (language / phrasing) [ ]

**Что.** Сейчас все промпты — на русском + английском смешанно, но без
контролируемого разброса. Хотим проверить устойчивость классификатора к:

- Языку (ru / en / mixed).
- Типографике (CAPS, опечатки, эмодзи в конце).
- Длине («fix bug in auth» vs развёрнутое ТЗ).

**План.**
- Новый набор сценариев `live-routing-smoke/variants/`:
  - Каждый базовый сценарий имеет 3 варианта: `ru`, `en`, `noisy` (опечатки + эмодзи).
  - Все должны классифицироваться идентично в `primaryOutcome` и
    `deliverable.kind`.
- Расширить `live-routing-smoke.mjs` `--variants=all|ru|en|noisy`.

**Acceptance.**
- 8 × 3 = 24 сценария. Расхождение `primaryOutcome` между вариантами одного сценария
  ≤ 1 из 24 (порог).

---

### P3.3 — `ensureCapability` idempotency [ ]

**Симптом (потенциальный).** Если дважды вызвать `ensureCapability("pdf-lib")`,
нет гарантии, что второй вызов — no-op. На CI это может приводить к повторной
установке (медленно) или к конкурентному write `node_modules` (ломается).

**Что.**
- Юнит-тест `ensure-capability.idempotency.test.ts`:
  - 1й вызов — устанавливает, возвращает `{installed: true}`.
  - 2й вызов сразу после — возвращает `{installed: false, present: true}` без
    сайд-эффектов (mock `pnpm add`).
- Параллельный тест: 3 одновременных `ensureCapability("same-pkg")` ⇒ ровно
  1 установка, остальные ждут/возвращают present.
- Audit реальный код в `src/platform/bootstrap/ensure-capability.ts` (или где он):
  - Убедиться в наличии **in-memory lock** по имени пакета.
  - Проверка presence через `require.resolve` до вызова `pnpm`.

**Acceptance.**
- Оба теста зелёные.
- `.gateway-dev.log`: при повторных однотипных промптах на `ensureCapability` НЕТ
  повторных `[capability] installing pkg=...`.

---

### P3.4 — parallel turn safety [ ]

**Что.** Два одновременных user turns (разные сессии) не должны перетирать друг
другу `platformExecutionContext`. Сейчас это проверено логически, но не тестом.

**План.**
- Юнит/интеграционный тест: два `runEmbeddedPiAgent(...)` в `Promise.all`, с разными
  промптами и разными `agentSessionId`. Проверить, что:
  - Каждый получил свой `plan`.
  - Логи каждого сессии не содержат записей другой.
  - Счётчики classifier / planner: ровно по 1 на каждый turn (не 1 общий и не 3+).

**Acceptance.**
- Тест зелёный 10 раз подряд (`--repeat 10`).

---

## Порядок выполнения

1. P3.3 первым — тихий baseline, не требует live.
2. P3.4 вторым — тоже офлайн.
3. P3.1 третьим — нужен живой gateway.
4. P3.2 последним — самый дорогой (24 сценария × live LLM).

---

## Verify checklist

- [ ] `pnpm vitest run src/platform/bootstrap/ensure-capability
      src/agents/pi-embedded-runner/run.parallel` — зелёный.
- [ ] `pnpm live:routing:smoke:stress --iterations=10` — `flakeRate ≤ 0.05`.
- [ ] `pnpm live:routing:smoke --variants=all` — `variantDrift ≤ 1/24`.
- [ ] Артефакты лежат в `.openclaw/test-artifacts/`.
- [ ] Обновить master §0 P3 → `DONE`.

---

## Что НЕ входит в P3

- Нагрузочное тестирование gateway (RPS, p99 latency) — отдельный трек.
- Chaos/fault injection (kill подпроцесса во время turn) — отдельный трек.
- Добавление новых recipes — это функциональная работа, не hardening.

---

## History

- 2026-04-20 — саб-план создан, задачи декомпозированы. Исполнитель не назначен.
