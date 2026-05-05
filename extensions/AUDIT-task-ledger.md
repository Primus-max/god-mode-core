# Slice F — TaskLedger Phase 1 Audit (READ-ONLY)

Branch: `audit/v1-slice-f-task-ledger-phase-1`
Base SHA: `dev` HEAD at audit time = `c644a9b794` (PR #180 — slice F sub-plan kickoff).
Maintainer signoff: blanket maintainer signoff for v1 commitment-kernel slices granted 2026-05-05 by Vladimir; read-only audit phases always cleared.

This document VERIFIES the §2 audit sketch in
`.cursor/plans/commitment_kernel_task_ledger.plan.md` against live source on
`dev`. No code was executed. No source under `src/` was modified. Findings are
line-anchored to current `dev` HEAD.

Hard invariants kept by Phase 1: #5 (no text matching on `UserPrompt`), #6
(`IntentContractor` sole reader of raw user text), #8 (`src/platform/commitment/`
does not import from `src/platform/decision/`), #11 (5 frozen contracts read-only),
#15 (signoff required for code-touching phases — Phase 1 is read-only).

---

## §2.1 — Existing «task»-shaped surfaces

The repo carries SEVEN distinct surfaces that use the word "task" non-trivially.
Each is classified below; only one is consumed by slice F (read-only), and ZERO
are touched (write).

### Frozen / off-limits — slice F neither reads nor writes

| File | Lines | Symbol | Status |
| --- | --- | --- | --- |
| `src/platform/decision/task-classifier.ts` | 507–518 | `TaskContract` | **Frozen contract #11**. Decision-layer planner-input shape: `{ primaryOutcome, requiredCapabilities, interactionMode, confidence, ambiguities, deliverable?, executionMode?, target?, schedule?, evidence? }`. Slice F does NOT import this type or this file. The new `TaskRecord` (Phase 2) is a sibling concept in `src/platform/task/`, syntactically distinct. |
| `src/platform/decision/task-classifier.ts` | 533–539 | `ClassifiedTaskResolution` | Frozen — wraps `TaskContract` + `RecipePlannerInput` + `ResolutionContract`. Not consumed by slice F. |
| `src/platform/decision/contracts.ts` | 9–17, 49–74 | `PlatformExecutionContextIntentSchema`, `PlatformExecutionContextSnapshotSchema` (carries optional `taskOverlayId`) | Decision-layer profile/recipe context. NOT one of the 5 frozen contracts but lives in the same module; slice F does NOT touch. |
| `src/platform/decision/input.ts` | line 40 | re-exports `TaskContract` | Decision-layer barrel. Not consumed. |

### Related but distinct (coexists; slice F neither reads nor writes)

| File | Lines | Concept | Distinction from `TaskRecord` |
| --- | --- | --- | --- |
| `src/plugin-sdk/llm-task.ts` | 1–13 | `definePluginEntry` re-export for the bundled `extensions/llm-task` plugin | Plugin-SDK barrel for "single-shot LLM call" plugin. The word "task" here means "LLM round-trip", NOT "operator-facing persistent task". Coexists; no symbol name collision (the plugin barrel exports `definePluginEntry`, not a `Task*` type). |
| `src/daemon/schtasks.ts`, `src/daemon/schtasks-exec.ts`, `src/daemon/schtasks.install.test.ts`, `src/daemon/schtasks.startup-fallback.test.ts`, `src/daemon/schtasks.stop.test.ts`, `src/daemon/schtasks.test.ts` | n/a | Windows `schtasks.exe` Scheduled Tasks integration for gateway autostart | OS-layer surface. `TaskRecord` is a runtime per-`IdentityId` ledger entry, not a Windows scheduled job. Different layer — no shared types. |
| `src/infra/windows-task-restart.ts`, `src/infra/windows-task-restart.test.ts` | 1–15 | Gateway restart helper for Windows scheduled tasks | OS-layer; uses `resolveGatewayWindowsTaskName(...)` for the `schtasks.exe` task name. Different layer. |
| `src/platform/session/intent-ledger.ts` | 22–60 | `INTENT_LEDGER_TTL_MS`, `INTENT_LEDGER_MAX_ENTRIES`, `IntentLedgerKind = "awaiting_confirmation" \| "awaiting_input" \| "promised_action" \| ...`, `RECENT_INTENT_HISTORY_WINDOW = 5`, `RECENT_INTENT_CONFIDENCE_FLOOR = 0.5` | **Per-`SessionId` sibling pattern.** Slice F's `TaskLedger` is the cross-`/new` analog keyed by `IdentityId`. The `IntentLedger` does NOT key on `IdentityId` and does NOT survive `/new` (15-minute TTL, 8-entry cap, in-memory). Coexists; slice F does NOT touch. |
| `src/agents/tools/cron-tool.ts` | 17–30 | `REMINDER_CONTEXT_*` constants — cron tool wraps the gateway cron API | Cron entries live in their own surface (slice J). A cron-fired turn MAY produce a `TaskRecord` via the Phase-5 hook, but the cron tool itself does NOT emit `task.*` attestations today. |

