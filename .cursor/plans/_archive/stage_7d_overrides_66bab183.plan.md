---
name: Stage 7D Overrides
overview: Довести specialist decision center от read-only explainability до реального, но узкого и policy-safe управления через base/session profile override. План фокусируется на backend write seam, применении override в runtime и минимальном UI-активационном слое поверх уже сделанного Stage 7C.
todos:
  - id: persist-specialist-session-fields
    content: Добавить specialist override поля в session store и validation
    status: completed
  - id: add-specialist-write-seam
    content: Протянуть gateway/session patch seam для auto/base/session specialist override
    status: completed
  - id: apply-specialist-override-runtime
    content: Учесть persisted override в agent-command planner/runtime path
    status: completed
  - id: upgrade-specialist-read-model
    content: Сделать platform.profile.resolve отражающим реальный override state
    status: completed
  - id: activate-specialist-ui-controls
    content: Включить override controls в specialist UI panel без большого редизайна
    status: completed
  - id: test-stage7d-overrides
    content: Добавить focused backend/UI tests и локализационную проверку для Stage 7D
    status: completed
isProject: false
---

# Stage 7D: Writable Specialist Overrides

## Goal

Сделать следующий логичный срез после Stage 7C: превратить specialist decision center из read-only surface в узкий рабочий control seam для `auto` / `base profile` / `session profile`, не трогая MAX и не уходя в большой UI redesign.

## Why This Is Next

- Stage 7C уже вывел specialist/runtime state в UI и подготовил override contract, но он остаётся заглушкой в [src/platform/profile/gateway.ts](src/platform/profile/gateway.ts).
- В runtime сейчас specialist plan считается слишком рано: `resolvePlatformRuntimePlan(...)` вызывается до `resolveSession(...)` в [src/agents/agent-command.ts](src/agents/agent-command.ts), поэтому даже будущие session overrides не начнут реально влиять на execution без отдельного шага.
- В session store есть зрелый паттерн patch/persist для runtime overrides, но specialist fields туда ещё не добавлены в [src/config/sessions/types.ts](src/config/sessions/types.ts) и [src/gateway/sessions-patch.ts](src/gateway/sessions-patch.ts).

## In Scope

- Добавить минимальные persisted specialist override поля в session store.
- Дать gateway write seam для specialist override.
- Применить persisted override в реальном planner/runtime path.
- Активировать существующий Stage 7C UI override block в [ui/src/ui/views/specialist-context.ts](ui/src/ui/views/specialist-context.ts).
- Сохранить policy-safe поведение: override меняет profile preference, но не выдаёт скрытые полномочия.

## Out Of Scope

- MAX integration.
- Большой visual redesign.
- Полный profile editor / конструктор specialist profiles.
- Широкая переработка overview/chat beyond activation of the existing override seam.
- Разбор текущих unrelated `pnpm tsgo` failures вне touched surface.

## Core Files

- [src/config/sessions/types.ts](src/config/sessions/types.ts)
- [src/gateway/sessions-patch.ts](src/gateway/sessions-patch.ts)
- [src/platform/profile/contracts.ts](src/platform/profile/contracts.ts)
- [src/platform/profile/gateway.ts](src/platform/profile/gateway.ts)
- [src/platform/profile/resolver.ts](src/platform/profile/resolver.ts)
- [src/platform/recipe/runtime-adapter.ts](src/platform/recipe/runtime-adapter.ts)
- [src/agents/agent-command.ts](src/agents/agent-command.ts)
- [src/platform/plugin.ts](src/platform/plugin.ts)
- [ui/src/ui/controllers/specialist.ts](ui/src/ui/controllers/specialist.ts)
- [ui/src/ui/views/specialist-context.ts](ui/src/ui/views/specialist-context.ts)
- [ui/src/ui/app-view-state.ts](ui/src/ui/app-view-state.ts)
- [ui/src/ui/app-render.ts](ui/src/ui/app-render.ts)
- [ui/src/i18n/locales/en.ts](ui/src/i18n/locales/en.ts)
- [ui/src/i18n/locales/ru.ts](ui/src/i18n/locales/ru.ts)

