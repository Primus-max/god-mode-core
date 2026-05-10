---
title: S12-AGGRESSIVE — sub-slice mapping for legacy fallback removal
session: 2026-05-10-s12-aggressive-scoping
status: SCOPING ONLY — no deletes in this PR
predecessor:
  - .cursor/plans/V1-CUTOVER-2026-05-09-execution.md
  - PR #351 (artifact upload — last merge on feat/v1-contract-only-orchestrator)
operator_authorization: 2026-05-09 — Vladimir authorized "вырезать всё что нагородили"
                        i.e. drop env-flag-off legacy fallback so
                        OPENCLAW_USE_V1_ORCHESTRATOR=1 becomes mandatory.
---

# S12-AGGRESSIVE — sub-slice mapping (no deletes yet)

## §1 Goal

After Phase 2 cutover, three dispatch sites short-circuit through orchestrator-v1
when `OPENCLAW_USE_V1_ORCHESTRATOR=1`:

- `extensions/telegram/src/bot-message-dispatch.ts::executeOrchestratorV1ShortCircuit`
- `src/plugin-sdk/inbound-reply-dispatch.ts::executeOrchestratorV1UniversalShortCircuit`
- `src/agents/agent-command-orchestrator-v1.ts::executeOrchestratorV1AgentCommandShortCircuit`
  (called from `agent-command.ts::agentCommandFromIngress`).

When the env flag is unset, control falls through to `agentCommandInternal`
(legacy fallback). That fallback drags the whole kernel + decision + pi-embedded-runner
attempt loop + memory wiring + auto-reply runner stack — ~250 files in the
"can-be-deleted-once-fallback-is-gone" set, of which the truly-orphan portion
is ~80–100 files (`src/platform/commitment/**` + `src/platform/decision/**`
+ kernel-coupled adapters in `src/agents/pi-embedded-runner/run/**`
+ `src/auto-reply/reply/agent-runner*` + `closure-outcome-dispatcher` +
their tests).

S12-aggressive declares `OPENCLAW_USE_V1_ORCHESTRATOR=1` MANDATORY: no env
gating, no legacy branch, no fallback. Once the three short-circuits are
the only path, every importer of the kernel + decision + auto-reply runner
chain becomes orphan and deletable.

This plan breaks that work into 6 sub-slices ordered to keep tsgo green
between merges. Each sub-slice is independently merge-able and reversible:
revert one PR ≤ harm. **No code in this PR — mapping + sequencing only.**

The mapping in §2 is the substantive work. Sub-slice acceptance, risk
register, verification, and rollback follow.

## §2 Code map — tier table

Tiers measure "distance from the env-flag-off branch entry point." Tier 1
is what runs immediately when env-flag-off; Tier 2 is what Tier 1 calls;
Tier 3 is observers + collectors only Tier 2 reaches; Tier 4 is barrel
re-exports.

Counts below come from grep (2026-05-10 worktree). External commitment
importers across `src/**` (excluding kernel-internal): **45 import lines
across 15 files** — note this is line count not file count; many files
import multiple symbols.

### Tier 1 — direct under `agentCommandInternal`

| File                                                                     | Lines | Orphan when env-flag mandatory? | Notes |
|--------------------------------------------------------------------------|-------|---------------------------------|-------|
| `src/agents/agent-command.ts` (lines ~1153–2130: runAgentAttempt, prepareAgentCommandExecution, agentCommandInternal) | 2189 | partial — only `agentCommand`/`agentCommandFromIngress` are public; `agentCommandInternal` body becomes orphan when fallback drops | Keep file; gut `agentCommandInternal` body, leave the two exports as thin wrappers around the v1 short-circuit. `InboundMediaSummary` import (line 49) becomes removable. |
| `src/agents/pi-embedded.ts` + `src/agents/cli-runner.ts` + `src/agents/pi-embedded-runner.ts` | — | NO (pi-embedded retained for orchestrator-v1 conversation-LLM path) | Verify: `src/orchestrator-v1/diagnostic.ts::callConversationLLM` does NOT route through pi-embedded; if it does, `pi-embedded` stays. Quick grep before S12-aggressive-1 starts. |
| `src/agents/model-fallback.ts`                                           | —     | NO — orchestrator-v1 may share this | Inspect; orchestrator-v1's `runConversationLLM` likely re-uses provider routing. Keep. |
| `src/agents/command/delivery.ts`                                         | —     | NO — `deliverAgentCommandResult` is also called from non-fallback code | Keep. |

