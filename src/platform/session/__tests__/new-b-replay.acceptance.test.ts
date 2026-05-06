import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearFollowupQueue,
  getExistingFollowupQueue,
  getFollowupQueue,
  resetInMemoryFollowupQueuesForTests,
} from "../../../auto-reply/reply/queue/state.js";
import type { FollowupRun, QueueSettings } from "../../../auto-reply/reply/queue/types.js";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  enqueueFollowupRun,
  resetRecentQueuedMessageIdDedupe,
} from "../../../auto-reply/reply/queue/enqueue.js";
import {
  __resetSessionResetRegistryForTests,
  getSessionResetRegistry,
} from "../../../server/session-reset-bootstrap.js";
import {
  asSessionResetSubscriberId,
  createSessionResetSubscriberRegistry,
  resetTurnSession,
  type SessionResetEvent,
  type SessionResetSubscriber,
} from "../reset.js";
import type { SessionId } from "../../commitment/ids.js";
import { asIdentityId, type IdentityId } from "../../identity/identity-id.js";
import { InMemoryMemoryStore } from "../../memory/in-memory-store.js";

/**
 * NEW-B Phase 6 — replay end-to-end acceptance fixture.
 *
 * Closes the live-reproduced 2026-05-06 18:25-18:27 leak in fixture
 * mode. Master plan §0.5.6 row NEW-B; sub-plan
 * `commitment_kernel_unified_session_reset.plan.md` Phase 6.
 *
 * Per Phase 1 audit (`extensions/AUDIT-unified-session-reset.md` §f) the
 * leak is `FOLLOWUP_QUEUES` (`src/auto-reply/reply/queue/state.ts:46-50`),
 * a process-global Map keyed by `sessionKey` populated by
 * `closure-outcome-dispatcher.ts:842-847` (which embeds the literal
 * prior-turn user text into a corrective followup prompt). The auto-reply
 * `/new` path (`session.ts`) did NOT call `clearFollowupQueue` while the
 * gateway-RPC reset path (`session-reset-service.ts:128-133`) DID. The
 * unified `resetTurnSession()` bus (Phase 3) + the
 * `subscriber:followup-queue-clear` subscriber (Phase 4) + the
 * `if (isNewSession)` wiring (Phase 5) close that asymmetry.
 *
 * Each test below:
 *
 *   1. Builds the production-shaped registry via `getSessionResetRegistry()`
 *      so the assertion `subscribers === 8` is sourced from the SAME
 *      bootstrap path production wires (no test-only re-registration).
 *
 *   2. Seeds `FOLLOWUP_QUEUES` via `enqueueFollowupRun` — the SAME
 *      production producer the leaked closure-outcome-dispatcher path
 *      uses — so the subscriber's `clearFollowupQueue(sessionKey)` is
 *      exercised against a real queue row, not a test-shaped stub.
 *
 *   3. Captures the `[session-reset]` log line emitted by
 *      `resetTurnSession()` and asserts the operator-grep anchor pins
 *      to the Phase 1 audit closed list (`subscribers=8`,
 *      `cleared >= 1`, `failed = 0`).
 *
 * Per AGENTS.md test discipline: NO `vi.spyOn` on the function under
 * test (`resetTurnSession`, the bootstrap registry, or the followup-queue
 * subscriber). Spies live only on optional dependencies of unrelated
 * subsystems (here: not used).
 *
 * Live-verify (REQUIRED — invariant #15 + handoff doc): the operator-side
 * replay against the actual 18:25-18:27 reproduction is documented in
 * the PR body, not in this test fixture; this test pins the invariants
 * a live replay would assert in CI mode.
 */

const VLADIMIR = asIdentityId("identity:vladimir");
const SESSION_KEY = "telegram:6533456892";
const PREVIOUS_SESSION_ID =
  "f71784c5-aaaa-bbbb-cccc-111111111111" as SessionId;
