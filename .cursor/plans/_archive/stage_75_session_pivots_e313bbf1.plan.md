---
name: stage 75 session pivots
overview: Stabilize the remaining session-oriented deep-link pivots by moving chat and cron-runtime links off low-level URL assembly and onto canonical destination builders plus existing SPA handoff behavior.
todos:
  - id: add-canonical-chat-builder
    content: Добавить shared canonical helper для chat session href и определить reuse path для cron runtime pivot без нового URL contract.
    status: completed
  - id: wire-session-pivot-builders
    content: Перевести app-render, cron и sessions на injected canonical builders для chat/runtime links вместо inline buildTabHref.
    status: completed
  - id: lock-session-pivot-regressions
    content: Обновить tests и docs для remaining session pivot canonical parity.
    status: completed
isProject: false
---

# Stage 75 - Session Pivot Canonical Parity

## Goal

Bring the remaining high-signal session-oriented pivots onto the same canonical routing model as the rest of the UI: `chat` links from overview/session rows/cron runs and the `cron` run pivot into `sessions` runtime should reuse shared destination builders, keep primary-click SPA handoff, and preserve native browser behavior for modified clicks.

## Why This Stage

- [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/cron.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/cron.ts) still builds run-level `chat` and `sessions` links with low-level `buildTabHref(...)`, even though the target surfaces already have canonical contracts.
- [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/sessions.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/sessions.ts) still builds the session-row `chat` link inline with `buildTabHref(...)`.
- [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-render.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-render.ts) still wires overview recent-session `chat` hrefs through `buildTabHref(...)`, so copied/open-in-new-tab behavior is not yet guaranteed to match the canonical destination contract everywhere.
- This is a better `v1` stabilization step than lower-signal polish because these pivots sit directly on investigation and recovery paths, and the work stays inside the existing `session` / `runtimeSession` URL namespace.

## Scope

- Canonicalize remaining internal `chat` session links.
- Canonicalize the `cron` run pivot into `sessions` runtime.
- Keep existing primary-click interception semantics for in-app navigation.
- Keep modified-click, middle-click, and copy-link behavior browser-native.
- Do not introduce a new query namespace or broader transient-state serialization.

## Planned Changes

- In [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-settings.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-settings.ts): add a small shared `chat` destination helper such as `buildCanonicalChatHref(...)` with a `sessionKey` override, matching the existing `buildCanonical*Href(...)` pattern instead of repeating `buildTabHref(...)` at call sites.
- In [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-render.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-render.ts): switch the shared `buildChatHref` wiring to the canonical helper and reuse the existing app-level handoff path for any cron/session pivots that should hydrate from URL state rather than ad hoc tab switching.
- In [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/cron.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/cron.ts): stop assembling run `chat` / `sessions` hrefs locally; inject destination builders for those links so `cron` becomes a pure renderer and the generated URLs match the destination surfaces.
- In [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/sessions.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/sessions.ts): replace the inline session-row `chat` URL construction with the shared canonical builder.
- In [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/overview-cards.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/overview-cards.ts): keep the existing click semantics, but let recent-session rows inherit the canonical `chat` hrefs from app-level wiring.

## Validation

- Update [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-settings.test.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/app-settings.test.ts) with a regression for canonical `chat` href overrides and, if needed, a representative `sessions` runtime override path reused by `cron`.
- Update [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/cron.test.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/cron.test.ts) so run-level `chat` and runtime links expect canonical hrefs and still distinguish primary-click handoff from modified-click browser fallthrough.
- Update [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/sessions.test.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/sessions.test.ts) so session-row `chat` links expect the canonical builder instead of inline `buildTabHref(...)` output.
- Update [C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/overview-cards.test.ts](C:/Users/Tanya/source/repos/god-mode-core/ui/src/ui/views/overview-cards.test.ts) if the shared `buildChatHref` contract changes its expected URL shape.
- Add short parity notes to [C:/Users/Tanya/source/repos/god-mode-core/docs/help/testing.md](C:/Users/Tanya/source/repos/god-mode-core/docs/help/testing.md) and [C:/Users/Tanya/source/repos/god-mode-core/docs/web/control-ui.md](C:/Users/Tanya/source/repos/god-mode-core/docs/web/control-ui.md).

## Notes

- This intentionally avoids nearby but lower-value work such as `skills` polish or `logsAutoFollow`: the session/chat/runtime pivots are more operator-critical and still leave a small number of obvious low-level URL builders in production UI code.
- Success looks the same as the previous parity stages: copied URL, refresh, direct open, primary-click handoff, and modified-click new-tab behavior all land on the same chat session or runtime inspector state.
