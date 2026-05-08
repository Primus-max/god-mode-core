/**
 * Slice D — DIAGNOSTIC-2026-05-08 Fix 3 plumbing. Sibling slice to
 * PR #310 (`fix(pi-embedded-runner): wrap streaming onBlockReply with
 * OutboundCoalescer`).
 *
 * Diagnostic: `.cursor/plans/DIAGNOSTIC-2026-05-08-kernel-vs-legacy-divergence.md`.
 * Production evidence: gateway-dev-2026-05-07.log session `78ff2b60`
 * turn 1 — Opus 4.6 emitted four `message_end` events for ONE logical
 * answer; each fired `onBlockReply` and shipped as its own Telegram
 * message. Two were chain-of-thought preambles ("ser is asking about",
 * "on for agent management. Actually, I think...") that should never
 * have left the model. PR #310 added the `attempt.ts` coalescer wrap
 * but gated it behind two opt-in params that NO production caller
 * sets:
 *   - `outboundCoalescerStreamingTurnId`
 *   - `outboundCoalescerStreamingChannelKey`
 *
 * Without this slice, PR #310 is dead code on every production turn
 * (the diagnostic confirmed `[outbound-coalescer] event=committed`
 * never appeared in the live evidence). This slice plumbs the two
 * fields from `agent-runner-execution.ts` → `runEmbeddedPiAgent` →
 * `runEmbeddedAttempt` so that real channel + identity tuples
 * activate the wrap, while heartbeat / internal channels keep the
 * bypass (preserving PR #310's regression-guard tests).
 *
 * What this test cohort pins:
 *   A — production-caller threading (positive): a real Telegram
 *       turn with `originatingChannel=telegram` +
 *       `originatingTo=<peer>` MUST forward both opt-in fields into
 *       the `runEmbeddedPiAgent` call, where they flow verbatim into
 *       `runEmbeddedAttempt` and engage the PR #310 wrap.
 *   B — channel-key shape: pin the structural format
 *       `${channel}:${accountId}:${target}` (consistent with the
 *       upstream `agent-runner.ts:644` coalescer wrap and the
 *       broker's queueKey from `dispatch-turn-via-broker.ts:156`).
 *       A test rather than a doc-comment so any future shape drift
 *       between the upstream wrap, the broker queueKey, and the
 *       streaming wrap surfaces immediately.
 *   C — heartbeat negative: when `isHeartbeat=true` flows down the
 *       same chain, both opt-in fields MUST remain undefined so the
 *       PR #310 bypass branch (= byte-identical pre-PR-310 behavior)
 *       is taken. Regression guard for the heartbeat lane.
 *   C2 — internal-channel negative: when `originatingChannel` is
 *       `webchat` (the `INTERNAL_MESSAGE_CHANNEL` in
 *       `src/utils/message-channel.ts:19`), both opt-in fields MUST
 *       remain undefined. The webchat lane has its own delivery
 *       surface and the streaming coalescer's drop_intermediates
 *       merge would suppress chunks the internal UI expects to
 *       render incrementally.
 *   C3 — missing originating tuple negative: when
 *       `originatingChannel` resolves but `originatingTo` is empty
 *       (e.g. CLI / test fixtures), both opt-in fields MUST remain
 *       undefined — channelKey requires a real target peer.
 *
 * Test discipline (per AGENTS.md "Tests must catch real bugs"):
 *   - The function under test is `runReplyAgent`. We do NOT spy on
 *     it.
 *   - Spies live on direct dependencies (`runAgentTurnWithFallback`
 *     forwarded to actual + capture; `runEmbeddedPiAgent` mocked at
 *     the seam where the new fields are attached). The wrap helper
 *     `wrapStreamingOutboundWithCoalescer` is NOT spied — we only
 *     observe the param boundary.
 *   - Each (A) (B) assertion fails on parent
 *     (`859769c269` — predecessor SHA, before this slice). Each (C*)
 *     assertion both fails on parent (the field is undefined for the
 *     wrong reason — caller never set anything) AND remains green
 *     after this slice (correct undefined for the right reason —
 *     bypass branch). The negative tests are paired with (A) so the
 *     bypass-vs-engaged contrast is the source of truth.
 *   - vi.resetModules + lazy-import pattern (PR #308 / #311) for
 *     cohort-flake resilience.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { TypingMode } from "../../config/types.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

// ============================================================================
// vi.hoisted state — captures and module-level seams.
// ============================================================================

const state = vi.hoisted(() => ({
  runEmbeddedPiAgentMock: vi.fn(),
  runCliAgentMock: vi.fn(),
  capturedEmbeddedParams: [] as Array<Record<string, unknown>>,
}));

const accountingState = vi.hoisted(() => ({
  persistRunSessionUsageMock: vi.fn(),
  incrementRunCompactionCountMock: vi.fn(),
  persistRunSessionUsageActual: null as null | ((params: unknown) => Promise<void>),
  incrementRunCompactionCountActual: null as
    | null
    | ((params: unknown) => Promise<number | undefined>),
}));

const helperState = vi.hoisted(() => ({
  finalizeWithFollowupMock: vi.fn(),
  finalizeWithFollowupActual: null as null | ((...args: unknown[]) => unknown),
}));

// ============================================================================
// Module mocks — same harness pattern as
// `agent-runner.thread-kernel-deps.e2e.test.ts` (PR #311).
// ============================================================================

vi.mock("../../agents/model-fallback.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/model-fallback.js")>();
  return {
    ...actual,
    runWithModelFallback: async ({
      provider,
      model,
      run,
    }: {
      provider: string;
      model: string;
      run: (provider: string, model: string) => Promise<unknown>;
    }) => ({
      result: await run(provider, model),
      provider,
      model,
      attempts: [],
    }),
  };
});

vi.mock("../../agents/pi-embedded.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/pi-embedded.js")>();
  return {
    ...actual,
    queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
    runEmbeddedPiAgent: (params: unknown) => state.runEmbeddedPiAgentMock(params),
  };
});

vi.mock("../../agents/cli-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/cli-runner.js")>();
  return {
    ...actual,
    runCliAgent: (params: unknown) => state.runCliAgentMock(params),
  };
});

vi.mock("./queue/enqueue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queue/enqueue.js")>();
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
  };
});

vi.mock("./queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queue.js")>();
  return {
    ...actual,
    scheduleFollowupDrain: vi.fn(),
  };
});

vi.mock("./session-run-accounting.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-run-accounting.js")>();
  accountingState.persistRunSessionUsageActual = actual.persistRunSessionUsage as (
    params: unknown,
  ) => Promise<void>;
  accountingState.incrementRunCompactionCountActual = actual.incrementRunCompactionCount as (
    params: unknown,
  ) => Promise<number | undefined>;
  return {
    ...actual,
    persistRunSessionUsage: (params: unknown) => accountingState.persistRunSessionUsageMock(params),
    incrementRunCompactionCount: (params: unknown) =>
      accountingState.incrementRunCompactionCountMock(params),
  };
});

vi.mock("./agent-runner-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-runner-helpers.js")>();
  helperState.finalizeWithFollowupActual = actual.finalizeWithFollowup as (
    ...args: unknown[]
  ) => unknown;
  return {
    ...actual,
    finalizeWithFollowup: (...args: unknown[]) => helperState.finalizeWithFollowupMock(...args),
  };
});

// ============================================================================
// Lazy-load runReplyAgent (must come AFTER mocks are registered so the
// module graph captured under test wires the mocked dependencies).
// ============================================================================

let runReplyAgentPromise:
  | Promise<(typeof import("./agent-runner.js"))["runReplyAgent"]>
  | undefined;

async function getRunReplyAgent() {
  if (!runReplyAgentPromise) {
    runReplyAgentPromise = import("./agent-runner.js").then((m) => m.runReplyAgent);
  }
  return await runReplyAgentPromise;
}

// ============================================================================
// Per-test broker fixture — bind a real broker so the runReplyAgent
// chain reaches `runAgentTurnBody` without hitting the broker bypass
// reject path. The broker's behaviour itself isn't under test here (PR
// #311 owns that); we just need a healthy chain to the
// `runEmbeddedPiAgent` seam where the new opt-in fields land.
// ============================================================================

async function bindBroker(): Promise<void> {
  const { bindProcessConcurrentTurnBroker, __resetConcurrentTurnBrokerBootstrapForTests } =
    await import("../../server/concurrent-turn-broker-bootstrap.js");
  __resetConcurrentTurnBrokerBootstrapForTests();
  bindProcessConcurrentTurnBroker({
    logger: {
      log: () => {},
    },
  });
}

async function unbindBroker() {
  const { __resetConcurrentTurnBrokerBootstrapForTests } = await import(
    "../../server/concurrent-turn-broker-bootstrap.js"
  );
  __resetConcurrentTurnBrokerBootstrapForTests();
}

async function resetMemoryRuntime() {
  const { __resetMemoryRuntimeForTests } = await import("../../server/memory-store-bootstrap.js");
  __resetMemoryRuntimeForTests();
}

// ============================================================================
// Run-builder — Telegram-shaped sessionKey that maps to identity:vladimir,
// matching the live-evidence trace `78ff2b60` from the diagnostic.
// ============================================================================

const VLADIMIR_TELEGRAM_PEER = "6533456892";
const VLADIMIR_SESSION_KEY = `agent:main:telegram:direct:${VLADIMIR_TELEGRAM_PEER}`;

function buildIdentitiesConfig() {
  return {
    "identity:vladimir": {
      displayName: "Vladimir",
      mappings: [{ channel: "telegram", externalId: VLADIMIR_TELEGRAM_PEER }],
    },
  };
}

type BuildOpts = {
  originatingChannel?: string;
  originatingTo?: string;
  originatingAccountId?: string;
  isHeartbeat?: boolean;
};

function buildRun(buildOpts: BuildOpts = {}) {
  const typing = createMockTypingController();
  const opts: GetReplyOptions | undefined = buildOpts.isHeartbeat
    ? ({ isHeartbeat: true } as unknown as GetReplyOptions)
    : undefined;
  const sessionCtx = {
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: buildOpts.originatingChannel ?? "telegram",
    OriginatingTo: buildOpts.originatingTo ?? VLADIMIR_TELEGRAM_PEER,
    AccountId: buildOpts.originatingAccountId ?? "primary",
    MessageSid: "msg-1",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const sessionKey = VLADIMIR_SESSION_KEY;
  const cfg: Record<string, unknown> = {
    identities: buildIdentitiesConfig(),
  };
  const followupRun = {
    prompt: "Удали лишних",
    summaryLine: "Удали лишних",
    enqueuedAt: Date.now(),
    originatingChannel: buildOpts.originatingChannel ?? "telegram",
    originatingTo: buildOpts.originatingTo ?? VLADIMIR_TELEGRAM_PEER,
    originatingAccountId: buildOpts.originatingAccountId ?? "primary",
    originatingThreadId: undefined,
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey,
      messageProvider: buildOpts.originatingChannel ?? "telegram",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: cfg,
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;

  return {
    typing,
    opts,
    sessionCtx,
    sessionKey,
    run: async () => {
      const runReplyAgent = await getRunReplyAgent();
      return runReplyAgent({
        commandBody: "Удали лишних",
        followupRun,
        queueKey: sessionKey,
        resolvedQueue,
        shouldSteer: false,
        shouldFollowup: false,
        isActive: false,
        isStreaming: false,
        opts,
        typing,
        sessionKey,
        sessionCtx,
        defaultModel: "anthropic/claude-opus-4-5",
        resolvedVerboseLevel: "off",
        isNewSession: false,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: "instant" as TypingMode,
      });
    },
  };
}

// ============================================================================
// Suite.
// ============================================================================

beforeAll(async () => {
  await getRunReplyAgent();
});

beforeEach(async () => {
  state.runEmbeddedPiAgentMock.mockClear();
  state.runCliAgentMock.mockClear();
  state.capturedEmbeddedParams = [];
  accountingState.persistRunSessionUsageMock.mockReset();
  accountingState.incrementRunCompactionCountMock.mockReset();
  helperState.finalizeWithFollowupMock.mockReset();

  accountingState.persistRunSessionUsageMock.mockImplementation(async (params: unknown) => {
    await accountingState.persistRunSessionUsageActual?.(params);
  });
  accountingState.incrementRunCompactionCountMock.mockImplementation(async (params: unknown) => {
    return await accountingState.incrementRunCompactionCountActual?.(params);
  });
  helperState.finalizeWithFollowupMock.mockImplementation((...args: unknown[]) => {
    return helperState.finalizeWithFollowupActual?.(...args);
  });
  vi.stubEnv("OPENCLAW_DEBUG_REPLY_ROUTING", "0");
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");

  // Default LLM passthrough — captures the params object so each test
  // can inspect the threading at the production seam where Slice D
  // attaches the new opt-in fields, then resolves a benign payload so
  // the post-call accounting and reply-build path still completes.
  state.runEmbeddedPiAgentMock.mockImplementation(async (params: unknown) => {
    state.capturedEmbeddedParams.push(params as Record<string, unknown>);
    return {
      payloads: [{ text: "ok" }],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    };
  });

  await bindBroker();
  await resetMemoryRuntime();
});

afterEach(async () => {
  await unbindBroker();
  await resetMemoryRuntime();
  vi.unstubAllEnvs();
});

describe("agent-runner-execution.ts — Slice D streaming OutboundCoalescer plumbing", () => {
  // ------------------------------------------------------------------------
  // Test A — production-caller threading (positive)
  // ------------------------------------------------------------------------
  it("A: forwards both opt-in fields into runEmbeddedPiAgent for a real Telegram turn", async () => {
    const { run } = buildRun();
    await run();

    expect(state.capturedEmbeddedParams).toHaveLength(1);
    const captured = state.capturedEmbeddedParams[0];
    expect(captured).toBeDefined();

    // Both fields MUST be defined and non-empty. On parent (859769c269)
    // these are undefined for every production turn — the bypass-only
    // bug PR #310's "Out of scope" follow-up flagged.
    expect(typeof captured!["outboundCoalescerStreamingTurnId"]).toBe("string");
    expect((captured!["outboundCoalescerStreamingTurnId"] as string).length).toBeGreaterThan(0);
    expect(typeof captured!["outboundCoalescerStreamingChannelKey"]).toBe("string");
    expect((captured!["outboundCoalescerStreamingChannelKey"] as string).length).toBeGreaterThan(0);

    // The turnId must equal the runtime runId (mirrors PR #311's `turnId
    // = params.opts?.runId ?? params.followupRun.requestRunId ??
    // crypto.randomUUID()` resolution); the same UUID is forwarded into
    // pi-embedded so the wrap and the broker key the same logical turn.
    expect(captured!["outboundCoalescerStreamingTurnId"]).toBe(captured!["runId"]);
  });

  // ------------------------------------------------------------------------
  // Test B — channel-key shape contract
  // ------------------------------------------------------------------------
  it("B: channel-key matches `${channel}:${accountId}:${target}` shape", async () => {
    const { run } = buildRun({
      originatingChannel: "telegram",
      originatingAccountId: "primary",
      originatingTo: VLADIMIR_TELEGRAM_PEER,
    });
    await run();

    const captured = state.capturedEmbeddedParams[0];
    expect(captured).toBeDefined();
    const channelKey = captured!["outboundCoalescerStreamingChannelKey"];
    expect(channelKey).toBe(`telegram:primary:${VLADIMIR_TELEGRAM_PEER}`);
  });

  // ------------------------------------------------------------------------
  // Test C — heartbeat negative
  // ------------------------------------------------------------------------
  it("C: heartbeat turns leave both opt-in fields undefined (PR #310 bypass)", async () => {
    const { run } = buildRun({ isHeartbeat: true });
    await run();

    expect(state.capturedEmbeddedParams).toHaveLength(1);
    const captured = state.capturedEmbeddedParams[0];
    expect(captured).toBeDefined();
    expect(captured!["outboundCoalescerStreamingTurnId"]).toBeUndefined();
    expect(captured!["outboundCoalescerStreamingChannelKey"]).toBeUndefined();
  });

  // ------------------------------------------------------------------------
  // Test C2 — internal/webchat channel negative
  // ------------------------------------------------------------------------
  it("C2: webchat (INTERNAL_MESSAGE_CHANNEL) leaves both opt-in fields undefined", async () => {
    const { run } = buildRun({ originatingChannel: "webchat" });
    await run();

    const captured = state.capturedEmbeddedParams[0];
    expect(captured).toBeDefined();
    expect(captured!["outboundCoalescerStreamingTurnId"]).toBeUndefined();
    expect(captured!["outboundCoalescerStreamingChannelKey"]).toBeUndefined();
  });

  // ------------------------------------------------------------------------
  // Test C3 — missing originating tuple negative
  // ------------------------------------------------------------------------
  it("C3: missing originatingTo leaves both opt-in fields undefined", async () => {
    const { run } = buildRun({ originatingTo: "" });
    await run();

    const captured = state.capturedEmbeddedParams[0];
    expect(captured).toBeDefined();
    expect(captured!["outboundCoalescerStreamingTurnId"]).toBeUndefined();
    expect(captured!["outboundCoalescerStreamingChannelKey"]).toBeUndefined();
  });
});
