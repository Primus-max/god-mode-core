---
name: Stage 7 UIUX
overview: "Выделить фронтовый трек: русификация, UX профилей, артефакты, личный кабинет и MAX."
todos:
  - id: design-ui-information-architecture
    content: Описать новую IA для profiles, artifacts, installs и account/device flows.
    status: pending
  - id: define-russian-localization-scope
    content: Зафиксировать объём русификации UI и backend-facing surfaces.
    status: pending
  - id: define-ui-tests
    content: Подготовить компонентные и smoke тесты для нового UX.
    status: pending
isProject: false
---

# Stage 7: UI UX And Channels

## Goal

Перевести продукт из состояния upstream-like control UI в локализованный specialist-first интерфейс.

## Scope

- Русификация UI.
- UX specialist profiles и task overlays.
- Artifact-centered views.
- Capability/install statuses.
- Личный кабинет: аккаунт, устройства, ключи, интеграции.
- MAX integration track.

## Target Areas

- [C:/Users/Tanya/source/repos/god-mode-core/ui/src/i18n/lib/registry.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/i18n/lib/registry.ts)
- [C:/Users/Tanya/source/repos/god-mode-core/ui/src/i18n/lib/translate.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/i18n/lib/translate.ts)
- channel catalog and control UI surfaces

## Tests

- UI unit/component tests.
- i18n coverage tests.
- Contract tests between backend state and UI.
- Smoke tests на ключевые русифицированные flows.

## Done When

- UI отражает platform model: profiles, artifacts, installs, publish, linked devices.
- Русификация и MAX рассматриваются как отдельный продуктовый трек, а не как побочный патч.
