# Master V1 Roadmap

## Purpose

Этот файл — короткий канонический контекст для новых чатов.

В новый чат передаётся:

- [master_orchestrator_context.md](master_orchestrator_context.md) как длинный архитектурно-продуктовый контекст;
- этот `master_v1_roadmap.md`;
- [v1_execution_checklist.md](v1_execution_checklist.md);
- [autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md);
- текущий активный `stage_XX_*.plan.md`, если нужно именно выполнять stage.

## Stable V1 Boundary

Для текущего репозитория `stable v1` значит не “всё идеально”, а следующее:

- основные user-facing shell/operator flows не расходятся по routing contract;
- release confidence опирается не только на unit/jsdom, но и на cheap deterministic E2E smoke;
- skill-driven поведение агента проверяется deterministic CI-safe слоями, а не только ручным ожиданием;
- delivery / closure / recovery truth можно проверять автоматически через runtime ledgers и gateway-facing surfaces;
- session-facing event and inspection surfaces остаются на одном canonical contract с runtime truth;
- heavier live, Docker, VM, Parallels и channel-specific smoke остаются optional follow-up, а не базовой частью каждого PR gate.

## Canonical References

- Long-form orchestrator context: [master_orchestrator_context.md](master_orchestrator_context.md)
- Product direction: [VISION.md](../../VISION.md)
- Contributor expectations: [CONTRIBUTING.md](../../CONTRIBUTING.md)
- Testing and release ladder: [docs/help/testing.md](../../docs/help/testing.md)
- Live acceptance gate: [../v1_user_acceptance_cases.md](../v1_user_acceptance_cases.md)

## Operational execution (autonomous v1 loop)

- Execution checklist: [v1_execution_checklist.md](v1_execution_checklist.md)
- Execution protocol history/context: [autonomous_v1_loop_a69b9e98.plan.md](autonomous_v1_loop_a69b9e98.plan.md)
- **Active backlog (что делать следующим прямо сейчас):** [autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md)
- Multi-agent protocol: [multi_agent_execution_protocol.md](multi_agent_execution_protocol.md)
- Product v1 scope: [autonomous_v1_roadmap_cb6fe0e6.plan.md](autonomous_v1_roadmap_cb6fe0e6.plan.md)
- Live user gate: [../v1_user_acceptance_cases.md](../v1_user_acceptance_cases.md)

## Execution Contract

Для `v1` запрещено состояние «код написан, validation потом».

Финальный сигнал готовности для пользователя:

- не только зелёные automated tiers;
- а прохождение **10/10** живых сценариев из [../v1_user_acceptance_cases.md](../v1_user_acceptance_cases.md), где бот реально отвечает, умно роутит, при необходимости устанавливает capability, продолжает выполнение и создаёт ожидаемые артефакты без падений.

Обязательный цикл для каждого slice:

1. `Implement`
2. `Run scoped validation`
3. `Run required tiers`
4. Если есть падение: `fix -> rerun same validation`
5. Обновить evidence и `resumeFrom` в [autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md)
6. Только после этого переходить к следующему slice или объявлять `blocked`

Репортить `done` можно только если:

- выполнен `doneWhen` активного slice;
- обязательные tier’ы зелёные;
- ручные/live шаги либо выполнены, либо явно вынесены в `blocked` с владельцем;
- следующий чат может продолжить работу без нового discovery.

## Recent Stage Ladder

### Done

- `Stage 79 - Navigation Validation Gate`  
  Plan: [stage_79_validation_d7074142.plan.md](stage_79_validation_d7074142.plan.md)
- `Stage 80 - Release Confidence E2E Gate`  
  Plan: [stage_80_e2e_gate_6aa314e7.plan.md](stage_80_e2e_gate_6aa314e7.plan.md)
- `Stage 81 - Skills Reliability Evals`  
  Status source lives in chat history and follow-up implementation summary.
- `Stage 82 - Runtime Recovery Confidence Gate`  
  Plan: [stage_82_recovery_gate_d607e678.plan.md](stage_82_recovery_gate_d607e678.plan.md)

- `Stage 83 - Session Event Broadcast Parity Gate`  
  Plan: [stage_83_session_event_broadcast_gate.plan.md](stage_83_session_event_broadcast_gate.plan.md)
