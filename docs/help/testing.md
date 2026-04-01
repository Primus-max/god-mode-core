---
summary: "Testing kit: unit/e2e/live suites, Docker runners, and what each test covers"
read_when:
  - Running tests locally or in CI
  - Adding regressions for model/provider bugs
  - Debugging gateway + agent behavior
title: "Testing"
---

# Testing

OpenClaw has three Vitest suites (unit/integration, e2e, live) and a small set of Docker runners.

This doc is a “how we test” guide:

- What each suite covers (and what it deliberately does _not_ cover)
- Which commands to run for common workflows (local, pre-push, debugging)
- How live tests discover credentials and select models/providers
- How to add regressions for real-world model/provider issues

## Quick start

Most days:

- Full gate (expected before push): `pnpm build && pnpm check && pnpm test`

When you touch tests or want extra confidence:

- Coverage gate: `pnpm test:coverage`
- E2E suite: `pnpm test:e2e`

When debugging real providers/models (requires real creds):

- Live suite (models + gateway tool/image probes): `pnpm test:live`

Tip: when you only need one failing case, prefer narrowing live tests via the allowlist env vars described below.

## Test suites (what runs where)

Think of the suites as “increasing realism” (and increasing flakiness/cost):

### Unit / integration (default)

- Command: `pnpm test`
- Config: `scripts/test-parallel.mjs` (runs `vitest.unit.config.ts`, `vitest.extensions.config.ts`, `vitest.gateway.config.ts`)
- Files: `src/**/*.test.ts`, `extensions/**/*.test.ts`
- Scope:
  - Pure unit tests
  - In-process integration tests (gateway auth, routing, tooling, parsing, config)
  - Deterministic regressions for known bugs
- Expectations:
  - Runs in CI
  - No real keys required
  - Should be fast and stable
- Runtime closure loop note:
  - When you touch checkpoint-driven continuation, keep at least one deterministic backend scenario that proves `blocked -> approved -> resumed -> completed` plus a machine-checkable outcome assertion.
  - Current reference coverage lives in `src/gateway/server.node-invoke-approval-bypass.test.ts`, `src/platform/bootstrap/service.test.ts`, and `src/agents/pi-embedded-runner/usage-reporting.test.ts`.
- Semantic outcome note:
  - When you touch unattended orchestration, keep at least one deterministic scenario where `completionOutcome` and `acceptanceOutcome` directly drive the backend decision (`close`, `retry`, or `escalate`) rather than asserting only on assistant text.
  - Current reference coverage lives in `src/platform/runtime/service.test.ts`, `src/cron/isolated-agent/run.interim-retry.test.ts`, and `src/agents/pi-embedded-runner/usage-reporting.test.ts`.
- Messaging ingress parity note:
  - When you touch main reply or followup orchestration, keep at least one deterministic scenario where the messaging path re-evaluates acceptance from real reply payload evidence and another where a persisted semantic retry rehydrates after in-memory reset.
  - Current reference coverage lives in `src/platform/decision/input.test.ts`, `src/auto-reply/reply/agent-runner.misc.runreplyagent.test.ts`, `src/auto-reply/reply/followup-runner.test.ts`, and `src/auto-reply/reply/reply-flow.test.ts`.
- Verified delivery note:
  - When you touch outbound closure or acceptance evidence, keep one scenario where `staged` output is not treated as delivered truth after send failure and one where post-send receipts close the run only after confirmed delivery evidence.
  - Current reference coverage lives in `src/platform/runtime/service.test.ts`, `src/auto-reply/reply/route-reply.test.ts`, and `src/auto-reply/dispatch.delivery-closure.test.ts`.
- Idempotent recovery note:
  - When you touch replay-sensitive side effects, keep at least one deterministic scenario where a `confirmed` action survives restart/recovery without a second external send and one non-messaging continuation scenario where a confirmed bootstrap/artifact action does not execute twice on resume.
  - Current reference coverage lives in `src/infra/outbound/delivery-queue.recovery.test.ts`, `src/platform/bootstrap/service.test.ts`, `src/platform/artifacts/service.test.ts`, and `src/platform/runtime/service.test.ts`.
- Contract verification note:
  - When you touch execution truth, keep one deterministic scenario where a formally successful tool/result path still produces `contract_mismatch` until verified output or confirmed delivery appears, and one scenario where `no_progress` drives a bounded supervisor retry instead of a close or infinite loop.
  - For non-messaging closure, keep one deterministic scenario where `derived` runtime evidence is not enough to close a bootstrap/artifact-heavy run, and one scenario where a verified structured receipt does allow the close path.
  - When you touch remediation selection, keep one scenario where `retry` still means `semantic_retry`, one where the same coarse `retry` resolves to `bootstrap`, `provider_fallback`, or `auth_refresh`, and one post-restart scenario where a persisted semantic followup queue drains again without a fresh enqueue.
  - For Stage 15-style recovery changes, keep one deterministic scenario where delivery backlog drains after backoff without a gateway restart, one where a recovery budget flips the supervisor from `retry` to explicit `stop` or `escalate`, and one cross-surface scenario where cron/messaging both honor the same `recoveryPolicy` exhaustion semantics.
  - For Stage 16-style intent changes, keep one parity scenario where embedded and messaging closure both reuse the same declared `executionIntent`, one lifecycle scenario where `before_recipe_execute` and `after_recipe_execute` carry structured intent/closure truth across the plugin boundary, and one durable closure scenario where the final acceptance/supervisor outcome can be rehydrated from the runtime closure store.
  - Current reference coverage lives in `src/platform/runtime/service.test.ts`, `src/auto-reply/reply/agent-runner-helpers.test.ts`, `src/agents/pi-embedded-runner/usage-reporting.test.ts`, `src/plugins/hooks.phase-hooks.test.ts`, and `src/gateway/server/readiness.test.ts`.
