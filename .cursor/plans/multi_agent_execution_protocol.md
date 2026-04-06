# Multi-agent execution protocol (Cursor dev agents)

Повторно используемый протокол для итераций **implement → verify → continue**. Снят с практики Stage 85 ([stage_85_cursor_execution_4d2f9c10.plan.md](stage_85_cursor_execution_4d2f9c10.plan.md)) и обязателен для автономного цикла v1.

## Термины

- **Главный агент** — владеет shared seams, интеграцией, финальным validation ladder и обновлением `.cursor/plans/autonomous_v1_active_backlog.md`.
- **Подагенты** — dev-подагенты Cursor с непересекающимися списками файлов (не путать с продуктовыми sub-agents OpenClaw).

## Роли

| Роль            | Ответственность                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Главный         | `src/platform/plugin.ts`, `src/agents/pi-embedded-runner/run.ts`, `src/agents/agent-command.ts` (когда в scope), сквозные integration-тесты, merge результатов, прогон ladder, обновление backlog |
| Подагент A/B/C… | Только свой `Owned files`; запрещённые пути не трогать                                                                                                                                            |

## Волны работ

1. **Wave 0 (главный):** прочитать [master_v1_roadmap.md](master_v1_roadmap.md), активный `stage_XX_*.plan.md`, [autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md); выбрать slice; зарезервировать shared files.
2. **Wave 1 — exploration (быстрые модели):** узкий поиск контракта/регрессий по slice; без правок или с минимальными.
3. **Wave 2 — implementation (параллельно, непересекающиеся пакеты):** каждый подагент получает явный prompt с Allowed / Forbidden paths (как в Stage 85).
4. **Wave 3 — integration (главный):** склейка, конфликтующие seams, один проход по затронутым integration-тестам.
5. **Wave 4 — verification:** tier’ы из активного stage-плана; при провале — fix → повтор tier’а.

## Формат ответа подагента (обязательный)

Главный принимает работу только если подагент вернул:

- `Changed files`
- `What is done`
- `Tests run`
- `Known risks`
- `Integration notes`

Если подагент изменил **Forbidden** файл — пакет не мержится, возврат на доработку.

## Выбор модели

- Сложное планирование, интеграция нескольких workstream — более способная модель.
- Узкий grep, точечные правки, focused тесты — быстрая модель.

## Границы (guardrails из Stage 85)

- Не отдавать нескольким подагентам одновременно одни и те же shared runtime seams.
- Не смешивать терминологию dev-подагентов и продуктовых sub-agents без явного пояснения.
- Финальный user-facing сценарий и полный широкий `pnpm test` остаются на главном агенте или на явном решении после зелёных tier’ов slice.

## После зелёных проверок

1. Обновить `status` slice в `.cursor/plans/autonomous_v1_active_backlog.md`.
2. Если нет hard stop — сразу начать следующий `open` slice.
3. Если backlog по scope пуст и ladder выполнен — handoff по секции «v1 ready for user test» в [autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md).
