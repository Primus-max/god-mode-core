---
name: Idempotency fix — persistent_session.created (по session store, не runs) — commit 1 of PR-4a
overview: "Починить idempotency-guard для persistent_session.created. Текущая реализация в `spawnSubagentDirect` ищет live run в SubagentRunRegistry, но `endedAt` ставится после каждого turn, поэтому в TG flow guard никогда не находит совпадение и каждое следующее \"Валера, ...\" создаёт новый сабагент или падает на `label already in use`. Нужно искать живую persistent session в gateway session store по label+origin. ЖЁСТКО: этот sub-plan — detail-spec для **commit 1 PR-4a (Wave A)**, НЕ standalone PR. Финальный мерж = PR-4a. Обоснование (см. master §0.5.3): фикс трогает те же layers, что routing flip (commit 2); общий dry-run покрывает оба фикса. Закрывает audit gaps G3 + G4 — см. master plan §0.5.2."
audit_gaps_closed:
  - G3 (idempotency guard unreachable in TG flow)
  - G4 (idempotency tests do not prove fix)
todos:
  - id: audit-current-guard
    content: Прочитать findActiveSubagentByLabelFromRuns в src/agents/subagent-registry-queries.ts и idempotency block в src/agents/subagent-spawn.ts (around line 430-460). Зафиксировать в комментарии плана PR, что текущая реализация не работает в реальном TG flow и почему (endedAt mechanic).
    status: pending
  - id: replace-runs-based-wip
    content: Не доводить текущий незакоммиченный runs-based guard как финальный фикс. Удалить/заменить findActiveSubagentByLabel* path из spawnSubagentDirect на session-store-based query; tests переписать так, чтобы endedAt-completed run не блокировал reuse живой persistent session.
    status: pending
  - id: design-session-store-query
    content: |
      Спроектировать findLivePersistentSessionByLabel(label, origin) на уровне gateway session store.
      Source of truth — gateway sessions Map (key -> SessionEntry), а не SubagentRunRegistry.
      Реальный shape SessionEntry (см. src/config/sessions/types.ts) НЕ содержит spawnMode / deletedAt / createdAt — псевдокод старой версии плана был idealised. Используем Вариант A (минимальный, без расширения SessionEntry).
      Критерий live (Variant A):
      (a) ключ matches `agent:*:subagent:<uuid>` (только subagent-keys, не main session);
      (b) entry.label === label.trim();
      (c) deliveryContextKey(entry.deliveryContext ?? entry.origin) === deliveryContextKey(requesterOrigin);
      (d) запись физически присутствует в store (run-mode сабагенты удаляются через sessions.delete на cleanup → их в store просто нет);
      (e) при коллизии нескольких matches — latest entry.updatedAt.
      Косвенность liveness (через "запись жива в store") страхуется обязательным contract test'ом из §3.2 (run-mode после cleanup отсутствует в store).
      Возвращает SessionEntry + key.
    status: pending
  - id: implement-session-query
    content: Реализовать функцию в src/gateway/session-store-queries.ts (новый файл; alt — расширить server-methods/sessions.ts). Pure-function над Map + read-only по env (process-local memory). Без I/O.
    status: pending
  - id: replace-guard-in-spawn
    content: В src/agents/subagent-spawn.ts заменить findActiveSubagentByLabel(label, requesterOrigin) на findLivePersistentSessionByLabel. Логи переписать с reuse_by_label на reuse_by_session — сохраняем семантику commitment effect=persistent_session.created action=reuse.
    status: pending
  - id: deprecate-old-query
    content: findActiveSubagentByLabelFromRuns пометить @deprecated в JSDoc. В PR-4 / следующем PR удалить вместе с тестами после migration period. Не удалять в этом PR, чтобы не было breaking change в тестах PR-1.5 / PR-2 / PR-3.
    status: pending
  - id: tests
    content: |
      [Audit 2026-04-27, closes G4] Полностью переписать subagent-spawn.idempotency.test.ts.

      ВАЖНО: текущий тестовый файл использует `vi.spyOn(subagentRegistry, 'findActiveSubagentByLabel')` (строки 22, 78, 105). Этот подход **не доказывает фикс** — он только проверяет early-return ветку в spawnSubagentDirect, не сам guard. Этот же spy скрывал бы регрессию, в которой `endedAt` снова стал источником "живости". Доказать G3 closure через spy нельзя.

      Что делать вместо:
      1. Удалить `vi.spyOn(subagentRegistry, 'findActiveSubagentByLabel')` целиком.
      2. Использовать реальный (in-memory) gateway session store из `test/helpers/` — заполнять его через тот же путь, что и production code.
      3. Тест-сценарии:
         (a) Unit на `findLivePersistentSessionByLabel`: label match / spawnMode filter / origin mismatch / deletedAt / latest by createdAt.
         (b) E2E reproducing real TG bug: spawn(label='Валера') → run завершён (endedAt set) → второй spawn(label='Валера') должен вернуть тот же childSessionKey. Этот сценарий **обязателен** — без него regression на endedAt вернётся.
         (c) Negative: empty label / different origin / oneshot mode / deleted session → fall through.
         (d) Не использовать spy/mock на новой `findLivePersistentSessionByLabel`. Если нужен deterministic behavior — используйте in-memory store fixture.
    status: pending
  - id: lint-and-typecheck
    content: pnpm tsgo + pnpm vitest run (subagent-spawn.idempotency*, gateway/sessions*) + lint:commitment:* — все green.
    status: pending
  - id: human-signoff
    content: Поскольку это изменение поведения idempotency, нужен human signoff против master invariant #15 (cutover production behavior change).
    status: pending
