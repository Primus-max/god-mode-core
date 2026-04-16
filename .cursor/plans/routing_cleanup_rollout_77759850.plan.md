---
name: routing cleanup rollout
overview: Перевести production routing на единый classifier-first контракт, убрать legacy drift между preview/send/runtime, затем синхронизировать tool/runtime availability и закрыть работу тестами и живым E2E для image, pdf, files, web/site и video-сценариев в пределах текущей сессии.
todos:
  - id: audit-contract-drift
    content: Подтвердить в коде все места, где classifier-first contract теряется или переопределяется planner/profile/template/gateway слоями.
    status: completed
  - id: lock-task-contract
    content: Сделать classifier bridge authoritative для artifact kinds, requested tools и execution invariants, включая image/pdf/video/site cases.
    status: completed
  - id: tighten-planner
    content: Убрать silent downgrade в planner для contract-first inputs и сделать fallback fail-closed вместо возврата в general_reasoning.
    status: completed
  - id: unify-entrypoints
    content: Перевести preview, gateway и template/session-backed paths на общий classifier-backed planner builder.
    status: completed
  - id: align-runtime-tools
    content: Синхронизировать tool registration, runtime availability и evidence acceptance с обещаниями контракта.
    status: completed
  - id: add-tests-smoke
    content: Обновить unit/integration/live smoke покрытие для ключевых routing scenarios.
    status: completed
  - id: prove-e2e
    content: Пересобрать UI и gateway и подтвердить живой E2E минимум для image, pdf и расширенных media/web cases.
    status: completed
isProject: false
---

# Classifier-First Routing Rollout

## Goal

Сделать один authoritative routing path для всего live execution: classifier -> contract -> planner -> runtime -> tools -> evidence -> UI. Главный критерий: ясные artifact-turns больше не сваливаются в `general_reasoning`, а preview и actual send смотрят на один и тот же runtime truth.

## What The Code Confirms

- `agent-command` уже идет через classifier-first path: [C:\Users\Tanya\source\repos\god-mode-core\src\agents\agent-command.ts](C:\Users\Tanya\source\repos\god-mode-core\src\agents\agent-command.ts).
- Session-backed preview/gateway/template path все еще строится через legacy decision input: [C:\Users\Tanya\source\repos\god-mode-core\src\platform\decision\input.ts](C:\Users\Tanya\source\repos\god-mode-core\src\platform\decision\input.ts), [C:\Users\Tanya\source\repos\god-mode-core\src\platform\profile\gateway.ts](C:\Users\Tanya\source\repos\god-mode-core\src\platform\profile\gateway.ts), [C:\Users\Tanya\source\repos\god-mode-core\src\auto-reply\reply\agent-runner-utils.ts](C:\Users\Tanya\source\repos\god-mode-core\src\auto-reply\reply\agent-runner-utils.ts).
- В classifier bridge уже есть нужные сигналы (`requestedTools`, `artifactKinds`), но planner все еще может допустить drift через broad matching и `executionContractAllowsRecipe()`: [C:\Users\Tanya\source\repos\god-mode-core\src\platform\decision\task-classifier.ts](C:\Users\Tanya\source\repos\god-mode-core\src\platform\decision\task-classifier.ts), [C:\Users\Tanya\source\repos\god-mode-core\src\platform\recipe\planner.ts](C:\Users\Tanya\source\repos\god-mode-core\src\platform\recipe\planner.ts).
- Runtime tool availability уже несимметрична: `image_generate` выставляется всегда, а `pdf` создается только при наличии `agentDir`; это надо выровнять с contract/evidence: [C:\Users\Tanya\source\repos\god-mode-core\src\agents\openclaw-tools.ts](C:\Users\Tanya\source\repos\god-mode-core\src\agents\openclaw-tools.ts).
- В `resolution-contract` heavy artifact/routing уже учитывают `video/site/document/image`, но classifier bridge и planner надо довести до той же полноты: [C:\Users\Tanya\source\repos\god-mode-core\src\platform\decision\resolution-contract.ts](C:\Users\Tanya\source\repos\god-mode-core\src\platform\decision\resolution-contract.ts).