### Consumed by slice F (read-only or as bridge)

| File | Role for slice F |
| --- | --- |
| `src/platform/identity/identity-id.ts` | `IdentityId` brand — ledger primary key (Phase 2 onwards). Slice F imports `IdentityId` type only. |
| `src/platform/identity/resolve-identity.ts` (lines 102–111) | `resolveIdentityFromSessionKey(sessionKey, registry) → IdentityId \| undefined` — used at the gateway-wiring seam (`src/platform/decision/memory-wiring.ts`) so Phase 5 can read the resolved identity. |
| `src/platform/memory/episodic-memory-event.ts` | Slice F EXTENDS this discriminated union with `task.*` slots (see §2.6 below — slots do NOT exist today). |
| `src/platform/memory/memory-store.ts` | `MemoryStore.storeEpisodic` invoked from the Phase 5 hook to cross-reference episodic events with `TaskRecord` rows. |
| `src/agents/pi-embedded-runner/run/memory-write-on-satisfied.ts` | Pattern + sibling location for Phase 5's NEW `task-write-on-satisfied.ts` (no edits to this file). |
| `src/platform/commitment/intent-contractor-impl.ts` | Pattern + insertion site for Phase 6's `<active_tasks>` block (additive constructor dep — additive change to this file is sanctioned per slice E precedent PR-#168). |

### Plugin / agent emitters of `task.*` effect family

**ZERO emit sites today.** Grep across `src/`, `extensions/**`, and the plugin
SDK for the strings `task.created`, `task.completed`, `task.cancelled`,
`task.failed`, and `effectFamily.*task` returns NO matches. The slice F Phase
5 hook will be the FIRST writer of `task.*` events — no allowlist filter is
needed in the hook for unintended side effects from prior emitters; the slice
introduces the surface AND its sole emit site simultaneously.

This is good news: there is no pre-existing `task.*` emitter to inadvertently
trigger ledger writes when the hook lights up.

---

## §2.2 — `task.*` effect family in the commitment runtime

### Does the current `EffectFamilyId` registry enumerate `task.*`?

**NO.** `src/platform/commitment/effect-family-registry.ts:23–48` enumerates
EXACTLY four effect families:

```ts
EFFECT_FAMILY_REGISTRY = [
  { id: "persistent_session", allowedOperationKinds: ["create", "observe", "cancel"] },
  { id: "communication",       allowedOperationKinds: ["create", "observe"] },
  { id: "web_research",        allowedOperationKinds: ["create"], branchingHints: [...] },
  { id: "unknown",             allowedOperationKinds: [] },
];
```

There is NO `"task"` entry. The closed PR-2 registry rejects unknown families
via `resolveEffectFamilyId(...)` (`effect-family-registry.ts:71–73`) — any
LLM-emitted `desiredEffectFamily: "task"` today is silently coerced to
`UNKNOWN_EFFECT_FAMILY` by `normalizeSemanticIntent(...)`
(`intent-contractor-impl.ts:592–615`).

