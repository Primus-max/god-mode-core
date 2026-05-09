---
title: V1-CONTRACT-ONLY — Smart classifier + deterministic dispatch (no kernel)
session: 2026-05-09-contract-only
revision: 2 (post 3-critic synthesis)
supersedes:
  - .cursor/plans/V1-CLOSE-2026-05-08-stabilization-charter.md
  - .cursor/plans/HANDOFF-2026-05-07-v1-frontier-exhausted.md
  - all commitment_kernel_*.plan.md sub-plans (kept as history, frozen, not active)
status: REVISED — awaiting operator final-go before implementation
isProject: true
critic_outputs:
  - red-team: "ship with-fixes" — flagged reply_template injection, concurrency contradiction, conversation textual-lying
  - plan-agent: "ship with modifications" — flagged classifier-prompt explosion, multi-action absence, model-fallback re-emergence, timeline 12-16h
  - explore: "8h realistic with caveats" — found cutover site, confirmed disableTools=true exists, advised fresh schema
---

# V1-CONTRACT-ONLY — Design (revision 2)

## Goal

Telegram bot that, given a user message, **classifies once into a typed contract**, then **deterministically dispatches** the contract to either tool calls or a free-form chat reply. Bot cannot lie about actions because the LLM that has tools never gets to write its own reply text, and the LLM that writes free-form text never has tools.

## Architecture

```
USER MESSAGE
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE A — TOOL/INTENT ROUTER (cheap LLM, ≤200ms)           │
│   input:  user_msg + last N turns + tool MENU (names only)  │
│   output: { intent: "tool_calls"|"conversation"|"refuse",   │
│             tool_names: string[],     // multi-action OK   │
│             sequencing: "sequential"|"parallel" }           │
└─────────────────────────────────────────────────────────────┘
    │
    ├── if conversation/refuse → straight to STAGE C/D
    │
    ▼ (if tool_calls)
┌─────────────────────────────────────────────────────────────┐
│ STAGE B — ARG EXTRACTOR (cheap LLM, per tool, ≤200ms each)  │
│   For each tool_name in stage A output:                     │
│     input:  user_msg + tool_name + that-one-tool's schema  │
│     output: typed args matching tool's Zod schema           │
│   → TurnContract { tool_calls: TurnAction[], sequencing }   │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE C — DISPATCHER (plain TypeScript, NOT LLM)            │
│   tool_calls: execute each TurnAction; reply rendered from  │
│              FIXED template catalog keyed (tool, outcome) + │
│              real tool output. No LLM-emitted templates.    │
│   conversation: call runEmbeddedPiAgent(disableTools:true)  │
│              with hardened system prompt forbidding         │
│              first-person past-tense action claims.         │
│   refuse: static template + refusal_reason field.           │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
TELEGRAM SEND
```

## Why bot cannot lie

| Path | Why no false claim is possible |
|---|---|
| `tool_calls` | Reply rendered from FIXED dispatcher-owned template catalog + real tool output. LLM never authors the reply text. |
| `conversation` | LLM has zero tools (`disableTools: true` flag — already supported in `pi-embedded-runner/run/params.ts:100`). System prompt forbids `я создал/записал/отправил` claims. Residual textual-lie risk acknowledged: bot may still hallucinate "я записал" — mitigation is system-prompt-only, not architectural. Severity: tolerable for chat path (no user data destroyed). |
| `refuse` | Static template. Zero LLM creativity. |

## Schema

```ts
// src/orchestrator-v1/contract.ts
const TurnActionSchema = z.object({
  tool: z.enum([...availableToolNames]),
  args: z.record(z.string(), z.unknown()),  // validated per-tool downstream
});

export const TurnContractSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("tool_calls"),
    tool_calls: z.array(TurnActionSchema).min(1),
    sequencing: z.enum(["sequential", "parallel"]).default("sequential"),
  }),
  z.object({
    intent: z.literal("conversation"),
  }),
  z.object({
    intent: z.literal("refuse"),
    refusal_reason: z.string(),
  }),
]);
```

**No `reply_template` field.** Templates are dispatcher-owned constants per tool/outcome pair.

## Reply template catalog (dispatcher-owned, no LLM input)

```ts
// src/orchestrator-v1/reply-templates.ts (illustrative; final list ~30 entries)
const TEMPLATES = {
  "write:success": "Записал в {path}",
  "write:failure": "Не получилось записать: {error}",
  "image_generate:success": "Сгенерировал: {url}",
  "image_generate:failure": "Не получилось сгенерировать: {error}",
  "edit:success": "Изменил {path}",
  ...
  "refuse:default": "Не могу: {refusal_reason}",
  "multi:success": "Готово: {summary}",  // for sequencing=sequential with N>1 successes
};
```

