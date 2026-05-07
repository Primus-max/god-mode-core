# RUNBOOK — Bundle-as-contract enforcement live-verify

| Field | Value |
| --- | --- |
| Sub-plan | `.cursor/plans/commitment_kernel_bundle_as_contract.plan.md` |
| Phase | 7 — Live-verify runbook + sub-plan flip + master plan entry |
| Slice | `bundle-as-contract` |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05 |
| Operator | Vladimir (Telegram chat `6533456892`) |

This runbook is the operator script for the live-verify gate the slice
sub-plan §1 todo `bundle-contract-phase-7-runbook-and-master` and §8
require to close the slice. It is NOT a test the agent runs — Vladimir
runs it on the dev gateway and records the captured `[bundle-filter]`
log lines as evidence. The structural assertion is on the per-turn
log line emitted at the schema-construction site
(`src/agents/pi-embedded-runner/run/attempt.ts:2074-2087`); the
operator-side observable is that the LLM never autonomously calls a
tool the bundle does NOT carry.

The agent has shipped (Phases 1–6):

- Phase 1 audit (`extensions/AUDIT-bundle-as-contract.md` — schema
  construction site at `attempt.ts:2004` confirmed; advisory consumers
  enumerated; reverse-defense gap documented).
- Phase 2 types (`src/agents/bundle-schema-filter.ts` —
  `BundleSchemaFilterConfig` + `DEFAULT_BUNDLE_ALLOWED_TOOLS` closed
  map covering all 9 `ResolutionToolBundle` enum values +
  `resolveBundleAllowedTools` pure helper; `BundleId` re-export of
  `ResolutionToolBundle` — invariant #11 preserved).
- Phase 3 pure filter (`filterToolSchemaByBundle` two-layer:
  bundle-allowlist + reverse-defense; never throws — invariant #15;
  pure — never mutates input).
- Phase 4 wiring at `attempt.ts` — `applyBundleSchemaFilterAtAttempt`
  adapter applied AFTER `applyModelProviderToolPolicy` and BEFORE
  `disableWebSearchTool` / `sanitizeToolsForGoogle` post-processing.
  Empty / undefined `toolBundles` → byte-identical pass-through via
  `missingBundlePolicy: 'allow_all'`.
- Phase 5 reverse-defense integration proof (adversarial post-
  `applyModelProviderToolPolicy` `web_search` re-injection caught
  when `nativeWebSearchTool=false` AND bundle does NOT carry
  `public_web_lookup`; `applyModelProviderToolPolicy` UNCHANGED —
  documented non-goal).
- Phase 6 telemetry + 355ae135 acceptance — `[bundle-filter]` log
  line at filter exit:
  `[bundle-filter] turnId=<id> bundles=[<...>] removed_tools=[<name>:<reason>,...] kept_tools=[<...>]`
  emitted at `info` when removals > 0; `debug` otherwise. Fixture
  replay of `gateway-grok-route.log` 2026-05-02 turn `355ae135`
  asserts empty tool schema reaches LLM AND telemetry records
  `web_search:not_in_bundle_allowlist`.

This runbook closes the loop by exercising the end-to-end schema-
filter path with REAL operator input on a dev gateway, capturing the
required structural log lines for three bundle classes
(`respond_only` / `public_web_lookup` / `artifact_authoring`) and
confirming behaviour matches the closed allowlist.

---

## §1 Pre-conditions

1. Dev gateway HARD-RESTARTED from the merged successor of
   `feat/v1-bundle-as-contract-phase-7-runbook` on `dev`. Phase 4
   wiring fires per-turn, so a hot-reload IS sufficient — but Phase 5
   reverse-defense binds at module-load, so a hard restart is the
   safer default. Confirm:
   ```
   git -C ~/source/repos/god-mode-core rev-parse HEAD
   ```
   The gateway boot banner should also show
   `god-mode-core ... commit=<sha>`.
2. Identity `identity:vladimir` registered with the Telegram chat.
   Confirm via `~/.openclaw/openclaw.json:identities.vladimir`
   (READ-only — do NOT overwrite this file; per memory rule «never
   overwrite ~/.openclaw/openclaw.json without backup»).
3. `~/.openclaw/openclaw.json` UNTOUCHED. The bundle-as-contract
   slice ships defaults (closed `DEFAULT_BUNDLE_ALLOWED_TOOLS` map +
   `missingBundlePolicy: 'allow_all'`) and does NOT require any new
   config key.
4. Gateway started in foreground with stdout captured to a fresh log
   file (e.g. `gateway-bundle-as-contract-live-verify.log`) so the
   `[bundle-filter]` log lines below can be greped reliably.
5. The `[bundle-filter]` line is emitted at `info` when ≥ 1 tool was
   removed and at `debug` otherwise. If the gateway's runtime logger
   filters `debug` lines (default for prod-mode), only the actionable
   removal cases will surface — adequate for §3 assertions. To see
   ALL turns (including byte-identical pass-through), bump the
   `agent/embedded` subsystem level to `debug` in
   `~/.openclaw/openclaw.json` (READ-only — verify before edit).

---

## §2 Operator prompts (3 turns)

Send the following prompts via Telegram in sequence. Each turn's
expected `[bundle-filter]` log line is documented inline. Capture the
gateway log file between turns so each turn's evidence is isolable.

### Turn 1 — Chit-chat (`bundles=[respond_only]`)

> «hi, how are you»

OR (Russian variant — exercises both the english and cyrillic
classifier paths):

> «привет, как дела»

Expected classifier output: `bundles=[respond_only]`
(`requestedTools=[]`).

Expected `[bundle-filter]` log line (one of two formats depending on
the model selected by the planner):

```
[bundle-filter] turnId=<id> bundles=[respond_only] removed_tools=[<all-non-respond-tools>:not_in_bundle_allowlist] kept_tools=[]
```

Where `<all-non-respond-tools>` is the comma-separated list of every
tool present in the catalog AFTER `applyModelProviderToolPolicy` ran,
each tagged `:not_in_bundle_allowlist`. The `kept_tools=[]` segment
is the central assertion: the LLM tool schema is empty for a
`respond_only` turn.

If the selected model has `nativeWebSearchTool=true` (e.g. some
hydra/sonar variant — check the `models.json` compat block),
`applyModelProviderToolPolicy` will have ALREADY removed
`web_search`, so `web_search` will NOT appear in the `removed_tools`
list. That is correct order-of-operations; the bundle filter still
removes everything else.

Operator-side observable: a short, friendly reply WITHOUT any tool
invocation. Reverse signal: if the gateway log shows
`Provider finish_reason: error` OR a `web_search` tool-call line
between the user prompt and the reply, the slice has regressed —
STOP and triage.

### Turn 2 — Current-event query (`bundles=[public_web_lookup]`)

> «какие новости в мире»

OR (English variant):

> «what's in the news right now»

Expected classifier output: `bundles=[public_web_lookup]`
(`requestedTools=[web_search]` may or may not be present — depends on
classifier prompt; the bundle is the load-bearing signal).

Two acceptable expected `[bundle-filter]` outcomes depending on the
selected model:

**Case A — non-native-search model (e.g. `claude-opus-4.6`,
`hydra/gpt-5.4`):**

```
[bundle-filter] turnId=<id> bundles=[public_web_lookup] removed_tools=[<all-other-tools>:not_in_bundle_allowlist] kept_tools=[web_search,web_fetch]
```

`kept_tools=[web_search,web_fetch]` is the central assertion: the
bundle authority WINS over the reverse-defense layer (Phase 5's
documented case 2 — `applyModelProviderToolPolicy` + reverse-defense
both yield to the bundle when `public_web_lookup` is present).

**Case B — native-search model (e.g. some `hydra/sonar*`):**

```
[bundle-filter] turnId=<id> bundles=[public_web_lookup] removed_tools=[<all-other-tools>:not_in_bundle_allowlist] kept_tools=[web_fetch]
```

`web_search` was ALREADY removed by `applyModelProviderToolPolicy`
BEFORE the bundle filter ran (Phase 5's documented case 3). The
bundle filter is a no-op on `web_search` here (no double-fire
telemetry).

Operator-side observable: a reply that quotes fresh-data sources via
the Search-Composer pipeline (`<web_evidence>` injection per Phase
4c follow-ups), OR a sonar-pro reply with citations on native-search
models. Reverse signal: Search-Composer pipeline failure —
`gateway-grok-route.log`-style autonomous DDG `web_search` →
`Provider finish_reason: error` — STOP and triage.

### Turn 3 — Artifact authoring (`bundles=[artifact_authoring]`)

> «сделай PDF из этого текста: <короткий текст по выбору оператора>»

OR (English variant):

> «make a PDF out of this text: <short operator-chosen text>»

Expected classifier output: `bundles=[artifact_authoring]` (the
`document_extraction` bundle is for the *ingest* direction; `pdf`
authoring is the *emit* direction — `artifact_authoring`).

Expected `[bundle-filter]` log line:

```
[bundle-filter] turnId=<id> bundles=[artifact_authoring] removed_tools=[<all-other-tools>:not_in_bundle_allowlist] kept_tools=[pdf,docx,image_generate,apply_patch]
```

`kept_tools` MUST include exactly the four tools mapped from the
`artifact_authoring` bundle in `DEFAULT_BUNDLE_ALLOWED_TOOLS` (the
order may vary — the closed mapping is by `Set` membership, not
sequence). Reverse-defense fires ONLY if upstream catalog drift
silently re-introduces `web_search` AND the selected model is
`nativeWebSearchTool=false`; in that case the
`reverse_defense_no_native_search` reason will appear additionally
in `removed_tools`.

Operator-side observable: a Telegram document attachment (`.pdf`)
with the operator's text rendered. Reverse signal: an autonomous
`web_search` invocation OR a `Provider finish_reason: error` —
STOP and triage.

---

## §3 Structural log assertions

After all three turns, grep the gateway log file for the
`[bundle-filter]` line per turn. The exact `<id>` values vary; the
**presence and shape** of each line is the assertion.

```
grep "\[bundle-filter\]" gateway-bundle-as-contract-live-verify.log
```

### §3.1 Pass criteria — every one of the following MUST hold

| Turn | Bundle | Pattern | Expected |
| --- | --- | --- | --- |
| 1 | `respond_only` | `[bundle-filter] turnId=<id> bundles=[respond_only] removed_tools=[...] kept_tools=[]` | ≥ 1 line, `kept_tools=[]` exactly |
| 2 | `public_web_lookup` | `[bundle-filter] turnId=<id> bundles=[public_web_lookup] removed_tools=[...] kept_tools=[web_search,web_fetch]` (Case A) OR `kept_tools=[web_fetch]` (Case B — native-search model) | ≥ 1 line |
| 3 | `artifact_authoring` | `[bundle-filter] turnId=<id> bundles=[artifact_authoring] removed_tools=[...] kept_tools=[pdf,docx,image_generate,apply_patch]` (any order) | ≥ 1 line |

Negative assertion across all three turns: `Provider finish_reason: error`
**0 occurrences**. The 355ae135 regression class is the absence-of-
this-line in the post-fix gateway log.

### §3.2 Telegram-side assertions

| Turn | Expected delivery |
| --- | --- |
| 1 | Single short text reply, NO tool invocations between prompt and reply. |
| 2 | Single text reply with citations (sonar/composer pipeline) OR fresh-data answer; NO bot-detection error chains. |
| 3 | Single document message containing a `.pdf` artifact with operator's text. |

If a turn produces TWO+ `[bundle-filter]` lines for the same
`turnId=<id>`, that is acceptable (e.g. retries over the same turn);
the assertion is on shape/presence, not count-per-turn-id.

---

## §4 Reverse case — verify filter is the sole gate (optional)

This reverse exercises sub-plan §8 row 5 (manual: drop the new filter
from the chain → tools list legacy-shape; proves filter is the sole
schema-side gate).

### §4.1 Setup (DESTRUCTIVE — local-only)

1. In a local working tree (NOT on `dev`), comment out the
   `applyBundleSchemaFilterAtAttempt(...)` invocation at
   `src/agents/pi-embedded-runner/run/attempt.ts:2074-2087` so
   `toolsAfterBundleFilter = toolsRaw` directly. DO NOT push.
2. Restart the gateway.
3. Re-run Turn 1 above (`respond_only`).

### §4.2 Pass criteria

- ZERO `[bundle-filter]` log lines (the call site is bypassed).
- The `respond_only` turn's tool catalog reaching the LLM contains
  the FULL legacy shape (`web_search`, `web_fetch`, `pdf`, `docx`,
  `image_generate`, `apply_patch`, `browser_*`, `exec`, …) —
  observable via the model's autonomous tool selection.
- Re-introduce the filter (revert local change), restart, re-run —
  catalog returns to empty for `respond_only`.

This reverse is NICE-TO-HAVE — the structural fail-closed is already
asserted at the unit-test layer (Phase 4 regression test —
`bundles=[respond_only]` reaches LLM with empty tool array; absence-
of-fix mode in the Phase 6 acceptance fixture asserts the legacy
shape when the filter is omitted).

---

## §5 Telemetry capture template

Paste the following block into the slice handoff entry (sub-plan §6
Handoff Log) once verified:

```
LIVE-VERIFY 2026-05-07 — bundle-as-contract enforcement
=======================================================
Gateway commit:           <git rev-parse HEAD>
Live-verify start:        <ISO-8601>
Telegram chat id:         6533456892

Turn 1 (respond_only):
  Telegram turnId:        <runId>
  [bundle-filter] line:   bundles=[respond_only] kept_tools=[]
  Operator-side:          short reply, NO tool calls

Turn 2 (public_web_lookup):
  Telegram turnId:        <runId>
  Selected model:         <claude-opus-4.6 | sonar-pro | gpt-5.4 | …>
  [bundle-filter] line:   bundles=[public_web_lookup] kept_tools=[web_search,web_fetch]  (Case A)
                          OR kept_tools=[web_fetch]                                       (Case B)
  Operator-side:          fresh-data answer with citations

Turn 3 (artifact_authoring):
  Telegram turnId:        <runId>
  [bundle-filter] line:   bundles=[artifact_authoring] kept_tools=[pdf,docx,image_generate,apply_patch]
  Operator-side:          .pdf document delivered

Negative assertion:
  Provider finish_reason: error  →  0 occurrences across all 3 turns

Reverse case (§4): SKIPPED / VERIFIED  (mark whichever applies)

Slice CLOSED.
```

---

## §6 Failure triage

If §3.1 Turn 1 `kept_tools=[]` is non-empty:
- Inspect the `[bundle-filter]` line for the actual bundle list. If
  `bundles=[]`, the classifier emitted no bundle and the
  `missingBundlePolicy: 'allow_all'` regression-guard is in effect
  (byte-identical legacy shape). The slice is operating correctly;
  the classifier needs investigation (separate slice).
- If `bundles=[respond_only]` but `kept_tools` is non-empty, the
  closed allowlist `DEFAULT_BUNDLE_ALLOWED_TOOLS` for `respond_only`
  may have drifted. Verify
  `src/agents/bundle-schema-filter.ts:DEFAULT_BUNDLE_ALLOWED_TOOLS`
  maps `respond_only` to `new Set([])`.

If §3.1 Turn 2 `kept_tools` is missing both `web_search` AND
`web_fetch`:
- The bundle authority did not win over the reverse-defense. Confirm
  `bundles=[public_web_lookup]` is in the line (NOT `bundles=[]`).
  If the bundle is correctly emitted but `web_search` was removed
  with reason `reverse_defense_no_native_search`, the reverse-
  defense layer is firing on the legitimate DDG-search path — this
  is a Phase 5 contract violation. Inspect
  `filterToolSchemaByBundle` reverse-defense gating logic.

If §3.1 Turn 3 `kept_tools` does not include all four artifact tools:
- Verify the `artifact_authoring` mapping in
  `DEFAULT_BUNDLE_ALLOWED_TOOLS` (sub-plan §3.3) is intact:
  `Set(['pdf', 'docx', 'image_generate', 'apply_patch'])`.
- Check whether the catalog actually contains `image_generate` /
  `apply_patch` for the selected model — `applyModelProviderToolPolicy`
  may have stripped them BEFORE the bundle filter ran (e.g. some
  models lack `image_generate` capability). The bundle filter is a
  no-op on a tool that was already absent.

If `Provider finish_reason: error` appears for ANY turn:
- Capture the full error envelope (provider + tool + status code).
- The error means the LLM autonomously called a tool that broke
  downstream (e.g. DDG bot-detection on `web_search`). Inspect the
  preceding `[bundle-filter]` line for the same `turnId`. If
  `kept_tools=[]` for that turn, the LLM did NOT have the tool in
  its schema and the error originates somewhere else (NOT a slice
  regression). If the offending tool IS in `kept_tools`, the bundle
  → tool allowlist is broader than intended for that bundle —
  triage `DEFAULT_BUNDLE_ALLOWED_TOOLS` mapping.

---

## §7 Rollback procedure

If live-verify fails and a rollback is required (PRESERVES advisory
semantics — bundles are still emitted by the classifier and consumed
by routing/planner/profile/overlay/web-evidence-prefetch; only the
schema-side hard filter is dropped):

### §7.1 Quick rollback (config-only, no merge required)

Set `missingBundlePolicy: 'allow_all'` is ALREADY the default — no
config knob exists for live disable. The rollback path is code-side
only (see §7.2). If a runtime config knob is needed, it must be
added in a separate slice.

### §7.2 Code rollback

1. In `src/agents/pi-embedded-runner/run/attempt.ts:2074-2087`,
   replace:
   ```ts
   const toolsAfterBundleFilter = [
     ...applyBundleSchemaFilterAtAttempt({
       tools: toolsRaw,
       platformExecutionContext: params.platformExecutionContext,
       modelCompat: params.model.compat,
       turnId: params.runId,
       logger: log,
     }).kept,
   ];
   ```
   with:
   ```ts
   const toolsAfterBundleFilter = toolsRaw;
   ```
2. Revert any callers that were threaded `toolBundles` through
   `params` (Phase 4 wiring) — but since the bundle filter reads
   `params.platformExecutionContext` directly (not a new
   `toolBundles` field), no caller-side rollback is required.
3. Restart the gateway. `[bundle-filter]` log lines will stop being
   emitted; the legacy advisory-only behaviour is restored.
4. Master plan §0.5.1 row "Tool exposure согласована с model
   capability и bundle-контрактом" reverts to OPEN; sub-plan
   frontmatter `status: completed` reverts to `status: in_progress`
   pending re-investigation.

### §7.3 Rollback acceptance

After rollback, the `gateway-grok-route.log` 2026-05-02 turn
`355ae135` failure mode is observable again:

- `respond_only` turns expose the full tool catalog to the LLM.
- A non-native-search model receiving a fresh-data turn that the
  classifier mis-emits as `respond_only` will autonomously call DDG
  `web_search` → bot-detection HTML → `Provider finish_reason:
  error`.

This proves the rollback restored advisory-only semantics and that
the slice was indeed the sole gate that closed the symptom.

---

## §8 Slice CLOSED criteria

The slice is considered CLOSED when:

1. §3.1 Turn 1 / Turn 2 / Turn 3 each match the expected
   `[bundle-filter]` line shape.
2. §3.1 negative assertion holds: `Provider finish_reason: error`
   has 0 occurrences across the three turns.
3. §3.2 Telegram-side delivery confirms the operator-side observable
   per turn.
4. §5 telemetry block pasted into the handoff log (`.cursor/plans/
   commitment_kernel_bundle_as_contract.plan.md` §6 Handoff Log).

The reverse case (§4) is NICE-TO-HAVE — the structural fail-closed
is already asserted at the unit-test layer; the live-verify reverse
is an additional belt-and-braces check the operator can run when a
local working tree is conveniently available.
