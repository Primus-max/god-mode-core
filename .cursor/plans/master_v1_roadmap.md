# Master V1 Roadmap

## Purpose

Этот файл — короткий канонический контекст для новых чатов.

В новый чат передаётся:

- этот `master_v1_roadmap.md`;
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

- Product direction: `[VISION.md](C:/Users/Tanya/source/repos/god-mode-core/VISION.md)`
- Contributor expectations: `[CONTRIBUTING.md](C:/Users/Tanya/source/repos/god-mode-core/CONTRIBUTING.md)`
- Testing and release ladder: `[docs/help/testing.md](C:/Users/Tanya/source/repos/god-mode-core/docs/help/testing.md)`

## Recent Stage Ladder

### Done

- `Stage 79 - Navigation Validation Gate`  
  Plan: `[.cursor/plans/stage_79_validation_d7074142.plan.md](C:/Users/Tanya/source/repos/god-mode-core/.cursor/plans/stage_79_validation_d7074142.plan.md)`
- `Stage 80 - Release Confidence E2E Gate`  
  Plan: `[.cursor/plans/stage_80_e2e_gate_6aa314e7.plan.md](C:/Users/Tanya/source/repos/god-mode-core/.cursor/plans/stage_80_e2e_gate_6aa314e7.plan.md)`
- `Stage 81 - Skills Reliability Evals`  
  Status source lives in chat history and follow-up implementation summary.
- `Stage 82 - Runtime Recovery Confidence Gate`  
  Plan: `[.cursor/plans/stage_82_recovery_gate_d607e678.plan.md](C:/Users/Tanya/source/repos/god-mode-core/.cursor/plans/stage_82_recovery_gate_d607e678.plan.md)`

- `Stage 83 - Session Event Broadcast Parity Gate`  
  Plan: `[.cursor/plans/stage_83_session_event_broadcast_gate.plan.md](C:/Users/Tanya/source/repos/god-mode-core/.cursor/plans/stage_83_session_event_broadcast_gate.plan.md)`
- `Stage 84 — V1 Release Gate`  
  Plan: `[.cursor/plans/stage_84_v1_gate_bd5c3d01.plan.md](C:/Users/Tanya/source/repos/god-mode-core/.cursor/plans/stage_84_v1_gate_bd5c3d01.plan.md)`

### Active

- `Stage 85 - Cursor Execution Plan`
  Plan: `[.cursor/plans/stage_85_cursor_execution_4d2f9c10.plan.md](C:/Users/Tanya/source/repos/god-mode-core/.cursor/plans/stage_85_cursor_execution_4d2f9c10.plan.md)`
  Purpose: вернуть roadmap из pure gate/stability режима в управляемую product execution фазу через одного главного агента и 4 dev-подагента Cursor без пересечения файлов.

### Next

- Optional side path: `v1 tag` — см. Release Ladder и `openclaw-release-maintainer` skill.
- После Stage 85: переход к следующему product stage уже по факту интегрированного `Master Orchestrator v0`, а не по markdown-only roadmap.

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

## Chat Handoff Rule

В конце каждого stage:

1. Обновляем этот master roadmap.
2. Фиксируем завершённый stage как `Done`.
3. Создаём следующий `stage_XX_*.plan.md`.

В новом чате:

1. Даём этот `master_v1_roadmap.md`.
2. Если нужно исполнение, добавляем только активный stage-plan.
3. Не тащим старые промежуточные workflow-планы и длинную историю чата, если они не нужны для конкретного решения.

## Guardrails

- Этот файл не хранит детальные TODO.
- Этот файл не дублирует `testing.md`.
- Этот файл не заменяет stage-планы.
- Детальный scope, todos, validation и implementation truth живут только в отдельном `stage_XX_*.plan.md`.
