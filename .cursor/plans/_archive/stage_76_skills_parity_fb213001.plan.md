---
name: stage 76 skills parity
overview: Завершить оставшуюся canonical routing parity для Skills из overview-карточек, убрав последний production callsite low-level `buildTabHref(...)` и выровняв его с уже существующим `skillFilter` contract. Этап остаётся в текущем URL namespace и фокусируется на стабильном, предсказуемом deep-link поведении для v1.
todos:
  - id: add-canonical-skills-builder
    content: Добавить shared canonical helper для Skills href с `skillFilter` override на существующем URL contract.
    status: completed
  - id: wire-overview-skills-links
    content: Перевести overview skills cards и при необходимости attention skills links на shared canonical builder вместо inline `buildTabHref(...)`.
    status: completed
  - id: lock-skills-link-regressions
    content: Обновить tests и docs для overview-to-skills canonical parity.
    status: completed
isProject: false
---

# Stage 76 - Skills Overview Canonical Parity

## Goal

Довести переходы из overview в `skills` до той же canonical routing модели, что уже используется для `attention` и остальных поверхностей: `skillFilter`-ссылки должны собираться через shared destination helper, primary click должен оставаться SPA-handoff, а modified click и copy-link должны продолжать работать через браузерный `href`.

## Why This Stage

- В [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-render.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-render.ts) в `buildCardHref` остался последний production use low-level `buildTabHref(...)` вне [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-settings.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-settings.ts): overview skills cards всё ещё собирают `session` + `skillFilter` вручную.
- В [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-settings.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-settings.ts) уже есть близкий canonical pattern: `buildAttentionItems(...)` собирает skills-target через shared tab-state path, а `skillFilter` уже является существующей частью URL contract.
- Это сильный `v1` stabilization шаг после Stage 75: scope маленький, риск низкий, новый query namespace не нужен, а production routing станет последовательным во всех оставшихся overview investigation pivots.

## Key Evidence

```742:749:C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-render.ts
buildCardHref: (tab, options) => {
  if (tab === "skills") {
    return buildTabHref({ basePath: state.basePath }, "skills", {
      session: state.sessionKey,
      skillFilter: options?.skillFilter ?? "",
    });
  }
  return buildCanonicalTabHref(state, tab);
},
```

## Scope

- Canonicalize overview cards that open `skills` with `skillFilter`.
- Reuse the existing `skillFilter` URL contract; do not add new query params.
- Keep current overview card click semantics: primary click stays in SPA, modified click/new-tab/copy-link remain browser-native.
- Keep the change narrowly focused; do not expand into broader Skills UX polish.

## Planned Changes

- In [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-settings.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-settings.ts): add a small shared builder such as `buildCanonicalSkillsHref(...)` or an equivalent helper-wrapper that applies the canonical tab query state for `skills` and allows a `skillFilter` override without forcing call sites back onto `buildTabHref(...)`.
- In [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-render.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-render.ts): replace the `skills` branch inside `buildCardHref` with the new canonical helper so overview skills cards and attention links converge on the same destination contract.
- In [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-settings.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-settings.ts): if useful, reuse the same helper inside `buildAttentionItems(...)` for skills-related attention targets so there is only one destination-construction path for `skillFilter` links.

## Validation

- Update [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-settings.test.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-settings.test.ts) with a regression for canonical `skills` href generation with `skillFilter` overrides.
- Update [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/overview-cards.test.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/overview-cards.test.ts) so blocked/missing skills cards expect the canonical helper output instead of raw `buildTabHref(...)` output.
- Update short notes in [C:/Users/Tanya/source/repos/god-mode-core/docs/help/testing.md](C:/Users/Tanya/source/repos/god-mode-core/docs/help/testing.md) and [C:/Users/Tanya/source/repos/god-mode-core/docs/web/control-ui.md](C:/Users/Tanya/source/repos/god-mode-core/docs/web/control-ui.md) to document that overview skills pivots now reuse the same canonical `skills` destination contract as the rest of the operator surface.

## Notes

- This is intentionally narrower and cleaner than broader skills polish, command-palette changes, or transient UI state work like `logsAutoFollow`.
- Success means that blocked/missing skills links from overview behave identically across copied URL, refresh, direct open, primary-click SPA handoff, and modified-click browser navigation.
