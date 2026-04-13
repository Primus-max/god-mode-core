# Multi-agent execution protocol (Cursor dev agents)

Повторно используемый протокол для итераций **implement -> verify -> fix -> rerun -> continue**. Снят с практики Stage 85 ([stage_85_cursor_execution_4d2f9c10.plan.md](stage_85_cursor_execution_4d2f9c10.plan.md)) и обязателен для автономного цикла v1.

## Термины

- **Главный агент** — владеет shared seams, интеграцией, финальным validation ladder и обновлением `.cursor/plans/autonomous_v1_active_backlog.md`.
- **Подагенты** — dev-подагенты Cursor с непересекающимися списками файлов (не путать с продуктовыми sub-agents OpenClaw).
- **Slice owner** — всегда главный агент; подагент может реализовать часть slice, но не может сам объявить slice `done`.
- **Execution truth** — поля `status`, `executionState`, `lastValidation`, `blockerOwner`, `resumeFrom`, `evidence` в `.cursor/plans/autonomous_v1_active_backlog.md`.

## Роли

| Роль            | Ответственность                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Главный         | `src/platform/plugin.ts`, `src/agents/pi-embedded-runner/run.ts`, `src/agents/agent-command.ts` (когда в scope), сквозные integration-тесты, merge результатов, прогон ladder, обновление backlog |
| Подагент A/B/C… | Только свой `Owned files`; запрещённые пути не трогать                                                                                                                                            |

## Волны работ

1. **Wave 0 (главный):** прочитать [master_v1_roadmap.md](master_v1_roadmap.md), [v1_execution_checklist.md](v1_execution_checklist.md), активный `stage_XX_*.plan.md`, [autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md); выбрать slice; обновить его `executionState`; зарезервировать shared files.
2. **Wave 1 — exploration (быстрые модели):** узкий поиск контракта/регрессий по slice; без правок или с минимальными.
3. **Wave 2 — implementation (параллельно, непересекающиеся пакеты):** каждый подагент получает явный prompt с Allowed / Forbidden paths (как в Stage 85).
4. **Wave 3 — integration (главный):** склейка, конфликтующие seams, один проход по затронутым integration-тестам.
5. **Wave 4 — verification:** tier’ы из активного stage-плана; при провале — `fix -> повтор того же tier`.
6. **Wave 5 — backlog evidence update:** главный агент обновляет execution truth и либо берёт следующий slice, либо фиксирует `blocked`.

## Do-Verify-Fix-Repeat

Multi-agent режим не отменяет обычный execution-контракт:

1. Подагенты помогают быстрее исследовать и кодить.
2. Главный агент всё равно обязан прогнать нужный validation ladder.
3. Любой fail переводит slice в `fixing`, а не в «частично готово».
4. Без обновлённого `lastValidation` и `resumeFrom` работа не считается переданной дальше.

## Формат ответа подагента (обязательный)

Главный принимает работу только если подагент вернул:

- `Changed files`
- `What is done`
- `Tests run`
- `Known risks`
- `Integration notes`
- `Next recommended step`

Если подагент изменил **Forbidden** файл — пакет не мержится, возврат на доработку.
Если `Tests run` пустой, подагент обязан явно написать `Not run`; это не освобождает главного агента от обязательного tier validation.

## Выбор модели

- Сложное планирование, интеграция нескольких workstream — более способная модель.
- Узкий grep, точечные правки, focused тесты — быстрая модель.

## Границы (guardrails из Stage 85)

- Не отдавать нескольким подагентам одновременно одни и те же shared runtime seams.
- Не смешивать терминологию dev-подагентов и продуктовых sub-agents без явного пояснения.
- Финальный user-facing сценарий и полный широкий `pnpm test` остаются на главном агенте или на явном решении после зелёных tier’ов slice.
- Подагент не может сам менять backlog-статус slice на `done`; максимум — предложить evidence для обновления главным агентом.
- Нельзя докладывать пользователю `готово`, пока главный агент не свёл все подагентские результаты, не прогнал обязательные tier’ы и не обновил execution truth.

## Когда запускать подагентов

- Запускать параллельно, если workstreams действительно разнесены по непересекающимся файлам или пакетам.
- Не запускать параллельно на одном shared seam только ради скорости.
- Отдельный подагент оправдан для:
  - contract audit / exploration;
  - локального implementation-пакета;
  - focused regression/testing пакета.

## Continuation contract

Если чат или итерация оборвались, следующий главный агент обязан:

1. Начать с `resumeFrom` в [autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md).
2. Проверить `lastValidation`, чтобы не повторять уже подтверждённое без причины.
3. Продолжить тот же slice до `done` или `blocked`, а не перескакивать к новому без явной причины.

## После зелёных проверок

1. Обновить `status`, `executionState`, `lastValidation`, `blockerOwner`, `resumeFrom` и `evidence` slice в `.cursor/plans/autonomous_v1_active_backlog.md`.
2. Если нет hard stop — сразу начать следующий `open` slice.
3. Если есть внешний блокер — перевести slice в `blocked`, указать владельца и строку в журнале блокеров.
4. Если backlog по scope пуст и ladder выполнен — handoff по секции «v1 ready for user test» в [autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md).