- Runtime activation note:
  - When you touch planner/recipe activation on the agent path, keep one regression that proves `platformExecutionContext` reaches embedded runner hook evaluation with the selected recipe/profile/runtime hints, and one regression that proves prompt/LLM hook contexts receive the same structured `ctx.platformExecution` instead of recomputing from raw prompt text.
  - Keep at least one plugin-side regression where pre-resolved `prependContext` / `prependSystemContext` are reused by the platform hook layer instead of rebuilding the route contract ad hoc.
  - Current reference coverage lives in `src/agents/agent-command.stage2.test.ts`, `src/agents/pi-embedded-runner/run.overflow-compaction.test.ts`, `src/agents/pi-embedded-runner/run/attempt.test.ts`, and `src/platform/plugin.test.ts`.
- Surface parity note:
  - When you touch secondary execution surfaces, keep one regression where a CLI-backed path reuses canonical runtime prompt/system context from the already-resolved `platformExecutionContext`, and one regression where cron timeout/fallback defaults are derived from the same runtime plan rather than hand-maintained side policy.
  - Also keep at least one cron regression that proves the same structured runtime context reaches the actual runner call (`embedded` or `CLI`) instead of being recomputed deeper in the surface-specific branch.
  - Current reference coverage lives in `src/agents/cli-runner.test.ts`, `src/cron/isolated-agent/run.owner-auth.test.ts`, `src/cron/isolated-agent/run.skill-filter.test.ts`, and `src/cron/isolated-agent/run.payload-fallbacks.test.ts`.
- Platform catalog note:
  - When you touch platform catalog surfaces, keep one plugin regression proving `platform.recipes.*` and `platform.capabilities.*` are actually registered, one gateway regression proving recipe/capability payloads stay read-only and reference shared registry data, and one UI regression proving the overview specialist surface renders the catalog without bypassing gateway methods.
  - Current reference coverage lives in `src/platform/plugin.test.ts`, `src/platform/catalog/gateway.test.ts`, `ui/src/ui/controllers/catalog.test.ts`, and `ui/src/ui/views/specialist-context.test.ts`.
- Runtime operator note:
  - When you touch operator-facing runtime surfaces, keep one regression where checkpoint/operator hints remain derived from canonical runtime checkpoint data, one controller regression where `platform.runtime.checkpoints/actions/closures` are loaded together as a single inspector flow, and one UI regression where sessions or adjacent operator surfaces render that runtime state without inventing a second source of truth.
  - When you touch operator recovery actions, also keep one regression where a recovery write path reuses canonical backend methods/scopes instead of bypassing them, and one regression where the inspector reloads the same ledger after the action rather than mutating local view state ad hoc.
  - Current reference coverage lives in `src/platform/runtime/gateway.test.ts`, `src/platform/runtime/recovery-operator-hint.test.ts`, `src/platform/plugin.test.ts`, `src/gateway/method-scopes.test.ts`, `ui/src/ui/controllers/runtime-inspector.test.ts`, `ui/src/ui/views/sessions.test.ts`, `ui/src/ui/views/specialist-context.test.ts`, and `ui/src/ui/views/bootstrap.test.ts`.
- Operator trust note:
  - When you touch confirmation guardrails or runtime attribution, keep one UI regression where a high-risk recovery action is blocked unless the confirmation step is accepted, and one gateway/runtime regression where the same operator write path returns durable `what/who/when` attribution in checkpoint or action detail.
  - Current reference coverage lives in `ui/src/ui/controllers/runtime-inspector.test.ts`, `ui/src/ui/views/sessions.test.ts`, `src/platform/runtime/gateway.test.ts`, `src/platform/bootstrap/gateway.test.ts`, and `src/platform/artifacts/gateway.test.ts`.
- Operator correlation note:
  - When you touch overview attention, deep links, or cross-surface operator routing, keep one regression where attention items are derived from existing canonical session/runtime/bootstrap state, one regression where tab-specific query state survives refresh/popstate, and one regression where linked bootstrap/artifact targets open the correct record without manual id lookup.
  - If you touch chat/overview entrypoints or sidebar navigation, keep one regression where the initiating handler calls the same canonical URL-sync helper used by the destination surface, and one render-level regression where open-in-new-tab `href`s reuse the shared routing contract instead of falling back to path-only links.
  - If you touch inline links inside operator surfaces such as `sessions` or `cron`, keep one render-level regression where row/action `href`s are built through the shared routing helper rather than ad-hoc `pathForTab(...)` string assembly, so modified-click and open-in-new-tab keep matching the canonical destination contract.
- If you touch overview dashboard cards, keep them as real anchor targets rather than click-only buttons, with a regression that covers both the rendered canonical `href` and the primary-click callback handoff for the same destination.
- If you touch overview recent-session rows, keep them on the same shared chat/session routing contract as other entry surfaces, with a regression for both the rendered `chat` href and the primary-click handoff callback.
- If you touch usage session rows, keep them on the same shared `usage` routing contract as the restored usage surface, with a regression for the rendered canonical `usage` href plus the primary-click and shift-click JS handoff semantics for the same session target.
  - If you extend `bootstrap` or `artifacts` routing to include list-level investigation state, keep one regression where `bootstrapQ` / `artifactQ` hydrate from URL state together with `bootstrapRequest` / `artifact`, one regression where the same state serializes back into a shareable link via `syncUrlWithTab`, and one render-level regression where filter interactions still preserve the existing selected-record drill-down flow.
  - If overview preloads runtime state for the active session, keep one regression proving it reuses the same handoff-aware `runtimeRun` selection as the Sessions inspect path instead of falling back to session-only scope.
  - If you extend `sessions` routing beyond runtime scope, keep one regression where list-level filters/search/sort/pagination survive refresh/popstate together with the existing runtime deep link, and one regression where invalid page/sort query state falls back without breaking the rest of the sessions URL contract.