## Proposed Steps

### 1. Persist Specialist Override State

Добавить в [src/config/sessions/types.ts](src/config/sessions/types.ts) минимальный session-level specialist payload:

- `specialistOverrideMode?: "auto" | "base" | "session"`
- `specialistBaseProfileId?: ProfileId`
- `specialistSessionProfileId?: ProfileId`

Нормализовать и валидировать их по существующим profile enums/contracts, по аналогии с уже существующими runtime session overrides.

### 2. Add Gateway Write Seam

Расширить session patch flow в [src/gateway/sessions-patch.ts](src/gateway/sessions-patch.ts) или выделить узкий specialist patch helper, чтобы UI мог:

- переключать `auto`
- задавать `base profile`
- задавать `session profile`
- очищать override

Сразу держать это в existing session patch model, если это не ломает текущую API форму. Это самый маленький путь без раздувания surface новым большим subsystem.

### 3. Apply Override In Real Runtime

Исправить sequencing в [src/agents/agent-command.ts](src/agents/agent-command.ts): specialist planner input должен учитывать persisted session override после `resolveSession(...)`, а не только raw prompt/body.

Практически:

- либо перенести/повторно вычислять `platformRuntimePlan`
- либо ввести helper, который merge-ит resolved session specialist overrides в planner input перед финальным execution plan

Done condition этого шага: override влияет не только на `platform.profile.resolve`, но и на фактический runtime selection для agent execution.

### 4. Upgrade Read Model To Real Override State

Обновить [src/platform/profile/gateway.ts](src/platform/profile/gateway.ts), чтобы `platform.profile.resolve` больше не возвращал постоянную заглушку:

- `override.supported: true`
- актуальный `mode`
- актуальные `baseProfileId` / `sessionProfileId`
- осмысленный `note` только если для конкретного режима есть ограничение

### 5. Activate Existing UI Seam

На базе уже сделанного Stage 7C включить control behavior в:

- [ui/src/ui/controllers/specialist.ts](ui/src/ui/controllers/specialist.ts)
- [ui/src/ui/views/specialist-context.ts](ui/src/ui/views/specialist-context.ts)
- [ui/src/ui/app-render.ts](ui/src/ui/app-render.ts)

Минимальный UX:

- enabled select вместо disabled override mode control
- profile pickers только когда mode != `auto`
- loading/saving/error state
- refresh specialist snapshot после apply

Без лишней полировки: reuse текущий panel/strip layout.

### 6. Tighten Specialist Vocabulary

Дошлифовать copy в [ui/src/i18n/locales/en.ts](ui/src/i18n/locales/en.ts) и [ui/src/i18n/locales/ru.ts](ui/src/i18n/locales/ru.ts), особенно там, где Stage 7C оставил mixed labels вроде `Recipe`, `Base profile`, `Session profile` в RU specialist block.

### 7. Focused Validation

Добавить targeted coverage:

- session patch tests for persisted specialist fields
- contract tests for `platform.profile.resolve` with `auto/base/session`
- agent/runtime tests proving override affects selected profile/recipe
- UI tests for enabled override controls, empty/auto/base/session states, and RU/EN copy

## Risks To Control

- Не допустить, чтобы override обходил policy; он влияет на preference/planner, не на permissions.
- Не хранить specialist override в ad-hoc UI local state; source of truth должен остаться в session store + gateway snapshot.
- Не оставить двойной источник runtime truth между `platform.profile.resolve` и `agent-command` execution path.
- Не расползтись в “full profile editor”; Stage 7D должен остаться узким operational slice.

## Done When

- Session can persist `auto/base/session` specialist override.
- `platform.profile.resolve` отражает реальный persisted override, а не placeholder.
- Agent runtime реально использует override при profile/recipe selection.
- Existing Stage 7C specialist panel becomes an active control seam with focused tests and localized copy.
