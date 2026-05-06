import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { OpenClawConfig } from "../../config/config.js";
import {
  clearFollowupQueue,
  FOLLOWUP_QUEUES,
  resetInMemoryFollowupQueuesForTests,
  resetPersistedFollowupQueuesForTests,
} from "./queue/state.js";
import { __resetSessionResetRegistryForTests } from "../../server/session-reset-bootstrap.js";
import { initSessionState } from "./session.js";

/**
 * NEW-B Phase 5 — wiring acceptance.
 *
 * Goal: prove that `if (isNewSession)` in `session.ts` invokes
 * `resetTurnSession()` exactly once per reset and that the
 * `subscriber:followup-queue-clear` subscriber empties the
 * process-global FOLLOWUP_QUEUES for the rotating `sessionKey`.
 *
 * Reverse-test discipline (per slice-implementer rules): if Phase 5
 * is rolled back (`resetTurnSession` call commented out in `session.ts`),
 * the test "/new clears the followup queue for the rotating sessionKey"
 * will FAIL — the queue stays populated. The test was authored
 * fail-first against the pre-PR-#221 source; the post-PR-#221 fix is
 * the wiring landed in this PR.
 *
 * Live evidence (gateway log 2026-05-06 18:25:23.156): the leaking
 * prompt is verbatim the prior turn's user text drained from
 * FOLLOWUP_QUEUES under the rotating sessionKey. The subscriber's
 * primary fix maps directly onto that scenario.
 */

vi.mock("../../agents/session-write-lock.js", () => ({
  acquireSessionWriteLock: async () => ({ release: async () => {} }),
}));

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => []),
}));

let suiteRoot = "";
let suiteCase = 0;

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-session-reset-wiring-"),
  );
});

afterAll(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true });
  suiteRoot = "";
  suiteCase = 0;
});

async function makeCaseDir(prefix: string): Promise<string> {
  const dir = path.join(suiteRoot, `${prefix}${++suiteCase}`);
  await fs.mkdir(dir);
  return dir;
}

async function makeStorePath(prefix: string): Promise<string> {
  const root = await makeCaseDir(prefix);
  return path.join(root, "sessions.json");
}

function seedFollowupQueueWithCorrectivePrompt(sessionKey: string): void {
  // Simulate what `closure-outcome-dispatcher.ts:842-847` builds and
  // `enqueue.ts:61-99` stores: a queued followup whose prompt embeds
  // the prior-turn user text. This is the leak that the live evidence
  // (gateway-pr211.log line 120) shows being drained AFTER /new under
  // the new sessionId.
  const now = Date.now();
  const queue = {
    items: [
      {
        prompt:
          "[corrective retry header]\n\n[Original task - preserve exact task intent below]\n\nзапомни мне рецепт борща: свекла, капуста, картошка, морковь, томат",
        runId: "run-leaked",
        enqueuedAt: now,
      },
    ],
    droppedCount: 0,
    summaryLines: [],
    lastEnqueuedAt: now,
    settings: { debounceMs: 1000, cap: 20, drop: "summarize" as const },
  };
  // Cast around the structural seed; tests for the queue itself live in
  // its own file and exercise the full enqueue pipeline.
  FOLLOWUP_QUEUES.set(sessionKey, queue as unknown as never);
}