isProject: false
---

# Idempotency fix — persistent_session.created (Sub-Plan)

## 0. Provenance

| Field                     | Value                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| Sub-plan of               | `commitment_kernel_v1_master.plan.md` (cutover-1 surface)                                   |
| Final merge target        | **PR-4a (Wave A), commit 1**. НЕ standalone PR. Detail-spec для первого коммита PR-4a.       |
| Branch                    | `pr/4a/cutover1-routing-flip` (либо `pr/4a/idempotency` с последующим cherry-pick в `pr/4a/*`) |
| Production routing change | YES (idempotency теперь реально reuse-ит существующую сессию)                               |
| Estimated effort          | 1-2 дня кода + тесты (внутри суммарного бюджета PR-4a Wave A)                                |
| Exit gate                 | Часть exit criteria PR-4a §7.A; отдельного human signoff на этот коммит не требуется         |

---

## 1. Problem statement

Реализация idempotency-guard, добавленная в PR `findActiveSubagentByLabel` (см. `src/agents/subagent-registry-queries.ts` lines 16-48 и `src/agents/subagent-spawn.ts` lines 430-460) ищет совпадение в `SubagentRunRegistry`. Каждый run закрывается с `endedAt` после завершения LLM turn-а. Persistent session при этом остаётся жива в gateway session store, но run считается завершённым.

В реальном TG-flow:

1. Пользователь: "Валера, слушай задачу 1" → `sessions_spawn(label='Валера')` → run1 создаётся, выполняется, закрывается (endedAt set).
2. Пользователь: "Валера, слушай задачу 2" → `sessions_spawn(label='Валера')` → guard ищет run где `endedAt === undefined` → не находит → второй spawn идёт в полный путь → попытка `sessions.patch label='Валера'` → `INVALID_REQUEST: label already in use`.

Логи подтверждают: ни одного `[commitment] reuse_by_label` за весь сеанс работы PR-3 cutover-1.

### 1.1. Current WIP audit result (2026-04-27)

В рабочем дереве уже есть незакоммиченная попытка idempotency через:

- `src/agents/subagent-registry-queries.ts` — `findActiveSubagentByLabelFromRuns(...)`;
- `src/agents/subagent-registry.ts` — wrapper `findActiveSubagentByLabel(...)`;
- `src/agents/subagent-spawn.ts` — early return `reuse_by_label`;
- `src/agents/subagent-registry-queries.test.ts` и `src/agents/subagent-spawn.idempotency.test.ts`.

Эта попытка полезна как regression sketch, но не является правильным фикс-путём для TG flow: она всё ещё считает "живость" через `endedAt` run-а. Финальная реализация должна заменить этот path на session-store lookup и тестировать сценарий, где run уже ended, но persistent session ещё существует.

## 2. Fix outline

Вместо runs-based query — session-store-based query. Source of truth для "жив ли persistent сабагент с label X в origin Y" — gateway session store, не run registry.