**Implication for slice F**: the Phase 5 hook does NOT need to gate on a
`SemanticIntent.desiredEffectFamily === "task"` test. The hook fires when an
EXECUTION-LAYER attestation carries a `task.*` family — which today no code
path produces. Slice F's emit sites (Phase 5 + later cron / subagent slices J
/ G) construct the `task.*` family value at the attestation construction
site, not via the `EFFECT_FAMILY_REGISTRY` const list. The registry's role is
to constrain `IntentContractor` LLM output (a closed set the user-text reader
is allowed to pick from); it does not constrain the runtime attestation surface.

If at some future point we want `IntentContractor` to OUTPUT
`desiredEffectFamily: "task"` directly (e.g. user says «создай задачу X»),
that would require adding `"task"` to `EFFECT_FAMILY_REGISTRY` — that file
sits inside the frozen layer (`src/platform/commitment/`), so it would
require master-plan amendment + signoff. **This slice does NOT add such
an entry.** The user-text path for «создай задачу X» can ride the existing
`persistent_session` family (a task is a persistent artifact) plus a
`constraints.taskRef` hint — see §2.4.

### Does `RuntimeAttestation` carry enough structured signal for the Phase 5 hook?

**Partially.** `src/platform/commitment/monitored-runtime.ts:21–28` defines:

```ts
export type RuntimeAttestation = {
  readonly terminalState: RuntimeTerminalState;          // "action_completed" | "rejected" | "unsupported"
  readonly acceptanceReason: RuntimeAcceptanceReason;
  readonly commitmentSatisfied: boolean;
  readonly stateBefore: WorldStateSnapshot;
  readonly stateAfter: WorldStateSnapshot;
  readonly satisfaction: SatisfactionResult;
};
```

The attestation does NOT directly carry `effectFamily` or `effectId` fields.
However, the attestation is FIRED by `runShadowBranch(...)`
(`src/platform/decision/run-turn-decision.ts:441–453`) which has full access
to the upstream `commitment` (`ExecutionCommitment` carries `effect: EffectId`
and `effectFamily: EffectFamilyId`). The Phase 5 hook integration is therefore
THIS pattern (already established by slice E):

- Slice E memory hook (`memory-write-on-satisfied.ts:108–114`, also see
  `memory-wiring.ts:78–122`) gets the `attestation` AND the **caller-side
  context** (the prompt text, identity, message id) at the wiring site
  — it does NOT need the effect family on the attestation itself, because
  the wiring layer holds it.

- Slice F's Phase 5 hook will follow the SAME pattern: the wiring site
  (sibling of `memory-wiring.ts`) holds the `effectFamily` + `effectId` +
  `taskRef` context (constructed at the call site — e.g. cron tool /
  subagent spawn / explicit task tool) and forwards it to
  `recordTaskOnCommitmentSatisfied({ attestation, taskLedger, identityId,
  taskInput, ... })`. The attestation's `commitmentSatisfied` boolean is the
  ONLY thing the hook reads off the attestation surface; the rest is supplied
  by the wiring site, mirroring `EpisodicEventInput` from slice E.

The structural-typing precedent from
`memory-write-on-satisfied.ts:59–63`:

```ts
export type CommitmentSatisfiedAttestationLike = {
  readonly commitmentSatisfied: boolean;
  readonly terminalState: string;
  readonly acceptanceReason: string;
};
```

is the EXACT same surface slice F's `task-write-on-satisfied.ts` will reuse —
no new dependency on `src/platform/commitment/` runtime values is introduced.

### Slice E `EpisodicMemoryEvent` `task.*` slot status

**CRITICAL FINDING — corrected against the sub-plan claim.**

`src/platform/memory/episodic-memory-event.ts:20–24` defines:

```ts
export type EpisodicEffectFamily =
  | "persistent_session"
  | "subagent"
  | "reminder"
  | "artifact";
```

**There is NO `"task"` member of this discriminated union today.** The slice F
sub-plan §2.2 line 71 says «slice E PR-#169 typed-but-inert `EpisodicMemoryEvent`
slots include `subagent.created` / `reminder.set` / `artifact.created`. Confirm
whether `task.created` / `task.completed` / `task.cancelled` slots already
exist in the discriminated union or need to be added in Phase 2.»

