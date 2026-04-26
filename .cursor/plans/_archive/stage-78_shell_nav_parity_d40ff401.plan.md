---
name: stage-78 shell nav parity
overview: Починить сломанный shell home affordance и подтянуть command palette к тому же canonical tab navigation contract, что уже использует sidebar, чтобы верхний shell перестал иметь мёртвые или урезанные navigation entrypoints.
todos:
  - id: wire-shell-breadcrumb
    content: Сделать breadcrumb `OpenClaw` реальным canonical navigation entrypoint в `overview` вместо неиспользуемого custom event.
    status: completed
  - id: expand-palette-navigation
    content: Расширить navigation section command palette до тех же high-signal tabs, что уже поддерживает sidebar/navigation model.
    status: completed
  - id: lock-shell-nav-regressions
    content: Добавить focused tests и docs для shell breadcrumb и command palette navigation parity.
    status: completed
isProject: false
---

# Stage 78 - Shell Navigation Parity

## Goal

Довести верхний shell до той же navigation contract-модели, что уже есть у sidebar: breadcrumb `OpenClaw` должен стать реальным canonical entrypoint в `overview`, а command palette должен давать keyboard-first доступ к тем же основным tabs, не обходя `state.setTab(...)` и URL sync.

## Why This Stage

- В [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/components/dashboard-header.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/components/dashboard-header.ts) breadcrumb сейчас выглядит как навигация, но только диспатчит `CustomEvent("navigate")`, который нигде не слушается, поэтому верхний home affordance фактически сломан.
- В [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/command-palette.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/command-palette.ts) navigation section покрывает только небольшой поднабор tabs (`overview`, `sessions`, `cron`, `skills`, `config`, `agents`), хотя [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/navigation.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/navigation.ts) и sidebar уже считают первичными и другие operator surfaces вроде `usage`, `channels`, `artifacts`, `bootstrap`, `nodes`, `logs`.
- Это сильный `v1` stabilization шаг: он убирает реально мёртвый navigation affordance в shell и закрывает разрыв между мышиной и keyboard-first навигацией без новых query params и без большого refactor.

## Key Evidence

```17:28:C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/components/dashboard-header.ts
return html`
  <div class="dashboard-header">
    <div class="dashboard-header__breadcrumb">
      <span
        class="dashboard-header__breadcrumb-link"
        @click=${() => this.dispatchEvent(new CustomEvent("navigate", { detail: "overview", bubbles: true, composed: true }))}
      >
        OpenClaw
      </span>
```

```504:506:C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-render.ts
<div class="topnav-shell__content">
  <dashboard-header .tab=${state.tab}></dashboard-header>
</div>
```

```68:96:C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-render.helpers.ts
<a
  href=${href}
  class="nav-item ${isActive ? "nav-item--active" : ""}"
  @click=${(event: MouseEvent) => {
    ...
    event.preventDefault();
    state.setTab(tab);
  }}
>
```

## Scope

- Make the shell breadcrumb a real canonical `overview` navigation target.
- Expand command palette navigation coverage to the same high-signal primary tabs already exposed by sidebar/navigation groups.
- Reuse existing `buildCanonicalTabHref(...)` / `state.setTab(...)` patterns; do not invent a new navigation mechanism or URL contract.
- Keep the current product intent that the breadcrumb represents “go to Overview”, not “go to `/` chat root”.

## Planned Changes

- In [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/components/dashboard-header.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/components/dashboard-header.ts): replace the dead custom-event-only breadcrumb pattern with a real navigation API surface, preferably a canonical `href` plus the same primary-click interception semantics used elsewhere, or minimally a consumed event contract that `app-render.ts` actually handles.
- In [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-render.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-render.ts): wire the header navigation into `state.setTab("overview")` and canonical URL sync, keeping modified-click browser behavior if the breadcrumb becomes a true `<a>`.
- In [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/command-palette.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/command-palette.ts): expand `PALETTE_ITEMS` navigation entries so the palette covers the same major tabs already present in [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/navigation.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/navigation.ts), especially the operator-critical surfaces added in previous routing stages.
- If needed, centralize the palette’s navigation item list around `TAB_GROUPS`/tab metadata so sidebar and palette stop drifting as new tabs are added.

## Validation

- Add focused UI regressions for the header shell path, likely in a new nearby test such as `ui/src/ui/components/dashboard-header.test.ts` or a shell-level render test:
  - one regression for the rendered breadcrumb target (`overview` canonical `href` if applicable);
  - one regression for primary-click SPA handoff;
  - one regression for modified-click browser fallthrough if the breadcrumb becomes an anchor.
- Add focused command-palette regressions, likely in a new `ui/src/ui/views/command-palette.test.ts`:
  - one regression proving the navigation list includes the expanded high-signal tabs;
  - one regression proving `nav:*` selection still goes through `onNavigate(...)` with the expected tab ids.
- If new test files are introduced, update [C:/Users/Tanya/source/repos/god-mode-core/vitest.unit-paths.mjs](C:/Users/Tanya/source/repos/god-mode-core/vitest.unit-paths.mjs).
- Add short shell-navigation notes to [C:/Users/Tanya/source/repos/god-mode-core/docs/help/testing.md](C:/Users/Tanya/source/repos/god-mode-core/docs/help/testing.md) and [C:/Users/Tanya/source/repos/god-mode-core/docs/web/control-ui.md](C:/Users/Tanya/source/repos/god-mode-core/docs/web/control-ui.md).

## Notes

- This is intentionally a shell-parity stage, not a broader runtime-routing refactor.
- A clean success criterion: topbar breadcrumb, sidebar, and command palette all reach the same canonical destinations and primary-click/tab-selection behavior without dead affordances or keyboard-only blind spots.