### 2.1. Design decision: Вариант A (без расширения SessionEntry)

Реальный `SessionEntry` (`src/config/sessions/types.ts`) НЕ содержит `spawnMode` / `deletedAt` / `createdAt`. Из доступного: `label?`, `deliveryContext?`, `origin?`, `subagentRole?: "orchestrator" | "leaf"`, `spawnedBy?`, `endedAt?`, `updatedAt: number`, `sessionId: string`.

Поэтому "live persistent session" детектируем через комбинацию:

1. **Shape ключа** — subagent-keys имеют форму `agent:<parent>:subagent:<uuid>`. Только их и фильтруем.
2. **Label match** — `entry.label === label.trim()`.
3. **Origin match** — `deliveryContextKey(entry.deliveryContext ?? entry.origin) === deliveryContextKey(requesterOrigin)`.
4. **Liveness = "запись физически в store"** — run-mode сабагенты удаляются через `sessions.delete` после cleanup; persistent остаются (их `endedAt` ставится, но запись не удаляется). Никакого `endedAt`-фильтра здесь НЕТ — это и был исходный bug.
5. **Tie-break при коллизии** — `latest by entry.updatedAt`.

Косвенность пункта 4 ("persistent" определяется через факт наличия в store) страхуется обязательным contract test'ом §3.2 (см. ниже): если кто-то в будущем изменит cleanup-logic и run-mode перестанут удаляться → тест падает и вынуждает пересмотреть guard.

Вариант B (явное поле `SessionEntry.spawnMode: "run" | "session"` + runtime patch на каждом spawn + миграция старых записей) сознательно отложен — см. §4.

### 2.2. Pseudocode (под реальный shape)

```ts
import type { SessionEntry } from "../config/sessions/types.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
import { deliveryContextKey } from "../utils/delivery-context.js";

const SUBAGENT_KEY_RE = /^agent:.+:subagent:[0-9a-f-]+$/i;

export function findLivePersistentSessionByLabel(
  store: ReadonlyMap<string, SessionEntry>,
  label: string,
  requesterOrigin: DeliveryContext | undefined,
): { key: string; entry: SessionEntry } | undefined {
  const trimmed = label.trim();
  if (!trimmed) return undefined;
  const targetOriginKey = deliveryContextKey(requesterOrigin);

  let best: { key: string; entry: SessionEntry } | undefined;
  for (const [key, entry] of store) {
    if (!SUBAGENT_KEY_RE.test(key)) continue;
    if (entry.label !== trimmed) continue;
    const entryOriginKey = deliveryContextKey(entry.deliveryContext ?? entry.origin);
    if (entryOriginKey !== targetOriginKey) continue;
    if (!best || entry.updatedAt > best.entry.updatedAt) {
      best = { key, entry };
    }
  }
  return best;
}
```

Замена в `spawnSubagentDirect`:

```diff
- const reused = findActiveSubagentByLabel(label, requesterOrigin);
+ const reused = findLivePersistentSessionByLabel(getGatewaySessionStore(), label, requesterOrigin);
```

Логи: `[commitment] effect=persistent_session.created action=reuse_by_session sessionKey=...`.

Implementation note: query — pure-function над уже загруженным `Map<string, SessionEntry>`, без I/O. Если read path в `spawnSubagentDirect` сейчас file-backed — добавить минимальный in-memory accessor `getGatewaySessionStore()` без расширения public API. Не добавлять I/O внутрь query-функции.

## 3. Tests (must-have)

### 3.1. Anti-pattern: чем существующие тесты НЕ являются доказательством фикса

`src/agents/subagent-spawn.idempotency.test.ts` сейчас построен так:

```ts
const findActiveSubagentByLabelSpy = vi.spyOn(subagentRegistry, 'findActiveSubagentByLabel');
// ...
findActiveSubagentByLabelSpy.mockReset().mockReturnValue(undefined);
// ...
findActiveSubagentByLabelSpy.mockReturnValue(existing);
```

Этот spy скрывает реальный путь определения "жив ли сабагент". Если `findActiveSubagentByLabel` снова начнёт смотреть `endedAt`, тесты останутся зелёными, потому что spy всегда возвращает заранее заданный результат. Поэтому:

1. Эти тесты не доказывают, что guard работает в TG flow.
2. Эти тесты не закрывают audit-gap G4.
3. Их **обязательно** нужно переписать в этой sub-plan, не в PR-4 как косметику.

### 3.2. Что вместо

1. **Unit `findLivePersistentSessionByLabel`** (без spy на саму функцию; реальная реализация поверх `Map<string, SessionEntry>`-fixture):
   - label match + origin match → returns `{ key, entry }`
   - label match + другой origin → undefined
   - label не subagent-key shape (например, main session с тем же label) → undefined
   - empty / whitespace label → undefined
   - две live persistent сессии с тем же label и origin → возвращает latest по `entry.updatedAt`
   - entry с `endedAt` set (run завершён, но persistent ещё в store) → возвращается (это и есть закрытие G3)

2. **Contract test: liveness invariant (страхует Вариант A)**:
   - **Сценарий**: spawn run-mode сабагента → run завершается → `sessions.delete` вызывается на cleanup → assert: запись отсутствует в `getGatewaySessionStore()`.
   - **Зачем обязателен**: Вариант A определяет "persistent" косвенно — через факт наличия в store. Если кто-то в будущем изменит cleanup-logic так, что run-mode тоже остаются в store, guard начнёт давать false positives и снова сломается. Этот тест — explicit gate против такой регрессии.
   - **Failure mode**: тест падает → нужно или восстановить cleanup-семантику, или ввести Вариант B (явный `SessionEntry.spawnMode`).

3. **E2E (current TG bug reproduction; closes G3+G4)**:
   - использовать реальный in-memory session store fixture, не spy
   - spawn(label='Валера', threadBinding=true) → first persistent session created, run created
   - **simulate run completion (endedAt set on session entry, run removed from runs registry)** — этот шаг ключевой: без него тест не воспроизводит реальный TG bug
   - spawn(label='Валера', threadBinding=true) → должен вернуть тот же childSessionKey, не fall through в полный spawn pipeline; **assert на отсутствие второго `subagent_spawning` hook fire**

4. **Negative** (fall-through path):
   - spawn(label='') → idempotency пропускается, fall through
   - spawn(label='Валера', threadBinding=false) → idempotency пропускается, fall through
   - spawn(label='Валера', mode='oneshot') → idempotency пропускается, fall through (run-mode сразу удалится после cleanup)
   - spawn(label='Валера') в origin A, потом spawn(label='Валера') в origin B → две разные сессии

## 4. Migration / deprecation

### 4.1. В commit 1 PR-4a (этот sub-plan)

`findActiveSubagentByLabelFromRuns` помечается `@deprecated`. Удаление — в следующем PR (PR-4 завершение или dedicated cleanup PR), не сейчас, чтобы не сломать тесты PR-1.5 / PR-2 / PR-3.

### 4.2. Deferred follow-up: Вариант B (`SessionEntry.spawnMode`)

**Решение (2026-04-27)**: явное поле `SessionEntry.spawnMode?: "run" | "session"` — НЕ в commit 1 PR-4a.

**Почему отложено**:

- Расширяет shape `SessionEntry` (frozen-ish layer, см. master §0.5 Five-Layer Freeze).
- Требует runtime patch при `registerSubagentRun` через `sessions.patch` на каждом spawn.
- Требует миграцию старых записей (или fallback handling).
- Расширяет surface commit 1 → ухудшает rollback-ability (а commit 1 — rollback unit для всего idempotency-фикса).
- НЕ закрывает G3/G4 — они закрываются Вариантом A полностью.

**Когда делать**: dedicated cleanup-PR ПОСЛЕ PR-4b. Trigger condition — любое из:

(a) contract test §3.2 начал падать (cleanup-семантика изменилась);
(b) появился второй потребитель "persistent vs run" различия за пределами `findLivePersistentSessionByLabel`;
(c) ревью PR-4b явно требует semantic-correct детектор.

До тех условий Вариант B = unnecessary surface expansion и не делается.

## 5. Exit criteria

**Этот sub-plan — commit 1 PR-4a, не standalone PR.** Поэтому Exit criteria формально проверяются как часть PR-4a §7.A. Локальные критерии для commit 1 (должны выполняться ДО переходов к commit 2 / commit 3):