## Target Flow

```mermaid
flowchart LR
  userTurn[UserTurn] --> classifier[TaskClassifier]
  classifier --> taskContract[TaskContract]
  taskContract --> bridge[BridgeMapping]
  bridge --> resolution[ResolutionContract]
  resolution --> planner[ContractFirstPlanner]
  planner --> runtime[RuntimePlan]
  runtime --> tools[ToolExecution]
  tools --> evidence[EvidenceCheck]
  evidence --> ui[PreviewAndReceipts]
```



## Execution Phases

### Phase 1: Lock The Contract

Update [C:\Users\Tanya\source\repos\god-mode-core\src\platform\decision\task-classifier.ts](C:\Users\Tanya\source\repos\god-mode-core\src\platform\decision\task-classifier.ts) so classifier output becomes the strict source of truth.

Scope:

- Make `requestedTools.length > 0` imply `executionContract.requiresTools = true`.
- Make artifact-bearing outcomes (`image`, `pdf`, `document`, `video`, `site`) impossible to map to plain `text_response`.
- Extend bridge coverage for broad artifact authoring cases:
  - pure image
  - pure pdf/document
  - image + pdf bundle
  - file extraction/report
  - website/browser observation
  - video/media request
- Remove ambiguity between `interactionMode`, `requestedTools`, `artifactKinds`, `outcomeContract`, `requiresArtifactEvidence`.

### Phase 2: Stop Planner Downgrades

Tighten [C:\Users\Tanya\source\repos\god-mode-core\src\platform\recipe\planner.ts](C:\Users\Tanya\source\repos\god-mode-core\src\platform\recipe\planner.ts) so contract-first inputs cannot silently widen back into `general_reasoning`.

Scope:

- Make contract-first recipe narrowing respect explicit artifact/tool bundles first.
- Prevent `executionContractAllowsRecipe()` from allowing `general_reasoning` when artifact evidence or tool execution is required.
- Make fallback deterministic and fail-closed for classifier-first turns instead of broad legacy widening.
- Audit `toolBundlesMatchRecipe()` for `browser`, `web_search`, `pdf`, `image_generate`, `video/site`-style artifact requests.

### Phase 3: Unify Live Entry Points

Move all live/session-backed paths onto the same classifier-backed builder.

Primary files:

- [C:\Users\Tanya\source\repos\god-mode-core\src\agents\agent-command.ts](C:\Users\Tanya\source\repos\god-mode-core\src\agents\agent-command.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\src\platform\profile\gateway.ts](C:\Users\Tanya\source\repos\god-mode-core\src\platform\profile\gateway.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\src\auto-reply\reply\agent-runner-utils.ts](C:\Users\Tanya\source\repos\god-mode-core\src\auto-reply\reply\agent-runner-utils.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\src\platform\decision\input.ts](C:\Users\Tanya\source\repos\god-mode-core\src\platform\decision\input.ts)

Scope:

- Introduce one shared session-aware classifier-backed planner-input builder for preview/template/send.
- Ensure preview strip, runtime snapshot, and actual send use the same contract and same selected recipe.
- Keep legacy heuristic builders only as explicit fallback when classifier is unavailable, never as a competing normal path.
- Revisit session-context assembly so old transcript/file noise does not hijack clear current artifact requests.

### Phase 4: Align Runtime And Tool Availability

Sync contract promises with what runtime can truly execute.

Primary files:

