---
name: Stage 84 V1 Gate
overview: "Stage 84 закрывает v1 journey: все пять v1-boundary-критериев покрыты стадиями 79-83. Задача — собрать единую deterministіc v1 release gate команду (`pnpm test:v1-gate`), зафиксировать её в docs и roadmap как canonical pre-release stamp, и перевести roadmap в состояние \"v1 ready\"."
todos:
  - id: pkg-script
    content: Добавить pnpm test:v1-gate в package.json
    status: done
  - id: docs-gate-section
    content: Добавить секцию 'V1 release gate' и строку в decision table в docs/help/testing.md
    status: done
  - id: roadmap-update
    content: "Обновить master_v1_roadmap.md: Stage 84 в Active, Release Ladder + финальный статус"
    status: done
  - id: stage-plan-todos
    content: Обновить stage_84 plan — пометить todos как done
    status: done
  - id: run-gate
    content: Прогнать pnpm test:v1-gate и убедиться что всё зелёное
    status: done
isProject: false
---

# Stage 84 — V1 Release Gate

## Контекст

После Stage 83 все пять Stable V1 Boundary критериев из `[master_v1_roadmap.md](.cursor/plans/master_v1_roadmap.md)` покрыты:

- Stage 79 — Navigation Validation Gate
- Stage 80 — Release Confidence E2E Gate
- Stage 81 — Skills Reliability Evals
- Stage 82 — Runtime Recovery Confidence Gate
- Stage 83 — Session Event Broadcast Parity Gate

Текущая release ladder в `[docs/help/testing.md](docs/help/testing.md)` выглядит как:

```
pnpm build && pnpm check && pnpm test && pnpm test:e2e:smoke
```

Плюс два focused deterministic gate-команды, которые нужно запускать вручную при касании соответствующих areas:

- `pnpm test:gateway:recovery-confidence`
- `pnpm test:gateway:session-event-parity`

Нет единого "всё готово к v1" командного штампа. Stage 84 создаёт его.

## Что делаем

### 1. `pnpm test:v1-gate` — единый deterministic pre-release stamp

Новый скрипт в `[package.json](package.json)` рядом с другими `test:gateway:*` командами:

```json
"test:v1-gate": "pnpm test:gateway:recovery-confidence && pnpm test:gateway:session-event-parity"
```

Это тонкий оркестратор поверх уже существующих suite-ов. Никаких новых тестов — только one-liner, который запускает всё что нужно перед v1 тегом.

Если в дальнейшем появятся новые focused gates (skills, etc.) — они добавляются в эту же команду.

### 2. Обновить `[docs/help/testing.md](docs/help/testing.md)`

Добавить в decision table строку:

```
- Pre-v1 release stamp / all focused deterministic gates: run pnpm test:v1-gate
```

Добавить секцию **"V1 release gate (CI-safe)"** после "Session event broadcast parity evals":

- Описать что включает `pnpm test:v1-gate`
- Чётко отделить её от `pnpm test:e2e:smoke` (которая про gateway boot/networking)
- Указать что эта команда является optional follow-up к базовому `pnpm build && pnpm check && pnpm test && pnpm test:e2e:smoke`, но обязательна перед v1 тегом

### 3. Обновить `[master_v1_roadmap.md](.cursor/plans/master_v1_roadmap.md)`

- Перенести Stage 84 в Done после выполнения
- Обновить Release Ladder: добавить `pnpm test:v1-gate` как явный шаг перед тегом
- Обновить секцию Next: "v1 tag ready — см. Release Ladder"

## Что НЕ делаем

- Не создаём новых тестов
- Не меняем версию в `package.json` (это отдельная операция через `openclaw-release-maintainer` skill)
- Не трогаем CHANGELOG.md (не scope этого stage)
- Не делаем новый E2E или live layer

## Validation

- `pnpm test:v1-gate` проходит зелёным без live providers
- Строка в decision table + новая секция в testing.md чётко описывают этот layer
- master_v1_roadmap.md корректно отражает финальное состояние v1 boundary