- If you extend `sessions` runtime routing beyond `runtimeSession` / `runtimeRun` / `checkpoint`, keep one regression where selected runtime action/closure detail survives refresh/popstate together with the existing runtime scope, and one regression where stale `runtimeAction` / `runtimeClosure` query state is canonicalized without dropping the rest of the sessions investigation context.
  - If you touch `sessions` runtime inspector controls, keep them on the shared runtime routing helper, with a regression for the rendered canonical `sessions` href plus the primary-click vs modified-click handoff semantics for representative `Inspect`, checkpoint, action, and closure targets.
  - If you add operator routing for `usage`, keep one regression where the canonical Usage surface restores `usageFrom` / `usageTo` / `usageTz` / `usageSession` / `usageQ` from URL state, one regression where the same state serializes back into a shareable link, and one regression where a restored single-session deep link reopens the same detail path after refresh/popstate.
  - If you add operator routing for `agents`, keep one regression where the canonical Agents surface restores `agent` / `agentsPanel` / `agentFile` from URL state, one regression where the same state is serialized back into a shareable link, and one render-level regression where the restored file drill-down is visible after refresh/popstate.
  - If you touch agents shell controls, keep them on the shared `agents` routing contract, with a regression for the rendered canonical `agents` href plus the primary-click vs modified-click handoff semantics for representative panel and file targets.
  - If you add operator routing for `skills`, keep one regression where skills-related attention opens the canonical Skills surface with a persisted `skillFilter`, and one regression where the same filter still matches derived blocked/missing skill state after refresh/popstate.
  - If you add operator routing for `channels`, keep one regression where explicit channel errors open the canonical Channels surface with a persisted `channel` selection, and one render-level regression where the restored channel selection is visible in the channels grid after refresh/popstate.
  - If you touch channels card shells, keep them on the shared `channels` routing contract, with a regression for the rendered canonical `channels` href plus the primary-click vs modified-click handoff semantics for the same channel target.
  - If you add operator routing for `instances`, keep one regression where `instancesReveal` hydrates from URL state into the canonical Instances privacy toggle, one regression where the same reveal state serializes back into a shareable link via `syncUrlWithTab`, and one render-level regression where the restored masked-vs-revealed mode is visible without relying on module-local view state.
- If you add operator routing for the settings family (`config`, `communications`, `appearance`, `automation`, `infrastructure`, `aiAgents`), keep one regression where tab-prefixed mode/search/section/subsection state hydrates from URL state into the canonical settings surface, one regression where the same navigation context serializes back into a shareable link, and one regression where switching tabs clears the previous settings-family query contract instead of leaking stale navigation state.
  - If you touch settings shell controls, keep them on the shared settings-family routing contract, with a regression for the rendered canonical settings `href` plus the primary-click vs modified-click handoff semantics for representative section and mode targets.
  - If you add operator routing for `exec approvals` or `nodes`, keep one regression where pending approval attention opens the canonical Nodes surface with persisted `execTarget` / `execNode` / `execAgent` state, and one render-level regression where the restored approvals target/scope is visible in the Nodes exec approvals UI after refresh/popstate.
  - If you touch exec approvals scope controls inside `nodes`, keep them on the shared `nodes` routing contract, with a regression for the rendered canonical `nodes` href plus the primary-click vs modified-click handoff semantics for representative defaults and agent targets.
  - If you add operator routing for `debug`, keep one regression where `debugMethod` / `debugParams` hydrate from URL state into the Manual RPC controls, one regression where the same state serializes back into a shareable link via `syncUrlWithTab`, and one regression where invalid or empty `debugParams` falls back to the default JSON payload without replaying the old call result.
  - If you add operator routing for `logs`, keep one regression where a gateway-level error opens the canonical Logs surface, one regression where `logQ` deep-link state survives refresh/popstate, and one render-level regression where the restored log filter is visible in the Logs UI after refresh/popstate.
- Current reference coverage lives in `ui/src/ui/app-settings.test.ts`, `ui/src/ui/views/overview-attention.test.ts`, `ui/src/ui/controllers/bootstrap.test.ts`, `ui/src/ui/controllers/artifacts.test.ts`, `ui/src/ui/views/bootstrap.test.ts`, `ui/src/ui/views/artifacts.test.ts`, `ui/src/ui/views/debug.test.ts`, `ui/src/ui/views/instances.test.ts`, and `ui/src/ui/views/sessions.test.ts`.
- Cron correlation note:
  - When you touch cron/operator routing, keep one regression where failed or overdue cron attention items open the canonical cron surface, one regression where `cronJob` deep-link state survives refresh/popstate, and one regression where cron run history opens the linked operator context without manual session lookup.
  - If you touch cron job rows, keep them on the shared `cron` routing contract, with a regression for the rendered canonical `cron` href plus the primary-click vs modified-click handoff semantics for the same job-history target.
  - If you extend `cron` routing to include list-level investigation state, keep one regression where `cronQ` / `cronEnabled` / `cronSchedule` / `cronStatus` / `cronSort` / `cronDir` hydrate from URL state together with `cronJob`, one regression where the same state serializes back into a shareable link, and one render/controller regression where job-list interactions still preserve the existing `cronJob` drill-down flow under active list filters.
  - If you extend `cron` routing to include run-history (runs explorer) state, keep one regression where `cronRunsScope` / `cronRunsQ` / `cronRunsSort` / `cronRunsStatus` / `cronRunsDelivery` hydrate from URL state together with jobs-level `cron*` and `cronJob`, one regression where the same state serializes back via `syncUrlWithTab`, one regression where invalid run filter/sort/scope values fall back without breaking the jobs list URL contract, and one regression where `cronRunsScope=job` with a missing or stale `cronJob` soft-falls back to `all` after refresh without dropping jobs list filters.
  - Current reference coverage lives in `ui/src/ui/app-settings.test.ts`, `ui/src/ui/controllers/cron.test.ts`, and `ui/src/ui/views/cron.test.ts`.
- Handoff truth note:
  - When you touch session handoff or runtime inspect routing, keep one regression where `handoffTruthSource === recovery` prefers `handoffRunId` / `handoffRequestRunId` over persisted closure history, and one regression where `handoffTruthSource === closure` preserves the closure-aligned inspect path without inventing a second source of truth.
  - Current reference coverage lives in `ui/src/ui/views/sessions.test.ts` and `ui/src/ui/controllers/sessions.test.ts`.
- Scheduler note:
  - `pnpm test` now keeps a small checked-in behavioral manifest for true pool/isolation overrides and a separate timing snapshot for the slowest unit files.
  - Shared unit coverage now defaults to `threads`, while the manifest keeps the measured fork-only exceptions and heavy singleton lanes explicit.
  - The shared extension lane still defaults to `threads`; the wrapper keeps explicit fork-only exceptions in `test/fixtures/test-parallel.behavior.json` when a file cannot safely share a non-isolated worker.
  - The channel suite (`vitest.channels.config.ts`) now also defaults to `threads`; the March 22, 2026 direct full-suite control run passed clean without channel-specific fork exceptions.
  - The wrapper peels the heaviest measured files into dedicated lanes instead of relying on a growing hand-maintained exclusion list.
  - Refresh the timing snapshot with `pnpm test:perf:update-timings` after major suite shape changes.