- [C:\Users\Tanya\source\repos\god-mode-core\src\agents\openclaw-tools.ts](C:\Users\Tanya\source\repos\god-mode-core\src\agents\openclaw-tools.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\src\agents\tools\image-generate-tool.ts](C:\Users\Tanya\source\repos\god-mode-core\src\agents\tools\image-generate-tool.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\src\agents\tools\pdf-tool.ts](C:\Users\Tanya\source\repos\god-mode-core\src\agents\tools\pdf-tool.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\src\platform\runtime\evidence-sufficiency.ts](C:\Users\Tanya\source\repos\god-mode-core\src\platform\runtime\evidence-sufficiency.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\src\image-generation\provider-registry.ts](C:\Users\Tanya\source\repos\god-mode-core\src\image-generation\provider-registry.ts)

Scope:

- If contract requires `pdf` or `image_generate` or analogous media capability, runtime must either expose that tool or fail fast before turn execution.
- Remove cases where text-only answers satisfy artifact acceptance.
- Audit whether video/site/media requests need missing tool wiring or explicit fail-closed diagnostics.
- In implementation phase, allow config/dependency installs needed for the controlling bot to actually execute these tools.

### Phase 5: Make UI Tell The Truth

Keep UI fixes downstream of runtime truth.

Primary files:

- [C:\Users\Tanya\source\repos\god-mode-core\src\platform\profile\gateway.ts](C:\Users\Tanya\source\repos\god-mode-core\src\platform\profile\gateway.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\specialist-context.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\specialist-context.ts)

Scope:

- Make specialist summary derive from classifier-backed runtime plan.
- Preserve closed-by-default expander behavior.
- Remove misleading `General / general_reasoning` labels once upstream routing is fixed.

### Phase 6: Add Regression Shields

Update the most valuable tests first, then add smoke coverage.

Priority test files:

- [C:\Users\Tanya\source\repos\god-mode-core\src\platform\decision\task-classifier.test.ts](C:\Users\Tanya\source\repos\god-mode-core\src\platform\decision\task-classifier.test.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\src\platform\decision\resolution-contract.test.ts](C:\Users\Tanya\source\repos\god-mode-core\src\platform\decision\resolution-contract.test.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\src\platform\recipe\planner.test.ts](C:\Users\Tanya\source\repos\god-mode-core\src\platform\recipe\planner.test.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\src\agents\agent-command.stage4.test.ts](C:\Users\Tanya\source\repos\god-mode-core\src\agents\agent-command.stage4.test.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\specialist-context.test.ts](C:\Users\Tanya\source\repos\god-mode-core\ui\src\ui\views\specialist-context.test.ts)
- [C:\Users\Tanya\source\repos\god-mode-core\scripts\dev\task-classifier-live-smoke.ts](C:\Users\Tanya\source\repos\god-mode-core\scripts\dev\task-classifier-live-smoke.ts)

Minimum scenario matrix:

- general answer
- pure image generation
- pure pdf generation
- document plus images bundle
- file extraction
- tabular compare from files
- browser observation
- public web research
- site/build request
- video/media request

### Phase 7: Final Live Verification

After code and tests, rebuild runtime/UI and run live E2E through the actual gateway/UI path.

Success evidence:

- preview summary matches actual selected route
- `image_generate` fires for pure image request
- `pdf` fires for pure PDF request
- artifact evidence is recorded from real tool receipts
- no clarify-only fallback for clear artifact requests
- website/video/media cases either work end-to-end or fail closed with precise runtime diagnostics instead of being misrouted into `general_reasoning`

## Order Of Work In Chat

1. Prove where the contract is lost and patch contract + planner invariants first.
2. Unify preview/template/send entry points.
3. Align runtime tool exposure and evidence enforcement.
4. Add targeted tests and smoke coverage.
5. Rebuild and run live E2E against the real gateway/UI path.

## Acceptance Bar

- Clear image requests route to artifact generation, not `general_reasoning`.
- Clear PDF/document requests produce deliverables, not explanatory chat.
- Files/web/browser/site/video requests no longer drift because preview and send disagree.
- Legacy heuristics remain only as explicit fallback when classifier is unavailable.
- The bot can self-install/configure missing execution prerequisites during implementation when they are required for the controlling runtime to actually work.