**Resolution: the `task.*` slots DO NOT exist in the discriminated union.
Slice F MUST add them in Phase 2.** This is a discriminated-union extension
(additive — new members, no breaking change to existing consumers; the
exhaustiveness compile-check via `assertNeverEpisodic` (line 227) will force
every reader to update — which is the desired behaviour). The corresponding
schema (`EpisodicMemoryEventSchema`, lines 190–216) and switch cases in
consumers (`memory-write-on-satisfied.ts:195–245`) must be extended in lock-step.

Required Phase 2 surface additions:

```ts
// episodic-memory-event.ts
export type EpisodicEffectFamily =
  | "persistent_session" | "subagent" | "reminder" | "artifact"
  | "task";  // NEW (slice F)

export type TaskCreatedPayload = {
  readonly taskId: string;          // mirrors the new TaskId brand value
  readonly label: string;
  readonly status: "open" | "in_progress" | "completed" | "cancelled" | "failed";
  readonly occurredAt: string;
};

// (similarly TaskCompletedPayload, TaskCancelledPayload — single
// discriminator slot OK if all three reuse one event with `status` field)

// EpisodicMemoryEvent gains:
//   | { identityId; effectFamily: "task"; effectId; payload: TaskCreatedPayload }
```

Note that `subagent`, `reminder`, `artifact` slots ARE typed-but-inert per
slice E PR-#169. The sub-plan misstated the family list — this audit finding
RESOLVES the misstatement: only those THREE slots are pre-typed; `task` is
NOT and slice F adds it.

This finding does NOT change the slice scope; it only adjusts Phase 2 to
include the discriminated-union extension as part of its surface (alongside
`TaskId`, `TaskRecord`, `TaskLedger`). The `assertNeverEpisodic` mechanism
guarantees the compile-time guardrails fire if any reader fails to handle the
new variant.

---

## §2.3 — `<active_tasks>` block / contractor recall site

The `<memory>` block injection pattern is implemented at
`src/platform/commitment/intent-contractor-impl.ts:191–302`. Salient anchors:

- **Constructor opt-in** (lines 191–227): `createIntentContractor(...)` accepts
  optional `memoryStore?`, `identityId?`, `logger?`, `memoryRecallLimit?` deps.
  Omitting any disables recall cleanly. Byte-identical pre-Phase-6 behaviour
  is REQUIRED of pre-Phase-6 callers — guarded by regression test
  (`intent-contractor-impl.memory-recall.test.ts`).

- **Recall call** (lines 257–263): `await maybeRecallMemory({ memoryStore,
  identityId, prompt, limit, logger })`. Returns
  `{ block: string | null, failed: boolean }`. Block is prepended to the
  adapter prompt (line 264).

- **Block format** (lines 357–367): `<memory>{JSON}</memory>` static
  literal wrapper, structured payload — invariant #5 safe (no raw user text
  in block contents; only the recalled entries' structured payload).

- **Failure path** (lines 320–349): `try/catch`; on error, log `warn` and
  return `{ block: null, failed: true }`. NEVER throws into the contractor
  flow. The `failed: true` flag drives the
  `MEMORY_RECALL_FAILED_UNCERTAINTY = "memory_recall_failed"` tag append at
  line 375–382.

- **Empty result** (lines 337–340): empty list returns `{ block: null,
  failed: false }` — NO `<memory>` block is emitted (zero whitespace
  pollution).

**Reusability assessment for `<active_tasks>` block: VERBATIM.** The Phase 6
implementation is a near-clone of `maybeRecallMemory(...)`:

- Same constructor opt-in pattern: add `taskLedger?: TaskLedger` and reuse
  the existing `identityId?` from slice E PR-#168.
- Same prepend-on-non-empty pattern: `${tasksBlock}${recall.block ?? ""}${prompt}`
  — order between `<active_tasks>` and `<memory>` is implementation choice
  (sub-plan §6 implementation notes give no preference; Phase 6 picks one and
  documents it).
