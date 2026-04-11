---
name: Stage 86 Smart Routing and Bootstrap
overview: "Первый полностью backlog-driven stage: smart routing + prompt optimization visibility + bootstrap approve-resume + Sessions/runtime inspector + usage/cost + Telegram E2E proof. Источник slices — autonomous_v1_active_backlog; приёмка — stage86_test_cases."
todos:
  - id: slice-s86-01
    content: "S86-01: routing parity + session-aware preflight (T1–T5 по slice)"
    status: in_progress
  - id: slice-s86-02
    content: "S86-02: prompt optimization visibility"
    status: done
  - id: slice-s86-03
    content: "S86-03: bootstrap approve → install → resume"
    status: done
  - id: slice-s86-04
    content: "S86-04: runtime inspector (route / blocked resume / lifecycle)"
    status: done
  - id: slice-s86-05
    content: "S86-05: usage / cost visibility"
    status: done
  - id: slice-s86-06
    content: "S86-06: Telegram E2E + 15m stability proof"
    status: in_progress
isProject: false
---

# Stage 86 — Smart routing, bootstrap, Telegram proof

## Goal

Закрыть видимую ценность investor v1 по треку: **умный маршрут**, **оптимизация промпта**, **bootstrap с авто-resume**, **инспектор сессий**, **usage/cost**, со **сквозным доказательством в Telegram** — в соответствии с [autonomous_v1_roadmap_cb6fe0e6.plan.md](autonomous_v1_roadmap_cb6fe0e6.plan.md) и долгим orchestration-контекстом из [master_orchestrator_context.md](master_orchestrator_context.md).

## Out of scope

- Полный мульти-рантайм codegen (Node/.NET/Python/Docker) как единый продукт.
- Произвольная установка capability вне approved catalog.
- Замена `docs/help/testing.md` или изменение инвариантов Stage 84 без отдельного согласования.
- Редактура `docs/zh-CN/`** (генерируемый слой).

## Ordered backlog slices

Канонический порядок и поля: **[autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md)** (S86-01 … S86-06).

Главный агент не дублирует таблицу здесь; при расхождении правит **только** `autonomous_v1_active_backlog.md`, затем кратко отражает изменение в этом плане одной строкой в конце сессии.

Post-Stage 86 Horizon 1 doc/report/context slices живут в том же backlog, но относятся уже к следующему stage и не валидируются этим планом.

## Validation ladder

Опираемся на [master_v1_roadmap.md](master_v1_roadmap.md), [stage_84_v1_gate_bd5c3d01.plan.md](stage_84_v1_gate_bd5c3d01.plan.md), [docs/help/testing.md](../../docs/help/testing.md).


| Tier | Команда                                      | Когда                                                                       |
| ---- | -------------------------------------------- | --------------------------------------------------------------------------- |
| T1   | `pnpm test -- <релевантные-paths>`           | Каждый slice после изменений кода                                           |
| T2   | `pnpm check`; при необходимости `pnpm build` | Изменения типов, UI bundle, широкий wiring                                  |
| T3   | `pnpm test:e2e:smoke`                        | Затронуты gateway boot / networking / runtime старт                         |
| T4   | `pnpm test:v1-gate`                          | Перед объявлением v1 ready; при касании recovery/session-event поверхностей |
| T5   | `.cursor/stage86_test_cases.md`              | Продуктовая приёмка smart-routing/bootstrap трека                           |


Маппинг кейсов T5 → slices см. в [autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md) (поля `requiredValidation` / `doneWhen`).

## Hard stop conditions

Остановка и отчёт пользователю, если:

- обязательный tier для текущего slice не зелёный без расширения scope на другие треки;
- нужны live ключи, Telegram, Ollama, Hydra, сеть — и их нет в среде агента;
- противоречие между [../stage86_test_cases.md](../stage86_test_cases.md) и реализуемым контрактом (тогда сначала согласовать правку чеклиста или кода).

## Continue conditions

Продолжать автономно, если slice переведён в `done` в backlog, все **его** обязательные tier’ы зелёные, и нет hard stop. Сразу взять следующий `open` slice по приоритету.

## User-facing test protocol

Полный протокол: **[../stage86_test_cases.md](../stage86_test_cases.md)** (15-минутная сессия, 8 кейсов).

Success criteria из того файла для закрытия Stage 86: **8/8 кейсов**, стабильный gateway 15 минут, bootstrap после approval с авто-продолжением.

Логи: шаблон команд в конце `stage86_test_cases.md` (адаптировать путь лог-файла под хост).

## Next stage handoff

После закрытия Stage 86:

1. В [master_v1_roadmap.md](master_v1_roadmap.md): перенести Stage 86 в **Done**, указать **Active** для следующего stage или явный follow-up.
2. Обновить [autonomous_v1_roadmap_cb6fe0e6.plan.md](autonomous_v1_roadmap_cb6fe0e6.plan.md) (todos `close-stage86` и связанные) по факту.
3. Сохранить краткий отчёт: автоматические команды (с версиями по возможности) + что оператор проверил руками.

## Session update

2026-04-10: backlog truth синхронизирован с live state: S86-02...05 закрыты по validation evidence, direct Telegram network blocker снят через configured proxy, активный хвост Stage 86 сузился до честного Telegram T5 `8/8` и 15-minute stability proof в `S86-06`.
2026-04-11: gateway/runtime bundle повторно доведён до зелёного `20/20` на `stage86-live-matrix.current.json`, включая investor-facing H1 flows, но Telegram снова стал внешним blocker: direct `api.telegram.org:443` недоступен с этого хоста, старый proxy перестал коннектиться, поэтому `S86-06` переведён в `blocked_external` в backlog до восстановления user-channel egress.

## Multi-agent

Протокол подагентов: [multi_agent_execution_protocol.md](multi_agent_execution_protocol.md).  
Прецедент разбиения пакетов: [stage_85_cursor_execution_4d2f9c10.plan.md](stage_85_cursor_execution_4d2f9c10.plan.md) (при необходимости скорректировать `Owned files` под фактические файлы slice).
