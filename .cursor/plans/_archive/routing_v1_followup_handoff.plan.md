# Routing v1 → v1.1 hand-off

**Use this file as the prompt for a fresh chat.** The agent in the new chat should have no prior context;
everything it needs to proceed is in this document.

---

## 0. TL;DR for the new agent

- Universal deliverable routing (v1) is live on branch `dev` and all 8 live E2E scenarios pass
  (`pnpm live:routing:smoke`). Details: §2.
- User intent is produced by an **LLM classifier** (`src/platform/decision/task-classifier.ts`) into a
  typed `DeliverableSpec`. **No regex / keyword dictionaries parse the user's prompt in
  decision/planner/recipe/runtime/tools.** A CI guard enforces this:
  `pnpm lint:routing:no-prompt-parsing` (wired into `pnpm check`).
- Missing capabilities are installed automatically at runtime through
  `src/platform/bootstrap/ensure-capability.ts` + `src/platform/bootstrap/defaults.ts`. No manual
  `npm install` for tool dependencies.
- Producers are dispatched via `src/platform/produce/registry.ts` keyed by
  `(DeliverableSpec.kind, format)`.

**Your job in the new chat:** pick one of the tracks in §5 and execute it end-to-end, including live
verification with `pnpm live:routing:smoke` (or a targeted subset).

---

## 1. Non-negotiables (do not violate)

1. **Zero parsing of user input** in `src/platform/decision/**`, `src/platform/planner/**`,
   `src/platform/recipe/**`, `src/platform/runtime/**`, `src/agents/tools/**`. No regex over prompt
   text, no Russian/English keyword lists, no `match(prompt, /pdf|docx|…/)`-style code. If intent is
   ambiguous, the classifier must ask the user for clarification through normal chat — **not** by
   string-matching.
2. **No manual dependency installs** for tool capabilities. Everything goes through
   `ensureCapability({ capabilityId })` + `Trusted_Capability_Catalog` in
   `src/platform/bootstrap/defaults.ts`. If you add a new producer, you add the capability entry
   (`packageRef`, `integrity`, `version`) and the runtime will install it on first use.
3. **Deliverable-first, not format-first.** Every new producer must register under a `kind`
   (`document`, `data`, `image`, `site`, `archive`, etc.), and declare accepted formats. The agent
   picks the format from `DeliverableSpec.acceptedFormats` and `preferredFormat`; the classifier is
   responsible for setting the right `constraints`.
4. **CI must stay green**, including `pnpm lint:routing:no-prompt-parsing`. If you find a legitimate
   false-positive, add the file to the `allowedFiles` set in
   `scripts/check-no-prompt-parsing.mjs` with a short comment describing why.

---

## 2. Current state (what works)

**Live E2E: 8/8 pass** against a real gateway on `127.0.0.1:19001`:

| # | scenario id             | prompt (RU)                                                      | expected outcome                                  |
|---|-------------------------|------------------------------------------------------------------|---------------------------------------------------|
| 1 | `01-hello`              | `Привет`                                                         | short assistant reply, no tool calls              |
| 2 | `02-image`              | `Сгенерировать картинку банана`                                  | `image_generate` tool → PNG/JPEG artifact         |
| 3 | `03-pdf`                | `Сгенерировать pdf про жизнь банана, красивый пдф…`              | `pdf_write` → `%PDF` magic-byte artifact          |
| 4 | `04-docx` (same session)| `То же самое сгенерировать в word.`                              | `docx_write` → `PK\x03\x04` (zip/docx) artifact   |
| 5 | `05-csv`                | `Какой то отчёт сделать в csv.`                                  | `csv_write` → CSV file                            |
| 6 | `06-xlsx`               | `Какой то отчёт сделать в эксель.`                               | `xlsx_write` → xlsx zip artifact                  |
| 7 | `07-site`               | `Создание сайта — простая лендинг-страница про бананы, отдай архив.` | `site_write` → zip archive                    |
| 8 | `08-capability-install` | `Установи стороннюю библиотеку pdfkit — выполни установку.`      | `capability_install` tool invoked, capability reported |

Tools live in `src/agents/tools/{csv,docx,xlsx,site,pdf,image,capability-install}-tool.ts`.
They all consume structured arguments from the LLM and never parse the user prompt.

**Key architecture files to read first (in order):**

1. `src/platform/decision/task-classifier.ts` — LLM classifier, produces `TaskContract` with
   `DeliverableSpec`. Contains stability few-shot examples (§`Stability examples`).