- Same uncertainty tag pattern: `TASK_RECALL_FAILED_UNCERTAINTY = "task_recall_failed"`.
- Same empty-list returns no block (no whitespace pollution).
- Same anonymous-session short-circuit: `taskLedger || identityId` undefined
  → no recall attempted.

**No complications discovered.** The contractor's existing two-block layout
(`<web_evidence>` + `<memory>`) extends naturally to a third block. Block
ordering convention from slice E places memory immediately before the prompt;
Phase 6 should place `<active_tasks>` adjacent to `<memory>` (both are
identity-keyed, both are consumed by the LLM together for cross-`/new`
recall).

---

## §2.4 — CRITICAL: `TargetRef` extension yes/no?

### `TargetRef` shape today

`src/platform/commitment/semantic-intent.ts:8–13`:

```ts
export type TargetRef =
  | { readonly kind: "session"; readonly sessionId?: SessionId }
  | { readonly kind: "artifact"; readonly artifactId?: string }
  | { readonly kind: "workspace" }
  | { readonly kind: "external_channel"; readonly channelId?: ChannelId }
  | { readonly kind: "unspecified" };
```

The matching Zod schema in `intent-contractor-impl.ts:100–106` uses
`z.discriminatedUnion("kind", [...])` with `.strict()` on each arm —
**adding a new `kind` literal here is a STRICT, breaking change to the
LLM-output schema**. Adding `"task"` would require:

1. Editing `src/platform/commitment/semantic-intent.ts` — frozen-layer file.
2. Editing the matching Zod schema (`intent-contractor-impl.ts:100`) — same
   frozen module.
3. Updating `IntentContractor` LLM prompt examples (lines 638–676) to teach
   the model when to pick `kind: "task"`.
4. Updating eval golden set
   (`src/platform/decision/eval/golden-set.json`) for Phase 6 regression.

Per invariant #11 + the frozen-layer label policy + AGENTS.md "Frozen layer
collision → BLOCKED", any source change inside `src/platform/commitment/`
requires explicit master-plan amendment + maintainer signoff.

### `SemanticIntent.constraints` shape

`semantic-intent.ts:22–29`:

```ts
export type SemanticIntent = {
  readonly desiredEffectFamily: EffectFamilyId;
  readonly target: TargetRef;
  readonly operation?: OperationHint;
  readonly constraints: ReadonlyRecord<string, unknown>;  // ← OPEN TYPED RECORD
  readonly uncertainty: readonly string[];
  readonly confidence: number;
};
```

`constraints` is a `ReadonlyRecord<string, unknown>` (open record) — and the
matching Zod schema (`intent-contractor-impl.ts:121`) uses
`z.record(z.string(), z.unknown()).default({})` with NO `.strict()`. This
means an LLM-emitted `constraints: { taskRef: "task:abc123" }` field
**already passes through the contractor today** without any schema change —
verified at `intent-contractor-impl.ts:116–125`.

### Recommendation: **NO `TargetRef` extension required.**

**Slice F ships WITHOUT extending `TargetRef`.** The orchestrator-level UX
«отмени PDF» / «как там?» is fully serveable via:

1. **`<active_tasks>` block** (Phase 6) — surfaces the identity's open
   tasks to the LLM with `id` + `label` + `status`, so the LLM has structured
   context to disambiguate «отмени PDF» against «task:abc123 — Generate
   Q3 PDF report».
2. **`constraints.taskRef`** (free-form field, already accepted by the
   open-record schema) — when the LLM resolves «отмени PDF» to «task:abc123»,
   it emits:
   ```json
   {
     "desiredEffectFamily": "persistent_session",
     "target": { "kind": "unspecified" },
     "operation": { "kind": "cancel" },
     "constraints": { "taskRef": "task:abc123" },
     "uncertainty": [],
     "confidence": 0.85
   }
   ```
3. The Phase 5 hook (or a future slice J resolver) reads `constraints.taskRef`
   and dispatches `taskLedger.cancel(taskId)`.

### Evidence supporting NO extension

- **`constraints` is already typed open** — no schema change needed; the LLM
  simply emits the field.
- **`TargetRef.kind: "unspecified"`** is a valid escape hatch (line 13) —
  used when the operation operates on a ledger entry rather than a
  session/artifact/channel.
