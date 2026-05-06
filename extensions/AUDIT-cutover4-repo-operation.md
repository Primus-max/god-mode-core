# AUDIT — Cutover-4 Repo Operation (Phase 1, read-only)

**Sub-plan**: `.cursor/plans/commitment_kernel_cutover4_repo_operation.plan.md`
**Slice id**: `cutover-4-repo-operation`
**Audit branch**: `audit/v1-cutover4-phase-1`
**Predecessor SHA**: `9fa2939678` (`origin/dev` HEAD; post PR-#236 — slice-outbound-coalescer Phase 6 / NEW-C SLICE COMPLETE; all 4 post-v1 slices closed). Spec stated `dec877fc72` but that SHA is not on `origin/dev`; HEAD `9fa2939678` is the same logical landing point ("post NEW-C SLICE COMPLETE").
**Maintainer signoff**: GRANTED via blanket authorization 2026-05-05.
**Frozen-layer touches in this audit**: NONE (read-only markdown deliverable).

This document maps the source-of-truth state of every surface cutover-4 will modify and confirms each precondition stated in the spec. Every finding is line-anchored against `dev` HEAD `9fa2939678`.

Cutover-4 routes `repo_operation.completed`-family effects (branch / commit / merge / diff) through the commitment-kernel `AffordanceRegistry`, mirroring Cutover-3 Artifacts (PRs #193-#197). Closure of the v1 cutover sequence (cutover-1 → cutover-2 → cutover-3 → cutover-4). Hard dependency on PolicyGate Full (landed in this session, see §g).

---

## §a. Direct git invocations — site-by-site classification

A repo-wide grep `execFile.*['\"]git['\"]|spawn.*['\"]git['\"]|exec\(\s*['\"]git` (rg) plus `'git'`/`"git"` literal scan against `src/**` returns exactly **three** production code locations and **two** test-only locations. No user-facing `git` / `exec_shell` tool wrapper exists under `src/agents/tools/`.

### a.1 `src/platform/session/workspace-probe.ts:103,109` — orchestrator-internal probe — **GRANDFATHERED**

```ts
// src/platform/session/workspace-probe.ts:101-127  (resolveGitInfo)
const remote = await execFileAsync("git", ["remote", "get-url", "origin"], {
  cwd: rootPath,
  timeout: GIT_TIMEOUT_MS,            // 1_000ms — line 10
  windowsHide: true,
  encoding: "utf8",
});
const branch = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
  cwd: rootPath,
  timeout: GIT_TIMEOUT_MS,
  windowsHide: true,
  encoding: "utf8",
});
```

- **Caller**: `probeWorkspace(...)` at `src/platform/session/workspace-probe.ts:167-227`. Internal: collects `<workspace>` projection metadata for the system prompt.
- **Predates kernel**: yes; `WorkspaceWorldState` slice exists as the empty stub `Record<string, never>` (see §c) precisely because this probe ran before the kernel was introduced.
- **User-driven semantics**: NONE. This call is pure read-only metadata for prompt projection; never writes the repo, never reaches an effect.
- **Classification**: **GRANDFATHERED**. Listed verbatim on the lint-rule allowlist (§h).

### a.2 `src/infra/update-runner.ts:147,163,206,470,501,522-523,538,563,570,591,630,655,709,714,734,738,763,792,948,…` — orchestrator self-update — **GRANDFATHERED**

`runCommand([...["git", "-C", root, …], …)` invocations spread across `update-runner.ts` (40 literal `"git"` mentions per `rg -c '"git"'`, of which 26 are the binary in argv slot 0, the rest are the `mode: "git"` string discriminator on the result envelope at lines 44, 482, 511, 553, 579, 599, 615, 639, 724, 753, 769, 782, 819, 835, 851, 876, 913, 936, 955).

Representative argv-0 sites: 147 (`rev-parse --abbrev-ref HEAD`), 163 (`tag --list`), 206 (`rev-parse --show-toplevel`), 470 (`rev-parse HEAD`), 501 (`status --porcelain`), 522-528 (`checkout dev`), 538-546 (`rev-parse --abbrev-ref --symbolic-full-name @{upstream}`), 563 (`fetch --all --prune --tags`), 570-572 (`rev-parse @{upstream}`), 591 (`rev-list --max-count=N upstream`), 630-631 (`worktree add --detach`), 655 (`checkout --detach <sha>`), 709-710 (`worktree remove --force`), 714 (`worktree prune`), 734 (`rebase <sha>`), 738 (`rebase --abort`), 763 (`fetch …`), 791-797 (`checkout --detach <tag>`), 948 (`rev-parse HEAD`).

- **Caller**: `runUpdate(...)` (the openclaw self-updater). Wrapped through `runCommand` / `runStep` / `runCommandWithTimeout` at `src/infra/process/exec.ts`, but the argv-0 binary literal is `"git"` so the lint rule must consider these as direct invocations.
- **Predates kernel**: yes; PR-#84 introduced the self-updater.
- **User-driven semantics**: NONE — only triggered via the `/update` admin command and the auto-update cron. The orchestrator updates **its own checkout**, never the user's working repo.
- **Classification**: **GRANDFATHERED**. Listed verbatim on the lint-rule allowlist (§h).

### a.3 `src/infra/update-runner.ts:734,791` — surfaced explicitly because the spec calls them out

The spec mentions lines `522, 734, 791` separately. They are the same kind of self-update call (lines 522 = `git checkout dev`; 734 = `git rebase <sha>`; 791-797 = `git checkout --detach <tag>`). All three are inside the `runUpdate(...)` self-update path and the same classification applies. No separate treatment needed.

### a.4 `src/infra/git-commit.test.ts:64,74,76,82,97,162,181,183` — **TEST-ONLY**

All eight `execFileSync("git", ...)` calls are inside `src/infra/git-commit.test.ts`, which fabricates throw-away git histories under `os.tmpdir()` to validate `resolveGitCommit(...)`'s `.git/HEAD` parsing. The production code (`src/infra/git-commit.ts`) does **not** invoke `git` — it reads `.git/HEAD` from the filesystem directly (see `src/infra/git-commit.ts:1-7,53-60`).

- **Classification**: **TEST-ONLY**. Lint rule is glob-scoped and skips `**/*.test.ts`.

### a.5 `src/test-utils/runtime-source-guardrail-scan.ts:82` — **TEST-ONLY**

```ts
const stdout = execFileSync("git", ["-C", repoRoot, "ls-files", "--", "src", "extensions"], {…});
```

- **Caller**: `scanRuntimeSourceGuardrail(...)` — a vitest helper that lists tracked files for the runtime-source guardrail invariant test.
- **Classification**: **TEST-ONLY**. The file is under `src/test-utils/`, which is the closed test-helper namespace; lint rule treats `src/test-utils/**` as test-only.

### a.6 No user-facing `git` / `exec_shell` tool wrapper under `src/agents/tools/`

Glob `src/agents/tools/**/*.ts` enumerated (88 files). None match `git-tool*` / `shell-tool*` / `exec*-tool*`. Closest neighbours:

- `src/agents/tools/agent-step.ts` — agent-loop coordinator, no shell exec.
- `src/agents/tools/capability-install-tool.ts` — installs capability bundles, not a git wrapper.
- `src/agents/tools/canvas-tool.ts` — canvas authoring, not a shell.

Confirmed: **cutover-4 is greenfield for the `repo` family** — there is no pre-existing user-facing `git` tool to retrofit; Phase 5 will land a new gated `repo-runtime-adapter.ts` (per the spec).

### a.7 Summary table

| Site | LOC | Class | Phase 5 obligation |
| --- | --- | --- | --- |
| `src/platform/session/workspace-probe.ts:103,109` | 2 | GRANDFATHERED | Allowlist entry; no rewire. |
| `src/infra/update-runner.ts` (26 argv-0 literals) | 26 | GRANDFATHERED | Allowlist entry (whole file); no rewire. |
| `src/infra/git-commit.test.ts` | 8 | TEST-ONLY | Skipped by `**/*.test.ts` glob exclusion. |
| `src/test-utils/runtime-source-guardrail-scan.ts:82` | 1 | TEST-ONLY | Skipped by `src/test-utils/**` glob exclusion. |
| **Total IN-SCOPE for §h lint rule** | **0 production sites needing migration** | — | The new `repo-runtime-adapter.ts` is the **only** allowed gate. |

---

## §b. `EFFECT_FAMILY_REGISTRY` — additive extension target

**File**: `src/platform/commitment/effect-family-registry.ts`. Currently 5 entries, post-Cutover-3. The list and exact line ranges:

| # | family id | declaration | registry block | allowed ops |
| --- | --- | --- | --- | --- |
| 1 | `persistent_session` | line 15 | lines 29-33 | `create / observe / cancel` |
| 2 | `communication` | line 16 | lines 34-38 | `create / observe` |
| 3 | `web_research` | line 17 | lines 39-47 | `create` (+ `branchingHints`) |
| 4 | `unknown` | line 18 | lines 48-52 | `[]` |
| 5 | `artifact` | line 19 | lines 53-63 | `create / observe / update` |

The `EFFECT_FAMILY_REGISTRY` array literal closes at line 64 with `satisfies EffectFamilyDefinition[])`. Helpers below (lines 66-110) are loop-driven over the array (`new Map` + `.map(...)`) — fully additive.

**Phase 2 obligation**: extend at line 19 with `export const REPO_EFFECT_FAMILY = "repo" as EffectFamilyId;` and add a 6th frozen entry between lines 63 and 64 with `id: REPO_EFFECT_FAMILY, displayName: "Repository operations", allowedOperationKinds: ["create","observe"]` (Phase 2 will pick the exact verbs based on the §i `OperationHint.kind` audit). No widening of `EffectFamilyDefinition` shape is required.

---

## §c. `WorldStateSnapshot` — sibling `repo` slice (recommendation)

**File**: `src/platform/commitment/world-state.ts`. Current `WorldStateSnapshot` slot definition at lines 109-115:

```ts
export type WorldStateSnapshot = {
  readonly sessions?: SessionWorldState;
  readonly artifacts?: ArtifactWorldState;
  readonly workspace?: WorkspaceWorldState;
  readonly deliveries?: DeliveryWorldState;
  readonly webEvidence?: WebEvidenceWorldState;
};
```

`WorkspaceWorldState` is the empty stub at line 56:

```ts
export type WorkspaceWorldState = Record<string, never>;
```

It is referenced **only** by the snapshot type itself and produced as `{}` by the in-memory observer/composer (`rg -n 'WorkspaceWorldState'` shows two hits: line 56 declaration + line 112 slot). It carries no records and was a Cutover-2 placeholder for Slice K (workspace tooling).

**Recommendation: SIBLING** — add `repo?: RepoWorldState;` adjacent to `workspace?` (insert at line 113) without repurposing the existing stub. Rationale:

1. The `workspace` stub is reserved for Slice K (which the comment block in `episodic-memory-event.ts:103-118` cross-references as `ArtifactCreatedPayload — STUB (slice K consumer)`). Repurposing it would steal a future slot.
2. Cutover-3 added the `artifacts` slice as a sibling at line 111 (PR-#193, lines 42-54 of this file). Cutover-4 must follow the same precedent — pure append.
3. A sibling slice keeps the Zod schema discipline isolated: a new `repoOperationRecordSchema` next to `artifactRecordSchema` (lines 97-107), a new `RepoOperationRecord` type next to `ArtifactRecord` (lines 42-50), and a new in-memory collector parallel to the artifact one.

**Phase 2 obligation**: ship `RepoOperationRecord` + `RepoWorldState` + `repoOperationRecordSchema` mirroring the artifact precedent (lines 30-54, 97-107).

---

## §d. `CUTOVER_2` array — 8 entries, anticipates Cutover-4 in-place extension

**File**: `src/platform/commitment/cutover-policy.ts`. Lines 44-77 hold the `CUTOVER_2` array literal. Current 8 entries:

| # | effect | family | line |
| --- | --- | --- | --- |
| 1 | `persistent_session.created` | `PERSISTENT_SESSION_EFFECT_FAMILY` | 45-48 |
| 2 | `answer.delivered` | `COMMUNICATION_EFFECT_FAMILY` | 49-52 |
| 3 | `clarification_requested` | `COMMUNICATION_EFFECT_FAMILY` | 53-56 |
| 4 | `external_effect.performed` | `COMMUNICATION_EFFECT_FAMILY` | 57-60 |
| 5 | `pdf.created` | `ARTIFACT_EFFECT_FAMILY` | 61-64 |
| 6 | `docx.created` | `ARTIFACT_EFFECT_FAMILY` | 65-68 |
| 7 | `code_patch.applied` | `ARTIFACT_EFFECT_FAMILY` | 69-72 |
| 8 | `image.created` | `ARTIFACT_EFFECT_FAMILY` | 73-76 |

**Cutover-4 anticipation**: the comment block at lines 35-43 ends with `// Cutover-4 will extend the same array.` (line 43). Phase 7 of cutover-4 extends `CUTOVER_2` in-place with the four `repo.*` effects (`branch.created`, `commit.created`, `merge.completed`, `diff.observed` — final names pending Phase 2). The array literal closes at line 77 with `satisfies CutoverEntry[])`. Pure append before line 77.

`createCutoverPolicy(...)` (line 85) and the `defaultCutoverPolicy` constant (line 100) build the immutable allow-list off `CUTOVER_2` by reference, so the extension is observed automatically by `isEligible(...)` (line 90) without further wiring.

---

## §e. `EpisodicEffectFamily` discriminated union — 10 members, additive `"repo"` arm slot

**File**: `src/platform/memory/episodic-memory-event.ts`. Current `EpisodicEffectFamily` union at lines 45-55:

```ts
export type EpisodicEffectFamily =
  | "persistent_session"   // line 46
  | "subagent"             // line 47
  | "reminder"             // line 48
  | "artifact"             // line 49
  | "task"                 // line 50
  | "policy_approval"      // line 51 (PolicyGate Full Phase 2)
  | "policy_budget"        // line 52
  | "policy_role"          // line 53
  | "policy_retry"         // line 54
  | "policy_escalation";   // line 55
```

PolicyGate Full added the trailing five `policy_*` arms in Phase 2 (PR-#198). The doc-block at lines 23-44 explicitly documents the additive-extension contract: *"Adding a new variant later is a discriminated-union extension, NOT a breaking change for existing consumers; the exhaustiveness compile check (`memory-store.contract.test.ts`) guarantees `recall` / `storeEpisodic` callers cover every case."*

**Phase 2 obligation** (cutover-4):

1. Append `| "repo"` at line 56 (after `policy_escalation`).
2. Add `RepoOperationCompletedPayload` type next to existing payload types (mirror `ArtifactCreatedPayload` at lines 110-118):
   ```ts
   export type RepoOperationCompletedPayload = {
     readonly operationKind: "branch" | "commit" | "merge" | "diff";  // closed set, Phase 2 picks final tuple
     readonly repoRoot: string;
     readonly ref?: string;          // e.g. branch name / sha / tag
     readonly subject?: string;      // e.g. commit subject for `kind: "commit"`
     readonly occurredAt: string;    // ISO-8601
   };
   ```
3. Append a 11th arm to `EpisodicMemoryEvent` discriminated union (lines 288-348) with `effectFamily: "repo"` + `payload: RepoOperationCompletedPayload`.
4. Append a parallel arm to `EpisodicMemoryEventSchema.discriminatedUnion("effectFamily", ...)` (lines 561-621) with the matching Zod schema.
5. Append the matching brand-typed schema constant (`RepoOperationCompletedPayloadSchema: z.ZodType<RepoOperationCompletedPayload>`).

The `assertNeverEpisodic(value: never)` exhaustiveness helper at lines 633-637 will then drive a compile error in every consumer that does not extend their switch — by design.

---

## §f. `CUTOVER_2` array — final cutover-4 effect-id naming (deferred to Phase 2)

**Out of scope for this audit**: exact effect-id strings (`branch.created` vs `repo.branch.created` etc.) — Phase 2 of the cutover-4 plan picks them. This audit only confirms that:

1. The `CUTOVER_2` allow-list is single-source-of-truth (§d).
2. The episodic-memory-event slot is one symbol (`"repo"`) that multiplexes over the operationKind via payload-level discriminator (§e), exactly as `task` does for `created/completed/cancelled/failed` (lines 187-191).

---

## §g. PolicyGate Full integration — five files present and ready

The cutover-4 spec depends on PolicyGate Full Phases 3-7 to gate `repo` effects. All five files exist on `dev` HEAD `9fa2939678`:

| Stage | Phase | File | Verified |
| --- | --- | --- | --- |
| 2 (Approvals) | PR-#199 | `src/platform/commitment/approval-policy.ts` | line 1-30 read; imports `ApprovalPolicyReader` from `policy-gate-stages.ts` |
| 3 (Budgets) | PR-#201 | `src/platform/commitment/budget-policy.ts` | line 1-30 read |
| 3 (Budget store) | PR-#201 | `src/platform/commitment/sqlite-budget-store.ts` | line 1-30 read; uses `requireNodeSqlite` shim |
| 4 (Role) | PR-#203 | `src/platform/commitment/role-policy.ts` | line 1-30 read |
| 5 (Retry) | PR-#204 | `src/platform/commitment/retry-policy.ts` | line 1-30 read |
| 6 (Escalation) | PR-#206 | `src/platform/commitment/escalation-hook.ts` | line 1-30 read |

**Phase 6 of cutover-4 obligation**: ADD-only. Wire `repo` family entries into:

1. `policy.approvals` config block (Stage 2) — the YAML/JSON config consumed by `ApprovalPolicyReader.evaluate(...)`.
2. `policy.budgets` config (Stage 3) — three orthogonal dimensions (`user/channel/effect`) per `policy-gate-stages.ts`.
3. `policy.roles` config (Stage 4) — `requiredRole` per `repo` effect-id.
4. `policy.retries` config (Stage 5) — `(identityId × effectId × sessionId)` triple key.
5. The `EscalationHook` v1 channel set (`memory + log`) is registry-driven and does NOT require a new entry.

The frozen layer (`src/platform/commitment/**`) is **untouched** in Phase 6 — only the **OpenClawConfig** schema and the YAML defaults shipped with the orchestrator gain new keys.

---

## §h. NEW invariant proposal — gated `runRepoCommand(...)`

**Proposed invariant text** (mirrors PolicyGate Full's Stage-2/3 fail-closed discipline):

> Direct `execFile('git', …)` / `execFileSync('git', …)` / `spawn('git', …)` outside the gated `src/platform/runtime/repo-runtime-adapter.ts#runRepoCommand(…)` is forbidden. Every user-driven git invocation MUST flow through `runRepoCommand(...)`, which:
>
> 1. resolves the affordance via `AffordanceRegistry.lookup(effect)`,
> 2. consults `ApprovalPolicyReader` / `BudgetPolicyReader` / `RolePolicyReader` / `RetryPolicyReader` (PolicyGate Full),
> 3. emits a closed `RepoOperationCompletedPayload` to the world-state observer + the episodic memory store,
> 4. enforces a per-call timeout, `windowsHide: true`, and an explicit allowlist of git subcommands (`branch / commit / merge / diff / status / log / show`).

### Lint-rule sketch

A new `eslint-plugin-local` rule `local/no-direct-git-exec` (or a `runtime-source-guardrail-scan.ts` extension) with this contract:

- **Pattern**: AST node `CallExpression` whose callee resolves to `execFile`/`execFileSync`/`exec`/`spawn` from `node:child_process` AND whose first argument is the literal `"git"`.
- **Allowlist (file-glob)**:
  - `src/platform/session/workspace-probe.ts` — orchestrator-internal probe (§a.1).
  - `src/infra/update-runner.ts` — orchestrator self-update (§a.2-3).
  - `src/platform/runtime/repo-runtime-adapter.ts` — the new gate itself (Phase 5).
  - `**/*.test.ts` — test-only.
  - `src/test-utils/**` — test-only.
- **Failure message**: `"Direct git invocation forbidden. Route through runRepoCommand(...) at src/platform/runtime/repo-runtime-adapter.ts. Allowlist sites are documented in extensions/AUDIT-cutover4-repo-operation.md §h."`.

The simplest concrete implementation in v1 is a guardrail vitest test (mirroring `src/test-utils/runtime-source-guardrail-scan.ts`) that does a static `git ls-files | xargs grep` for the forbidden pattern outside the allowlist, fails with a clear message. Phase 8 of cutover-4 lights the guardrail; Phase 5 lands the adapter that satisfies it.

### Enumerated grandfathered sites (verbatim, copy-paste-ready for the lint config)

```jsonc
// .eslintrc.local-rules.json (or runtime-source-guardrail-scan.ts allowlist)
{
  "local/no-direct-git-exec": ["error", {
    "allow": [
      "src/platform/session/workspace-probe.ts",
      "src/infra/update-runner.ts",
      "src/platform/runtime/repo-runtime-adapter.ts"
    ],
    "allowGlobs": [
      "**/*.test.ts",
      "src/test-utils/**"
    ]
  }]
}
```

---

## §i. `TargetRef` / `OperationHint` — already cover repo semantics

**File**: `src/platform/commitment/semantic-intent.ts`. The two discriminated unions:

```ts
// lines 8-13
export type TargetRef =
  | { readonly kind: "session"; readonly sessionId?: SessionId }
  | { readonly kind: "artifact"; readonly artifactId?: string }
  | { readonly kind: "workspace" }                  // line 11 — already exists
  | { readonly kind: "external_channel"; readonly channelId?: ChannelId }
  | { readonly kind: "unspecified" };

// lines 15-20
export type OperationHint =
  | { readonly kind: "create" }
  | { readonly kind: "update"; readonly updateOf?: TargetRef }
  | { readonly kind: "cancel"; readonly cancelOf?: TargetRef } // line 18 — already exists
  | { readonly kind: "observe" }
  | { readonly kind: "custom"; readonly verb: string };
```

**Confirmation**:

- `TargetRef.kind: "workspace"` — present at line 11. `repo` effects target the workspace root, not a session/artifact/channel; reuse this slot (no widening).
- `OperationHint.kind: "cancel"` — present at line 18. Carries `cancelOf?: TargetRef` so a "cancel my last commit / abort merge" intent maps cleanly without union widening.
- `kind: "create"` (commit, branch), `kind: "observe"` (diff, status), `kind: "update"` (merge / fast-forward) all reuse existing slots.

**No discriminated-union widening needed.** Phase 2 wires the `repo` family into the existing `TargetRef = { kind: "workspace" }` + `OperationHint` slots.

The IntentContractor prompt-hint allowlist at `src/platform/commitment/intent-contractor-impl.ts:917` currently lists 4 families:

```
"persistent_session" | "communication" | "web_research" | "artifact" | "unknown"
```

Phase 8 of cutover-4 will extend that string literal to include `"repo"`. **NOT this audit's concern**.

---

## Audit conclusions

1. **Frozen layer untouched** in this audit (read-only markdown deliverable).
2. **Greenfield migration** — there is no pre-existing user-facing `git` tool to retrofit; cutover-4 lands a new gated `repo-runtime-adapter.ts`, mirroring Cutover-3 Artifacts' new `artifact-runtime-adapter.ts` precedent.
3. **All five extension surfaces (`§b`–`§e`, `§h`) are pure-append** — one new `EFFECT_FAMILY_REGISTRY` entry, one new `WorldStateSnapshot` slot, four new `CUTOVER_2` entries, one new `EpisodicEffectFamily` arm, one new lint rule. No discriminated-union widening, no contract amendment, no frozen-layer touch.
4. **PolicyGate Full landed** — all five gating files (`approval-policy.ts`, `budget-policy.ts` + `sqlite-budget-store.ts`, `role-policy.ts`, `retry-policy.ts`, `escalation-hook.ts`) are present on `dev` HEAD `9fa2939678`. Phase 6 of cutover-4 is **ADD-only configuration wiring**.
5. **`TargetRef.kind: "workspace"` and `OperationHint.kind: "cancel"`** already exist — no semantic-intent widening needed.
6. **Three production direct-git sites** (workspace-probe + update-runner + nothing else) — both grandfathered. Two test-only sites — skipped by glob. **Zero production sites need migration**; the new gated adapter is the only allowed gate.