2. `src/platform/decision/deliverable.ts` (or wherever `DeliverableSpec` lives — grep for
   `DeliverableSpec`) — the typed contract.
3. `src/platform/produce/registry.ts` — maps `(kind, format)` → `{ toolName, capabilityId }`.
4. `src/platform/bootstrap/defaults.ts` — trusted capability catalog.
5. `src/platform/bootstrap/ensure-capability.ts` — dynamic install + module load.
6. `src/platform/runtime/evidence-sufficiency.ts` — accepts a run only when the produced artifact
   matches `DeliverableSpec.acceptedFormats`.
7. `src/platform/recipe/runtime-adapter.ts` — composes system prompts with deliverable guardrails.

**Live E2E driver:** `scripts/live-routing-smoke.mjs`, run via `pnpm live:routing:smoke`.
Output goes to `.artifacts/live-routing-smoke/<scenario>.json`. It starts its own gateway client on
`ws://127.0.0.1:19001` and expects the gateway to already be running (`pnpm gateway:dev`).

**Guardrail:** `scripts/check-no-prompt-parsing.mjs`, run via `pnpm lint:routing:no-prompt-parsing`.
Already wired into `pnpm check`.

---

## 3. What's intentionally pending (not a bug)

- **`src/platform/recipe/runtime-adapter.test.ts`** has 10 pre-existing failures. They are unrelated
  to routing v1 and were deferred. Fix them as a separate pass.
- **`scripts/lib/ts-guard-utils.mjs` → `resolveRepoRoot()`** has an off-by-one bug: it computes
  `..` / `..` from `scripts/<foo>.mjs` which lands one directory above the repo root. All existing
  `check-*.mjs` guards silently pass because they find zero source files. Our new
  `check-no-prompt-parsing.mjs` uses a local override and works correctly. This should be fixed
  repo-wide (and every existing guard re-verified).
- **Image-tool prompt fallback** (`src/agents/tools/image-{generate-,}tool.ts`) still uses small
  regex to extract quoted text for the offline SVG fallback (gated by env var
  `OPENCLAW_ALLOW_LOCAL_IMAGE_FALLBACK`). Allow-listed in the guard. If the product owner wants
  **literal** "zero parsing, nowhere", the fallback should be rewritten to take the text through an
  explicit `text` tool argument instead of reading `prompt`.
- **Attachment file-extension regex** in `src/platform/decision/{resolution-contract,route-preflight}.ts`.
  Legitimate (they look at `.pdf` / `.png` file extensions, not user text) and allow-listed.

---

## 4. How to verify right now

```powershell
# 1. One-time install (should be a no-op on a clean clone)
pnpm install --frozen-lockfile=false

# 2. Start the gateway in one terminal
pnpm gateway:dev

# 3. In another terminal, run the live routing smoke (8 scenarios)
pnpm live:routing:smoke

# 4. Static guardrails
pnpm lint:routing:no-prompt-parsing
```

Expected: `=== PHASE 7 RESULT: 8/8 passed ===`, guard exits 0, `.artifacts/live-routing-smoke/*.json`
contains per-scenario evidence (tool calls, produced artifact paths, assistant text).

---

## 5. Pick one of these tracks for the next chat

### Track A — "developer profile" routing expansion (the user's next test set)

Goal: expand the classifier + producer registry so the bot can handle multi-step developer requests
without any new prompt parsing. Example prompts the user will throw:

- "Создай новый репозиторий под X, инициализируй, добавь README и CI."
- "Сделай рефакторинг модуля Y, покажи diff, прогнать тесты."
- "Найди и пофикси утечку в tests lane, подтверди heap снапшотами."
- "Обнови зависимость Z, прогнать security checks."

Sub-tasks (all must land before the track is closed):

1. Extend `DeliverableSpec` (in `src/platform/decision/…`) with a `kind: "code-change"` /
   `"repo-operation"` family. Update `ProducerRegistry` with the corresponding tool mappings
   (e.g. `git_commit`, `apply_patch`, `run_tests`, etc., which likely already exist somewhere under
   `src/agents/tools/**`).
2. Add classifier few-shot examples covering the prompts above. Do NOT add regex/keyword
   fallback.
3. Expand `scripts/live-routing-smoke.mjs` with a new `SCENARIOS` block (`dev-*`). Assert on
   tool names + artifact presence, not on text.
4. Make sure all new dev-mode capabilities are declared in `Trusted_Capability_Catalog` if they
   rely on npm packages that are not already in the repo.
5. All 8 existing scenarios + new dev scenarios must pass. Guard stays green.