- `Stage 84 — V1 Release Gate`  
  Plan: [stage_84_v1_gate_bd5c3d01.plan.md](stage_84_v1_gate_bd5c3d01.plan.md)
- `Stage 85 - Cursor Execution Plan`  
  Plan: [stage_85_cursor_execution_4d2f9c10.plan.md](stage_85_cursor_execution_4d2f9c10.plan.md)  
  Purpose: схема исполнения главный агент + dev-подагенты по непересекающимся пакетам; прецедент для [multi_agent_execution_protocol.md](multi_agent_execution_protocol.md).

### Active

- `Stage 86 - Smart routing, bootstrap, Telegram proof`  
  Plan: [stage_86_smart_routing_bootstrap.plan.md](stage_86_smart_routing_bootstrap.plan.md)  
  Backlog slices: [autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md)  
  User acceptance: [../stage86_test_cases.md](../stage86_test_cases.md)  
  Current truth: gateway/runtime acceptance is green on `stage86-live-matrix.current.json` (`20/20`, including investor-facing flows), and H1 document/calculation slices are effectively validated on the live runtime. Stage 86 still cannot move to `Done` because the final Telegram proof is externally blocked again: direct `api.telegram.org:443` is unavailable from this host, the previously working proxy no longer connects, and `S86-06` is now an explicit external-network blocker rather than an implementation blocker.

### Next

- Optional side path: `v1 tag` — см. Release Ladder и `openclaw-release-maintainer` skill.
- После Stage 86: `Stage 87 - Horizon 1 doc flows and builder context`  
  Plan: [stage_87_h1_docflows.plan.md](stage_87_h1_docflows.plan.md)  
  Backlog slices: [autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md)

## Release Ladder

Минимальная deterministic release story сейчас должна собираться из:

- `pnpm build`
- `pnpm check`
- `pnpm test`
- `pnpm test:e2e:smoke`
- **`pnpm test:v1-gate`** ← обязателен перед v1 тегом; запускает все focused deterministic gates (recovery-confidence + session-event-parity)

Manual или heavier follow-up нужны только когда их реально требует touched area:

- broader `pnpm test:e2e`
- `pnpm test:live`
- Docker / VM / Parallels smoke
- local runtime recovery smoke

Но финальный `v1 ready` определяется не только этой лестницей, а ещё и полным live acceptance-прогоном **10/10**.

## Chat Handoff Rule

В конце каждого рабочего цикла:

1. Обновляем `status`, `executionState`, `lastValidation`, `blockerOwner`, `resumeFrom` и `evidence` в [autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md).
2. Если slice закрыт, сразу выбираем следующий `open` slice или явно фиксируем блокер.
3. Если меняется stage-level truth, обновляем этот `master_v1_roadmap.md`.

В конце каждого stage:

1. Обновляем этот master roadmap.
2. Фиксируем завершённый stage как `Done`.
3. Создаём следующий `stage_XX_*.plan.md`.

В новом чате:

1. Даём этот `master_v1_roadmap.md`.
2. Даём [master_orchestrator_context.md](master_orchestrator_context.md), если нужен полный продуктовый и архитектурный смысл оркестратора.
3. Даём [v1_execution_checklist.md](v1_execution_checklist.md).
4. Даём [../v1_user_acceptance_cases.md](../v1_user_acceptance_cases.md).
5. Если нужно исполнение, добавляем активный `stage_XX_*.plan.md` и при автономном цикле v1 — [autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md).
6. Не тащим старые промежуточные workflow-планы и длинную историю чата, если они не нужны для конкретного решения.

## Guardrails

- Этот файл не хранит детальные TODO.
- Этот файл не хранит per-slice evidence; оно живёт в [autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md).
- Этот файл не дублирует `testing.md`.
- Этот файл не заменяет stage-планы.
- Этот файл не заменяет [master_orchestrator_context.md](master_orchestrator_context.md); длинный смысл оркестратора живёт там.
- Детальный scope живёт в отдельном `stage_XX_*.plan.md`.
- Детальный execution truth, validation status и continuation point живут в [autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md).