describe("session.ts /new — wiring of resetTurnSession (NEW-B Phase 5)", () => {
  beforeEach(() => {
    __resetSessionResetRegistryForTests();
    resetInMemoryFollowupQueuesForTests({ keepPersisted: true });
    resetPersistedFollowupQueuesForTests();
  });

  afterEach(() => {
    __resetSessionResetRegistryForTests();
    resetInMemoryFollowupQueuesForTests({ keepPersisted: true });
    resetPersistedFollowupQueuesForTests();
  });

  it("/new with a queued corrective followup clears FOLLOWUP_QUEUES for the rotating sessionKey (closes 2026-05-06 18:25-18:27 leak)", async () => {
    const storePath = await makeStorePath("openclaw-followup-clear-on-new-");
    const sessionKey = "telegram:6533456892";

    const cfg = {
      session: {
        store: storePath,
        resetTriggers: ["/new"],
      },
    } as OpenClawConfig;

    seedFollowupQueueWithCorrectivePrompt(sessionKey);
    expect(FOLLOWUP_QUEUES.get(sessionKey)?.items).toHaveLength(1);

    const result = await initSessionState({
      ctx: {
        RawBody: "/new",
        CommandBody: "/new",
        Provider: "telegram",
        ChatType: "direct",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    // PRIMARY assertion — followup queue for the rotating sessionKey
    // must be empty after /new. If Phase 5 wiring is missing this
    // assertion FAILS (the seed remains visible).
    expect(FOLLOWUP_QUEUES.get(sessionKey)).toBeUndefined();
  });

  it("/new emits the [session-reset] structured log line with subscribers=8 and the rotating ids", async () => {
    const storePath = await makeStorePath("openclaw-session-reset-log-");
    const sessionKey = "telegram:6533456892";

    const cfg = {
      session: {
        store: storePath,
        resetTriggers: ["/new"],
      },
    } as OpenClawConfig;

    // Capture the [session-reset] log line via console.log spy. The
    // production binding routes through `createSubsystemLogger("session-init").info`
    // which lands on the runtime log sink (console.log under tests).
    const logged: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      logged.push(line);
    });

    try {
      await initSessionState({
        ctx: {
          RawBody: "/new",
          CommandBody: "/new",
          Provider: "telegram",
          ChatType: "direct",
          SessionKey: sessionKey,
        },
        cfg,
        commandAuthorized: true,
      });
    } finally {
      consoleSpy.mockRestore();
    }

    // The structured log line is the operator-grep anchor (Phase 6).
    const sessionResetLines = logged.filter((line) =>
      line.includes("[session-reset]"),
    );
    expect(sessionResetLines.length).toBeGreaterThanOrEqual(1);
    const line = sessionResetLines[0];
    expect(line).toMatch(/event=session_reset/u);
    expect(line).toMatch(/subscribers=8/u);
    expect(line).toMatch(/reason=reset_trigger/u);
    expect(line).toMatch(/sessionKey=telegram:6533456892/u);
  });

  it("a fresh-start /new (no prior queued followup, no prior sessionEntry) still emits [session-reset] subscribers=8 with reason=reset_trigger", async () => {
    const storePath = await makeStorePath(
      "openclaw-session-reset-fresh-start-",
    );
    const sessionKey = "telegram:0000fresh";
    const cfg = {
      session: {
        store: storePath,
        resetTriggers: ["/new"],
      },
    } as OpenClawConfig;

    const logged: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      logged.push(line);
    });

    try {
      await initSessionState({
        ctx: {
          RawBody: "/new",
          CommandBody: "/new",
          Provider: "telegram",
          ChatType: "direct",
          SessionKey: sessionKey,
        },
        cfg,
        commandAuthorized: true,
      });
    } finally {
      consoleSpy.mockRestore();
    }

    const sessionResetLines = logged.filter((line) =>
      line.includes("[session-reset]"),
    );
    expect(sessionResetLines.length).toBeGreaterThanOrEqual(1);
    expect(sessionResetLines[0]).toMatch(/subscribers=8/u);
  });

  it("non-reset turn (no /new, fresh entry) does NOT emit a [session-reset] log line and does NOT clear queues", async () => {
    const storePath = await makeStorePath("openclaw-session-reset-noop-");
    const sessionKey = "telegram:7777777777";

    const cfg = {
      session: {
        store: storePath,
        resetTriggers: ["/new"],
      },
    } as OpenClawConfig;

    // Seed an existing fresh session entry so the second call is a NON-reset
    const existingId = "session-keep";
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: existingId,
          updatedAt: Date.now(),
          systemSent: true,
        },
      }),
      "utf8",
    );

    seedFollowupQueueWithCorrectivePrompt(sessionKey);

    const logged: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      logged.push(line);
    });

    try {
      await initSessionState({
        ctx: {
          RawBody: "hello world",
          CommandBody: "hello world",
          Provider: "telegram",
          ChatType: "direct",
          SessionKey: sessionKey,
        },
        cfg,
        commandAuthorized: true,
      });
    } finally {
      consoleSpy.mockRestore();
    }

    // No reset → no [session-reset] log line
    const sessionResetLines = logged.filter((line) =>
      line.includes("[session-reset]"),
    );
    expect(sessionResetLines).toHaveLength(0);
    // Queue must still be present — non-reset turns do not clear it.
    expect(FOLLOWUP_QUEUES.get(sessionKey)?.items).toHaveLength(1);
    // Cleanup
    clearFollowupQueue(sessionKey);
  });

  it("daily-staleness reset (no /new trigger, but stale entry) routes through the SAME call with reason=daily_reset", async () => {
    const storePath = await makeStorePath("openclaw-daily-staleness-reset-");
    const sessionKey = "telegram:55555staleness";

    // Stale entry: updatedAt long enough in the past that the default
    // freshness policy treats it as expired. We use 8 days; the default
    // resetMaxAgeMs is 7 days for direct (per session reset config).
    const eightDaysAgoMs = Date.now() - 8 * 24 * 3600 * 1000;
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "session-stale",
          updatedAt: eightDaysAgoMs,
          systemSent: true,
        },
      }),
      "utf8",
    );

    const cfg = {
      session: {
        store: storePath,
      },
    } as OpenClawConfig;

    const logged: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      logged.push(line);
    });

    try {
      const result = await initSessionState({
        ctx: {
          RawBody: "ordinary message",
          CommandBody: "ordinary message",
          Provider: "telegram",
          ChatType: "direct",
          SessionKey: sessionKey,
        },
        cfg,
        commandAuthorized: false,
      });
      // Stale → new session rotated; resetTriggered false (daily-staleness).
      expect(result.isNewSession).toBe(true);
      expect(result.resetTriggered).toBe(false);
    } finally {
      consoleSpy.mockRestore();
    }

    const sessionResetLines = logged.filter((line) =>
      line.includes("[session-reset]"),
    );
    expect(sessionResetLines.length).toBeGreaterThanOrEqual(1);
    // The reason field discriminates the daily-staleness path from the
    // operator-typed-/new path; Phase 6 acceptance asserts both routes
    // converge on the same call site.
    expect(sessionResetLines[0]).toMatch(/reason=daily_reset/u);
  });
});
