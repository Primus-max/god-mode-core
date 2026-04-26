---
name: Stage 4 Developer
overview: Сделать publish-first runtime для разработки, деплоя и релизов.
todos:
  - id: design-developer-runtime
    content: Описать code/build/publish flow и publish targets.
    status: pending
  - id: define-credential-model
    content: Зафиксировать модель подключения git/cloud credentials.
    status: pending
  - id: define-publish-tests
    content: Подготовить safety и integration test suite для publish flows.
    status: pending
isProject: false
---

# Stage 4: Developer Publish Runtime

## Goal

Сделать так, чтобы developer path материализовал результат: preview, deploy, release, artifact.

## Scope

- Ввести `code_build_publish` flow.
- Спроектировать publish targets: git, preview URL, binary/release artifacts.
- Описать credential binding model для GitHub и будущих провайдеров.

## Target Areas

- existing git/gateway/tool surfaces
- new developer runtime modules
- artifact runtime integration

## Deliverables

- Publish pipeline model.
- Release artifact model.
- Developer specialist behavior.

## Tests

- Integration tests на build/publish orchestration.
- Mock tests на credential binding.
- Safety tests на publish approvals.
- Artifact tests на preview/release outputs.

## Done When

- Developer runtime умеет не только генерировать код, но и материализовать доступный результат.
