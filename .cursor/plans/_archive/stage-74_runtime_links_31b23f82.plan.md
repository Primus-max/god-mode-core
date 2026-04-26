---
name: stage-74 runtime links
overview: Bring Sessions runtime linked-record buttons onto the same canonical destination helpers and SPA handoff pattern used by other operator surfaces. This keeps bootstrap/artifact recovery pivots shareable, refresh-safe, and native for modified clicks without introducing a new URL contract.
todos:
  - id: canonicalize-runtime-linked-record-hrefs
    content: Перевести bootstrap/artifact links в Sessions runtime inspector на shared canonical destination builders вместо ad hoc buildTabHref.
    status: completed
  - id: wire-runtime-linked-record-handoff
    content: Добавить primary-click SPA handoff для internal runtime linked-record links, сохранив browser-native modified-click/new-tab behavior.
    status: completed
  - id: lock-runtime-linked-record-regressions
    content: Обновить tests и docs для Sessions runtime linked-record link parity.
    status: completed
isProject: false
---

# Stage 74 - Sessions Runtime Linked Record Link Parity

## Goal

Сделать linked-record переходы внутри `sessions` runtime inspector полноценными canonical entrypoints: ссылки на `bootstrap` и `artifacts` должны использовать тот же shared destination contract, что и сами поверхности, и при primary click оставаться внутри SPA без full document navigation.

## Why This Stage

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts) runtime linked records всё ещё собираются через low-level `buildTabHref(...)`, а не через destination-specific canonical helpers:

```370:406:ui/src/ui/views/sessions.ts
function renderRuntimeLinkedRecords(checkpoint: RuntimeCheckpointSummary, props: SessionsProps) {
  return html`
    <div class="row" style="gap:8px; flex-wrap:wrap; margin-top:12px;">
      ${checkpoint.target?.bootstrapRequestId
        ? html`<a class="btn" href=${buildTabHref({ basePath: props.basePath }, "bootstrap", {
            session: checkpoint.sessionKey ?? props.runtimeSessionKey,
            bootstrapRequest: checkpoint.target.bootstrapRequestId,
          })}>...`
        : nothing}
      ${checkpoint.target?.artifactId
        ? html`<a class="btn" href=${buildTabHref({ basePath: props.basePath }, "artifacts", {
            session: checkpoint.sessionKey ?? props.runtimeSessionKey,
            artifact: checkpoint.target.artifactId,
          })}>...`
        : nothing}
    </div>
  `;
}
```

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts) уже есть подходящие shared helpers: `buildCanonicalBootstrapHref(...)` и `buildCanonicalArtifactsHref(...)`.
- Это сильный operator path: recovery/checkpoint investigation часто заканчивается переходом в конкретный bootstrap request или artifact record. Сейчас surface уже выглядит как link surface, но ещё не выровнен по canonical contract и SPA handoff.
- Scope чистый: не нужен новый query namespace, только reuse существующих destination builders и уже знакомого click-semantics pattern.

## Planned Changes

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.ts):
  - Добавить пропсы уровня `buildRuntimeBootstrapHref(...)` / `buildRuntimeArtifactHref(...)` или один общий link-builder для linked records, чтобы view перестал собирать destination URL вручную.
  - Добавить `isModifiedNavigationClick(...)`-guarded primary-click interception для internal linked-record links, по тому же шаблону, что уже используется для session rows, pagination и runtime inspect controls.
  - Оставить modified clicks нативному браузерному поведению.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-render.ts):
  - Пробросить builders поверх `buildCanonicalBootstrapHref(...)` и `buildCanonicalArtifactsHref(...)`, накладывая `bootstrapRequest` / `artifact` override поверх уже существующего destination context.
  - Добавить app-level navigation callback для primary-click handoff, скорее всего тем же pattern, что и `overview attention`: `pushState` на target href и затем `onPopState(...)`, чтобы destination tab/query state гидратировались одинаково для direct open, refresh и in-app click.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.ts):
  - Логику query contract не расширять.
  - При необходимости добавить маленькие helper wrappers для runtime-linked overrides, но не дублировать `bootstrap` / `artifacts` contract вне existing canonical builders.

## Validation

- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\sessions.test.ts):
  - Обновить render regressions так, чтобы runtime linked-record hrefs ожидались через `buildCanonicalBootstrapHref(...)` и `buildCanonicalArtifactsHref(...)`, а не через `buildTabHref(...)`.
  - Добавить primary-click vs modified-click regression для representative bootstrap/artifact runtime link.
  - Проверить, что primary click вызывает handoff callback, а modified click остаётся browser fallthrough.
- В [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\app-settings.test.ts):
  - При необходимости добавить regression на representative `buildCanonicalBootstrapHref(...)` / `buildCanonicalArtifactsHref(...)` override комбинации из sessions-runtime entry path, если текущего builder coverage недостаточно.
- Обновить notes в [C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md](C:\Users\Tanya\source\repos\god-mode-core\docs\help\testing.md) и [C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md](C:\Users\Tanya\source\repos\god-mode-core\docs\web\control-ui.md):
  - Зафиксировать, что runtime linked bootstrap/artifact pivots теперь reuse'ят canonical destination helpers и поддерживают modified-click parity так же, как другие operator surfaces.

## Notes

- Это сильнее, чем следующий boolean-only polish вроде `logsAutoFollow` или `instancesReveal`: здесь уже есть operator-facing links в критичном recovery flow, но они ещё не дотянуты до общей canonical routing модели.
- Это чище, чем тащить сейчас новый URL contract для более тяжёлых transient investigations: никакие новые query params не нужны, только выравнивание existing destinations и SPA handoff semantics.
- Хороший success criterion: copied runtime-linked URL, refresh destination tab и direct in-app click все приводят к одному и тому же selected bootstrap/artifact record без ручного повторного drill-down.
