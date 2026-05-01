---
name: Stage 3 Builder
overview: Собрать первый specialist runtime для документов, OCR и табличных сценариев.
todos:
  - id: design-document-runtime
    content: Спроектировать document runtime contracts и input/output model.
    status: pending
  - id: define-builder-artifacts
    content: Описать structured artifacts для extraction/report/export.
    status: pending
  - id: wire-builder-orchestration
    content: Подключить document recipes/artifacts к Stage 2 orchestration path, llm_output extraction и artifact store seam.
    status: pending
  - id: define-document-tests
    content: Подготовить fixture-based test strategy для document flows.
    status: pending
isProject: false
---

# Stage 3: Builder Specialist Runtime

## Goal

Дать реальную ценность document-heavy и строительным сценариям.

## Scope

- Ввести document runtime foundation.
- Подготовить paths: `doc_ingest`, `ocr_extract`, `table_extract`.
- Зафиксировать future seam для OCR/VLM backends вроде GLM-OCR.
- Делать structured outputs first.
- Определить artifact capture path через существующий Stage 2 runtime contract (`platformExecutionContext`, recipe/runtime planner, `llm_output`).
- Разделить document runtime abstraction и конкретные backends, чтобы OCR/table engines подключались через capability/adapter seam, а не прямо в runner.

## Deliverables

- Document task descriptors.
- Structured extraction artifacts.
- Builder-oriented context preferences.
- Runtime adapters для `doc_ingest` / `ocr_extract` / `table_extract`.
- Artifact projection flow: extraction result -> artifact descriptor/store -> prompt/report consumers.

## Target Areas

- `src/platform/document/*`
- `src/platform/schemas/artifact.ts` и связанные document-specific artifact contracts
- `src/platform/recipe/defaults.ts`, planner/runtime adapter из Stage 2
- `src/platform/plugin.ts` и `llm_output` artifact extraction path
- `src/platform/registry/artifact-store.ts`
- `src/agents/agent-command.ts`, `src/agents/pi-embedded-runner/run.ts` только в пределах уже существующих orchestration seams
- fixture corpus / document tests рядом с platform runtime modules

## Tests

- Fixture tests на PDF/scan/table inputs.
- Extraction correctness tests.
- Artifact output tests.
- Regression tests against general chat path.
- Regression tests на builder routing через existing agent/gateway orchestration path.
- Contract tests на backend abstraction: fake OCR/table provider должен подключаться без изменения planner/runner.

## Done When

- Builder profile по умолчанию использует document-first execution path.
- Документы возвращаются как structured artifacts, а не только чатовый текст.
- `doc_ingest` / `ocr_extract` / `table_extract` живут на одном orchestration contract, а не на ad-hoc bypass path.
- OCR/VLM backend можно заменить через adapter seam без изменения core runner wiring.