- Embedded runner note:
  - When you change message-tool discovery inputs or compaction runtime context,
    keep both levels of coverage.
  - Add focused helper regressions for pure routing/normalization boundaries.
  - Also keep the embedded runner integration suites healthy:
    `src/agents/pi-embedded-runner/compact.hooks.test.ts`,
    `src/agents/pi-embedded-runner/run.overflow-compaction.test.ts`, and
    `src/agents/pi-embedded-runner/run.overflow-compaction.loop.test.ts`.
  - Those suites verify that scoped ids and compaction behavior still flow
    through the real `run.ts` / `compact.ts` paths; helper-only tests are not a
    sufficient substitute for those integration paths.
- Pool note:
  - Base Vitest config still defaults to `forks`.
  - Unit wrapper lanes default to `threads`, with explicit manifest fork-only exceptions.
  - Extension scoped config defaults to `threads`.
  - Channel scoped config defaults to `threads`.
  - Unit, channel, and extension configs default to `isolate: false` for faster file startup.
  - `pnpm test` also passes `--isolate=false` at the wrapper level.
  - Opt back into Vitest file isolation with `OPENCLAW_TEST_ISOLATE=1 pnpm test`.
  - `OPENCLAW_TEST_NO_ISOLATE=0` or `OPENCLAW_TEST_NO_ISOLATE=false` also force isolated runs.
- Fast-local iteration note:
  - `pnpm test:changed` runs the wrapper with `--changed origin/main`.
  - The base Vitest config marks the wrapper manifests/config files as `forceRerunTriggers` so changed-mode reruns stay correct when scheduler inputs change.
  - Vitest's filesystem module cache is now enabled by default for Node-side test reruns.
  - Opt out with `OPENCLAW_VITEST_FS_MODULE_CACHE=0` or `OPENCLAW_VITEST_FS_MODULE_CACHE=false` if you suspect stale transform cache behavior.
- Perf-debug note:
  - `pnpm test:perf:imports` enables Vitest import-duration reporting plus import-breakdown output.
  - `pnpm test:perf:imports:changed` scopes the same profiling view to files changed since `origin/main`.
  - `pnpm test:perf:profile:main` writes a main-thread CPU profile for Vitest/Vite startup and transform overhead.
  - `pnpm test:perf:profile:runner` writes runner CPU+heap profiles for the unit suite with file parallelism disabled.

### E2E (gateway smoke)

- Command: `pnpm test:e2e`
- Config: `vitest.e2e.config.ts`
- Files: `src/**/*.e2e.test.ts`, `test/**/*.e2e.test.ts`
- Runtime defaults:
  - Uses Vitest `forks` for deterministic cross-file isolation.
  - Uses adaptive workers (CI: up to 2, local: 1 by default).
  - Runs in silent mode by default to reduce console I/O overhead.
- Useful overrides:
  - `OPENCLAW_E2E_WORKERS=<n>` to force worker count (capped at 16).
  - `OPENCLAW_E2E_VERBOSE=1` to re-enable verbose console output.
- Scope:
  - Multi-instance gateway end-to-end behavior
  - WebSocket/HTTP surfaces, node pairing, and heavier networking
- Expectations:
  - Runs in CI (when enabled in the pipeline)
  - No real keys required
  - More moving parts than unit tests (can be slower)

### E2E: OpenShell backend smoke

- Command: `pnpm test:e2e:openshell`
- File: `test/openshell-sandbox.e2e.test.ts`
- Scope:
  - Starts an isolated OpenShell gateway on the host via Docker
  - Creates a sandbox from a temporary local Dockerfile
  - Exercises OpenClaw's OpenShell backend over real `sandbox ssh-config` + SSH exec
  - Verifies remote-canonical filesystem behavior through the sandbox fs bridge
- Expectations:
  - Opt-in only; not part of the default `pnpm test:e2e` run
  - Requires a local `openshell` CLI plus a working Docker daemon
  - Uses isolated `HOME` / `XDG_CONFIG_HOME`, then destroys the test gateway and sandbox
- Useful overrides:
  - `OPENCLAW_E2E_OPENSHELL=1` to enable the test when running the broader e2e suite manually
  - `OPENCLAW_E2E_OPENSHELL_COMMAND=/path/to/openshell` to point at a non-default CLI binary or wrapper script

### Live (real providers + real models)

- Command: `pnpm test:live`
- Config: `vitest.live.config.ts`
- Files: `src/**/*.live.test.ts`
- Default: **enabled** by `pnpm test:live` (sets `OPENCLAW_LIVE_TEST=1`)
- Scope:
  - “Does this provider/model actually work _today_ with real creds?”
  - Catch provider format changes, tool-calling quirks, auth issues, and rate limit behavior
- Expectations:
  - Not CI-stable by design (real networks, real provider policies, quotas, outages)
  - Costs money / uses rate limits
  - Prefer running narrowed subsets instead of “everything”
  - Live runs will source `~/.profile` to pick up missing API keys
- API key rotation (provider-specific): set `*_API_KEYS` with comma/semicolon format or `*_API_KEY_1`, `*_API_KEY_2` (for example `OPENAI_API_KEYS`, `ANTHROPIC_API_KEYS`, `GEMINI_API_KEYS`) or per-live override via `OPENCLAW_LIVE_*_KEY`; tests retry on rate limit responses.
- Progress/heartbeat output:
  - Live suites now emit progress lines to stderr so long provider calls are visibly active even when Vitest console capture is quiet.
  - `vitest.live.config.ts` disables Vitest console interception so provider/gateway progress lines stream immediately during live runs.
  - Tune direct-model heartbeats with `OPENCLAW_LIVE_HEARTBEAT_MS`.
  - Tune gateway/probe heartbeats with `OPENCLAW_LIVE_GATEWAY_HEARTBEAT_MS`.