### Tier 2 — dispatch helpers reached from Tier 1

| File                                                                       | Lines | Orphan? | Notes |
|----------------------------------------------------------------------------|-------|---------|-------|
| `src/auto-reply/reply/agent-runner.ts` (`runReplyAgent`)                   | 1895  | YES     | Sole non-test importers are `closure-outcome-dispatcher`, `inbound-reply-dispatch.ts` legacy branch. After short-circuit-only mode, only tests remain. |
| `src/auto-reply/reply/agent-runner-execution.ts`                           | 1239  | YES     | Imports `commitment/inbound-image-reference-precondition-resolver`. |
| `src/auto-reply/reply/agent-runner-utils.ts`                               | —     | YES     | Imports decision contracts. |
| `src/auto-reply/reply/agent-runner-helpers.ts`                             | —     | YES     | |
| `src/auto-reply/reply/agent-runner-memory.ts`                              | —     | YES     | No commitment imports — pure session/memory glue, but only used by `runReplyAgent`. |
| `src/auto-reply/reply/agent-runner-payloads.ts`                            | —     | YES     | |
| `src/auto-reply/reply/agent-runner-auth-profile.ts`                        | —     | YES     | |
| `src/auto-reply/reply/agent-runner-reminder-guard.ts`                      | —     | YES     | |
| `src/auto-reply/reply/agent-runner-usage-line.ts`                          | —     | YES     | |
| `src/auto-reply/reply/agent-runner.runtime.ts` + `.runtime.ts` siblings    | —     | YES     | Runtime overrides; only the runner uses them. |
| `src/auto-reply/reply/closure-outcome-dispatcher.ts`                       | 1056  | YES     | Imports `platform/decision/contracts` + `route-preflight`. Sole consumer is `runReplyAgent`. |
| `src/auto-reply/reply/get-reply-run.ts`                                    | —     | YES     | Wraps runner for `recordInboundSessionAndDispatchReply` legacy branch. |
| `src/agents/pi-embedded-runner/run/attempt.ts`                             | 3708  | partial | Imports `commitment/ids`. Used by both fallback and possibly tools-runner via shared helpers. **Audit needed:** does `runEmbeddedPiAgent` still get called from any orchestrator-v1 path? If only `runEmbeddedPiAgent` for conversation-LLM stays, the tool-attempt loop is orphan but the embedded runner isn't. Likely answer: only `runEmbeddedPiAgent` survives; `attempt.ts`'s "tool execution attempt loop" becomes dead. |
| `src/agents/pi-embedded-runner/run/artifact-runtime-adapter.ts` (+ test)   | —     | YES     | Pure kernel observer wiring for tool artifacts. Already-known orphan. |
| `src/agents/pi-embedded-runner/run/artifact-ambient-turn.ts`               | —     | YES     | |
| `src/agents/pi-embedded-runner/run/emit-artifact-from-tool.ts` (+ test)    | —     | YES     | |
| `src/agents/pi-embedded-runner/run/web-research-orchestrator.ts` (+ test)  | —     | YES     | Already deleted in S13-narrow per charter? Re-verify file existence; if present it's orphan. |
| `src/agents/pi-embedded-runner/run/web-research-runtime-adapter.ts` (+ test) | —   | YES     | Same. |
| `src/agents/pi-embedded-runner/run/image-generate-img2img-wrapper.ts`      | —     | YES     | Imports `inbound-image-reference-precondition-resolver`. |
| `src/agents/pi-embedded-runner/run/session-reset-subscribers/*`            | —     | YES     | Pure kernel reset wiring. |
| `src/platform/decision/input.ts` (842 lines)                               | 842   | YES     | Sole external importers: `agent-command.ts` + `agent-runner-execution.ts` + `agent-runner-utils.ts` (all in fallback path) + `model-fallback.ts` (cross-cutting; see Tier 1 note). |
| `src/platform/decision/web-evidence-prefetch.ts`                           | 191   | YES     | Sole production caller is `agent-command.ts::prepareAgentCommandExecution`. |
| `src/platform/decision/task-classifier.ts`                                 | 1760  | YES     | Imports `commitment/intent-contractor-impl`. After fallback drops, only orchestrator-v1's classifier-stage-a runs. |
| `src/platform/decision/turn-normalizer.ts`                                 | —     | YES (sole importer is gateway/server.impl.ts? — verify) | Audit before delete. |
| `src/platform/decision/run-turn-decision.ts` + 14 cutover tests            | —     | YES     | Decision tree; nothing in v1 path uses it. |
| `src/platform/decision/memory-wiring.ts`                                   | —     | YES     | Imports `commitment/index`. |
| `src/platform/decision/route-preflight.ts`                                 | —     | partial | `closure-outcome-dispatcher` imports it; if `model-fallback.ts` also imports it, keep. **Audit before delete.** |
| `src/platform/decision/web-research-transports.ts`                         | —     | YES     | Already deleted in S13? Verify. |
| `src/platform/decision/contracts.ts`                                       | —     | YES     | Decision contracts — sole consumer is the decision tree + closure-outcome-dispatcher. |