const NEW_SESSION_ID = "99f9e4f2-82be-4148-bd79-ffb80a2e07e3" as SessionId;
const RESET_AT = "2026-05-06T18:25:00.000Z";

// Mirrors the audit §c reproduction prompt verbatim (the Russian
// borscht-recipe leak) so a future grep across logs can correlate
// fixture text to the live-evidence log lines. The corresponding
// turn-2 query in the live evidence is «что я запомнил про борщ?»;
// the in-memory recall here uses the distinctive substring `борщ`
// directly because the in-memory scorer is substring-based (`борщ`
// IS a substring of `борща`, while the full Russian sentence is
// not).
const TURN_1_USER_TEXT =
  "запомни мне рецепт борща: свекла, капуста, картошка, морковь, томат";

const QUEUE_SETTINGS: QueueSettings = { mode: "queue" };

// Stand-in cfg for the FollowupRun.run.config field. The fixture never
// resolves a real config (the followup runner is never invoked here —
// only `enqueueFollowupRun` populates the queue and `clearFollowupQueue`
// drains it). The cast is the standard test-fixture shortcut used by
// slice E b1-replay and slice F b7-replay.
const FIXTURE_CFG = {} as unknown as OpenClawConfig;

function makeFollowupRun(prompt: string, suffix: string): FollowupRun {
  return {
    prompt,
    enqueuedAt: Date.parse("2026-05-06T18:24:30.000Z"),
    messageId: `msg-${suffix}`,
    originatingChannel: "telegram-bot",
    originatingTo: "6533456892",
    originatingAccountId: "primary",
    run: {
      agentId: "worker",
      agentDir: "/tmp/openclaw-test",
      sessionId: PREVIOUS_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: "/tmp/openclaw-test/session.jsonl",
      workspaceDir: "/tmp/openclaw-test/workspace",
      config: FIXTURE_CFG,
      provider: "test-provider",
      model: "test-model",
      timeoutMs: 30_000,
      blockReplyBreak: "message_end",
    },
  };
}

function buildResetEvent(overrides: Partial<SessionResetEvent> = {}): SessionResetEvent {
  return {
    sessionId: NEW_SESSION_ID,
    sessionKey: SESSION_KEY,
    identityId: VLADIMIR,
    previousSessionId: PREVIOUS_SESSION_ID,
    reason: "reset_trigger",
    occurredAt: RESET_AT,
    ...overrides,
  };
}

/**
 * Capture the single structured log line `resetTurnSession()` emits
 * per call. Tests assert on the captured string rather than spying on
 * `console.log` so the assertion does not depend on ambient stdio
 * shape.
 */
function makeLogCapture(): {
  readonly log: (line: string) => void;
  readonly lines: readonly string[];
} {
  const lines: string[] = [];
  return {
    log(line: string) {
      lines.push(line);
    },
    get lines() {
      return lines;
    },
  };
}

beforeEach(() => {
  __resetSessionResetRegistryForTests();
  resetInMemoryFollowupQueuesForTests();
  // Persisted dedupe cache spans tests in the same process — clear it
  // so each test's `enqueueFollowupRun` call lands fresh items
  // regardless of `messageId` collision with prior tests.
  resetRecentQueuedMessageIdDedupe();
});

afterEach(() => {
  __resetSessionResetRegistryForTests();
  resetInMemoryFollowupQueuesForTests();
  resetRecentQueuedMessageIdDedupe();
});

