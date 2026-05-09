---
title: HANDOFF — orchestrator-v1 LIVE in Telegram (diagnostic mode)
session: 2026-05-09-orchestrator-v1-handoff
status: ACTIVE — read this FIRST in the next chat
supersedes:
  - .cursor/plans/V1-CLOSE-2026-05-08-stabilization-charter.md (already SUPERSEDED)
references:
  - .cursor/plans/V1-CONTRACT-ONLY-2026-05-09-design.md (design, revision 2)
  - PR #326 (design-only, draft, /ultrareview verdict: findings=[])
  - branch feat/v1-contract-only-orchestrator (implementation, pushed)
isProject: true
---

# Handoff — orchestrator-v1 live in Telegram, diagnostic mode

## TL;DR

The contract-only orchestrator (Stage A classifier → Stage B per-tool
arg extractor → deterministic dispatcher → reply from fixed catalog) is
**live in Telegram** (env-gated by `OPENCLAW_USE_V1_ORCHESTRATOR=1`).
Real prompts have been classified end-to-end. 3 of 4 test prompts
classified correctly; one PDF prompt mis-routed (known gap, not blocker).

## What is shipped on branch `feat/v1-contract-only-orchestrator`

- `src/orchestrator-v1/` — 7 source files + 6 test files, **61 unit tests passing**.
  - `contract.ts` — TurnContract Zod schema, TOOL_NAMES (10 tools), helpers
  - `tool-arg-schemas.ts` — 10 per-tool Zod schemas
  - `classifier-stage-a.ts` — intent + tool routing (cheap LLM, gpt-5-mini)
  - `classifier-stage-b.ts` — per-tool arg extraction (cheap LLM)
  - `dispatcher.ts` — deterministic dispatch + injection-safe reply rendering
  - `reply-templates.ts` — fixed dispatcher-owned catalog (~30 entries)
  - `chat-lock.ts` — per-chat serialization (Map<chatKey, Promise>)
  - `orchestrator.ts` — runOrchestratorTurn entry point
  - `diagnostic.ts` — diagnoseTurn (DRY-RUN; no tool execution)
  - `__bench__/classifier-bench.ts` — model bench (gpt-5-mini won 100%/100%)
- `src/plugin-sdk/orchestrator-v1.ts` — public surface for extensions
- `scripts/lib/plugin-sdk-entrypoints.json` — registered new entry
- `package.json` — added `./plugin-sdk/orchestrator-v1` export
- `src/plugin-sdk/inbound-reply-dispatch.ts` — universal short-circuit
  (works for non-Telegram channels)
- `extensions/telegram/src/bot-message-dispatch.ts` — Telegram-specific
  short-circuit (Telegram bypasses universal dispatch)

## How to run live

```bash
# 1. Fresh dev pull
git checkout feat/v1-contract-only-orchestrator
git pull --ff-only origin feat/v1-contract-only-orchestrator

# 2. Build (tsdown picks up plugin-sdk entries from JSON)
node scripts/tsdown-build.mjs

# 3. Stop any running gateway, start fresh with env flag
export OPENCLAW_USE_V1_ORCHESTRATOR=1
pnpm openclaw gateway run --bind loopback --port 19001 --force \
  > gateway-v1-tg.log 2>&1 &

# 4. Wait for "listening" line
until grep -q "listening" gateway-v1-tg.log; do sleep 1; done

# 5. Send messages to @gode_mode_0_bot in Telegram, watch the log
tail -F gateway-v1-tg.log | grep -E "orch-v1-debug"
```

When env flag is unset, native flow runs unchanged. **Zero risk to native.**

## Live-verify evidence (2026-05-09 13:30-13:42 UTC+3)

| Prompt | Stage-A | Stage-B | Verdict |
|---|---|---|---|
| "напиши заметку 'тест прошёл' в файл /tmp/test.md" | tool_calls [write] | path + content extracted | ✅ PASS |
| "Сгенерируй картинку с весёлым бананом" | tool_calls [image_generate] | prompt enriched + size=1024x1024 | ✅ PASS |
| "напиши заметку 'тест прошёл' в файл /tmp/test.md" (repeat) | tool_calls [write] | identical args | ✅ PASS deterministic |
| "Создай PDF с инфографикой о городском котике" | tool_calls [write, image_generate] (WRONG — should be [pdf]) | both args missing | ❌ FAIL |
| "Дружелюбную, на приколе..." (after /new clarify-question) | refuse | n/a | ⚠️ DEBATABLE — no chat history context |
| "/new" | refuse | n/a | ⚠️ Special command misclassified |

