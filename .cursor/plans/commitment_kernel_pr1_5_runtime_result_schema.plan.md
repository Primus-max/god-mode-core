---
name: "PR-1.5 — Runtime Result Schema Extension"
overview: "Micro-PR между PR-1 и PR-2: расширить SpawnSubagentResult и SpawnAcpResult на pure session metadata (agentId + parentSessionKey) через branded типы в src/platform/commitment/ids.ts. Одна schema-точка для boundary spawn-runtime <-> future observer (PR-3). Никакого изменения routing, никакого raw user text, никакого TaskContract."
todos:
  - id: branded-ids-extend
    content: Расширить src/platform/commitment/ids.ts двумя новыми branded type AgentId и SessionKey; обновить index.ts re-exports.
    status: completed
  - id: world-state-realign
    content: Перевести SessionRecord.agentId с plain string на AgentId; SessionRecord.parentSessionKey с string | null на SessionKey | null. Без runtime-кода (только types).
    status: completed
  - id: spawn-subagent-result-extend
    content: Добавить readonly agentId AgentId + readonly parentSessionKey SessionKey | null в SpawnSubagentResult (status accepted only) в src/agents/subagent-spawn.ts; заполнить из targetAgentId / requesterInternalKey на единственном return accepted.
    status: completed
  - id: spawn-acp-result-extend
    content: Симметрично расширить SpawnAcpResult в src/agents/acp-spawn.ts. Заполнение из аналогичных existing переменных. Обоснование симметрии — observer (PR-3) читает оба channel-source в followupRegistry.
    status: completed
  - id: llm-result-builder-update
    content: Обновить buildSubagentSpawnLlmResult и buildAcpSpawnLlmResult в src/agents/tools/sessions-spawn-tool.ts; новые поля surface наружу под status accepted only, как childSessionKey/runId. На error/forbidden — drop (по существующей политике).
    status: completed
  - id: tests-update
    content: Обновить existing call-site tests на новые required поля; добавить два-три new test cases (accepted shape contains agentId+parentSessionKey, error shape не содержит, LLM-builder корректно фильтрует).
    status: completed
  - id: human-signoff
    content: Explicit human maintainer review против master invariants #11 (no frozen-layer touch), #15 (signoff). Подтвердить scope (только runtime result schema, ничего больше).
    status: completed
isProject: false
---

# PR-1.5 — Runtime Result Schema Extension (Sub-Plan)

## 0. Provenance & Inheritance