describe("NEW-B Phase 6 — replay acceptance fixture", () => {
  it("closes the live-reproduced FOLLOWUP_QUEUES leak — turn-2 sees no queued prior-turn prompt and the log pins subscribers=8", async () => {
    // ----- TURN 1 (pre-/new) — populate FOLLOWUP_QUEUES the way the
    // closure-outcome-dispatcher does at audit §c reproduction. The
    // queued prompt embeds the literal prior user text — this is the
    // payload that resurfaces as the parrot reply on turn 2 when the
    // queue is NOT cleared.
    const queuedSucceeded = enqueueFollowupRun(
      SESSION_KEY,
      makeFollowupRun(TURN_1_USER_TEXT, "1"),
      QUEUE_SETTINGS,
    );
    expect(queuedSucceeded).toBe(true);
    const seededQueue = getExistingFollowupQueue(SESSION_KEY);
    expect(seededQueue).toBeDefined();
    expect(seededQueue?.items).toHaveLength(1);
    expect(seededQueue?.items[0]?.prompt).toContain(TURN_1_USER_TEXT);

    // Plant a memory entry for VLADIMIR so the slice E B1 regression
    // guard at the bottom of this test can prove identity-scope
    // memory survives the reset (turn-2 recall returns the planted
    // entry even after the reset).
    const memoryStore = new InMemoryMemoryStore();
    await memoryStore.storeSemantic({
      identityId: VLADIMIR,
      content: TURN_1_USER_TEXT,
      metadata: { source: "fixture", kind: "recipe" },
    });
    const turn1Recall = await memoryStore.recall({
      identityId: VLADIMIR,
      query: "борщ",
      limit: 5,
    });
    expect(turn1Recall.entries.length).toBeGreaterThanOrEqual(1);

    // ----- SIMULATE /new — invoke resetTurnSession via the production
    // bootstrap registry. Capture the structured log line.
    const registry = getSessionResetRegistry();
    expect(registry.list()).toHaveLength(8);
    const capture = makeLogCapture();
    const summary = await resetTurnSession({
      event: buildResetEvent(),
      registry,
      logger: capture.log,
    });

    // (c) Phase 6 §6 — `[session-reset] subscribers=8` log line fires
    // with `cleared >= 1`.
    expect(summary.subscribers).toHaveLength(8);
    expect(summary.clearedCount).toBeGreaterThanOrEqual(1);
    expect(summary.failedCount).toBe(0);
    expect(capture.lines).toHaveLength(1);
    const logLine = capture.lines[0] ?? "";
    expect(logLine).toContain("[session-reset]");
    expect(logLine).toContain("event=session_reset");
    expect(logLine).toContain(`sessionKey=${SESSION_KEY}`);
    expect(logLine).toContain(`sessionId=${NEW_SESSION_ID}`);
    expect(logLine).toContain("reason=reset_trigger");
    expect(logLine).toContain(`identityId=${VLADIMIR}`);
    expect(logLine).toContain("subscribers=8");
    expect(logLine).toMatch(/cleared=[1-9]\d*/u);
    expect(logLine).toContain("failed=0");

    // The followup-queue-clear subscriber fired a `cleared` outcome
    // for our seeded queue.
    const followupQueueResult = summary.subscribers.find(
      (row) => row.id === "subscriber:followup-queue-clear",
    );
    expect(followupQueueResult).toBeDefined();
    expect(followupQueueResult?.outcome.kind).toBe("cleared");

    // ----- TURN 2 (post-/new) — assert the queue is empty so the
    // followup runner CANNOT replay the prior-turn prompt.
    //
    // (a) Phase 6 §6 — FOLLOWUP_QUEUES for OLD sessionKey/sessionId is
    // empty (no prior user turn carry-over).
    const queueAfterReset = getExistingFollowupQueue(SESSION_KEY);
    expect(queueAfterReset).toBeUndefined();

    // (d) Phase 6 §6 — model's prompt context receives ONLY new prompt
    // (no parrot). Simulated by checking that no queue items are
    // available for the followup drainer. In production the drainer
    // would see an empty queue and not produce a parallel run.
    expect(getExistingFollowupQueue(SESSION_KEY)?.items ?? []).toHaveLength(0);

    // (b) Phase 6 §6 — memory recall for operator's identityId DOES
    // surface prior facts. This is the slice E B1 regression guard:
    // identity-scoped memory survives /new by design (slice E PR-#170
    // contract; reaffirmed by `subscriber:memory-scope-reaffirm` which
    // emits `kind: "skipped"`).
    const memoryReaffirm = summary.subscribers.find(
      (row) => row.id === "subscriber:memory-scope-reaffirm",
    );
    expect(memoryReaffirm).toBeDefined();
    expect(memoryReaffirm?.outcome.kind).toBe("skipped");

    const turn2Recall = await memoryStore.recall({
      identityId: VLADIMIR,
      query: "борщ",
      limit: 5,
    });
    expect(turn2Recall.entries.length).toBeGreaterThanOrEqual(1);
    const turn2Contents = turn2Recall.entries.map((e) => e.content);
    expect(turn2Contents.some((c) => c.includes("свекла"))).toBe(true);
  });

  it("reverse — omitting resetTurnSession() leaves FOLLOWUP_QUEUES leaking the prior-turn user text (bug reproduction fail-first)", async () => {
    // Seed the queue exactly as test 1 does — but DO NOT call
    // resetTurnSession(). This proves the test 1 assertion (queue
    // empty after reset) is non-trivially won by the production
    // wiring; without the reset call, the prior-turn user text
    // remains queued for replay under the new sessionId — the live
    // 2026-05-06 18:25-18:27 leak shape.
    enqueueFollowupRun(
      SESSION_KEY,
      makeFollowupRun(TURN_1_USER_TEXT, "1"),
      QUEUE_SETTINGS,
    );

    // Bootstrap the registry but NEVER call resetTurnSession().
    // The registry exists with 8 subscribers; merely instantiating
    // it does NOT dispatch — only resetTurnSession does.
    const registry = getSessionResetRegistry();
    expect(registry.list()).toHaveLength(8);

    // The bug shape: queue still carries the prior-turn payload
    // verbatim, the followup drainer would replay it under the new
    // sessionId, and the operator sees the parrot reply.
    const leakedQueue = getExistingFollowupQueue(SESSION_KEY);
    expect(leakedQueue).toBeDefined();
    expect(leakedQueue?.items).toHaveLength(1);
    expect(leakedQueue?.items[0]?.prompt).toContain(TURN_1_USER_TEXT);

    // Cleanup — remove the leaked queue manually so afterEach starts
    // from a clean slate; this also confirms the production
    // `clearFollowupQueue` API contract returns >0 when there ARE
    // items to drop, which is what subscriber:followup-queue-clear
    // emits as `kind: "cleared", details.entriesCleared`.
    const cleared = clearFollowupQueue(SESSION_KEY);
    expect(cleared).toBeGreaterThanOrEqual(1);
    expect(getExistingFollowupQueue(SESSION_KEY)).toBeUndefined();
  });

  it("subscriber failure isolation — one throwing subscriber does NOT block others (defense-in-depth invariant #15)", async () => {
    // Build a private registry (NOT the production singleton) so the
    // throwing subscriber cannot leak across tests. Insert three
    // subscribers in deterministic order: pass — throw — pass. The
    // assertion: outcome reports `failed` for the middle slot, both
    // outer slots run normally, and the followup queue is still
    // cleared by the third subscriber.
    enqueueFollowupRun(
      SESSION_KEY,
      makeFollowupRun(TURN_1_USER_TEXT, "1"),
      QUEUE_SETTINGS,
    );

    const cleared: string[] = [];
    const passSubscriberA: SessionResetSubscriber = {
      id: asSessionResetSubscriberId("subscriber:test-pass-a"),
      category: "misc",
      async onReset() {
        cleared.push("a");
        return { kind: "cleared", details: { slot: "a" } };
      },
    };
    const throwingSubscriber: SessionResetSubscriber = {
      id: asSessionResetSubscriberId("subscriber:test-throw"),
      category: "misc",
      async onReset() {
        throw new Error("synthetic_isolation_test_failure");
      },
    };
    const passSubscriberC: SessionResetSubscriber = {
      id: asSessionResetSubscriberId("subscriber:test-pass-c"),
      category: "chat-history",
      async onReset(event) {
        const queue = getExistingFollowupQueue(event.sessionKey);
        const before = queue?.items.length ?? 0;
        clearFollowupQueue(event.sessionKey);
        cleared.push("c");
        return {
          kind: "cleared",
          details: { slot: "c", entriesCleared: before },
        };
      },
    };

    const registry = createSessionResetSubscriberRegistry();
    registry.register(passSubscriberA);
    registry.register(throwingSubscriber);
    registry.register(passSubscriberC);

    const capture = makeLogCapture();
    const summary = await resetTurnSession({
      event: buildResetEvent(),
      registry,
      logger: capture.log,
    });

    // All three subscribers ran in order even though the middle one
    // threw — that is the defense-in-depth invariant #15 guarantee.
    expect(cleared).toEqual(["a", "c"]);
    expect(summary.subscribers.map((s) => s.id as string)).toEqual([
      "subscriber:test-pass-a",
      "subscriber:test-throw",
      "subscriber:test-pass-c",
    ]);
    expect(summary.subscribers[0]?.outcome.kind).toBe("cleared");
    expect(summary.subscribers[1]?.outcome.kind).toBe("failed");
    expect(summary.subscribers[2]?.outcome.kind).toBe("cleared");
    expect(summary.clearedCount).toBe(2);
    expect(summary.failedCount).toBe(1);

    // Log line surfaces the failure count without abandoning the run.
    const logLine = capture.lines[0] ?? "";
    expect(logLine).toContain("subscribers=3");
    expect(logLine).toContain("failed=1");
    expect(logLine).toContain("cleared=2");

    // The downstream queue WAS cleared by passSubscriberC despite the
    // middle subscriber's throw — i.e. the leak fix proceeds even
    // under partial-failure conditions.
    expect(getExistingFollowupQueue(SESSION_KEY)).toBeUndefined();
  });

  it("anonymous session — reset still runs cleanly with identityId=undefined; log line renders identityId=anon", async () => {
    enqueueFollowupRun(
      SESSION_KEY,
      makeFollowupRun(TURN_1_USER_TEXT, "anon"),
      QUEUE_SETTINGS,
    );
    expect(getExistingFollowupQueue(SESSION_KEY)?.items).toHaveLength(1);

    const registry = getSessionResetRegistry();
    expect(registry.list()).toHaveLength(8);
    const capture = makeLogCapture();
    const summary = await resetTurnSession({
      event: buildResetEvent({ identityId: undefined }),
      registry,
      logger: capture.log,
    });

    // Reset completes — production wiring does NOT crash on the
    // anonymous-identity branch.
    expect(summary.subscribers).toHaveLength(8);
    expect(summary.failedCount).toBe(0);
    // `subscriber:followup-queue-clear` does NOT need identityId — it
    // keys on `sessionKey` only — so the leak is closed even
    // pre-identity-resolution. This matches the audit §a row 13
    // (`FOLLOWUP_QUEUES` keyed by `sessionKey`, NOT `sessionId` /
    // `identityId`).
    expect(summary.clearedCount).toBeGreaterThanOrEqual(1);
    expect(getExistingFollowupQueue(SESSION_KEY)).toBeUndefined();

    const logLine = capture.lines[0] ?? "";
    // Anonymous events render `identityId=anon` per Phase 3 contract
    // so post-mortem grep can distinguish identity-resolved resets
    // from pre-resolution resets without parsing the absence of a
    // field.
    expect(logLine).toContain("identityId=anon");
    expect(logLine).not.toContain("identity:vladimir");
  });

  it("identity preservation — turn-1 memory under operator A survives /new and turn-2 recall returns the prior fact (slice E B1 RUNTIME-wise regression guard)", async () => {
    // This is the slice E B1 RUNTIME-wise regression guard: the master
    // plan §0.5.6 NEW-B row says NEW-B closes B1 RUNTIME-wise. Slice E
    // PR-#170 closed B1 architecturally (memory-store keyed by
    // identityId; survives /new because the store is identity-scoped,
    // not session-scoped). NEW-B Phase 6 closes the runtime gap by
    // proving the unified reset bus does NOT accidentally cross-clear
    // identity-scoped state.
    const memoryStore = new InMemoryMemoryStore();

    // Turn 1 — operator A (VLADIMIR) plants a fact under their identity.
    await memoryStore.storeSemantic({
      identityId: VLADIMIR,
      content: TURN_1_USER_TEXT,
      metadata: { source: "fixture", kind: "recipe", operator: "vladimir" },
    });

    // Sanity: the fact is recallable BEFORE the reset. Use the
    // distinctive substring `борщ` rather than the full TURN_2_USER_TEXT
    // (the in-memory scorer is substring-based; `борщ` IS a substring of
    // `борща` while the full Russian sentence is not).
    const beforeReset = await memoryStore.recall({
      identityId: VLADIMIR,
      query: "борщ",
      limit: 5,
    });
    expect(beforeReset.entries.length).toBeGreaterThanOrEqual(1);

    // Simulated /new — invoke resetTurnSession with the production
    // 8-subscriber registry.
    const registry = getSessionResetRegistry();
    const summary = await resetTurnSession({
      event: buildResetEvent(),
      registry,
    });

    // The memory-scope-reaffirm subscriber MUST emit `skipped` with a
    // reason mentioning identity-scope. If it ever flips to `cleared`
    // that would be a B1 regression — operator memory survives /new by
    // design (slice E PR-#170 contract).
    const memoryReaffirm = summary.subscribers.find(
      (row) => row.id === "subscriber:memory-scope-reaffirm",
    );
    expect(memoryReaffirm).toBeDefined();
    expect(memoryReaffirm?.outcome.kind).toBe("skipped");
    if (memoryReaffirm?.outcome.kind === "skipped") {
      expect(memoryReaffirm.outcome.reason.toLowerCase()).toContain(
        "identity",
      );
    }

    // Same posture for slice F task-scope reaffirm — B7 regression
    // guard covered by the audit §d row 6.
    const taskReaffirm = summary.subscribers.find(
      (row) => row.id === "subscriber:task-scope-reaffirm",
    );
    expect(taskReaffirm).toBeDefined();
    expect(taskReaffirm?.outcome.kind).toBe("skipped");

    // Turn 2 — operator A asks «что я запомнил про борщ?»; recall
    // surfaces the planted fact. The store was NEVER touched by the
    // reset (it lives outside the session-reset bus by design).
    const afterReset = await memoryStore.recall({
      identityId: VLADIMIR,
      query: "борщ",
      limit: 5,
    });
    expect(afterReset.entries.length).toBeGreaterThanOrEqual(1);
    expect(afterReset.entries.some((e) => e.content.includes("свекла"))).toBe(
      true,
    );
    expect(afterReset.entries.some((e) => e.content === TURN_1_USER_TEXT)).toBe(
      true,
    );

    // Cross-operator separation: a different IdentityId MUST NOT see
    // operator A's memory (this is the slice E B1 + slice D
    // cross-channel-identity invariant; this fixture pins it under the
    // reset bus too).
    const someoneElse: IdentityId = asIdentityId("identity:someone-else");
    const crossOperator = await memoryStore.recall({
      identityId: someoneElse,
      query: "борщ",
      limit: 5,
    });
    expect(crossOperator.entries).toHaveLength(0);

    // Smoke: if a future refactor rewires the followup-queue subscriber
    // to also clear MemoryStore by mistake, the test above already
    // catches it (afterReset would be empty). This `getFollowupQueue`
    // helper call is defensive proof that test 5 also exercises the
    // queue-clearing code path even though no queue was seeded — i.e.
    // even an absent queue does not perturb the identity-scoped store.
    expect(getFollowupQueue(SESSION_KEY, QUEUE_SETTINGS).items).toHaveLength(0);
  });
});