Placeholder substitution is escape-aware (no nested `{...}` from tool output executes as new placeholders).

## What gets deleted (or becomes dead code post-cutover)

- `src/platform/commitment/**` — entire kernel.
- `src/platform/decision/{run-turn-decision, task-classifier, resolution-contract, recipe-routing-hints, qualification-execution-contract, outcome-contract}.ts`.
- `src/auto-reply/reply/{post-llm-commitment-evaluator, agent-runner two-brain flow}.ts`.
- `concurrent-turn-broker`, `monitored-runtime`, `outbound-coalescer-wiring`, `block-external-buffer`.

Day-1 strategy: replace the entry point (`bot-handlers.runtime.ts:~200`) — old code becomes unreached. Physical deletion is a separate housekeeping pass post-ship.

## What stays / is reused

- **`pi-ai`** library — LLM transport.
- **Tool implementations** — `src/agents/pi-embedded-runner/tools/*` reused as-is. Dispatcher calls them directly with validated args.
- **`runEmbeddedPiAgent` with `disableTools: true`** — for conversation path. Reuses identity/persona/history/locale pre-flight; we add `disableTools: true` to ensure zero tool surface.
- **Per-chat serialization lock** — `Map<chatId, Promise<void>>` (~10 LOC). NOT the full `concurrent-turn-broker`, but minimum lock so two messages from same chat don't race. (Red-team blocker #7.)
- **Model fallback** — wrap classifier and conversation calls in try-next-model loop using existing model registry. (Plan-agent concern.)
- **Telegram I/O** — `extensions/telegram/*` unchanged except for the inbound handler callback swap.
- **Identity / session plumbing** — current pre-flight (identity resolve, session reset, persona injection) reused via `runEmbeddedPiAgent` for conversation path AND threaded into dispatcher for tool_calls path.
- **Persistent worker / cron infrastructure** — accessible as tools the dispatcher calls.

## Non-goals (today)

- Memory persistence (embedder config) — defer.
- Streaming partial replies — defer to v1.1 (one-shot replies acceptable for v1).
- Persistent-worker-push live verification — depends on T8b decision-layer wiring; cron tool is invokable but live cron-fire chain is separate workstream.
- Multi-turn deixis ("сделай это" referring 3 turns back) — classifier sees last N turns, may resolve heuristically; explicit referent-resolution layer is post-v1.

## Failure modes (revision 2 — explicit)

| Failure | Mitigation | Acceptable? |
|---|---|---|
| Stage A picks wrong tool | Tool fails or does bounded action; user retries. | Yes (architectural ceiling). |
| Stage A picks `conversation` when user wanted action | Bot replies in text; system prompt forbids fake action claims; user retries. | Yes. |
| Stage B emits args that fail Zod validation | Dispatcher refuses → reply "Не могу разобрать запрос: {field}". | Yes (fail closed). |
| Tool throws | Caught; reply = template `tool:failure` + error. | Yes (truthful). |
| Multi-action with one of N tool_calls failing | If `sequencing=sequential`, halt at first failure; reply = "Шаг 1 ОК ({summary}); шаг 2 не получилось: {error}". `parallel` reports all results. | Yes. |
| Same-chat concurrent messages | Per-chat lock serializes; second message waits. | Yes. |
| Classifier (Stage A or B) hallucinates non-existent tool | Zod enum rejects → fail closed. | Yes. |
| Classifier returns invalid JSON | Try-fallback model in registry; if all fail → "Сервис временно недоступен, попробуй позже". | Yes. |
| Provider outage on conversation LLM | Fallback to next model in registry. | Yes. |
| Reply template has unfilled `{var}` | Detect; fallback to "Готово" + raw tool output summary. | Yes (degraded). |

## Implementation order (revised: ~9h with hard-stop checkpoint)