### Track B — Real bot channel integration (Telegram ignore, but Discord/CLI/Web are fair game)

Goal: wire the v1 routing all the way through to the gateway's chat channels so the user can drive
the scenarios through the UI / CLI bot, not only through the smoke driver.

1. Inspect `src/auto-reply/reply/agent-runner-execution.ts` and `src/gateway/server-methods/chat.ts`
   — confirm `DeliverableSpec` flows through `dispatchInboundMessage` into every channel adapter.
2. Add a live scenario to `live-routing-smoke.mjs` that uses each target channel's ingress path
   (CLI, web). Verify end-to-end: user message → classifier → tool → artifact → chat delivery.
3. Make sure the channel adapters deliver artifacts (the `ProducedArtifact.path` values) back to the
   user exactly once, with the right MIME/filename.
4. Do not introduce Telegram-specific code paths — channel-agnostic only.

### Track C — Harden the existing 8 scenarios

Goal: make the routing robust under load and failure injection.

1. Run `pnpm live:routing:smoke` 10 times in a row with random prompt variations (use the LLM to
   synthesize variants — still no regex!) and assert 10/10. Log timing budget per scenario.
2. Force each capability's package to be missing before the run, confirm `ensureCapability`
   installs it transparently, confirm the artifact is still produced and the elapsed time is
   bounded.
3. Add a deliberate "unsupported kind" prompt. Verify the agent asks a clarifying question through
   the LLM (no regex!) instead of hallucinating a tool call.
4. Fix `runtime-adapter.test.ts` 10 failing tests in the same pass.

### Track D — Clean up `scripts/lib/ts-guard-utils.mjs::resolveRepoRoot` bug (§3)

Small but high-leverage:

1. Fix `resolveRepoRoot` to walk up exactly one level from `scripts/`.
2. Re-run every existing `scripts/check-*.mjs` with an injected regression to prove they each
   actually catch violations (they currently don't — they silently pass).
3. Add an assertion test under `scripts/__tests__/` (or similar) that guards this behavior
   permanently.

---

## 6. Ground rules for the new agent

- Do NOT touch the plan file `.cursor/plans/universal_deliverable_v1_e9400057.plan.md` unless asked.
  That plan is "done" as far as v1 is concerned.
- Before writing any new code: read the 7 files listed in §2 and `scripts/live-routing-smoke.mjs`.
- Do NOT add new keyword/regex parsing over `prompt` / `userMessage` in routing-critical dirs. The
  guard will catch you in CI, but catching it in review is cheaper.
- Prefer extending `DeliverableSpec` + `ProducerRegistry` + `Trusted_Capability_Catalog` over
  adding ad-hoc code paths.
- When a new producer is added, the bare minimum checklist is:
  1. New tool in `src/agents/tools/<name>-tool.ts` with a Typebox/Zod schema.
  2. Capability entry in `src/platform/bootstrap/defaults.ts` (if npm-backed).
  3. Producer registry entry in `src/platform/produce/registry.ts`.
  4. Classifier examples updated.
  5. Evidence check path in `src/platform/runtime/evidence-sufficiency.ts` understands the new
     magic bytes / extension.
  6. Live scenario added to `scripts/live-routing-smoke.mjs`.
  7. `pnpm check` and `pnpm live:routing:smoke` both green.

---

## 7. Commands cheat sheet

```powershell
# Gateway
pnpm gateway:dev

# Type & lint (includes routing guard)
$env:NODE_OPTIONS='--max-old-space-size=8192'
pnpm tsgo --noEmit
pnpm check

# Routing-specific
pnpm lint:routing:no-prompt-parsing
pnpm live:routing:smoke

# Unit tests
pnpm test -- src/platform/decision
pnpm test -- src/platform/produce
pnpm test -- src/platform/bootstrap
pnpm test -- src/platform/runtime/evidence-sufficiency.test.ts
```

---

## 8. Exact prompt to paste into a fresh chat

> Read `.cursor/plans/routing_v1_followup_handoff.plan.md` end-to-end. Confirm the 8 live
> scenarios in §2 still pass by running `pnpm gateway:dev` and `pnpm live:routing:smoke`. Then
> pick **Track A** from §5 and deliver it end-to-end: classifier updates, registry updates, trusted
> capability entries, live scenarios in the smoke driver, `pnpm check` green,
> `pnpm live:routing:smoke` green for every old and new scenario. Follow the non-negotiables in §1
> and the ground rules in §6. Do not parse user input anywhere in the routing path. Do not install
> tool dependencies manually. Report back with a condensed run log of the final smoke results.