- **`OperationHint.kind: "cancel"`** already supports `cancelOf?: TargetRef`
  (lines 17–18) — but `cancelOf` carries a `TargetRef`, NOT a free-form
  task id. A cleaner separation: `operation.kind: "cancel"` + `target.kind:
  "unspecified"` + `constraints.taskRef: "task:..."`. The `cancelOf` field
  remains reserved for the future case of cancelling a session or artifact
  by reference (still not strictly needed today, since the ledger handles
  this in its own surface).
- **No precedent for first-class kind on `TargetRef` in slice E** — slice E's
  memory-recall hook surfaces past entries via the `<memory>` block; it does
  NOT extend `TargetRef` to add a `kind: "memory"`. Slice F follows the
  same boundary: identity-keyed cross-session recall is a contractor-prompt
  feature, NOT a `TargetRef` widening.
- **Frozen-layer touch is expensive** — every `TargetRef` widening cascades
  to (a) Zod schema in `intent-contractor-impl.ts`, (b) LLM prompt examples,
  (c) eval golden set, (d) every consumer that switches on `target.kind`
  exhaustively. Avoiding the widening keeps the slice scope local to
  `src/platform/task/` plus Phase 5/6 additive seams.

### When the extension WOULD be required

Only if a downstream consumer needs to PATTERN-MATCH on `target.kind === "task"`
to drive routing or affordance selection in a typed way (e.g. an
"affordance:task.cancel" requires `target.kind === "task"` to dispatch).
Slice F does NOT introduce such an affordance. If a future slice (e.g. slice
G subagent registry) needs first-class `kind: "task"` for affordance
selection, it can propose the master-plan amendment then. Slice F does NOT
pre-emptively widen.

**Final recommendation, evidence-backed: slice F ships WITHOUT extending
`TargetRef`. LLM resolves task references via `<active_tasks>` block
(Phase 6) + free-form `constraints.taskRef` (already accepted today).**

---

## §2.5 — Identity surface

`src/platform/identity/resolve-identity.ts:102–111`:

```ts
export function resolveIdentityFromSessionKey(
  sessionKey: string | null | undefined,
  registry: IdentityRegistry,
): IdentityId | undefined {
  const extracted = extractChannelAndPeerFromSessionKey(sessionKey);
  if (!extracted) return undefined;
  return registry.resolve(extracted.channel, extracted.peerId);
}
```

**Confirmed — this is the SOLE entrypoint to a resolved `IdentityId`.** The
function:

- Never throws on miss — `undefined` is the normal "anonymous session" signal
  (lines 98–101).
- Filters wrapped scopes (`subagent`, `cron`, `acp`) at line 22's
  `NON_IDENTITY_SCOPE_MARKERS` — those keys do NOT have a stable
  `(channel, peerId)` identity, so cross-channel identity resolution returns
  `undefined`. Cron-fired tasks therefore CANNOT write to `TaskLedger` keyed
  on the parent operator's identity via the session-key path; cron / subagent
  slices (J / G) need their own context-injection path.

Slice F uses this function as-is (Phase 5 wiring already invokes it via
`memory-wiring.ts:66`). No new identity-resolution code in this slice.

`src/platform/identity/identity-id.ts` defines `IdentityId` as a branded
string of form `identity:<slug>` validated by `asIdentityId(...)` —
slice F's `TaskRecord.ownerIdentityId: IdentityId` consumes this brand.

---

## §2.6 — Slice E memory store + episodic events cross-reference

### Phase 5 hook can call BOTH ledger AND episodic memory: CONFIRMED.

The slice E hook
(`src/agents/pi-embedded-runner/run/memory-write-on-satisfied.ts:167–246`)
demonstrates the pattern:

- Async function takes `MemoryStore | undefined` + `EpisodicEventInput |
  undefined` + `IdentityId | undefined`.
- On success, calls `await memoryStore.storeEpisodic(...)` (line 198) and
  returns `{ kind: "written", entryId }` (line 209).
- On failure, logs warn (line 213) and returns `{ kind: "failed", error }`
  (line 221) — never throws.

