# RUNBOOK — IntentContractor freshness/recency live-verify

| Field | Value |
| --- | --- |
| Sub-plan | `.cursor/plans/commitment_kernel_intent_contractor_freshness.plan.md` |
| Phase | 5 — Acceptance + log emissions + runbook |
| Slice | `intent-contractor-freshness` |
| Maintainer signoff | GRANTED via blanket authorization 2026-05-05 |
| Operator | Vladimir (Telegram chat 6533456892) |

This runbook is the operator script for the live-verify gate the slice
sub-plan §4 (acceptance #11) and §5 require to close Phase 5. It is
NOT a test the agent runs — Vladimir runs it on the dev gateway and
records the captured log lines + Telegram replies as evidence.

The agent has shipped:
- Phase 4 wiring (`<memory>` recency reorder + `<active_tasks>` recency
  reorder + `<freshness_hints>` block + producer-side `recordedAt`
  stamp).
- Phase 5 log emissions (four `[intent-contractor]` lines below).
- High-N acceptance test (`intent-contractor-freshness-acceptance.test.ts`).

This runbook closes the loop by exercising the path with REAL operator
input on a dev gateway and confirming the freshness reorder behaves
coherently when `MemoryStore` already holds a high-N cohort.

---

## §1 Pre-conditions

1. Dev gateway built from `feat/v1-freshness-phase-5-acceptance` (or a
   merged successor on `dev`) — confirm via `git rev-parse HEAD` and
   the gateway boot banner `god-mode-core ... commit=<sha>`.
2. Identity `identity:vladimir` already has > 10 semantic memory
   entries with mixed ages. Confirm via:
   ```
   sqlite3 ~/.openclaw/memory.db "SELECT COUNT(*) FROM semantic_entries WHERE identity_id='identity:vladimir';"
   ```
   The cohort SHOULD include rows recorded over the last 0–30 days
   so the freshness reorder has dynamic range to demonstrate.
3. `~/.openclaw/openclaw.json` UNTOUCHED (per memory rule
   "never overwrite ~/.openclaw/openclaw.json without backup"). The
   freshness slice ships defaults (`decayHalfLifeMs = 7d`,
   `defaultWindowMs = 30d`, `missingTimestampPolicy = 'penalize_to_floor'`)
   and does NOT require any new config key. If you DO want to tune,
   make a backup first.
4. Gateway started in foreground with stdout captured to a fresh log
   file (e.g. `gateway-freshness-live-verify.log`) so the four
   `[intent-contractor]` log lines can be greped reliably.

---

## §2 Operator prompts (3 turns)

Send the following three prompts in order via Telegram. Wait for the
gateway to surface the reply (the reply text is operator-judged for
coherence; the log lines are the structural assertion). Allow 10–30s
between turns so the per-turn log block does not interleave.

### Turn 1 — RECENT-anchored prompt
> "что я делал сегодня и вчера?" *(/ "what did I do today and yesterday?")*

Expected behaviour: the contractor's memory recall returns a top-K
list that includes recent entries (today / yesterday) at the head and
older entries (multi-day) at the tail. The `<freshness_hints>` block
is injected BEFORE the user prompt; the LLM sees its temporal frame.

### Turn 2 — OLD-anchored prompt
> "напомни о чем я договаривался месяц назад" *(/ "remind me what I agreed on a month ago")*

Expected behaviour: the contractor STILL applies the same reorder
(`combinedScore = score * recencyDecay`) — older entries fall to the
floor at `DECAY_FLOOR=0.05` so similarity-only matches dominate. The
LLM is the entity that interprets the temporal scope ("месяц назад") —
the freshness reorder is purely a prompt-attention budget tool. Reply
should still surface the matching old entry coherently.

### Turn 3 — NEUTRAL prompt with high recall pressure
> "перечисли все мои активные задачи и последние заметки" *(/ "list all my active tasks and recent notes")*

Expected behaviour: this is the cohort-pressure test. Both
`<active_tasks>` and `<memory>` blocks fire. Tasks reorder by
`updatedAt`-then-`createdAt`; memory reorders by recency. Both block
log lines fire (`memory.block` and `active_tasks.block`). The reply
should mention recent tasks first.

---

## §3 Expected gateway log lines

For EACH of the three turns above, grep the gateway log for the four
Phase 5 freshness records. Exactly one `freshness.applied` and one
`freshness_hints.block` per turn; `memory.block` and `active_tasks.block`
fire only when the corresponding recall surfaced ≥1 row.

Capture command:
```
grep -E '\[intent-contractor\] (freshness\.applied|memory\.block|active_tasks\.block|freshness_hints\.block)' gateway-freshness-live-verify.log
```

Expected line shapes (one per turn — ranges are empirical hints):

```
[intent-contractor] freshness.applied half_life_ms=604800000 floor=0.05 now_ms=<13-digit-epoch-ms> policy=penalize_to_floor
[intent-contractor] memory.block items=<N≥1> scored=<N> top_decay=<0.05–1.0> bottom_decay=<0.05–1.0>
[intent-contractor] active_tasks.block items=<N≥1> scored=<N> top_decay=<0.05–1.0> bottom_decay=<0.05–1.0>
[intent-contractor] freshness_hints.block emitted=true
```

Acceptance:
- `freshness.applied` carries the exact integer half-life
  `604800000` (= 7d × 86400000) when defaults are in use. A different
  value indicates a config override — record it.
- `top_decay` should be `> bottom_decay` whenever the recalled list
  spans > 1 distinct timestamp (the reorder did its job).
- `emitted=true` whenever ANY recall path fired (memory or tasks);
  `emitted=false` only when both recall paths returned empty.

---

## §4 Telegram coherence criteria

The bot's reply text is operator-judged. Acceptance:

- Turn 1 ("today/yesterday"): reply mentions actually-recent items;
  does NOT lead with stale or unrelated entries.
- Turn 2 ("a month ago"): reply still surfaces the matching old
  entry — the freshness floor at `0.05` ensures stale rows are never
  silently dropped.
- Turn 3 (combined): reply enumerates active tasks (preferring
  recently-updated) and mentions recent notes. No identity bleed
  (only `identity:vladimir`'s data — the freshness reorder is a pure
  per-identity reorder).

Failure modes that MUST trigger a STOP:
- Bot replies with content from a different identity (identity
  isolation regression — invariant guard).
- Bot throws or returns an `intent_unclear` low-confidence shape on a
  prompt the prior session handled (regression on the contractor
  pipeline rather than freshness wiring).
- One of the four log lines is absent for a turn that should have
  emitted it.

---

## §5 Telemetry capture

For each turn record:

| Field | Source |
| --- | --- |
| Turn id | gateway log `[turn] turnId=...` (preceding the freshness lines) |
| `freshness.applied` line | full text from log |
| `memory.block` line (if fired) | full text |
| `active_tasks.block` line (if fired) | full text |
| `freshness_hints.block` line | full text |
| Reply text | Telegram thread (copy/paste) |
| Latency | gateway log `[turn] turnId=... durationMs=...` |
| `decay envelope` | derived: `top_decay - bottom_decay` from the memory/tasks lines |

Save the captured block as a session note (e.g. paste into the next
handoff doc under "Phase 5 live-verify evidence").

---

## §6 Pass/Fail criteria

PASS — all three turns produce:
1. The four log lines per §3 with shapes matching the templates.
2. Reply text per §4 (operator-judged coherent).
3. No identity bleed.
4. No latency regression beyond the operator's prior-session baseline.

FAIL — any of:
- A log line is missing or malformed (different field order, missing
  `policy=` etc.).
- Reply text leaks another identity's data.
- Reply text is structurally wrong (e.g., LLM error replied as plain
  text).
- Gateway emits a stack trace tied to the freshness path.

If FAIL, capture the failing turn id, log block, and reply, and open a
hot-fix slice keyed to the master plan. The freshness defaults are
operator-tunable via `agents.defaults.embeddedPi.intentContractor`
extension keys (Phase 4 deps); however changing defaults at the
config layer is the SECOND-line response — diagnose the failure first.

---

## §7 References

- Sub-plan: `.cursor/plans/commitment_kernel_intent_contractor_freshness.plan.md`
- Audit: `extensions/AUDIT-intent-contractor-freshness.md`
- Phase 5 acceptance test:
  `src/platform/commitment/__tests__/intent-contractor-freshness-acceptance.test.ts`
- Log emission site:
  `src/platform/commitment/intent-contractor-impl.ts` →
  `emitFreshnessLogLines(...)`
- Frozen-layer integrity guard: same acceptance test, second `describe`.
- Telegram credentials: chat id 6533456892 (memory note
  `reference_telegram_demo_credentials.md`).
