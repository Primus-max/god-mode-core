---
name: stage 83 session event broadcast gate
overview: После Stage 82 следующий сильный v1 gap — зафиксировать deterministic parity между canonical session row truth и реальными `sessions.changed` broadcast variants, чтобы thin clients и operator-facing consumers не расходились с recovery/closure contract по мере дальнейших изменений gateway/runtime.
todos:
  - id: audit-session-event-contract
    content: "Зафиксировать минимальный producer-side contract для `sessions.changed`: flat top-level keys, omission semantics, и variant-specific broadcast policy."
    status: done
  - id: build-session-event-harness
    content: Собрать тонкий deterministic harness поверх `session-broadcast-snapshot` и `session-event-hub` seams вместо нового event framework.
    status: done
  - id: add-broadcast-parity-scenarios
    content: Добавить небольшой набор CI-safe scenarios для mutation/lifecycle/transcript or message emit paths с parity against `sessions.list`-style truth.
    status: done
  - id: align-session-event-docs-and-gate
    content: Обновить testing guidance так, чтобы session-event broadcast parity выглядела как отдельный deterministic layer рядом с recovery-confidence suite.
    status: done
isProject: false
---

# Stage 83 - Session Event Broadcast Parity Gate

## Why This Stage

После `Navigation validation gate`, `Release confidence E2E gate`, `Skills reliability evals` и `Runtime recovery confidence gate` следующий сильный gap уже не в самом runtime truth, а в том, насколько надёжно эта truth доезжает до thin clients и operator-facing consumers через реальные `sessions.changed` emit paths.

В `[docs/help/testing.md](C:/Users/Tanya/source/repos/god-mode-core/docs/help/testing.md)` это уже почти сформулировано как отдельный контракт:

- `sessions.changed` intentionally mirrors the gateway session row model at the top level;
- `JSON.stringify()` drops `undefined`, поэтому omission semantics являются нормальной частью wire contract;
- producer-side session event behavior должен оставаться покрыт split regression matrix через snapshot builder, event hub policy tests и real emit integration tests.

Stage 82 уже доказал parity между session-facing handoff truth и runtime ledgers. Следующий честный шаг к stable v1 — доказать, что тот же canonical story стабильно проходит через broadcast layer, а не только через direct inspection или `sessions.list`.

## Goal

Добавить маленький deterministic, CI-safe session-event parity layer поверх существующих gateway session broadcast seams, чтобы v1 опиралась на автоматически проверяемую parity между:

- canonical session row fields;
- `sessions.changed` top-level payload contract;
- omission semantics for optional `handoff*`, recovery and `runClosureSummary` keys;
- real emit variants for mutation, lifecycle, transcript, and session-message adjacent paths.

## Key Evidence

- `[docs/help/testing.md](C:/Users/Tanya/source/repos/god-mode-core/docs/help/testing.md)` прямо фиксирует:
  - `WebSocket sessions.changed payloads intentionally mirror the gateway session row model ... at the top level`
  - `JSON.stringify() drops keys whose value is undefined`
  - producer-side changes должны держать regression matrix через `session-broadcast-snapshot`, `session-event-hub.test.ts` и gateway integration tests
- `[src/gateway/session-broadcast-snapshot.ts](C:/Users/Tanya/source/repos/god-mode-core/src/gateway/session-broadcast-snapshot.ts)` уже является lower-level enumerator for session row broadcast data
- `[src/gateway/session-event-hub.ts](C:/Users/Tanya/source/repos/god-mode-core/src/gateway/session-event-hub.ts)` уже задаёт policy differences между variant emit surfaces
- `[src/gateway/session-broadcast-snapshot.test.ts](C:/Users/Tanya/source/repos/god-mode-core/src/gateway/session-broadcast-snapshot.test.ts)`, `[src/gateway/session-event-hub.test.ts](C:/Users/Tanya/source/repos/god-mode-core/src/gateway/session-event-hub.test.ts)`, `[src/gateway/server.sessions.gateway-server-sessions-a.test.ts](C:/Users/Tanya/source/repos/god-mode-core/src/gateway/server.sessions.gateway-server-sessions-a.test.ts)`, `[src/gateway/session-message-events.test.ts](C:/Users/Tanya/source/repos/god-mode-core/src/gateway/session-message-events.test.ts)`, `[src/gateway/server-chat.agent-events.test.ts](C:/Users/Tanya/source/repos/god-mode-core/src/gateway/server-chat.agent-events.test.ts)` уже дают seams, которые можно собрать в thin gate вместо нового framework

## Scope

### 1. Define The Minimal Broadcast Parity Contract

Минимум для этого stage:

- flat top-level session fields остаются canonical для `sessions.changed`
- omitted `undefined` keys трактуются как valid optional-none wire behavior
- variant-specific event policy не рвёт parity между mutation, lifecycle, transcript and message-related emit paths
- recovery / handoff / closure fields не теряются и не дублируются по-разному между snapshot builder и real emits

### 2. Build A Thin Deterministic Harness

Не делать новый WS/event lab. Вместо этого собрать focused deterministic layer поверх:

- `[src/gateway/session-broadcast-snapshot.ts](C:/Users/Tanya/source/repos/god-mode-core/src/gateway/session-broadcast-snapshot.ts)`
- `[src/gateway/session-event-hub.ts](C:/Users/Tanya/source/repos/god-mode-core/src/gateway/session-event-hub.ts)`
- уже существующих integration seams для реальных emit paths

Если получится, держать это в одном соседнем focused test file или в компактном helper path, а не размазывать ad-hoc assertions по многим старым тестам.

### 3. Add The First 2-4 Broadcast Parity Scenarios

Сильный минимальный набор для stage:

- one `flat payload parity` scenario: top-level `sessions.changed` fields mirror canonical session row truth
- one `omission semantics` scenario: absent optional `handoff*` / recovery / `runClosureSummary` keys остаются valid wire representation, а не считаются contract drift
- one `variant policy` scenario: mutation vs lifecycle/transcript/session-message surfaces сохраняют expected inclusion policy без случайного расхождения
- one `recovery-aligned broadcast` scenario: recovery/closure-facing fields из Stage 82 доезжают через broadcast layer в inspectable and stable form

### 4. Align Docs With The New Gate

Обновить `[docs/help/testing.md](C:/Users/Tanya/source/repos/god-mode-core/docs/help/testing.md)`, чтобы стало ясно:

- что теперь покрывает deterministic session-event broadcast parity layer
- чем этот слой отличается от recovery-confidence suite
- какой focused command или suite стоит запускать, если меняются session broadcast, handoff projection, event hub policy или omission semantics

## Out Of Scope

- Новый heavy WebSocket replay framework
- Полный rewrite session event architecture
- Large UI redesign или consumer migration campaigns
- Live gateway/network/VM validation как always-on requirement

## Validation

Минимальный expected результат stage:

- новый deterministic session-event parity suite проходит локально без live providers
- suite проверяет broadcast-level parity, а не только helper-only serialization
- docs ясно отделяют этот слой от recovery-confidence suite и broader E2E/live checks
- targeted gateway/session event contracts остаются зелёными

## Why This Is The Strong Next Step

Этот stage делает v1 сильнее там, где backend truth встречается с реальными consumers:

- закрывает gap между canonical session row truth и фактическим event delivery contract
- защищает thin clients и operator surfaces от regressions в handoff/recovery/closure broadcast story
- дополняет Stage 82: сначала мы доказали truth в runtime ledgers, теперь доказываем её стабильную доставку через session event layer
