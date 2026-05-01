# Stage 87 — Horizon 1 doc flows and builder context

## Goal

Закрыть оставшуюся user-facing ценность Horizon 1 после Stage 86: сравнение CSV/Excel, structured calculation/report flow и лёгкий builder/project-designer context preset.

## Out of scope

- Полный general-purpose codegen или generated tools для произвольных доменов.
- Полный DWG/AutoCAD pipeline.
- Нормативная верификация инженерных расчётов как сертифицированный контур.
- Любая правка `docs/zh-CN/**`.

## Ordered backlog slices

Канонический порядок и поля: **[autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md)** (H1-01 … H1-03).

Главный агент не дублирует таблицу здесь; при расхождении правит **только** `autonomous_v1_active_backlog.md`, затем кратко отражает изменение в этом плане.

## Validation ladder

Опираемся на [master_v1_roadmap.md](master_v1_roadmap.md), [docs/help/testing.md](../../docs/help/testing.md), и финальный Stage 86 acceptance для сквозной части.

| Tier | Команда / действие                           | Когда обязателен                                                                     |
| ---- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| T1   | `pnpm test -- <релевантные-paths>`           | Каждый slice после изменений кода                                                    |
| T2   | `pnpm check`; `pnpm build`                   | Для всех H1-01…H1-03, так как затрагиваются shared runtime/document/model surfaces   |
| T3   | `pnpm test:e2e:smoke`                        | Если меняется gateway/chat/runtime wiring или materialization/bootstrap user journey |
| T4   | `pnpm test:v1-gate`                          | Перед финальным handoff Horizon 1; раньше, если затронуты recovery/session surfaces  |
| T5   | Live investor demo scenarios + Stage 86 flow | Прямой прогон через запущенный проект, UI, бота, Telegram                            |

## Hard stop conditions

Остановка и отчёт пользователю, если:

- обязательный tier для текущего slice нельзя сделать зелёным без расширения scope;
- live-проверка требует внешней среды, которой нет локально;
- roadmap обещает контракт, который конфликтует с реальным runtime behavior;
- нужен секрет, аккаунт или инфраструктура вне уже доступной среды.

## Continue conditions

Продолжать автономно, если slice переведён в `done` в backlog, все обязательные tier’ы зелёные, и нет hard stop. Сразу брать следующий `open` slice по приоритету.

## User-facing test protocol

Live proof для Stage 86: [../stage86_test_cases.md](../stage86_test_cases.md).

Дополнительно для Horizon 1 обязательны live сценарии из [autonomous_v1_roadmap_cb6fe0e6.plan.md](autonomous_v1_roadmap_cb6fe0e6.plan.md):

- `Сгенерируй PDF-отчет`
- `Сравни эти два прайса и скажи, у кого лучше покупать`
- `Посчитай вентиляцию по этим размерам и сделай сводку`

## Next stage handoff

После закрытия Stage 87:

1. В [master_v1_roadmap.md](master_v1_roadmap.md): перевести Stage 86 и Stage 87 в `Done`, явно отметить завершение Horizon 1 investor cut.
2. В [autonomous_v1_roadmap_cb6fe0e6.plan.md](autonomous_v1_roadmap_cb6fe0e6.plan.md): обновить todos `builder-context-v0`, `excel-compare-v0`, `reasoning-report-v0`, `report-generation-v0`.
3. Сохранить краткий handoff: что проверено автоматикой, что проверено live, какие exact prompts и артефакты использовались.
