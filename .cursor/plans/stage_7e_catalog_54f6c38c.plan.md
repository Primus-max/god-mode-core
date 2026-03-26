---
name: Stage 7E Catalog
overview: "Довести specialist system после Stage 7D до консистентного runtime-catalog уровня: выровнять schema ids и реальные default profiles, добавить недостающие specialist profiles/overlays/recipe fit, затем закрыть validation debt через `pnpm tsgo` и более широкий test pass."
todos:
  - id: catalog-default-profiles
    content: Довести defaults.ts до полного intended specialist catalog и обновить catalog-level tests
    status: completed
  - id: catalog-routing-signals
    content: Добавить signals/resolver logic для новых specialist profiles
    status: completed
  - id: catalog-overlays-recipes
    content: Связать новые profiles с overlays и recipe selection
    status: completed
  - id: catalog-policy-alignment
    content: Проверить и при необходимости уточнить policy-safe behavior для новых profiles
    status: completed
  - id: catalog-ui-contract-alignment
    content: Сверить gateway snapshot и specialist UI с расширенным catalog
    status: completed
  - id: catalog-validation-pass
    content: Прогнать pnpm tsgo, pnpm test и pnpm build, затем разобрать результаты
    status: completed
isProject: false
---

# Stage 7E: Specialist Catalog Completion

## Goal

Сделать specialist catalog консистентным по всей цепочке `schema -> defaults -> signals -> planner -> policy -> UI snapshot`, а затем прогнать более широкий validation pass после Stage 7D.

## Why This Is Next

- В [src/platform/schemas/profile.ts](src/platform/schemas/profile.ts) `PROFILE_IDS` уже включает `integrator`, `operator`, `media_creator`, но живой runtime catalog в [src/platform/profile/defaults.ts](src/platform/profile/defaults.ts) сейчас реально заводит только `general`, `builder`, `developer`.
- Из-за этого schema-valid specialist ids могут существовать в контрактах и session override state, но не иметь полноценного runtime поведения в resolver/planner/default registry.
- После Stage 7D write seam уже готов; теперь нужно, чтобы все specialist ids были либо полноценно поддержаны, либо сознательно убраны из surface. Судя по текущему направлению, логичнее именно добить catalog.

## Scope

- Добавить недостающие default specialist profiles в [src/platform/profile/defaults.ts](src/platform/profile/defaults.ts).
- Дотянуть signals / resolver / overlays / recipes до полного catalog поведения.
- Проверить policy-safe semantics: profile не выдает скрытые права сам по себе.
- Обновить snapshot/UI vocabulary только в той части, где появляются реальные новые profile options.
- Прогнать и разобрать более широкий validation pass: `pnpm tsgo`, затем расширенные тесты.

## Key Files

- [src/platform/schemas/profile.ts](src/platform/schemas/profile.ts)
- [src/platform/profile/defaults.ts](src/platform/profile/defaults.ts)
- [src/platform/profile/signals.ts](src/platform/profile/signals.ts)
- [src/platform/profile/resolver.ts](src/platform/profile/resolver.ts)
- [src/platform/profile/overlay.ts](src/platform/profile/overlay.ts)
- [src/platform/recipe/defaults.ts](src/platform/recipe/defaults.ts)
- [src/platform/recipe/planner.ts](src/platform/recipe/planner.ts)
- [src/platform/recipe/runtime-adapter.ts](src/platform/recipe/runtime-adapter.ts)
- [src/platform/policy/rules.ts](src/platform/policy/rules.ts)
- [src/platform/profile/gateway.ts](src/platform/profile/gateway.ts)
- [ui/src/ui/views/specialist-context.ts](ui/src/ui/views/specialist-context.ts)
- [src/platform/schemas/baseline-descriptors.test.ts](src/platform/schemas/baseline-descriptors.test.ts)

## Proposed Approach

### 1. Normalize the live specialist catalog

Expand [src/platform/profile/defaults.ts](src/platform/profile/defaults.ts) so every schema-declared profile that should remain public has a real default definition, label, description, overlays, and sensible tool/publish preferences.

Initial target set to complete:

- `integrator`
- `operator`
- `media_creator`

### 2. Make auto-routing capable of selecting the full catalog

Update [src/platform/profile/signals.ts](src/platform/profile/signals.ts) and [src/platform/profile/resolver.ts](src/platform/profile/resolver.ts) so auto mode can meaningfully infer the new profiles instead of only ever converging on the current Stage 1 trio.

### 3. Align overlays and recipes with the new profiles

Adjust [src/platform/profile/overlay.ts](src/platform/profile/overlay.ts), [src/platform/recipe/defaults.ts](src/platform/recipe/defaults.ts), and [src/platform/recipe/planner.ts](src/platform/recipe/planner.ts) so each new profile has at least one credible runtime path.

Focus on narrow operational value, not broad invention:

- `integrator`: integration/release/pipeline-oriented work
- `operator`: infrastructure/ops/machine-control oriented work
- `media_creator`: media/content/artifact-oriented work

### 4. Keep policy-safe behavior explicit

Review [src/platform/policy/rules.ts](src/platform/policy/rules.ts) and nearby tests so new profiles still obey the existing rule that profile preference does not grant hidden permissions. If profile-specific policy behavior is needed, keep it explicit and approval-gated.

### 5. Reconcile contracts, snapshot, and UI surface

Verify [src/platform/profile/gateway.ts](src/platform/profile/gateway.ts) and [ui/src/ui/views/specialist-context.ts](ui/src/ui/views/specialist-context.ts) correctly expose the expanded catalog without requiring a redesign. Only do targeted UI/i18n updates needed for the real catalog.

### 6. Validation pass after the catalog work

Run validation in this order:

1. `pnpm tsgo`
2. Focused specialist/profile tests if broken by in-flight refactors
3. `pnpm test`
4. `pnpm build`

If `pnpm tsgo` or broader tests fail outside the touched surface, separate those failures into:

- directly caused by Stage 7E and must-fix now
- pre-existing/unrelated debt to report clearly

## Risks To Control

- Do not leave schema ids that still silently downgrade to `general` in runtime.
- Do not let new profiles imply hidden privileges; policy must stay approval-driven.
- Do not create a giant redesign of recipes or UI; keep 7E as catalog completion, not a new subsystem.
- Keep one runtime truth between resolver, planner, and `platform.profile.resolve`.

## Done When

- All intended specialist profile ids in schema have real runtime definitions.
- Auto-routing and manual override both work against the same complete catalog.
- Recipes/overlays exist for the expanded profiles in a policy-safe way.
- `pnpm tsgo`, `pnpm test`, and `pnpm build` have been run and results triaged accurately.