Slice F's Phase 5 hook (`task-write-on-satisfied.ts`) will be a STRUCTURAL
sibling at the SAME location:

```ts
// HYPOTHETICAL Phase 5 surface
export async function recordTaskOnCommitmentSatisfied(deps: {
  readonly attestation: CommitmentSatisfiedAttestationLike;
  readonly identityId: IdentityId | undefined;
  readonly taskLedger: TaskLedger | undefined;
  readonly memoryStore: MemoryStore | undefined;        // for cross-reference
  readonly taskInput: TaskWriteInput | undefined;       // discriminator on op kind
  readonly logger: { warn(...); debug(...) };
}): Promise<TaskWriteOutcome>;
```

The hook's success path performs TWO writes, cross-referenced via
the new `TaskId`:

1. `await taskLedger.create(...)` (or `complete` / `cancel` based on
   `taskInput.kind`) — returns `TaskId`.
2. `await memoryStore.storeEpisodic({ effectFamily: "task", effectId: taskInput.taskId, payload: { taskId, label, status, occurredAt } })` —
   writes the episodic cross-reference event.

If EITHER write fails: log warn, return outcome `{ kind: "failed_partial",
ledgerWritten: bool, episodicWritten: bool }`. **The commitment STILL
satisfies** (invariant #15 — cross-reference is observability, not gating).
This matches sub-plan §6 line 148.

The wiring point is the same one slice E uses: a sibling helper to
`memory-wiring.ts` that produces the `onAttestation` callback consumed by
`runShadowBranch` (see §5 below). Both writes are cross-referenced on
`(identityId, taskId)` — joinable downstream by slice K (reconciler) and the
B7 acceptance test.

**Caveat — see §2.2.** The episodic side requires the `task` slot in
`EpisodicEffectFamily` (currently absent — Phase 2 adds it).

---

## §5 — Phase 5 wiring site

The EXISTING construction site for the slice E memory hook's `onAttestation`
callback is `src/platform/decision/memory-wiring.ts` (lines 51–124). This
helper is invoked per-turn upstream of `runTurnDecision(...)`. It returns
a partial input object with these fields:

```ts
export type MemoryWiringForTurn = Partial<{
  memoryStore: MemoryStore;
  identityId: IdentityId;
  memoryLogger: IntentContractorLogger;
  onAttestation: (attestation: RuntimeAttestation) => Promise<void>;
}>;
```

`onAttestation` is the SOLE callback chain — `runShadowBranch(...)` at
`run-turn-decision.ts:294` invokes it once per turn, after the cutover gate
attestation is computed:

```ts
// run-turn-decision.ts:294-304
if (input.onAttestation && cutover.attestation) {
  try {
    await input.onAttestation(cutover.attestation);
  } catch (error) {
    defaultRuntime.log(`[memory-hook] onAttestation callback failed: ${...}`);
  }
}
```

Confirmed: slice F's `task-write-on-satisfied.ts` plugs into the SAME
callback chain via two strategies:

### Strategy A (preferred for v1 surface stability) — chain inside `memory-wiring.ts`

Extend the existing `resolveMemoryWiringForTurn(...)` to additionally invoke
`recordTaskOnCommitmentSatisfied(...)` inside the SAME `onAttestation`
arrow (after `recordMemoryOnCommitmentSatisfied`). The callback becomes a
fan-out point for ALL identity-keyed observability hooks, ordered:
memory-episodic → task-ledger+task-episodic. Both writes use the same
attestation; their failures are independently logged via
`defaultRuntime.log`. This is the smallest possible change (one file:
`memory-wiring.ts`) and preserves the single-callback discipline at the
`run-turn-decision.ts` seam.

Risk: slice F now touches `src/platform/decision/memory-wiring.ts`. This is
NOT a frozen file (`src/platform/decision/` is the decision layer, not the
commitment layer; it does not import from `src/platform/commitment/`).
Touching it is sanctioned by the «slice E gateway-wiring bridge» precedent.

### Strategy B — sibling wiring file `src/platform/decision/task-wiring.ts`

Sibling helper that produces an `onAttestation` for the task hook only.
The caller (`pi-embedded-runner` orchestration, where `runTurnDecision` is
called from) composes the two callbacks: `chain([memWiring.onAttestation,
taskWiring.onAttestation])`. Cleaner separation but requires a small
chaining utility AND requires updating the call site in `pi-embedded-runner`.

**Recommendation: Strategy A.** Extend `memory-wiring.ts` in Phase 5; this
matches the existing layering and avoids duplicating the
`runtime`/`identityId` resolution. Consider extracting a shared resolver
helper (the `getMemoryRuntime + resolveIdentityFromSessionKey` prelude) only
if slice G/J wiring shows the same prelude appearing a third time.

The existing seam (`run-turn-decision.ts:112` `onAttestation` field; `run-turn-decision.ts:294`
invocation) is **untouched** by slice F — confirming the hook plugs into the
SAME callback chain.

---

## §8 — Existing `task.*` emitters — flagged for allowlist filter

**ZERO existing `task.*` emitters discovered** (see §2.1 last sub-section).

Greps performed (across `src/`, `extensions/`, `extensions/*/openclaw.plugin.json`):
- `task\.created|task\.completed|task\.cancelled|task\.failed`
- `effectFamily.*task`
- `task\.\*`
- `EffectFamilyId.*task`

All return zero matches. **Conclusion: no allowlist filter needed in the
Phase 5 hook for unintended pre-existing emitters.** The slice F Phase 5
hook is the FIRST writer of `task.*` events; the universe of triggers it
sees is exactly the universe slice F creates.

If/when slices G (subagent registry) or J (cron) emit task-shaped events,
the hook's defense-in-depth posture (skip on missing `taskInput`, skip on
non-task family, return typed outcome on failure) handles them cleanly
without needing an allowlist.