## Which suite should I run?

Use this decision table:

- Editing logic/tests: run `pnpm test` (and `pnpm test:coverage` if you changed a lot)
- Touching gateway networking / WS protocol / pairing: add `pnpm test:e2e`
- Debugging “my bot is down” / provider-specific failures / tool calling: run a narrowed `pnpm test:live`

WebSocket `sessions.changed` payloads intentionally mirror the gateway session row model (including `runClosureSummary`, recovery fields, and handoff projection) at the **top level**, not only inside nested `session`, so thin clients stay aligned with `sessions.list` without re-implementing field lists. Reference: `src/gateway/session-broadcast-snapshot.ts`, `src/gateway/session-event-hub.ts`, and their focused tests.

When validating consumer behavior, remember that `JSON.stringify()` drops keys whose value is `undefined`. For Stage 29 consumer adoption this means a missing optional `handoff*`, recovery, or `runClosureSummary` key on the wire should be interpreted as "field currently unset"; consumer-side caches/tests must not require those keys to be present with an explicit `undefined`.

When you change producer-side session event behavior, keep the regression matrix split by variant:

- `buildGatewaySessionBroadcastSnapshot()` remains the only lower-level field enumerator for session row broadcast data.
- `src/gateway/session-event-hub.test.ts` should lock the policy differences between mutation, lifecycle, transcript, and `session.message` surfaces.
- Gateway integration coverage should still prove the real emit paths stay wired through the same hub (`src/gateway/server.sessions.gateway-server-sessions-a.test.ts`, `src/gateway/session-message-events.test.ts`, `src/gateway/server-chat.agent-events.test.ts`).

## Local runtime recovery smoke

Run this after changes that touch delivery truth, closure truth, restart/recovery behavior, or operator inspection surfaces.

Acceptance criteria:

- A successful send shows the same story in runtime actions and runtime closures.
- A `partial` or `failed` delivery does not get reported as clean delivered closure truth.
- After restart/recovery, previously confirmed delivery actions are still visible and are not duplicated by resume logic.
- The operator surfaces are enough to correlate `messaging_delivery` actions, closure receipts, and recovery checkpoints without guessing from logs alone.

Recommended flow:

1. Run the default backend gate first.

```bash
pnpm build
pnpm check
OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test
```

2. If the change touched gateway orchestration, pairing, or cross-process recovery, add:

```bash
pnpm test:e2e
```

3. Start or restart the local gateway and confirm the control plane is healthy.

```bash
openclaw gateway status --deep
openclaw channels status --probe
```

4. Exercise one real messaging or local delivery scenario, then inspect the runtime ledgers directly through gateway RPC.

```bash
openclaw gateway call sessions.send --params '{"key":"agent:dev:main","message":"stage smoke","idempotencyKey":"request-123"}'
openclaw gateway call platform.runtime.actions.list --params '{"idempotencyKey":"request-123","kind":"messaging_delivery"}'
openclaw gateway call platform.runtime.closures.list --params '{"requestRunId":"request-123"}'
openclaw gateway call platform.runtime.actions.list --params '{"sessionKey":"agent:dev:main","kind":"messaging_delivery"}'
openclaw gateway call platform.runtime.closures.list --params '{"sessionKey":"agent:dev:main"}'
openclaw gateway call platform.runtime.closures.get --params '{"runId":"<run-id>"}'
openclaw gateway call platform.runtime.checkpoints.list --params '{"sessionKey":"agent:dev:main"}'
```

Continuation-aware handoff rules:

- Treat `sessions.send.idempotencyKey` as the stable request anchor for the entire handoff.
- Treat runtime `runId` as execution-local. A continuation, retry, or resumed run may produce a different final `runId`.
- Treat `sessions.list` / `sessions.get` handoff fields as the operator-facing summary:
  `handoffRequestRunId` is the stable request anchor, `handoffRunId` is the current runtime target, and `handoffTruthSource` tells you whether the row is currently following durable closure history or active recovery.
- If `handoffTruthSource` is `recovery`, trust the handoff fields over the persisted `runClosureSummary.runId`; the closure summary remains useful as durable history, but the in-flight recovery run is the current handoff truth.
- Start handoff inspection with `platform.runtime.closures.list --params '{"requestRunId":"<request-id>"}'` and `platform.runtime.actions.list --params '{"idempotencyKey":"<request-id>","kind":"messaging_delivery"}'`.
- Use the final closure returned by that request anchor to identify the final runtime `runId`, then fetch the full closure via `platform.runtime.closures.get`.
- If compaction or retry changed what the session row shows, prefer the request-anchored runtime ledgers over manual session transcript correlation.

5. For one concrete delivery action, fetch the full action receipt and compare it with the closure receipts and recovery state.

```bash
openclaw gateway call platform.runtime.actions.get --params '{"actionId":"<action-id>"}'
```

What to verify during the smoke:

- `sessions.get` or `sessions.list` exposes `handoffRequestRunId`, `handoffRunId`, and `handoffTruthSource` that agree with the runtime ledger for the scenario under test.
- `platform.runtime.closures.list --params '{"requestRunId":"<request-id>"}'` returns the final closure chain for the original request, even if the final `runId` differs from the `idempotencyKey`.
- `platform.runtime.actions.list --params '{"idempotencyKey":"<request-id>","kind":"messaging_delivery"}'` returns at least one delivery action you can hand off without guessing.
- `platform.runtime.actions.list` shows the expected `messaging_delivery` action state (`confirmed`, `partial`, or `failed`) for the run under test.
- `platform.runtime.actions.get` returns the receipt payload you expect for that action, including `deliveryResults` when the channel produced confirmed delivery evidence.
- `platform.runtime.closures.get` reports closure outcome, `executionVerification.receipts`, and acceptance/remediation data that agree with the action ledger.
- `platform.runtime.checkpoints.list` shows the recovery checkpoint lifecycle when a restart or continuation path is involved.
- If a restart/recovery path is part of the smoke, the resumed run reuses durable action truth instead of sending a second confirmed delivery for the same action.

Targeted references while debugging:

- Delivery truth and queue recovery: `src/infra/outbound/delivery-queue.recovery.test.ts`
- Delivery-aware closure parity: `src/auto-reply/dispatch.delivery-closure.test.ts`
- Reply-path delivery parity: `src/auto-reply/reply/route-reply.test.ts`
- Runtime closure and receipt evaluation: `src/platform/runtime/service.test.ts`

Before a limited internal deploy or manual shared-host run, capture and keep:

- The original request anchor (`sessions.send.idempotencyKey`)
- The exact `runId` and at least one inspected `actionId`
- The `platform.runtime.closures.get` output for the smoke run
- The matching `platform.runtime.actions.get` output for the delivery action you validated
- The relevant `platform.runtime.checkpoints.list` slice if recovery/resume was part of the scenario

## Live: Android node capability sweep

- Test: `src/gateway/android-node.capabilities.live.test.ts`
- Script: `pnpm android:test:integration`
- Goal: invoke **every command currently advertised** by a connected Android node and assert command contract behavior.
- Scope:
  - Preconditioned/manual setup (the suite does not install/run/pair the app).
  - Command-by-command gateway `node.invoke` validation for the selected Android node.
- Required pre-setup:
  - Android app already connected + paired to the gateway.
  - App kept in foreground.
  - Permissions/capture consent granted for capabilities you expect to pass.
- Optional target overrides:
  - `OPENCLAW_ANDROID_NODE_ID` or `OPENCLAW_ANDROID_NODE_NAME`.
  - `OPENCLAW_ANDROID_GATEWAY_URL` / `OPENCLAW_ANDROID_GATEWAY_TOKEN` / `OPENCLAW_ANDROID_GATEWAY_PASSWORD`.
- Full Android setup details: [Android App](/platforms/android)

## Live: model smoke (profile keys)

Live tests are split into two layers so we can isolate failures:

- “Direct model” tells us the provider/model can answer at all with the given key.
- “Gateway smoke” tells us the full gateway+agent pipeline works for that model (sessions, history, tools, sandbox policy, etc.).

### Layer 1: Direct model completion (no gateway)

- Test: `src/agents/models.profiles.live.test.ts`
- Goal:
  - Enumerate discovered models
  - Use `getApiKeyForModel` to select models you have creds for
  - Run a small completion per model (and targeted regressions where needed)
- How to enable:
  - `pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` if invoking Vitest directly)
