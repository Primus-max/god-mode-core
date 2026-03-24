---
name: Stage 5 Bootstrap
overview: Разрешить управляемую доустановку возможностей через trusted capability catalog.
todos:
  - id: design-capability-catalog
    content: Описать trusted capability catalog и descriptor format.
    status: pending
  - id: design-installer-lifecycle
    content: Зафиксировать install, verify, register, rollback flow.
    status: pending
  - id: define-bootstrap-tests
    content: Подготовить safety/integration tests для bootstrap layer.
    status: pending
isProject: false
---

# Stage 5: Controlled Bootstrap Layer

## Goal

Дать системе возможность расширять среду без произвольной установки из интернета.

## Scope

- Ввести capability catalog.
- Спроектировать capability resolver.
- Спроектировать sandboxed installer, health-check и audit trail.

## Deliverables

- Capability package descriptor.
- Install lifecycle model.
- Failure/rollback behavior.

## Target Areas

- platform bootstrap modules
- policy engine integration
- future runtime installers

## Tests

- Unit tests на capability resolution.
- Integration tests install -> health-check -> register.
- Safety tests на блокировку unapproved installs.
- Failure tests на degraded mode и rollback.

## Done When

- Система умеет сама доустанавливать только approved capabilities, а не всё подряд.
