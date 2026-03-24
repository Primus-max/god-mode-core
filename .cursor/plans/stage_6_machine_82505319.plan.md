---
name: Stage 6 Machine
overview: Выделить отдельный high-risk контур управления машиной пользователя через explicit device linking.
todos:
  - id: design-device-linking
    content: Описать flow привязки устройства и trust contract.
    status: pending
  - id: define-machine-policy
    content: Зафиксировать permissions, approvals и kill switch model.
    status: pending
  - id: define-machine-tests
    content: Подготовить safety test suite для machine-control контура.
    status: pending
isProject: false
---

# Stage 6: User Machine Control

## Goal

Оставить возможность управлять машиной пользователя, но как отдельную явную функцию высокого риска.

## Scope

- Device linking flow.
- Explicit consent and risk contract.
- Separate machine-control profile and policy rules.
- Kill switch, audit log, session isolation.

## Deliverables

- Device trust model.
- Machine-control permission model.
- High-risk execution boundaries.

## Target Areas

- gateway/account UI flows
- policy engine
- tool/runtime restrictions

## Tests

- Link/unlink tests.
- Permission boundary tests.
- Kill-switch tests.
- Safety tests на недоступность machine control без явной привязки.

## Done When

- Machine control не смешан с обычным assistant behavior и может быть полностью отключён отдельно.