- Set `OPENCLAW_LIVE_MODELS=modern` (or `all`, alias for modern) to actually run this suite; otherwise it skips to keep `pnpm test:live` focused on gateway smoke
- How to select models:
  - `OPENCLAW_LIVE_MODELS=modern` to run the modern allowlist (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.7, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` is an alias for the modern allowlist
  - or `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (comma allowlist)
- How to select providers:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (comma allowlist)
- Where keys come from:
  - By default: profile store and env fallbacks
  - Set `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to enforce **profile store** only
- Why this exists:
  - Separates “provider API is broken / key is invalid” from “gateway agent pipeline is broken”
  - Contains small, isolated regressions (example: OpenAI Responses/Codex Responses reasoning replay + tool-call flows)

### Layer 2: Gateway + dev agent smoke (what "@openclaw" actually does)

- Test: `src/gateway/gateway-models.profiles.live.test.ts`
- Goal:
  - Spin up an in-process gateway
  - Create/patch a `agent:dev:*` session (model override per run)
  - Iterate models-with-keys and assert:
    - “meaningful” response (no tools)
    - a real tool invocation works (read probe)
    - optional extra tool probes (exec+read probe)
    - OpenAI regression paths (tool-call-only → follow-up) keep working
- Probe details (so you can explain failures quickly):
  - `read` probe: the test writes a nonce file in the workspace and asks the agent to `read` it and echo the nonce back.
  - `exec+read` probe: the test asks the agent to `exec`-write a nonce into a temp file, then `read` it back.
  - image probe: the test attaches a generated PNG (cat + randomized code) and expects the model to return `cat <CODE>`.
  - Implementation reference: `src/gateway/gateway-models.profiles.live.test.ts` and `src/gateway/live-image-probe.ts`.
- How to enable:
  - `pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` if invoking Vitest directly)
- How to select models:
  - Default: modern allowlist (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.7, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` is an alias for the modern allowlist
  - Or set `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (or comma list) to narrow
- How to select providers (avoid “OpenRouter everything”):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (comma allowlist)
- Tool + image probes are always on in this live test:
  - `read` probe + `exec+read` probe (tool stress)
  - image probe runs when the model advertises image input support
  - Flow (high level):
    - Test generates a tiny PNG with “CAT” + random code (`src/gateway/live-image-probe.ts`)
    - Sends it via `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - Gateway parses attachments into `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - Embedded agent forwards a multimodal user message to the model
    - Assertion: reply contains `cat` + the code (OCR tolerance: minor mistakes allowed)

Tip: to see what you can test on your machine (and the exact `provider/model` ids), run:

```bash
openclaw models list
openclaw models list --json
```

## Live: Anthropic setup-token smoke

- Test: `src/agents/anthropic.setup-token.live.test.ts`
- Goal: verify Claude Code CLI setup-token (or a pasted setup-token profile) can complete an Anthropic prompt.
- Enable:
  - `pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` if invoking Vitest directly)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- Token sources (pick one):
  - Profile: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - Raw token: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- Model override (optional):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

Setup example:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live: CLI backend smoke (Claude Code CLI or other local CLIs)

- Test: `src/gateway/gateway-cli-backend.live.test.ts`
- Goal: validate the Gateway + agent pipeline using a local CLI backend, without touching your default config.
- Enable:
  - `pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` if invoking Vitest directly)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- Defaults:
  - Model: `claude-cli/claude-sonnet-4-6`
  - Command: `claude`
  - Args: `["-p","--output-format","json","--permission-mode","bypassPermissions"]`
- Overrides (optional):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.4"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` to send a real image attachment (paths are injected into the prompt).
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` to pass image file paths as CLI args instead of prompt injection.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (or `"list"`) to control how image args are passed when `IMAGE_ARG` is set.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` to send a second turn and validate resume flow.
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` to keep Claude Code CLI MCP config enabled (default disables MCP config with a temporary empty file).

Example:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-6" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### Recommended live recipes

Narrow, explicit allowlists are fastest and least flaky:

- Single model, direct (no gateway):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- Single model, gateway smoke:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Tool calling across several providers:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/MiniMax-M2.7" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google focus (Gemini API key + Antigravity):
  - Gemini (API key): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

Notes:

- `google/...` uses the Gemini API (API key).
- `google-antigravity/...` uses the Antigravity OAuth bridge (Cloud Code Assist-style agent endpoint).
- `google-gemini-cli/...` uses the local Gemini CLI on your machine (separate auth + tooling quirks).
- Gemini API vs Gemini CLI:
  - API: OpenClaw calls Google’s hosted Gemini API over HTTP (API key / profile auth); this is what most users mean by “Gemini”.
  - CLI: OpenClaw shells out to a local `gemini` binary; it has its own auth and can behave differently (streaming/tool support/version skew).

## Live: model matrix (what we cover)

There is no fixed “CI model list” (live is opt-in), but these are the **recommended** models to cover regularly on a dev machine with keys.

### Modern smoke set (tool calling + image)

This is the “common models” run we expect to keep working:

- OpenAI (non-Codex): `openai/gpt-5.2` (optional: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.4`
- Anthropic: `anthropic/claude-opus-4-6` (or `anthropic/claude-sonnet-4-6`)
- Google (Gemini API): `google/gemini-3.1-pro-preview` and `google/gemini-3-flash-preview` (avoid older Gemini 2.x models)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` and `google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/MiniMax-M2.7`

Run gateway smoke with tools + image:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.4,anthropic/claude-opus-4-6,google/gemini-3.1-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/MiniMax-M2.7" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### Baseline: tool calling (Read + optional Exec)

Pick at least one per provider family:

- OpenAI: `openai/gpt-5.2` (or `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-6` (or `anthropic/claude-sonnet-4-6`)
- Google: `google/gemini-3-flash-preview` (or `google/gemini-3.1-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/MiniMax-M2.7`

Optional additional coverage (nice to have):

- xAI: `xai/grok-4` (or latest available)
- Mistral: `mistral/`… (pick one “tools” capable model you have enabled)
- Cerebras: `cerebras/`… (if you have access)
- LM Studio: `lmstudio/`… (local; tool calling depends on API mode)

### Vision: image send (attachment → multimodal message)

Include at least one image-capable model in `OPENCLAW_LIVE_GATEWAY_MODELS` (Claude/Gemini/OpenAI vision-capable variants, etc.) to exercise the image probe.

### Aggregators / alternate gateways

If you have keys enabled, we also support testing via:

- OpenRouter: `openrouter/...` (hundreds of models; use `openclaw models scan` to find tool+image capable candidates)
- OpenCode: `opencode/...` for Zen and `opencode-go/...` for Go (auth via `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

More providers you can include in the live matrix (if you have creds/config):

- Built-in: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `opencode-go`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- Via `models.providers` (custom endpoints): `minimax` (cloud/API), plus any OpenAI/Anthropic-compatible proxy (LM Studio, vLLM, LiteLLM, etc.)

Tip: don’t try to hardcode “all models” in docs. The authoritative list is whatever `discoverModels(...)` returns on your machine + whatever keys are available.

## Credentials (never commit)

Live tests discover credentials the same way the CLI does. Practical implications:

- If the CLI works, live tests should find the same keys.
- If a live test says “no creds”, debug the same way you’d debug `openclaw models list` / model selection.

- Profile store: `~/.openclaw/credentials/` (preferred; what “profile keys” means in the tests)
- Config: `~/.openclaw/openclaw.json` (or `OPENCLAW_CONFIG_PATH`)

If you want to rely on env keys (e.g. exported in your `~/.profile`), run local tests after `source ~/.profile`, or use the Docker runners below (they can mount `~/.profile` into the container).

## Deepgram live (audio transcription)

- Test: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- Enable: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## BytePlus coding plan live

- Test: `src/agents/byteplus.live.test.ts`
- Enable: `BYTEPLUS_API_KEY=... BYTEPLUS_LIVE_TEST=1 pnpm test:live src/agents/byteplus.live.test.ts`
- Optional model override: `BYTEPLUS_CODING_MODEL=ark-code-latest`

## Image generation live

- Test: `src/image-generation/runtime.live.test.ts`
- Command: `pnpm test:live src/image-generation/runtime.live.test.ts`
- Scope:
  - Enumerates every registered image-generation provider plugin
  - Loads missing provider env vars from your login shell (`~/.profile`) before probing
  - Uses live/env API keys ahead of stored auth profiles by default, so stale test keys in `auth-profiles.json` do not mask real shell credentials
  - Skips providers with no usable auth/profile/model
  - Runs the stock image-generation variants through the shared runtime capability:
    - `google:flash-generate`
    - `google:pro-generate`
    - `google:pro-edit`
    - `openai:default-generate`
- Current bundled providers covered:
  - `openai`
  - `google`
- Optional narrowing:
  - `OPENCLAW_LIVE_IMAGE_GENERATION_PROVIDERS="openai,google"`
  - `OPENCLAW_LIVE_IMAGE_GENERATION_MODELS="openai/gpt-image-1,google/gemini-3.1-flash-image-preview"`
  - `OPENCLAW_LIVE_IMAGE_GENERATION_CASES="google:flash-generate,google:pro-edit"`
- Optional auth behavior:
  - `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to force profile-store auth and ignore env-only overrides

## Docker runners (optional "works in Linux" checks)

These run `pnpm test:live` inside the repo Docker image, mounting your local config dir and workspace (and sourcing `~/.profile` if mounted). They also bind-mount only the needed CLI auth homes (or all supported ones when the run is not narrowed), then copy them into the container home before the run so external-CLI OAuth can refresh tokens without mutating the host auth store:

- Direct models: `pnpm test:docker:live-models` (script: `scripts/test-live-models-docker.sh`)
- Gateway + dev agent: `pnpm test:docker:live-gateway` (script: `scripts/test-live-gateway-models-docker.sh`)
- Onboarding wizard (TTY, full scaffolding): `pnpm test:docker:onboard` (script: `scripts/e2e/onboard-docker.sh`)
- Gateway networking (two containers, WS auth + health): `pnpm test:docker:gateway-network` (script: `scripts/e2e/gateway-network-docker.sh`)
- Plugins (install smoke + `/plugin` alias + Claude-bundle restart semantics): `pnpm test:docker:plugins` (script: `scripts/e2e/plugins-docker.sh`)

The live-model Docker runners also bind-mount the current checkout read-only and
stage it into a temporary workdir inside the container. This keeps the runtime
image slim while still running Vitest against your exact local source/config.
They also set `OPENCLAW_SKIP_CHANNELS=1` so gateway live probes do not start
real Telegram/Discord/etc. channel workers inside the container.
`test:docker:live-models` still runs `pnpm test:live`, so pass through
`OPENCLAW_LIVE_GATEWAY_*` as well when you need to narrow or exclude gateway
live coverage from that Docker lane.

Manual ACP plain-language thread smoke (not CI):

- `bun scripts/dev/discord-acp-plain-language-smoke.ts --channel <discord-channel-id> ...`
- Keep this script for regression/debug workflows. It may be needed again for ACP thread routing validation, so do not delete it.

Useful env vars:

- `OPENCLAW_CONFIG_DIR=...` (default: `~/.openclaw`) mounted to `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (default: `~/.openclaw/workspace`) mounted to `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (default: `~/.profile`) mounted to `/home/node/.profile` and sourced before running tests
- External CLI auth dirs under `$HOME` are mounted read-only under `/host-auth/...`, then copied into `/home/node/...` before tests start
  - Default: mount all supported dirs (`.codex`, `.claude`, `.qwen`, `.minimax`)
  - Narrowed provider runs mount only the needed dirs inferred from `OPENCLAW_LIVE_PROVIDERS` / `OPENCLAW_LIVE_GATEWAY_PROVIDERS`
  - Override manually with `OPENCLAW_DOCKER_AUTH_DIRS=all`, `OPENCLAW_DOCKER_AUTH_DIRS=none`, or a comma list like `OPENCLAW_DOCKER_AUTH_DIRS=.claude,.codex`
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` to narrow the run
- `OPENCLAW_LIVE_GATEWAY_PROVIDERS=...` / `OPENCLAW_LIVE_PROVIDERS=...` to filter providers in-container
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to ensure creds come from the profile store (not env)

## Docs sanity

Run docs checks after doc edits: `pnpm docs:list`.

## Offline regression (CI-safe)

These are “real pipeline” regressions without real providers:

- Gateway tool calling (mock OpenAI, real gateway + agent loop): `src/gateway/gateway.test.ts` (case: "runs a mock OpenAI tool call end-to-end via gateway agent loop")
- Gateway wizard (WS `wizard.start`/`wizard.next`, writes config + auth enforced): `src/gateway/gateway.test.ts` (case: "runs wizard over ws and writes auth token config")

## Agent reliability evals (skills)

We already have a few CI-safe tests that behave like “agent reliability evals”:

- Mock tool-calling through the real gateway + agent loop (`src/gateway/gateway.test.ts`).
- End-to-end wizard flows that validate session wiring and config effects (`src/gateway/gateway.test.ts`).

What’s still missing for skills (see [Skills](/tools/skills)):

- **Decisioning:** when skills are listed in the prompt, does the agent pick the right skill (or avoid irrelevant ones)?
- **Compliance:** does the agent read `SKILL.md` before use and follow required steps/args?
- **Workflow contracts:** multi-turn scenarios that assert tool order, session history carryover, and sandbox boundaries.

Future evals should stay deterministic first:

- A scenario runner using mock providers to assert tool calls + order, skill file reads, and session wiring.
- A small suite of skill-focused scenarios (use vs avoid, gating, prompt injection).
- Optional live evals (opt-in, env-gated) only after the CI-safe suite is in place.

## Contract tests (plugin and channel shape)

Contract tests verify that every registered plugin and channel conforms to its
interface contract. They iterate over all discovered plugins and run a suite of
shape and behavior assertions.

### Commands

- All contracts: `pnpm test:contracts`
- Channel contracts only: `pnpm test:contracts:channels`
- Provider contracts only: `pnpm test:contracts:plugins`

### Channel contracts

Located in `src/channels/plugins/contracts/*.contract.test.ts`:

- **plugin** - Basic plugin shape (id, name, capabilities)
- **setup** - Setup wizard contract
- **session-binding** - Session binding behavior
- **outbound-payload** - Message payload structure
- **inbound** - Inbound message handling
- **actions** - Channel action handlers
- **threading** - Thread ID handling
- **directory** - Directory/roster API
- **group-policy** - Group policy enforcement
- **status** - Channel status probes
- **registry** - Plugin registry shape

### Provider contracts

Located in `src/plugins/contracts/*.contract.test.ts`:

- **auth** - Auth flow contract
- **auth-choice** - Auth choice/selection
- **catalog** - Model catalog API
- **discovery** - Plugin discovery
- **loader** - Plugin loading
- **runtime** - Provider runtime
- **shape** - Plugin shape/interface
- **wizard** - Setup wizard

### When to run

- After changing plugin-sdk exports or subpaths
- After adding or modifying a channel or provider plugin
- After refactoring plugin registration or discovery

Contract tests run in CI and do not require real API keys.

## Adding regressions (guidance)

When you fix a provider/model issue discovered in live:

- Add a CI-safe regression if possible (mock/stub provider, or capture the exact request-shape transformation)
- If it’s inherently live-only (rate limits, auth policies), keep the live test narrow and opt-in via env vars
- Prefer targeting the smallest layer that catches the bug:
  - provider request conversion/replay bug → direct models test
  - gateway session/history/tool pipeline bug → gateway live smoke or CI-safe gateway mock test
- SecretRef traversal guardrail:
  - `src/secrets/exec-secret-ref-id-parity.test.ts` derives one sampled target per SecretRef class from registry metadata (`listSecretTargetRegistryEntries()`), then asserts traversal-segment exec ids are rejected.
  - If you add a new `includeInPlan` SecretRef target family in `src/secrets/target-registry-data.ts`, update `classifyTargetClass` in that test. The test intentionally fails on unclassified target ids so new classes cannot be skipped silently.
