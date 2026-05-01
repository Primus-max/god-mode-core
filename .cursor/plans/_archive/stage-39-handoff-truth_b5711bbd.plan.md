---
name: stage-39-handoff-truth
overview: Выравнять UI/operator contract вокруг `handoffRequestRunId` / `handoffRunId` / `handoffTruthSource`, чтобы sessions/runtime navigation и поясняющий UX опирались на текущую truth-ветку recovery vs closure и не уводили оператора в устаревший run.
todos:
  - id: normalize-handoff-runtime-selection
    content: Вынести truth-aware правило выбора runtime target для sessions inspect path и применить его в UI.
    status: completed
  - id: surface-handoff-truth-context
    content: Показать в sessions минимальный handoff truth context без визуального шума.
    status: completed
  - id: lock-handoff-regressions-and-docs
    content: Добавить focused regressions и обновить docs/testing guidance для handoff contract.
    status: completed
isProject: false
---

# Stage 39 — Handoff Truth Surfaces

## Почему это следующий шаг

После `Stage 38` operator correlation уже покрывает `sessions/bootstrap/artifacts/cron/machine`, но в `sessions` остался более фундаментальный contract gap: кнопка runtime inspect всё ещё предпочитает `runClosureSummary.runId`, хотя продуктовая документация уже говорит, что при `handoffTruthSource === "recovery"` нужно доверять handoff-полям как текущей truth-ветке.

Якорные места:

- `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts)`: `onInspectRuntimeSession(row.key, row.runClosureSummary?.runId ?? row.handoffRunId ?? row.handoffRequestRunId)`
- `[C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md)`: handoff note уже фиксирует, что при `recovery` handoff-поля важнее persisted closure history.
- `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\sessions.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\sessions.ts)`: UI уже получает `handoffRequestRunId`, `handoffRunId`, `handoffTruthSource`, но почти не использует их как operator-facing contract.

## Цель

Сделать `handoff` полноценной и объяснимой частью уже существующего operator flow:

- `sessions -> runtime inspector` открывает текущий truth run, а не случайный исторический closure run;
- оператор видит, откуда сейчас берётся handoff truth: `closure` или `recovery`;
- request anchor и current runtime target перестают быть скрытым внутренним состоянием и становятся минимально explainable в UI;
- всё это остаётся thin UI-orchestration поверх существующих `sessions.*` и `platform.runtime.*` surfaces, без нового dashboard или backend-агрегатора.

## Scope

### 1. Нормализовать truth-aware выбор runtime target

Вынести единое правило выбора run для inspect/navigation, чтобы оно было согласовано с handoff contract, а не с локальным ad hoc order.

Основные файлы:

- `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts)`
- `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\sessions.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\sessions.ts)`
- при необходимости маленький helper рядом с sessions view/controller

Минимальный contract:

- если `handoffTruthSource === "recovery"`, inspect сначала использует `handoffRunId`, затем `handoffRequestRunId`, и только потом closure history, если это вообще нужно как fallback;
- если `handoffTruthSource === "closure"`, inspect использует closure-aligned run и request anchor без recovery-приоритета;
- логика выбора живёт в одном месте и не дублируется по кнопкам/линкам.

### 2. Показать handoff truth минимально и по делу

Расширить существующую sessions surface так, чтобы оператору было понятно, какой run считается текущим truth и чем он отличается от durable history.

Основные файлы:

- `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts)`
- `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\types.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\types.ts)`
- `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\i18n\locales\en.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\i18n\locales\en.ts)`
- `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\i18n\locales\ru.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\i18n\locales\ru.ts)`

Показывать минимум:

- truth source: `closure` vs `recovery`;
- current handoff target / request anchor только там, где это помогает inspect decision и не превращает строку sessions в шум;
- краткий hint, когда active recovery truth расходится с persisted closure summary.

### 3. Добить parity в tests/docs

Закрепить handoff как явный operator contract, а не скрытый transport detail.

Основные файлы:

- `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.test.ts)`
- `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\sessions.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\sessions.test.ts)`
- `[C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md)`
- `[C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md](C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md)`

Regression focus:

- `handoffTruthSource === "recovery"` открывает recovery-aligned run вместо stale closure run;
- `handoffTruthSource === "closure"` не ломает текущий inspect path;
- docs явно описывают request anchor vs current runtime target для operator UX.

## Границы stage

Не включать в этот этап:

- новый handoff dashboard
- расширение gateway/schema beyond tiny incidental cleanup
- новый cross-session incident flow
- переработку runtime checkpoint/action ledger

## Критерии выхода

- `sessions` inspect path следует handoff truth contract, а не случайному полю из historical closure summary.
- Operator UI минимально объясняет разницу между request anchor, current runtime target и durable closure history.
- Focused UI tests и `pnpm build` подтверждают, что existing Stage 34–38 flow не сломан.

## Проверка

- Один regression на truth-aware inspect selection в `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.test.ts)`.
- Один regression на parsing/preservation handoff fields в `[C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\sessions.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\controllers\sessions.test.ts)`.
- `pnpm build` и focused sessions tests остаются зелёными.