---

## Summary

| Audit question | Resolution |
| --- | --- |
| §2.1 task surfaces | 7 surfaces enumerated; 4 frozen/distinct, 3 reused (memory, identity, contractor pattern). Zero name collisions with the new `TaskRecord` / `TaskLedger`. |
| §2.2 `task.*` effect family in registry | NOT enumerated in `EFFECT_FAMILY_REGISTRY` today. Slice F does NOT add it (the registry constrains LLM output, not runtime attestation construction). |
| §2.2 `RuntimeAttestation` payload | Does NOT directly carry `effectFamily` / `effectId`. Slice F follows slice E pattern: wiring layer holds the family/id and supplies it as a `TaskWriteInput` alongside the attestation. |
| §2.2 `EpisodicMemoryEvent` `task.*` slot | **DOES NOT EXIST today** (sub-plan misstated — only `subagent`, `reminder`, `artifact` are typed-but-inert). Slice F Phase 2 ADDS the `task` member of `EpisodicEffectFamily` plus `TaskCreatedPayload` / `TaskCompletedPayload` / `TaskCancelledPayload`. |
| §2.3 `<active_tasks>` block reusability | VERBATIM — same pattern as slice E `<memory>` block. No complications. |
| §2.4 `TargetRef` extension required? | **NO.** Recommendation: ship slice F WITHOUT extending `TargetRef`. The LLM resolves task references via `<active_tasks>` block + free-form `constraints.taskRef` (already accepted today by the open-record Zod schema). |
| §2.5 Identity surface | `resolveIdentityFromSessionKey` is SOLE entrypoint. Slice F uses as-is. |
| §2.6 Cross-reference (ledger + episodic) | Confirmed — the Phase 5 hook performs TWO writes (ledger.create + memoryStore.storeEpisodic) cross-referenced on `(identityId, taskId)`. Failure of either is observability-only (invariant #15). |
| §5 Wiring site | `onAttestation` callback chain in `runShadowBranch` is the seam. Recommended: extend `src/platform/decision/memory-wiring.ts` to fan out to BOTH memory + task hooks (Strategy A). |
| §8 Pre-existing `task.*` emitters | NONE. No allowlist filter needed. |

Phase 1 deliverable complete. Phase 2 (TaskLedger interface + types + the
`EpisodicEffectFamily` `task` extension) is unblocked.
