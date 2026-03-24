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

## Deliverables

- Document task descriptors.
- Structured extraction artifacts.
- Builder-oriented context preferences.

## Target Areas

- platform document runtime modules
- artifact contracts from Stage 0
- profile integration from Stage 1

## Tests

- Fixture tests на PDF/scan/table inputs.
- Extraction correctness tests.
- Artifact output tests.
- Regression tests against general chat path.

## Done When

- Builder profile по умолчанию использует document-first execution path.
- Документы возвращаются как structured artifacts, а не только чатовый текст.