| Field | Value |
| --- | --- |
| Sub-plan of | `commitment_kernel_v1_master.plan.md` (§8.2) |
| Inherits | 16 hard invariants + 6 flexible (без изменений) |
| Production routing change | **none** (runtime result shape only; никакой логики) |
| Estimated effort | 0.5-1 день кода + ~0.5 дня review |
| Exit gate | Human maintainer signoff (hard invariant #15) |

Любое изменение invariants — **revision мастер-плана, не этого sub-plan**. Sub-plan не имеет права ослаблять или переопределять hard / flexible invariants.

---

## 1. Goal of This PR

Закрыть **один** boundary defect, обнаруженный в Round 4: combined `(spawnResult + callerContext)` — anti-pattern. PR-3 observer (`SessionWorldState.followupRegistry`) ожидает каждую `SessionRecord` как **pure value** (см. master §5.4 / sub-plan PR-1 §3.5):

```ts
SessionRecord = {
  sessionId: SessionId;
  agentId: AgentId;             // <- сейчас отсутствует на boundary spawn->observer
  parentSessionKey: SessionKey | null;  // <- то же
  status: ...;
  createdAt: ISO8601;
};
```

Без extension в spawn-результат:
- PR-2 (`runTurnDecision` shadow path) пишет на messy contract — каждый writer вынужден вычислять `agentId` / `parentSessionKey` локально из caller context.
- PR-3 (observer) переписывается, как только появляется второй call-site (cron / subagent / acp).

Один PR — **одна schema-точка** на boundary. Никакого runtime кода, никаких routing-решений.

> NB. Это PR не про commitment kernel surface (commitment/ layer). Это про **runtime evidence shape** в существующем `src/agents/`. Но он наследует invariants мастер-плана: pure value, no raw user text, no TaskContract, no classifier output в полях.

---

## 2. Files To Create / Modify

### 2.1. Modify — `src/platform/commitment/ids.ts`

Добавить два branded type. Никакого нового файла. Все остальные branded ids остаются неприкосновенными.

```ts
declare const AgentIdBrand: unique symbol;
export type AgentId = string & { readonly [AgentIdBrand]: true };

declare const SessionKeyBrand: unique symbol;
export type SessionKey = string & { readonly [SessionKeyBrand]: true };
```

И re-export из `src/platform/commitment/index.ts`:

```ts
export type { AgentId, SessionKey } from './ids';
```

### 2.2. Modify — `src/platform/commitment/world-state.ts`

Single shape realignment (внутри PR-1 sketch shape был `string`):

```ts
import type { AgentId, SessionId, SessionKey, ISO8601 } from './ids';

export type SessionRecord = {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  readonly parentSessionKey: SessionKey | null;
  readonly status: 'active' | 'paused' | 'closed';
  readonly createdAt: ISO8601;
};

export type SessionRecordRef = {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
};
```

> **Ничего больше** в `world-state.ts` / `expected-delta.ts` не трогаем. Все остальные slices (`ArtifactWorldState`, `WorkspaceWorldState`, `DeliveryWorldState`) — out of scope (cutover-2+).

### 2.3. Modify — `src/agents/subagent-spawn.ts`

| Edit | Lines (current) | Nature |
| --- | --- | --- |
| Add import `AgentId`, `SessionKey` | top | type-only |
| Extend `SpawnSubagentResult` two new optional fields | ~line 102 | type-only |
| Fill fields on the single `status: "accepted"` return | ~line 964 | runtime fill from existing locals (`targetAgentId`, `requesterInternalKey`) |

```ts
import type { AgentId, SessionKey } from '../platform/commitment/ids.js';

export type SpawnSubagentResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnSubagentMode;
  note?: string;
  modelApplied?: boolean;
  error?: string;
  errorReason?: SpawnSubagentErrorReason;
  agentId?: AgentId;                       // populated only on status=accepted
  parentSessionKey?: SessionKey | null;    // populated only on status=accepted; null = no parent (top-level spawn)
  attachments?: { ... unchanged ... };
};
```

И на единственный `return { status: "accepted", ... }` (current ~line 964):

```ts
return {
  status: "accepted",
  childSessionKey,
  runId: childRunId,
  mode: spawnMode,
  note,
  modelApplied: resolvedModel ? modelApplied : undefined,
  agentId: targetAgentId as AgentId,
  parentSessionKey: (requesterInternalKey ?? null) as SessionKey | null,
  attachments: attachmentsReceipt,
};
```

> **`as` cast — единственное разрешённое место**, потому что branded типы это nominal-on-string и нет runtime constructor. Приведение происходит ровно на boundary spawn -> result. Все downstream consumers видят уже branded. Это та же модель, что используется в `intent-contractor.ts` для `'unknown' as EffectFamilyId` в PR-1 stub.

### 2.4. Modify — `src/agents/acp-spawn.ts`

**Симметрично** `SpawnSubagentResult`. Обоснование симметрии:

> PR-3 observer читает `SessionWorldState.followupRegistry`, в который попадают **оба** channel-source: subagent runs и acp sessions. Если расширить только один — schema mismatch на boundary, PR-3 переписывается.

```ts
import type { AgentId, SessionKey } from '../platform/commitment/ids.js';

export type SpawnAcpResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnAcpMode;
  streamLogPath?: string;
  note?: string;
  error?: string;
  agentId?: AgentId;                       // populated only on status=accepted
  parentSessionKey?: SessionKey | null;    // populated only on status=accepted
};
```

Заполнение — на каждом `status: "accepted"` return из `spawnAcpDirect`. Источники в файле уже существуют: `targetAgentId` / `parsedRequesterAgentId` для `agentId`, `requesterInternalKey` (или эквивалент в этом файле — `params.parentSessionKey` уже передаётся в `resolveAcpSpawnRequesterState`) для `parentSessionKey`.

> **Если выясняется что в `acp-spawn.ts` нет single accepted-return, а их N**, заполнение делается через локальный helper `buildAcceptedAcpResult(...)` вверху файла, чтобы schema не расходилась между ветками. Это decision pre-implementation: посмотреть и решить в момент кода.

### 2.5. Modify — `src/agents/tools/sessions-spawn-tool.ts`

Surface новых полей в LLM-result. Только под `status === "accepted"`. На `error` / `forbidden` — **drop**, по существующей политике (см. comment 10-12 файла).

```ts
export function buildSubagentSpawnLlmResult(result: SpawnSubagentResult): Record<string, unknown> {
  if (result.status === "accepted") {
    const out: Record<string, unknown> = { status: result.status };
    if (result.childSessionKey) out.childSessionKey = result.childSessionKey;
    if (result.runId)           out.runId           = result.runId;
    if (result.mode)            out.mode            = result.mode;
    if (result.note)            out.note            = result.note;
    if (result.modelApplied !== undefined) out.modelApplied = result.modelApplied;
    if (result.agentId)         out.agentId         = result.agentId;          // new
    if (result.parentSessionKey !== undefined) out.parentSessionKey = result.parentSessionKey;  // new (null is meaningful)
    if (result.attachments)     out.attachments     = result.attachments;
    return out;
  }
  // error/forbidden branch unchanged
  ...
}
```

Аналогично для `buildAcpSpawnLlmResult`.

### 2.6. Modify — tests

| File | Change |
| --- | --- |
| `src/agents/tools/sessions-spawn-tool.test.ts` | Update existing accepted-shape assertions: ожидаем `agentId`, `parentSessionKey` в LLM-payload; existing "strips internal hints when error" tests должны pass без изменений (drop policy сохраняется). |
| `src/agents/subagent-spawn.attachments.test.ts` / `subagent-spawn.error-surface.test.ts` / `subagent-spawn.hardening.test.ts` / `subagent-spawn.workspace.test.ts` / `subagent-spawn.model-session.test.ts` | Если существующий test читает accepted shape целиком (`expect(result).toEqual(...)`), добавить новые два поля в expected. Если читает field-by-field — без изменений. |
| `src/auto-reply/reply/commands-subagents-spawn.test.ts` | Та же логика. |
| `src/agents/pi-embedded-runner/run/attempt.spawn-workspace.test.ts` | Та же логика. |

**Новые test cases** (минимум три, добавить в существующий `subagent-spawn.error-surface.test.ts` или новый focused suite):

| # | What | Expected |
| --- | --- | --- |
| 1 | accepted spawn populates `agentId === targetAgentId` (branded)            | result.agentId is the resolved targetAgentId, type-system enforces branded |
| 2 | accepted top-level spawn (no parent) populates `parentSessionKey: null`   | result.parentSessionKey === null |
| 3 | accepted nested spawn populates `parentSessionKey` from `requesterInternalKey` | result.parentSessionKey === requesterInternalKey |
| 4 | error/forbidden result does NOT contain `agentId` / `parentSessionKey`    | LLM-builder drops them; raw result.agentId is undefined |

---

## 3. Type Invariants (PR-1.5)

Эти invariants — **наследуемые** от мастера, перечисляются здесь только для чек-листа ревьюера.

| Invariant | Applies how |
| --- | --- |
| #11 (five-layer freeze) | `SpawnSubagentResult` / `SpawnAcpResult` **НЕ** входят в пять frozen contracts. Расширение разрешено без freeze-label. PR template freeze-section отмечается как `none of the above`. |
| #15 (human signoff)     | Mandatory exit gate. |
| #5 / #6 (raw user text) | Новые поля **не содержат** `UserPrompt` / `RawUserTurn` / любого raw user text. Только session metadata (id, key, channel-pure value). |
| #1 (commitment tool-free) | PR-1.5 не трогает `ExecutionCommitment`. Никаких `tool` / `recipe` полей вообще. |
| #8 (commitment !-> decision) | Импорт `AgentId` / `SessionKey` идёт **agents -> commitment** (allowed), не commitment -> decision. |
| #16 (EffectFamilyId vs EffectId) | `AgentId` / `SessionKey` — **отдельные** branded types, без implicit conversion в `EffectId` / `EffectFamilyId` / `SessionId`. |

---

## 4. Out of Scope (что НЕ делаем в PR-1.5)

| Item | Where it lands |
| --- | --- |
| Заполнение `DecisionTrace.shadowCommitment` runtime | PR-2 |
| Реальный `IntentContractor` / `ShadowBuilder` logic | PR-2 |
| `runTurnDecision` unified entry point | PR-2 |
| `affordance_branching_factor` shadow telemetry | PR-2 |
| `SessionWorldState` observer (real reader of `followupRegistry`) | PR-3 |
| `Affordance(persistent_session.created)` | PR-3 |
| `commitmentSatisfied` runtime gate | PR-3 |
| Расширение других runtime result shapes (cron / hook results) | future PRs |
| `decision-eval` shadow comparison | PR-2 |

---

## 5. Implementation Order (recommended)

```text
Day 1 (morning):
  1. Add branded AgentId + SessionKey to src/platform/commitment/ids.ts.
  2. Update src/platform/commitment/index.ts re-exports.
  3. Realign SessionRecord / SessionRecordRef in world-state.ts / expected-delta.ts.
  4. Run tsc --noEmit; expect zero new errors (types-only realign).

Day 1 (afternoon):
  5. Extend SpawnSubagentResult; fill on the single accepted return.
  6. Extend SpawnAcpResult; fill on accepted return(s) — pre-check single vs N branches.
  7. Update buildSubagentSpawnLlmResult + buildAcpSpawnLlmResult.
  8. Run pnpm test; fix expected-shape diffs in existing tests.
  9. Add focused test cases (§2.6 new cases 1-4).
  10. Run scripts/check-no-raw-user-text-import.mjs + scripts/check-no-decision-imports-from-commitment.mjs;
      expect zero violations (PR-1.5 не трогает raw text surface, не импортирует из decision/).

Day 2 (review buffer):
  11. Address review comments; must not change scope.
  12. Final signoff.
  13. Progress marker commit (per .cursor/rules/pr-session-bootstrap.mdc):
      flip pr15-runtime-result-schema-extension todo in master frontmatter to completed,
      flip all pr15-* todos in this sub-plan to completed,
      append row to master §0 PR Progress Log.
      Trailer: Plan-Step: PR-1.5 / Plan-Status: completed.
```

---

## 6. Exit Criteria — Checklist

- [ ] **TypeScript build green**: `tsc --noEmit` без новых ошибок (PR-1 baseline сохранён). PR-1.5 modified files (`src/platform/commitment/ids.ts`, `src/platform/commitment/index.ts`, `src/platform/commitment/world-state.ts`, `src/platform/commitment/expected-delta.ts`, `src/agents/subagent-spawn.ts`, `src/agents/acp-spawn.ts`, `src/agents/tools/sessions-spawn-tool.ts`) компилируются чисто.
- [ ] **Lint check-скрипты green**: `lint:commitment:no-raw-user-text-import` + `lint:commitment:no-decision-imports` exit 0. PR-1.5 не трогает whitelist для raw-user-text и не вводит decision-imports.
- [ ] **Existing tests green**: все existing call-site tests passing. Diff в expected shape — только добавление двух новых полей.
- [ ] **New test cases green**: §2.6 cases 1-4 passing.
- [ ] **`agentId` / `parentSessionKey` populated only on status=accepted**: на `error` / `forbidden` поля undefined; LLM-builder drops them.
- [ ] **Branded types enforced**: попытка вернуть `string` без cast в поле `agentId: AgentId` падает на компиляции (negative compile-test опционально, может быть зафиксирован в `__tests__/types.test.ts` через `// @ts-expect-error`).
- [ ] **Никаких изменений в `src/platform/decision/**`**: `git diff` пуст в этой директории.
- [ ] **Никаких изменений в `src/platform/commitment/**` за пределами `ids.ts` / `index.ts` / `world-state.ts` / `expected-delta.ts`**: `git diff` это подтверждает.
- [ ] **Никаких изменений в `runTurnDecision` / shadow runtime / observer code** (этого кода ещё нет; проверка — отсутствие новых файлов в `commitment/` за пределами трёх перечисленных).
- [ ] **Bit-identical decision-eval snapshot test (от PR-1) green**: `lint:commitment:*` + bit-identical snapshot test проходят без изменений baseline.
- [ ] **PR template freeze-section отмечена `none of the above`**: PR-1.5 не трогает frozen layer.
- [ ] **Progress marker commit** (mandatory final step): отдельный `docs(plan): mark PR-1.5 completed` коммит. Trailer: `Plan-Step: PR-1.5` / `Plan-Status: completed`.
- [ ] **Human signoff** против master invariants #11 (no frozen-layer touch), #15.

---

## 7. References

- Master plan: `.cursor/plans/commitment_kernel_v1_master.plan.md` §8.2, §5.4 (`SessionRecord` shape), §15 (touch-down points)
- Discussion artefact: `.cursor/plans/commitment_kernel_design_dialog.plan.md` (Round 3-4 — обсуждение boundary defect)
- Predecessor sub-plan: `.cursor/plans/commitment_kernel_pr1_types_seed.plan.md` (PR-1, branded id pattern)
- Affected files (modify): `src/platform/commitment/ids.ts`, `src/platform/commitment/index.ts`, `src/platform/commitment/world-state.ts`, `src/platform/commitment/expected-delta.ts`, `src/agents/subagent-spawn.ts`, `src/agents/acp-spawn.ts`, `src/agents/tools/sessions-spawn-tool.ts`
- Affected tests: `src/agents/subagent-spawn.*.test.ts`, `src/agents/tools/sessions-spawn-tool.test.ts`, `src/auto-reply/reply/commands-subagents-spawn.test.ts`, `src/agents/pi-embedded-runner/run/attempt.spawn-workspace.test.ts`

---

## 8. Risk Log

| Risk | Mitigation in PR-1.5 |
| --- | --- |
| `acp-spawn.ts` имеет N веток `status: "accepted"`, и schema расходится между ветками | Перед заполнением полей проверить число accepted-returns в файле; если > 1, ввести локальный helper `buildAcceptedAcpResult(...)` (чисто structural). Не trying to "DRY" функцию между subagent и acp — boundary разный. |
| Existing test читает accepted shape через `expect(...).toEqual(...)` (full-equality), и breaks на каждом call-site | Снимается обновлением expected. Принципиальная mitigation: на новых boundary всегда field-by-field assertions (но это рефакторинг тестов уже за scope PR-1.5). |
| Branded `AgentId` / `SessionKey` где-то ниже по стеку нужны как plain `string` (например, для gateway JSON serialization) | Branded на string — runtime это **`string`**. Сериализация в JSON работает прозрачно. TypeScript-уровневая проверка только на использования. Cast-ы при чтении из gateway response (`as AgentId`) допустимы на boundary "raw protocol -> typed value", как и в текущем коде с `runId`. |
| `SessionKey` колликсирует с другими существующими типами session-key в репо (там везде `string`) | PR-1.5 не пытается принудительно типизировать всё репо. `SessionKey` используется **только** в `SpawnSubagentResult` / `SpawnAcpResult` / `SessionRecord(.Ref)`. В остальных местах остаётся `string`. Future PR может расширить охват. |
| `parentSessionKey` всегда `null` для top-level спавна — null vs undefined | LOCKED: `null` для "no parent (top-level)", `undefined` для "не applicable / drop в LLM-payload" (на error/forbidden). Это разные семантики. Документируется в JSDoc на поле. |
| Кто-то запишет в новые поля `RawUserTurn.text` или фрагмент TaskContract | Code review ловит. Lint-скрипт `no-raw-user-text-import` уже блокирует import `RawUserTurn` в `src/agents/**`. TaskContract — не в scope любого spawn-кода. Реалистично риск низкий. |