| Hour | Step | Deliverable | Hard-stop? |
|---|---|---|---|
| **0–1** | **Classifier-model bench** — write 10 fixture prompts (greeting / file write / image gen / persistent worker / web search / multi-action / refuse / Russian / English / ambiguous). Run each through top-3 cheap candidates (`hydra/gpt-5-mini`, `hydra/claude-haiku-4.5`, `hydra/gemini-2.5-flash`). Measure: accuracy on intent, accuracy on tool selection, p95 latency, $/1k. **Pick winner.** | `src/orchestrator-v1/__bench__/classifier-bench.test.ts` + `BENCHMARK.md` results | **YES** — if no model achieves ≥80% accuracy on 10 fixtures, scope-down decision: ship MVP with conversation + write + image_generate only (3 tools), expand incrementally. |
| 1–2 | TurnContract Zod schema + Stage A prompt template (system prompt with tool MENU only, names + 1-line descriptions). | `contract.ts`, `classifier-stage-a.ts` |  |
| 2–3 | Stage A wrapper: pi-ai call → parse → Zod → typed contract.intent + tool_names. 5 unit tests on fixture prompts. | `classifier-stage-a.ts` (impl + tests) |  |
| 3–4 | Stage B per-tool arg extractors. Generic helper `extractToolArgs(tool, userMsg)` that picks the tool's Zod schema, builds prompt with that ONE schema, validates output. | `classifier-stage-b.ts` |  |
| 4–6 | Dispatcher: switch on intent, plumb tools, reply template catalog, multi-action sequencing. Per-chat lock. Model fallback wrapper. | `dispatcher.ts`, `reply-templates.ts`, `chat-lock.ts` |  |
| 6–7 | Telegram entry point: replace `processMessage` callback in `bot-handlers.runtime.ts:~200` with orchestrator-v1 entry. Reuse identity/session pre-flight. Gateway-restart cutover (no in-flight drain). | One-line callback swap + ~50 LOC of pre-flight plumbing |  |
| 7–8 | Smoke test in Telegram: 5 canonical prompts. Live-verify rows in §6 below. | §6 evidence rows | **YES** — checkpoint: if 3+ of 5 fail in unrecoverable way, halt and escalate. |
| 8–9 | Buffer for fixes / unknown unknowns. | — |  |

## Acceptance

A turn passes if:
1. Classifier output validates against `TurnContractSchema`.
2. Dispatcher path matches `intent`.
3. Reply renders from fixed template + real tool output, OR from tool-less conversation LLM, OR from refuse template — never from LLM-emitted free text on tool_calls path.
4. Telegram message arrives.

A session passes if 5 canonical prompts (in §6) all pass on dev tip in one sitting, with no false action claims.

## What is NOT in this plan (anti-bloat)

- No feature flags. No env-var toggles. The cutover is one inbound-handler swap; old code becomes dead.
- No post-LLM watcher / mirror / parity test / drift detector. Architecture removes the lying surface for tool path; we accept residual chat-path textual-lie risk.
- No regex / verb parsing of user input or bot output. Forbidden.
- No "16 hard invariants", no frozen layers, no two brains, no recipe routing hints, no qualification execution contracts.
- No multi-day phasing. One PR, one cutover. Either it works tonight or hard-stop checkpoint at hour 7 forces scope-down.

## Live-verify log (§6)

| Date | Prompt | Expected intent | Actual intent | Tool called | Reply correct? | Notes |
|---|---|---|---|---|---|---|
| _pending_ | "привет" | conversation | _pending_ | none | _pending_ | greeting |
| _pending_ | "напиши заметку 'тест' в memory.md" | tool_calls (write) | _pending_ | write | _pending_ | file write |
| _pending_ | "сгенерируй картинку красного кота" | tool_calls (image_generate) | _pending_ | image_generate | _pending_ | image gen |
| _pending_ | "создай файл и потом отправь его в чат боссу" | tool_calls multi (write → sessions_send) | _pending_ | _pending_ | _pending_ | multi-action |
| _pending_ | "что ты умеешь?" | conversation | _pending_ | none | _pending_ | self-introspection (no fake action claims) |

## Operator decisions locked from 3-critic synthesis (2026-05-09)

1. ✅ `reply_template` is dispatcher-owned, not classifier-emitted (red-team + plan-agent BLOCK).
2. ✅ `TurnContract.tool_calls: TurnAction[]` with sequencing (plan-agent BLOCK).
3. ✅ Two-stage classifier (Stage A tool-menu, Stage B per-tool args) (plan-agent BLOCK).
4. ✅ Per-chat serialization lock (red-team #7).
5. ✅ Conversation system prompt forbids first-person past-tense action claims (red-team #12, plan-agent #1 mitigation).
6. ✅ Reuse `runEmbeddedPiAgent` with `disableTools: true` for conversation path (Explore Q3).
7. ✅ Preserve model fallback via try-next-model wrapper (plan-agent concern).
8. ✅ Hour 0-1 classifier-model bench → pick winner before main implementation (operator request 2026-05-09).
9. ✅ Timeline 9h with hard-stop checkpoints at hour 1 (bench) and hour 7 (smoke). Scope-down to 3-tool MVP if checkpoint fails.
10. ✅ No streaming in v1; one-shot replies. Streaming = v1.1.
