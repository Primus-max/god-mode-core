---
name: Stage 1 Profiles
overview: Спроектировать автоматическое определение потребностей пользователя, specialist profiles и policy foundation.
todos:
  - id: design-profile-model
    content: Описать модель base/session/task profile.
    status: pending
  - id: define-scoring-signals
    content: Зафиксировать сигналы и правила automatic profile scoring.
    status: pending
  - id: define-policy-foundation
    content: Определить базовые policy decisions и safety boundaries.
    status: pending
isProject: false
---

# Stage 1: Policy And Profile Foundation

## Goal

Научить систему автоматически выбирать профиль и execution preference без ручной настройки пользователя.

## Scope

- Ввести `base profile`, `session profile`, `task overlay`.
- Спроектировать `Profile Resolver` и `Policy Engine foundation`.
- Зафиксировать сигналы scoring: запросы, файлы, артефакты, цели публикации, интеграции.

## Target Areas

- [C:/Users/Tanya/source/repos/god-mode-core/src/plugins/types.ts](C:/Users/Tanya/source/repos/god-mode-core/src/plugins/types.ts)
- [C:/Users/Tanya/source/repos/god-mode-core/src/commands/agent.ts](C:/Users/Tanya/source/repos/god-mode-core/src/commands/agent.ts)
- new platform modules рядом с orchestration layer

## Deliverables

- Profile resolution model.
- Policy decision model.
- Initial profiles: `general`, `builder`, `developer`.

## Tests

- Unit tests для profile scoring.
- Unit tests для overlay resolution.
- Safety tests, что профиль не выдаёт скрытые права.
- Integration tests для mixed-use scenarios.

## Done When

- Один пользователь может автоматически получать document-first или code-first поведение.
- Specialist profile не блокирует fun/general задачи.