### Tier 3 — kernel observers + collectors only used by Tier 2

| File                                                       | Orphan? | Notes |
|------------------------------------------------------------|---------|-------|
| `src/platform/commitment/intent-contractor-impl.ts`        | YES     | Used by `task-classifier.ts` only; orchestrator-v1 has its own Stage A. |
| `src/platform/commitment/intent-contractor.ts`             | YES     | Same. |
| `src/platform/commitment/raw-user-turn.ts`                 | YES     | |
| `src/platform/commitment/semantic-intent.ts`               | YES     | |
| `src/platform/commitment/world-state.ts`                   | YES     | Observer plumbing. |
| `src/platform/commitment/artifact-world-state-observer.ts` | YES     | |
| `src/platform/commitment/web-evidence-world-state-observer.ts` | YES | |
| `src/platform/commitment/delivery-receipt-registry.ts`     | YES     | |
| `src/platform/commitment/delivery-world-state-observer.ts` | YES     | |
| `src/platform/commitment/effect-family-registry.ts`        | YES     | |
| `src/platform/commitment/execution-commitment.ts`          | YES     | |
| `src/platform/commitment/expected-delta.ts`                | YES     | |
| `src/platform/commitment/inbound-image-reference-precondition-resolver.ts` | YES | Used by `agent-runner-execution` + `image-generate-img2img-wrapper` + `artifact-runtime-adapter`, all Tier 2 orphans. |
| `src/platform/commitment/done-predicate-*.ts` (12 files)   | YES     | Bound to monitored-runtime; no v1 consumer. |
| `src/platform/commitment/policy-gate*.ts`                  | YES     | |
| `src/platform/commitment/approval-policy.ts` + `clarification-policy.ts` + `budget-policy.ts` + `cutover-policy.ts` + `escalation-hook.ts` + `retry-policy.ts` + `role-policy.ts` | YES | All decision-tree side artifacts. |
| `src/platform/commitment/shadow-builder*.ts`               | YES     | |
| `src/platform/commitment/persistent-worker-report-observer.ts` | partial | Used by `src/server/persistent-worker-push-bootstrap.ts` (charter §"Production-path importer to remember"). **MUST be replaced or removed BEFORE this Tier 3 file disappears.** Tracked as S11c (separate). |
| `src/platform/commitment/production-runtime-defaults.ts`   | partial | Same — bootstraps the persistent-worker collector. |
| `src/platform/commitment/monitored-runtime.ts`             | YES     | |
| `src/platform/commitment/affordance*.ts`                   | YES     | |
| `src/platform/commitment/budget-store.ts` + `sqlite-budget-store.ts` | YES | |
| `src/platform/commitment/retry-state-store.ts`             | YES     | |
| `src/platform/commitment/reminder-world-state-observer.ts` + `scheduled-reminder-world-state-observer.ts` + `repo-world-state-observer.ts` + `session-world-state-observer.ts` | YES | |
| `src/platform/commitment/ids.ts`                           | partial | Brand types `AgentId`/`SessionKey`/`SessionId` are CONSUMED by Tier 2 files (`attempt.ts`, `web-research-*`). After Tier 2 drops, `ids.ts` becomes orphan. **Already migrated** to `src/platform/identity/branded-ids.ts` per S11a (PR #340). Confirm zero consumers remain. |
| `src/platform/commitment/__tests__/*` (~25 files)          | YES     | All test files in the kernel tree. |

### Tier 4 — barrel re-exports

| File                                       | Notes |
|--------------------------------------------|-------|
| `src/platform/commitment/index.ts`         | Re-exports ~30 symbols. Pruning order: drop unused re-exports as Tier 3 deletes, then delete the barrel last. |

## §3 Sub-slices

Six sub-slices, sequenced leaves-first to minimise tsgo error volume between
merges. Each one is independently revertible.

### S12-AGG-1 — make `OPENCLAW_USE_V1_ORCHESTRATOR=1` mandatory at all 3 dispatch sites

**Goal:** flip the env gate from "default off, opt-in via env" to "always on, no fallback."

**Files touched (3):**
- `extensions/telegram/src/bot-message-dispatch.ts` — remove the `if (process.env.OPENCLAW_USE_V1_ORCHESTRATOR === "1")` guard around the short-circuit; remove the legacy branch fallthrough below it.
- `src/plugin-sdk/inbound-reply-dispatch.ts::recordInboundSessionAndDispatchReply` — same; the lines below the `if (handled) return` (legacy `dispatchReplyWithBufferedBlockDispatcher` branch) become unreachable and get deleted.
- `src/agents/agent-command.ts::agentCommandFromIngress` — change `if (orchestratorOutcome.handled) return result; else fall through` into "always short-circuit; throw if `handled === false` for an unexpected reason." The `agentCommandInternal` body call gets removed from this path.

**Out of scope:** do NOT delete `agentCommandInternal` body in this slice — that's S12-AGG-3. Just stop calling it from `agentCommandFromIngress`. The CLI entry point `agentCommand` (trusted-operator local flow) still calls `agentCommandInternal` and stays alive in this slice; it goes in S12-AGG-3.

**Acceptance:**
- `pnpm tsgo` exit 0.
- Scoped vitest: `bot-message-dispatch.test.ts`, `inbound-reply-dispatch.test.ts`, `agent-command-orchestrator-v1.test.ts` pass.
- Live Telegram: `OPENCLAW_USE_V1_ORCHESTRATOR` UNSET (deliberately) — write/pdf/web_search still produce correct replies (proof the env-flag-off branch no longer participates).
- Live Telegram: `OPENCLAW_USE_V1_ORCHESTRATOR=1` — same five canary prompts still green.

**Dependencies:** none. This is the FIRST slice.

**Estimated impact:** 3 files modified, ~80 lines deleted, ~10 lines edited.
No commitment-importer drop yet (the importers still exist, just unreachable).

### S12-AGG-2 — drop `agentCommand` CLI entry's `agentCommandInternal` call (or keep behind a CLI-only flag)

**Decision needed by operator:** does `openclaw agent <prompt>` (CLI) still need the legacy execution path, or should it also route through orchestrator-v1?

- If "CLI also routes through v1" → fold `agentCommand` into the v1 short-circuit and delete `agentCommandInternal` entirely in this slice.
- If "CLI keeps legacy for trusted-operator local debugging" → keep `agentCommandInternal` around but mark all callers as CLI-only; Tier 2 deletes still happen because no production hot path calls them.

**Tentative recommendation:** route CLI through v1 too — there's no reason a `openclaw agent` CLI invocation should hit the kernel decision tree if `agentCommandFromIngress` (the network-facing entry) doesn't. This eliminates `agentCommandInternal` cleanly.

**Files touched (1):** `src/agents/agent-command.ts` (replace `agentCommandInternal` body with a small wrapper that calls `executeOrchestratorV1AgentCommandShortCircuit` directly, never returning `handled: false`; delete `prepareAgentCommandExecution`, `runAgentAttempt`, all helper functions only used by `agentCommandInternal`).

**Acceptance:**
- `pnpm tsgo` exit 0.
- `agent-command.stage2.test.ts`, `agent-command.stage4.test.ts` either pass or are scoped for deletion in S12-AGG-6.
- CLI smoke: `openclaw agent --to <test-chat> "echo hi"` returns a v1 reply.

**Dependencies:** S12-AGG-1.

**Estimated impact:** 1 file modified (~1500 lines deleted), `agent-command.ts` shrinks from 2189 → ~700 lines.

### S12-AGG-3 — delete `auto-reply/reply/agent-runner*` + `closure-outcome-dispatcher`

After S12-AGG-1+2 the only callers of `runReplyAgent` are tests (and any
remaining references in `inbound-reply-dispatch.ts` legacy branch which
S12-AGG-1 already removed).

**Files touched (~30):**
- `src/auto-reply/reply/agent-runner.ts` + `.runtime.ts` + tests (8 files)
- `src/auto-reply/reply/agent-runner-execution.ts` + tests
- `src/auto-reply/reply/agent-runner-utils.ts` + tests
- `src/auto-reply/reply/agent-runner-helpers.ts` + tests
- `src/auto-reply/reply/agent-runner-memory.ts` + `.runtime.ts` + tests
- `src/auto-reply/reply/agent-runner-payloads.ts` + tests
- `src/auto-reply/reply/agent-runner-auth-profile.ts`
- `src/auto-reply/reply/agent-runner-reminder-guard.ts`
- `src/auto-reply/reply/agent-runner-usage-line.ts` + tests
- `src/auto-reply/reply/closure-outcome-dispatcher.ts` + 3 tests
- `src/auto-reply/reply/get-reply-run.ts` + 1 test

**Pre-flight check:** before deleting, grep for non-test importers of each
file. If any production file outside Tier 2 imports them, STOP and surface.

**Acceptance:**
- `pnpm tsgo` exit 0.
- Scoped vitest: every test in `src/auto-reply/reply/**` either deleted or green.
- Bench 100/100 (orchestrator-v1 classifier).
- Live Telegram canary: 5 prompts (write, image, pdf, web_search, refuse) — all green.

**Dependencies:** S12-AGG-1, S12-AGG-2.

**Estimated impact:** ~30 files deleted, ~6000–8000 lines, drops the
single largest commitment-importer cluster (`agent-runner-execution.ts`'s
`commitment/inbound-image-reference-precondition-resolver`).

### S12-AGG-4 — delete `pi-embedded-runner/run/` kernel-coupled adapters

After S12-AGG-3, the kernel-coupled artifact/web-research adapters lose
their callers because `attempt.ts`'s tool-execution loop is no longer
reached (the v1 tool-runner-registry replaces it).

**Pre-flight check:** confirm `attempt.ts` is not invoked from any v1
path. The v1 short-circuit uses `runOrchestratorTurn` → `runTool` from
`tool-runner-registry`, which delegates to `tool-runners/*` (S1–S7).
None of those touch `attempt.ts`. The `runEmbeddedPiAgent` call that
`runConversationLLM` (in `diagnostic.ts`) makes goes through `pi-embedded.ts`,
NOT through `pi-embedded-runner/run/attempt.ts`'s tool-execution branch.

If the pre-flight grep shows `attempt.ts` is still consumed by v1, this
slice splits into smaller pieces (delete artifact-* but keep attempt.ts).

**Files touched (~14):**
- `src/agents/pi-embedded-runner/run/artifact-runtime-adapter.ts` + test
- `src/agents/pi-embedded-runner/run/artifact-ambient-turn.ts`
- `src/agents/pi-embedded-runner/run/emit-artifact-from-tool.ts` + test
- `src/agents/pi-embedded-runner/run/image-generate-img2img-wrapper.ts` + test
- `src/agents/pi-embedded-runner/run/web-research-orchestrator.ts` + test (if still present)
- `src/agents/pi-embedded-runner/run/web-research-runtime-adapter.ts` + test (if still present)
- `src/agents/pi-embedded-runner/run/session-reset-subscribers/*.test.ts` (kernel-coupled subset)
- `src/agents/apply-patch.cutover3-emit-site.test.ts`

**Acceptance:**
- `pnpm tsgo` exit 0.
- All test files in `pi-embedded-runner/run/` either deleted or green.
- Live Telegram canary: 5 prompts.

**Dependencies:** S12-AGG-3.

**Estimated impact:** ~14 files deleted, drops 30+ commitment-importer lines.

### S12-AGG-5 — delete `src/platform/decision/**`

After S12-AGG-1+2+3, decision-tree consumers (`agent-command.ts`,
`agent-runner-execution.ts`, `agent-runner-utils.ts`, `closure-outcome-dispatcher.ts`)
are gone. Remaining importers should be:
- `model-fallback.ts` — keeps `decision/input.ts`? **AUDIT REQUIRED before this slice starts.** If yes, S12-AGG-5 is BLOCKED until `model-fallback.ts` migrates off.
- `gateway/gateway.test.ts` — test only; deleted with the kernel.
- `cron/isolated-agent/run.ts` — confirm v1-routed before delete.
- `scripts/dev/decision-eval.ts` + `eval-classifier*.ts` + `task-contract-eval.ts` + `task-classifier-live-smoke.ts` — eval scripts; delete or migrate to orchestrator-v1's bench.

**Files touched (~46):** entire `src/platform/decision/**` directory + the script files above.

**Acceptance:**
- `pnpm tsgo` exit 0.
- Bench 100/100.
- Live Telegram canary: 5 prompts.

**Dependencies:** S12-AGG-3, plus `model-fallback.ts` audit.

**Estimated impact:** ~46 files, ~7000 lines, drops all `decision/contracts`
+ `decision/route-preflight` importers from production code.

### S12-AGG-6 — delete `src/platform/commitment/**` (kernel directory)

After S12-AGG-3+4+5, all production importers of the kernel are gone.
Remaining importers:

- `src/server/persistent-worker-push-bootstrap.ts` — calls
  `getProcessPersistentWorkerReportCollector()`. **MUST be migrated
  (or removed) BEFORE this slice via S11c (separate task).** S12-AGG-6
  is BLOCKED until S11c lands.
- `src/agents/agent-command.ts:49` — `import type { InboundMediaSummary }
  from "../platform/inbound-media/types.js"`. Wait — that's NOT a
  kernel import. Re-checking: the line is `import type { InboundMediaSummary
  } from "../platform/inbound-media/types.js"`. `inbound-media/types.ts`
  is NOT inside `src/platform/commitment/`. So this is a non-issue for
  S12-AGG-6 — it's `inbound-media`, a peer of `commitment` not a child.
  The charter's "InboundMediaSummary leak" note refers to the type
  living in `platform/` proper but not in `commitment/`. Confirm with
  grep at slice start; if still flagged, fold into this slice.
- `src/orchestrator-v1/classifier-stage-b.ts` — re-check: orchestrator-v1
  must NOT import the kernel. If grep shows it does, that's a bug
  (charter invariant #1) and must be redirected before S12-AGG-6.

**Files touched (~80):** entire `src/platform/commitment/**` directory.

**Acceptance:**
- `pnpm tsgo` exit 0.
- Bench 100/100.
- Live Telegram canary: 5 prompts.
- `grep -r "platform/commitment" src/ --include="*.ts" | wc -l` returns 0
  for production code (excluding `.cursor/plans` historical references).

**Dependencies:** S12-AGG-5, S11c (persistent-worker-push migration).

**Estimated impact:** ~80 files deleted, ~12000–15000 lines. After this,
the kernel directory is gone.

## §4 Risk register

### Production regression risks

- **Non-Telegram channels live-tested with v1?** Charter says "live-verified
  GREEN in Telegram on write/pdf/web_search/refuse paths." Discord, Slack,
  IRC, Mattermost, Matrix, MS Teams etc. all funnel through
  `recordInboundSessionAndDispatchReply` which has the universal
  short-circuit (S10). But none have been live-tested with the env flag on.
  **Mitigation:** before S12-AGG-1 ships, do a one-shot Discord canary
  test with `OPENCLAW_USE_V1_ORCHESTRATOR=1`. If it explodes, fix in
  orchestrator-v1, NOT by re-enabling the legacy fallback.
- **CLI `openclaw agent` flow** — `src/commands/agent.ts` calls
  `agentCommand` (CLI trusted-operator entry). If S12-AGG-2 routes CLI
  through v1, scripts that depend on legacy CLI semantics (subagent
  orchestration, cron-spawned `openclaw agent` invocations) may break.
  **Mitigation:** grep `openclaw agent` usage in `cron/isolated-agent/`,
  `auto-reply/`, scripts; either migrate or split S12-AGG-2 into "ingress
  routes through v1" (safe) and "CLI routes through v1" (separate, after
  audit).
- **`gateway/server-methods/agent.ts` JSON-RPC** — calls
  `agentCommandFromIngress`; covered by S9.5 short-circuit. After S12-AGG-1,
  no env flag needed; works the same way.
- **`extensions/discord/src/voice/manager.ts`** — same path; same risk.
  Add to canary set.
- **`extensions/acpx/src/runtime.ts`** — ACPx control-plane MCP host
  also routes through `agentCommandFromIngress`. Needs canary.
- **`src/server/persistent-worker-push-bootstrap.ts`** — kernel observer
  collector. Cannot delete `commitment/` until this is migrated (S11c).
  S12-AGG-6 BLOCKED on S11c. **Track explicitly.**
- **`src/cron/isolated-agent/run.ts`** — imports `pi-embedded` + `decision`.
  If cron-spawned agents still take the legacy path, they'll break when
  decision/ disappears. **Verify cron uses `agentCommandFromIngress`** (i.e.
  the v1-routed entry) and not `agentCommand` directly.
- **`subagent-control.ts` / `subagent-announce.ts` / `subagent-registry.ts`**
  — subagent infrastructure imports `pi-embedded` + persistent-worker
  bits. Audit whether subagent spawn still uses the legacy fallback.

### Test risks

- **Tests in `src/auto-reply/reply/agent-runner.*.test.ts`** are real
  end-to-end tests of the legacy reply pipeline. After S12-AGG-3 they
  must be DELETED (per AGENTS.md "no test-fitting" — if the test only
  exists to assert legacy behaviour, it dies with the code). DO NOT
  rewrite them to pass on the v1 path; that would be test-fitting.
- **Tests in `src/platform/decision/run-turn-decision.*.test.ts`** —
  same story. Delete.
- **Tests in `src/platform/commitment/__tests__/`** — same. Delete.
- **`test/scripts/check-no-decision-imports-from-commitment.test.ts`**
  — this is a guard test. After S12-AGG-6 it's vacuously true; delete.
- **`src/agents/agent-command.stage2.test.ts` + `.stage4.test.ts`** —
  tests of the legacy `agentCommandInternal` body. Die in S12-AGG-2.

### Sequencing risks

- Going out of order produces tsgo storms (50–150 errors per intermediate
  state). The leaves-first ordering above keeps each merge to <10 errors
  within the slice (which the slice itself fixes by deleting the leaves
  with their importers).
- Reverting S12-AGG-3 mid-cleanup is hard if S12-AGG-4/5 already merged
  because the runner files would re-introduce kernel imports that the
  later slices removed. **Recommended:** if a slice breaks live canary,
  revert ONLY that slice; do not let two later slices stack on top of a
  broken predecessor.

## §5 Verification protocol

### Per-slice (pre-merge)

1. Branch from latest `feat/v1-contract-only-orchestrator` (after the
   prior slice merged).
2. `pnpm tsgo` — must be exit 0. If not, fix or refuse the slice.
3. Scoped vitest on the changed files + their direct importers.
4. Bench 100/100 if any classifier file touched (none expected for
   S12-AGG-* deletes; bench just sanity-checks no accidental classifier
   regression).

### Per-slice (post-merge canary — required)

1. Restart gateway with `OPENCLAW_USE_V1_ORCHESTRATOR` UNSET (after
   S12-AGG-1 the env var is irrelevant; v1 always runs).
2. Telegram canary — five prompts:
   - "write a file `/tmp/canary.md` with one line"  → expect write tool
     fires + reply renders from catalog.
   - "сделай pdf про осень с одной картинкой"      → expect pdf tool
     fires + artifact uploaded.
   - "найди в интернете последние новости по AI"    → web_search.
   - "иди нахуй"                                     → refuse template.
   - "Поможешь сделать практику?"                    → multi-turn
     `missing_field` refuse, then second turn delivers.
3. Grep `gateway-v1-tg.log` for `[orch-v1] turn started/completed`
   on each prompt; confirm `dispatch.allOk=true` (or appropriate refuse).
4. Check for absence of `[agent]` legacy-fallback log lines (those
   come from `agentCommandInternal`).

### Per-slice (cross-channel canary — required for S12-AGG-1 only)

Discord + ACPx canary (one prompt each) before S12-AGG-1 merges. If
either fails, S12-AGG-1 blocks; the universal short-circuit needs a
fix first.

## §6 Rollback plan

### Per-slice rollback

Each sub-slice is one PR. Rollback = `git revert <merge-sha>` + restart
gateway. Because the slices are leaves-first, reverting a later slice
does not require touching the earlier ones. Reverting an earlier slice
when a later one is already merged is harder — see "Sequencing risks"
in §4.

### Full-rollback (worst case — production catastrophe)

If S12-AGG-1 merges and Telegram catastrophically breaks across all
prompt classes, revert in this order:

1. Revert S12-AGG-1 — the ONLY slice that flipped behaviour. Slices 2–6
   are pure deletes that take effect only because slice 1 made the
   fallback unreachable. After reverting S12-AGG-1, the env flag is
   back to opt-in and the legacy fallback resumes.
2. If slices 2–6 already merged, the legacy fallback files are gone.
   Reverting those slices restores the code; gateway restart with
   env flag unset returns to legacy path.
3. Worst case: revert ALL S12-AGG-* commits, return to predecessor
   `897b723e6b` (PR #351 merge).

### Rollback canary

After any revert, run the same five-prompt Telegram canary from §5 with
the env flag UNSET to confirm the legacy fallback is alive again.

## §7 Out-of-scope (not part of S12-AGG)

- **S11c — persistent-worker-push-bootstrap migration.** Required as a
  prerequisite for S12-AGG-6 only. Tracked separately.
- **Multi-turn drift detection.** Charter "task #22 + #23" — orthogonal.
- **Memory persistence (embedder).** Deferred non-goal.
- **Streaming partials.** Deferred non-goal.
- **Per-channel chunking** for Discord (2000) / Slack (40000). Tracked
  but independent of S12-AGG.
- **Image runner test failures (10/11 in `image.test.ts`).** Pre-existing,
  not S9-introduced; not blocked by S12-AGG.

## §8 Estimated totals

If all six slices land:

- **Sub-slice count:** 6 (plus S11c prerequisite, separately tracked).
- **Files deleted:** ~170 (30 runner + 14 pi-embedded-runner adapters +
  46 decision/ + 80 commitment/ ≈ 170). Plus ~25 deleted test files
  inside those directories.
- **Lines deleted:** ~25,000–30,000 LOC.
- **Commitment-importer drop:** from current 45 import lines / 15 files
  in `src/**` (kernel-internal excluded) to 0 lines / 0 files. The
  `.cursor/plans/*` historical references stay (documentation, not code).
- **Decision-importer drop:** from 11 files to 0.
- **`agent-command.ts` size:** 2189 → ~700 lines (gut `agentCommandInternal`).

## §9 Operator decision points

Before sub-slice 1 starts, operator confirms:

1. **CLI routing.** S12-AGG-2 — does `openclaw agent <prompt>` (CLI)
   route through orchestrator-v1, or keep legacy? Recommendation: route
   through v1.
2. **Cross-channel canary.** Acceptable to canary Discord + ACPx
   manually before S12-AGG-1 ships, or rely on Telegram-only canary?
   Recommendation: Discord canary required (one prompt is enough).
3. **S11c sequencing.** S11c (persistent-worker-push migration) blocks
   S12-AGG-6. Two options:
   - (a) Land S11c first (separate PR); then run S12-AGG-1..6 sequentially.
   - (b) Land S12-AGG-1..5; pause; land S11c; then S12-AGG-6.
   Recommendation: (a) — keeps the kernel-delete window short.
4. **Plan-only PR vs immediate execution.** This PR opens for review
   the plan only. Operator approves the plan, then S12-AGG-1 starts in
   a fresh slice-implementer session.