## Known gaps (in priority order)

1. **PDF tool description too thin in Stage A prompt** — classifier
   doesn't recognize "PDF" / "инфографика" / "отчёт" as triggers for
   the `pdf` tool. Fix: extend `TOOL_DESCRIPTIONS["pdf"]` in
   `src/orchestrator-v1/classifier-stage-a.ts` (and in `diagnostic.ts`
   if it has a copy) with synonyms. This is a **content-only fix**, no
   logic change. Operator (Vladimir 2026-05-09) acknowledged it's a
   semi-hack but acceptable.
2. **Stage B isolated per tool** — when Stage A picks multiple tools,
   each Stage B call sees only ONE tool's schema and the user's raw
   message. It can't always extract args because it doesn't know the
   role of THIS tool in the multi-action plan. Example: "PDF with
   инфографика" → Stage A picks [pdf, image_generate], Stage B for
   image_generate misses the `prompt` because the user described the
   *infographic content*, not "an image to generate". Fix later: pass
   the FULL Stage A plan to Stage B so each call knows about its
   siblings. **Not v1-blocker.**
3. **Conversation context for "refuse" decisions** — bot's clarification
   question + user's reply is two turns; Stage A on the reply alone
   doesn't have the original question. Last N turns of history are NOT
   yet passed to Stage A. Fix: thread chat history into the Stage A
   prompt template (already accepts a userMessage; needs context
   addition). **Not v1-blocker.**
4. **Special commands like `/new`** — go through the same classifier;
   it sees a system-injected greeting prompt and refuses. Probably
   fine for v1 (these are internal — but UX shows a refuse to user).
   Investigate: does the synthetic-message handler actually reach the
   short-circuit? If yes, special-case `/new` `/reset` in the flag check.

## Plan integrity

- Plan file: `.cursor/plans/V1-CONTRACT-ONLY-2026-05-09-design.md` revision 2
  (post 3-critic synthesis: red-team + plan-agent + Explore + cloud
  ultrareview verdict findings=[])
- The 9 architectural decisions in plan §"Operator decisions locked"
  are all implemented in the source code.

## What is NOT done

- **NOT integrated with web UI** — Browser Control panel at
  `http://127.0.0.1:19003/` has its own chat path (WebSocket via
  `GatewayBrowserClient`), not yet routed through orchestrator-v1.
  Operator chose Telegram-first ("хер с тобой и с UI, у нас задача
  сегодня собрать умного оркестратора"); web UI integration deferred.
- **NOT executing tools** — diagnostic mode only. Real tool execution
  through the dispatcher's runTool callback requires plumbing the
  existing tool registry from agent-runner-execution. This is a
  separate workstream after the classifier is proven smart.
- **NOT replacing native flow** — env-flag short-circuit only. To
  cut over fully, remove the native `dispatchReplyWithBufferedBlockDispatcher`
  call from `bot-message-dispatch.ts` and unconditionally route
  through orchestrator-v1.

## Hot files for the next chat

| File | Purpose | Recent change |
|---|---|---|
| `src/orchestrator-v1/classifier-stage-a.ts` | tool MENU + Stage A prompt | TOOL_DESCRIPTIONS map needs synonym expansion |
| `src/orchestrator-v1/diagnostic.ts` | DRY-RUN reply renderer | currently shows JSON contract; could be friendlier |
| `src/orchestrator-v1/classifier-stage-b.ts` | per-tool arg extraction | needs context awareness for multi-action |
| `extensions/telegram/src/bot-message-dispatch.ts` | Telegram short-circuit | live, gated by env var |
| `src/plugin-sdk/inbound-reply-dispatch.ts` | universal short-circuit | works for non-Telegram |

## Active task on entry

Apply Vladimir's accepted hack: improve TOOL_DESCRIPTIONS in
`classifier-stage-a.ts` with Russian + English synonyms + use cases.
Especially `pdf` (currently fails on "инфографика"/"отчёт"). Then
restart gateway and re-test "PDF с инфографикой" + variants.

## Memory pointers

- `project_v1_contract_only.md` — active charter
- `project_v1_close_charter.md` — SUPERSEDED 2026-05-09
- All `commitment_kernel_*.plan.md` — historical, not active

## Bot identity

- Telegram bot: `@gode_mode_0_bot`
- Telegram demo chat: `6533456892`
- Operator: Vladimir