1. CI green на этом коммите изолированно: `pnpm tsgo`, `pnpm vitest run` (idempotency tests), `pnpm run lint:commitment:*`.
2. Manual smoke на dev TG до commit 2: 3 подряд "Валера, …" → один сабагент, нет `label already in use` в логе, есть `[commitment] reuse_by_session` после первого spawn. Это критично, потому что без работающего idempotency commit 2 (routing flip) сразу же начнёт падать на `label already in use`.
3. **Audit gap closure**: после merge PR-4a master plan §0.5.3 обновлён строкой `closed by PR-4a <merge-SHA>` для G3 и G4 (одной строкой вместе с G1, G2, G5).
4. `subagent-spawn.idempotency.test.ts` не содержит `vi.spyOn(...)` на guard / `findLivePersistentSessionByLabel` (grep gate).
5. **Liveness invariant test green** (см. §3.2 пункт 2): contract test "run-mode entry deleted after cleanup → not in store" присутствует и проходит. Без него Вариант A считается недоказанным.
6. **`SessionEntry` shape не расширен**: grep по `src/config/sessions/types.ts` НЕ должен показать новых полей `spawnMode` / `deletedAt` в этом коммите. Если они нужны — это отдельный cleanup-PR (см. §4.2).
7. Human signoff на изменение idempotency-поведения — общий с PR-4a (invariant #15), отдельной signoff-точки на этот коммит нет.

## 6. Handoff Log

### 2026-04-27 — Audit before implementation

Completed TODO ids: none.

Touched files during audit: none by this audit step. Existing working tree already contains runs-based WIP in `src/agents/subagent-registry-queries.ts`, `src/agents/subagent-registry.ts`, `src/agents/subagent-spawn.ts`, `src/agents/subagent-registry-queries.test.ts`, and `src/agents/subagent-spawn.idempotency.test.ts`.

Tests/lints run: none.

Blockers:

- Current WIP implements active-run lookup and will still miss persistent sessions after `endedAt`.
- Need to locate authoritative gateway session store shape before writing `findLivePersistentSessionByLabel`.

Next recommended TODO id: `replace-runs-based-wip`, then `design-session-store-query`.

### 2026-04-27 (later) — Pseudocode aligned with real SessionEntry shape

Trigger: pre-implementation audit обнаружил, что псевдокод §2 ссылался на несуществующие поля `SessionEntry.spawnMode` / `deletedAt` / `createdAt`. Реальный `SessionEntry` (`src/config/sessions/types.ts`) содержит только `label?`, `deliveryContext?`, `origin?`, `subagentRole?`, `spawnedBy?`, `endedAt?`, `updatedAt`, `sessionId` (релевантные для guard).

Changes:

- §2 переписан под Вариант A (детектор по shape ключа `agent:*:subagent:<uuid>` + label + origin через `deliveryContextKey` + tie-break по `updatedAt`). Без расширения `SessionEntry`.
- §2.1 явно фиксирует design decision и почему Вариант B отложен.
- §3.2 пункт 2 — добавлен обязательный contract test "run-mode entry deleted after cleanup → not in store" как страховка для Варианта A (косвенный детектор liveness).
- §3.2 пункт 1 — убраны cases на несуществующие поля (`spawnMode=oneshot`, `deletedAt`); добавлен case "entry с endedAt set → возвращается" (это и есть закрытие G3).
- §4.2 — Вариант B (`SessionEntry.spawnMode`) явно отложен в cleanup-PR после PR-4b с trigger conditions.
- §5 Exit criteria — добавлены пункты 5 (liveness invariant test green) и 6 (`SessionEntry` shape не расширен).
- todo `design-session-store-query` — переформулирован под Вариант A.

Next recommended TODO id: `audit-current-guard` → `replace-runs-based-wip` → `implement-session-query`.

## 7. References

- Source of truth: `commitment_kernel_v1_master.plan.md` (cutover-1 surface, hard invariant #14, §0.5.3 правило idempotency-fix внутри PR-4a).
- **Final merge target**: PR-4a (`commitment_kernel_pr4_chat_effects_cutover.plan.md`), commit 1. См. там frontmatter todo `idempotency-fix-persistent-session` и body §4 [Wave A]. Standalone PR не выпускается (см. master §0.5.3).
- Текущая (broken) реализация: `src/agents/subagent-registry-queries.ts:16-48`, `src/agents/subagent-spawn.ts:430-460`.
