---
name: Stage 3B Builder Normalization
overview: Нормализовать document extraction outputs в единый downstream-friendly builder format поверх Stage 3 foundation.
todos:
  - id: design-normalization-model
    content: Спроектировать normalization model для fields/tables/exports и правила стабилизации output shape.
    status: pending
  - id: implement-normalization-pipeline
    content: Ввести normalization pipeline поверх document artifact projection и route-aware extraction.
    status: pending
  - id: wire-normalized-builder-artifacts
    content: Подключить normalized payloads к artifact projection/store и builder-facing consumption paths.
    status: pending
  - id: define-normalization-fixtures
    content: Подготовить fixture corpus и regression tests для normalization edge cases.
    status: pending
isProject: false
---

# Stage 3B: Builder Extraction Normalization

## Why This Is Separate

- Это логическое продолжение Stage 3 Builder, а не часть Stage 4 Developer.
- Stage 3 уже дал contracts, routing, artifact projection и fixture foundation.
- Новый шаг про semantic normalization document outputs, а не про build/publish/release runtime.

## Goal

Сделать так, чтобы builder flow не просто принимал document-shaped JSON, а стабильно приводил extraction/report/export outputs к единому format для downstream consumers.

## Scope

- Ввести normalized builder payload model для fields, tables, report summary и export previews.
- Нормализовать naming, value typing, table shape и metadata across `doc_ingest`, `ocr_extract`, `table_extract`.
- Зафиксировать deterministic fallback behavior для partial / noisy / over-complete extraction outputs.
- Подготовить fixture-based normalization regressions для scanned docs, estimates и table-heavy inputs.
- Оставаться внутри существующего Stage 2/3 orchestration contract; не делать новый bypass path.

## Explicit Non-Goals

- Не добавлять реальные OCR/VLM providers.
- Не строить Stage 4 developer/publish behavior.
- Не делать UI-facing artifact browser.

## Deliverables

- Normalized builder artifact schema(s).
- Normalization pipeline for raw document payloads.
- Route-aware projection rules:
  `doc_ingest` -> normalized fields/report
  `ocr_extract` -> normalized OCR fields/text blocks
  `table_extract` -> normalized tables/export preview
- Fixture corpus for noisy and happy-path extraction outputs.

## Target Areas

- `src/platform/document/*`
- `src/platform/schemas/artifact.ts` only if common artifact envelope needs extension
- `src/platform/plugin.ts` and `llm_output` projection seam
- `src/platform/registry/artifact-store.ts` only if normalized metadata persistence needs a shared helper
- tests colocated with document modules

## Design Constraints

- Normalization must be deterministic and pure where possible.
- Projection and normalization should stay separable:
  raw payload parse -> normalize -> artifact descriptor projection.
- Route-specific heuristics are allowed, but the final normalized shape should be common enough for downstream consumers.
- Unknown/extra source fields should be preserved in a controlled metadata bucket instead of being silently dropped.
- Do not couple normalization logic to a specific OCR backend or prompt wording.

## Suggested Module Split

- `src/platform/document/normalize.ts`
  Pure normalization entrypoints.
- `src/platform/document/normalize-fields.ts`
  Field/key normalization and typed value coercion.
- `src/platform/document/normalize-tables.ts`
  Table shape stabilization and row/header cleanup.
- `src/platform/document/normalize-report.ts`
  Report/export summary normalization.
- Reuse `artifact-projection.ts` for final descriptor materialization.

## Tests

- Fixture tests for:
  scanned OCR output with inconsistent field labels
  estimate extraction with duplicated totals
  table extraction with uneven headers/rows
  mixed report + extraction payloads
- Pure normalization tests:
  key canonicalization
  duplicate field merge rules
  table row padding/trimming
  export preview normalization
- Regression tests:
  general chat path must not emit normalized builder artifacts
  non-document routes must remain unaffected
  route-specific output filtering must remain deterministic

## Done When

- Builder document outputs materialize into a stable normalized shape, not just pass-through JSON.
- `doc_ingest`, `ocr_extract`, and `table_extract` share one normalization pipeline with route-specific adapters, not three ad-hoc code paths.
- Fixture-based tests cover both happy path and noisy extraction inputs.
- `pnpm build` and `pnpm check` stay green after the normalization layer lands.
