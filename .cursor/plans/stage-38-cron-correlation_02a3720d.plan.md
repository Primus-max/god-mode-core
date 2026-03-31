---
name: stage-38-cron-correlation
overview: "Довести `cron` до того же operator-flow уровня, что уже есть у `sessions/bootstrap/artifacts`: overview attention должен не просто сигналить о failed/overdue job’ах, а открывать нужную cron-запись и, где возможно, вести дальше в связанный session/runtime context без ручного поиска."
todos:
  - id: extend-cron-deeplink-contract
    content: Добавить cron job selection в query/deep-link state и синхронизировать это состояние между app-settings, app-render и cron tab.
    status: completed
  - id: wire-cron-attention-drilldown
    content: Превратить failed/overdue cron attention items в actionable ссылки на canonical cron surface с правильным preselect контекстом.
    status: completed
  - id: connect-cron-history-to-operator-context
    content: Дать из cron run history переход в связанный session/runtime context, используя уже доступные поля или минимально расширив cron payload при необходимости.
    status: completed
  - id: lock-cron-correlation-regressions
    content: Закрепить focused regressions и docs guidance для нового cron correlation flow.
    status: completed
isProject: false
---

# Stage 38 — Cron Correlation Surfaces

## Почему это следующий шаг

После `Stage 37` операторский recovery flow уже безопаснее и объяснимее, но `cron` всё ещё отстаёт от того же navigation contract, который уже получили `sessions`, `bootstrap`, `artifacts` и `machine`.

Ключевой незакрытый gap виден прямо в `overview attention`: cron-сигналы уже считаются, но остаются пассивным текстом без перехода в нужный surface.

```850:872:ui/src/ui/app-settings.ts
const cronJobs = host.cronJobs ?? [];
const failedCron = cronJobs.filter((j) => j.state?.lastStatus === "error");
if (failedCron.length > 0) {
  items.push({
    severity: "error",
    icon: "clock",
    title: `${failedCron.length} cron job${failedCron.length > 1 ? "s" : ""} failed`,
    description: failedCron.map((j) => j.name).join(", "),
  });
}
// overdue jobs тоже без href / actionLabel
```

И deep-link слой пока знает только про `bootstrap/artifact/runtime`, но не про выбранную cron job или её run scope:

```127:157:ui/src/ui/app-settings.ts
function applyDeepLinkStateFromUrl(host, sources) {
  host.bootstrapSelectedId = pick("bootstrapRequest");
  host.artifactsSelectedId = pick("artifact");
  host.runtimeSessionKey = pick("runtimeSession");
  host.runtimeRunId = pick("runtimeRun");
  host.runtimeSelectedCheckpointId = pick("checkpoint");
}
```

При этом cron view уже знает `sessionKey` у run history и умеет вести только в `chat`, то есть связанный operator path до `sessions/runtime inspector` ещё не собран:

```1716:1770:ui/src/ui/views/cron.ts
typeof entry.sessionKey === "string" && entry.sessionKey.trim().length > 0
  ? `${pathForTab("chat", basePath)}?session=${encodeURIComponent(entry.sessionKey)}`
// ...
if (onNavigateToChat && entry.sessionKey) {
  onNavigateToChat(entry.sessionKey);
}
```

## Цель

Сделать `cron` полноценной частью уже существующего operator correlation flow:

- overview attention открывает вкладку `cron` с правильным предвыбором job;
- cron state переживает refresh/popstate так же, как `bootstrap/artifact/runtime`;
- из cron run history оператор может перейти не только в чат, но и в `sessions/runtime inspector`, когда есть связанный session/runtime context;
- это остаётся thin UI orchestration поверх существующих surfaces, без нового incident dashboard.

## Scope

### 1. Добавить cron в deep-link contract

Расширить URL/query state тем же паттерном, который уже используется для `bootstrapRequest`, `artifact`, `runtimeSession`, `runtimeRun`, `checkpoint`.

Основные файлы:

- [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts)
- [ui/src/ui/app.ts](ui/src/ui/app.ts)
- [ui/src/ui/app-render.ts](ui/src/ui/app-render.ts)

Минимальный contract:

- `cronJob=<id>` для выбранной job
- при необходимости отдельный query для run scope/history, только если это нужно для стабильного refresh

### 2. Превратить cron attention из пассивного сигнала в действие

Доработать `buildAttentionItems(...)`, чтобы failed/overdue cron сигналы:

- ссылались на canonical cron record;
- использовали тот же `buildTabHref(...)` / `actionLabel`, что уже применяется в `bootstrap/artifacts/machine`;
- оставались explainable и не дублировали backend-логику.

Основные файлы:

- [ui/src/ui/app-settings.ts](ui/src/ui/app-settings.ts)
- [ui/src/ui/views/overview-attention.ts](ui/src/ui/views/overview-attention.ts)

### 3. Довести cron surface до operator drill-down parity

На самой cron-вкладке:

- гидрировать выбранную job из URL;
- сохранять выбор обратно в URL после user action;
- из run history дать переход не только в `chat`, но и в `sessions/runtime inspector`, если хватает данных.

Основные файлы:

- [ui/src/ui/controllers/cron.ts](ui/src/ui/controllers/cron.ts)
- [ui/src/ui/views/cron.ts](ui/src/ui/views/cron.ts)
- [ui/src/ui/app-render.ts](ui/src/ui/app-render.ts)
- [ui/src/ui/types.ts](ui/src/ui/types.ts)

Важно:

- если текущего `CronRunLogEntry` достаточно (`sessionKey` already present), переиспользовать это;
- если для runtime jump реально нужен `runId` или request anchor, добавить только минимальное расширение существующего `cron` payload, без нового агрегирующего backend слоя.

### 4. Закрепить regressions и docs guidance

Добавить focused coverage на новый cron correlation contract.

Основные файлы:

- [ui/src/ui/app-settings.test.ts](ui/src/ui/app-settings.test.ts)
- [ui/src/ui/views/overview-attention.test.ts](ui/src/ui/views/overview-attention.test.ts)
- [ui/src/ui/views/cron.test.ts](ui/src/ui/views/cron.test.ts)
- [ui/src/ui/controllers/cron.test.ts](ui/src/ui/controllers/cron.test.ts)
- [docs/help/testing.md](docs/help/testing.md)
- [docs/web/control-ui.md](docs/web/control-ui.md)

## Границы stage

Не включать в этот этап:

- новый incident dashboard
- cross-gateway / fleet aggregation
- большой audit/history subsystem для cron
- переписывание runtime/core scheduler logic, если хватает текущих `cron.*` surfaces

## Критерии выхода

- Failed/overdue cron signals в overview attention имеют рабочий drill-down в нужную cron job.
- Выбранная cron job восстанавливается после refresh/popstate через query state.
- Из cron run history оператор может открыть связанный session/runtime context без ручного поиска, когда эти данные доступны.
- `docs/help/testing.md` и `docs/web/control-ui.md` больше не отстают от нового cron/operator flow.
- Focused UI tests и `pnpm build` проходят.

## Проверка

- Один regression на `buildAttentionItems(...)`, где cron signal получает корректный `href` и `actionLabel`.
- Один regression на cron deep-link hydration/sync через URL.
- Один regression на переход из cron history в связанный operator surface (`chat` и/или `sessions`, в зависимости от доступных полей).
- `pnpm build` и focused UI tests остаются зелёными.
