/**
 * Remediation slice — `Fix 1+2 — thread kernel deps through agent-runner.ts:973`.
 *
 * Diagnostic: `.cursor/plans/DIAGNOSTIC-2026-05-08-kernel-vs-legacy-divergence.md`.
 * Production evidence: gateway-dev-2026-05-07.log turn `78ff2b60` («Удали
 * лишних» -> bot replied «Готово. Лишнее убрал, оставил только главного»
 * without a tool_call; PR-MT broker telemetry was completely absent —
 * `[broker] enqueued|dispatch|complete` never emitted because
 * `agent-runner.ts:973` never threaded `identityId` / `concurrentBroker`
 * into `runAgentTurnWithFallback`. The bypass conditional at
 * `agent-runner-execution.ts:202` therefore forced `broker = undefined`
 * on every production turn, so the kernel slices ran as dead code.
 *
 * What this test cohort pins:
 *   A — broker enqueued (positive): when the inbound `sessionKey`
 *       resolves to a real `IdentityId` and the process broker is bound,
 *       `runReplyAgent` MUST forward both into `runAgentTurnWithFallback`
 *       so the broker actually dispatches the turn. Asserts that the
 *       captured params carry both fields and that `[broker] enqueued`
 *       fires on the bound logger.
 *   C — bypass preserved (negative): when the `sessionKey` does NOT
 *       map to a known identity (anonymous-default registry), the
 *       caller MUST still leave the broker in bypass — otherwise the
 *       regression-guard contract on
 *       `dispatch-turn-via-broker.ts:148-154` is broken. No `[broker]`
 *       log lines may fire.
 *   D — concurrency FIFO (edge): two turns landing on the same
 *       `(identityId, channel-tuple)` queue key must be SERIALIZED by
 *       the broker. Demonstrates that the threading-fix isn't just
 *       cosmetic — it actually activates the broker's per-key FIFO
 *       guarantee on the production caller chain.
 *
 * NOTE on Test B (`commitmentSatisfied` text-only-response): the
 * spec lists this as required but the runtime path that would
 * evaluate the done-predicate post-LLM does NOT exist on the
 * `runAgentTurnWithFallback` chain today (`runEmbeddedPiAgent` does
 * not consume `monitoredRuntime` / `expectedDeltaResolver`; those
 * deps live on `runTurnDecision`, called from `plugin.ts` hooks
 * alongside the LLM call). Threading
 * `memoryRuntime` / `taskLedger` / `observers` through the
 * `runAgentTurnWithFallback` signature alone would create
 * dead-code fields with no consumer — outside the spec's "smallest
 * possible diff" constraint and the AGENTS.md "no test-fitting"
 * rule (a test that asserts a field is forwarded but never read
 * does not catch a real bug). Wiring the post-LLM commitment
 * evaluation is a follow-up slice; the PR body documents it.
 *
 * V1-CLOSE T2 follow-up (charter §4 T2): the cross-cutting INT-A → INT-D
 * integration cohort that pins ALL kernel deps simultaneously on a
 * SINGLE end-to-end turn (broker + streaming coalescer + post-LLM
 * mirror predicate + memoryRuntime recall) lives in
 * `agent-runner.hot-path-integration.e2e.test.ts`. THIS file remains
 * the broker-focused per-slice harness; future broker-only regressions
 * land here, while cross-dep regressions are pinned in the integration
 * file so a silent bypass of one dep cannot pass CI green.
 *
 * Test discipline (per AGENTS.md "Tests must catch real bugs"):
 *   - The function under test is `runReplyAgent` (the production
 *     caller). We do NOT spy on it.
 *   - Spies live on direct dependencies (`runAgentTurnWithFallback`,
 *     `runEmbeddedPiAgent`, the bound broker's logger) — not on the
 *     function being tested.
 *   - Each assertion fails on parent (no threading) and passes after
 *     the agent-runner.ts:973 fix.
 *   - The broker is a REAL `createConcurrentTurnBroker` instance bound
 *     via `bindProcessConcurrentTurnBroker`. No broker-internal mock.
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
}));

const accountingState = vi.hoisted(() => ({
  persistRunSessionUsageMock: vi.fn(),
  incrementRunCompactionCountMock: vi.fn(),
  persistRunSessionUsageActual: null as null | ((params: unknown) => Promise<void>),
  incrementRunCompactionCountActual: null as
    | null
    | ((params: unknown) => Promise<number | undefined>),
}));

const executionState = vi.hoisted(() => ({
  runAgentTurnWithFallbackMock: vi.fn(),
  runAgentTurnWithFallbackActual: null as null | ((params: unknown) => Promise<unknown>),
  capturedParams: [] as Array<Record<string, unknown>>,
}));

const helperState = vi.hoisted(() => ({
  finalizeWithFollowupMock: vi.fn(),
  finalizeWithFollowupActual: null as null | ((...args: unknown[]) => unknown),
}));

// ============================================================================
// Module mocks — same harness pattern as
// `agent-runner.runreplyagent.e2e.test.ts`.
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

vi.mock("./agent-runner-execution.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-runner-execution.runtime.js")>();
  executionState.runAgentTurnWithFallbackActual = actual.runAgentTurnWithFallback as (
    params: unknown,
  ) => Promise<unknown>;
  return {
    ...actual,
    runAgentTurnWithFallback: (params: unknown) =>
      executionState.runAgentTurnWithFallbackMock(params),
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
// Lazy-load runReplyAgent (must come AFTER mocks are registered).
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
// Per-test broker fixture — bind a real broker, capture log lines via the
// bootstrap logger seam. Reset between tests so cross-test bleed never
// produces a false-positive `[broker] enqueued` from an earlier turn.
// ============================================================================

type BrokerLog = { message: string; level?: "info" | "debug" };

async function bindBrokerWithCapturedLogger(): Promise<{ logs: BrokerLog[] }> {
  const { bindProcessConcurrentTurnBroker, __resetConcurrentTurnBrokerBootstrapForTests } =
    await import("../../server/concurrent-turn-broker-bootstrap.js");
  __resetConcurrentTurnBrokerBootstrapForTests();
  const logs: BrokerLog[] = [];
  bindProcessConcurrentTurnBroker({
    logger: {
      log: (message: string, level?: "info" | "debug") => {
        logs.push({ message, ...(level ? { level } : {}) });
      },
    },
  });
  return { logs };
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
// Run-builder — Telegram-shaped sessionKey that resolves to identity:vladimir
// when `cfg.identities` carries the matching mapping. Mirrors the live-evidence
// trace the diagnostic was captured against.
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

function buildRun(params?: { sessionKey?: string; withIdentities?: boolean }) {
  const typing = createMockTypingController();
  const opts: GetReplyOptions | undefined = undefined;
  const sessionCtx = {
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: VLADIMIR_TELEGRAM_PEER,
    AccountId: "primary",
    MessageSid: "msg-1",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const sessionKey = params?.sessionKey ?? VLADIMIR_SESSION_KEY;
  const cfg: Record<string, unknown> = {};
  if (params?.withIdentities ?? true) {
    cfg.identities = buildIdentitiesConfig();
  }
  const followupRun = {
    prompt: "Удали лишних",
    summaryLine: "Удали лишних",
    enqueuedAt: Date.now(),
    originatingChannel: "telegram",
    originatingTo: VLADIMIR_TELEGRAM_PEER,
    originatingAccountId: "primary",
    originatingThreadId: undefined,
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey,
      messageProvider: "telegram",
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
  accountingState.persistRunSessionUsageMock.mockReset();
  accountingState.incrementRunCompactionCountMock.mockReset();
  executionState.runAgentTurnWithFallbackMock.mockReset();
  executionState.capturedParams = [];
  helperState.finalizeWithFollowupMock.mockReset();

  accountingState.persistRunSessionUsageMock.mockImplementation(async (params: unknown) => {
    await accountingState.persistRunSessionUsageActual?.(params);
  });
  accountingState.incrementRunCompactionCountMock.mockImplementation(async (params: unknown) => {
    return await accountingState.incrementRunCompactionCountActual?.(params);
  });
  // Capture params, then forward to the actual function. This is the
  // capture pattern used by `agent-runner.runreplyagent.e2e.test.ts` —
  // we are NOT spying on the function under test (`runReplyAgent`); we
  // are observing the dependency seam.
  executionState.runAgentTurnWithFallbackMock.mockImplementation(async (params: unknown) => {
    executionState.capturedParams.push(params as Record<string, unknown>);
    return await executionState.runAgentTurnWithFallbackActual?.(params);
  });
  helperState.finalizeWithFollowupMock.mockImplementation((...args: unknown[]) => {
    return helperState.finalizeWithFollowupActual?.(...args);
  });
  vi.stubEnv("OPENCLAW_DEBUG_REPLY_ROUTING", "0");
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");

  // Default LLM passthrough — short, complete, no tool calls. The shape
  // is enough to satisfy the post-call accounting and reply-build path.
  state.runEmbeddedPiAgentMock.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: { agentMeta: { usage: { input: 1, output: 1 } } },
  });

  await resetMemoryRuntime();
});

afterEach(async () => {
  await unbindBroker();
  await resetMemoryRuntime();
  vi.unstubAllEnvs();
});

describe("agent-runner.ts:973 — kernel-deps threading (remediation slice Fix 1+2)", () => {
  // ------------------------------------------------------------------------
  // Test A — broker enqueued (positive)
  // ------------------------------------------------------------------------
  it("A: forwards identityId + concurrentBroker to runAgentTurnWithFallback when sessionKey resolves", async () => {
    // Pre-condition: broker bound + identities config carries vladimir
    // mapped to the inbound telegram peer.
    const { logs } = await bindBrokerWithCapturedLogger();
    const { run } = buildRun();

    await run();

    // The capture is the dependency-seam observation: parent code passes
    // `identityId: undefined` and `concurrentBroker: undefined` so the
    // bypass conditional at agent-runner-execution.ts:202 forces the
    // broker off — no `[broker] enqueued` is ever emitted. After the fix
    // the call site MUST resolve identity from the sessionKey and forward
    // both fields.
    expect(executionState.capturedParams).toHaveLength(1);
    const params = executionState.capturedParams[0];
    expect(params).toBeDefined();
    expect(params!["identityId"]).toBe("identity:vladimir");
    expect(params!["concurrentBroker"]).toBeDefined();

    // End-to-end proof: with both threaded, the bound broker actually
    // enqueues + dispatches the turn. The live evidence we are pinning
    // is the absence of `[broker] *` lines in
    // gateway-dev-2026-05-07.log turn `78ff2b60`.
    expect(
      logs.some((entry) => entry.message.startsWith("[broker] enqueued")),
      "expected [broker] enqueued line — broker took the non-bypass path",
    ).toBe(true);
    expect(
      logs.some((entry) => entry.message.startsWith("[broker] dispatch")),
      "expected [broker] dispatch line",
    ).toBe(true);
    expect(
      logs.some((entry) => entry.message.startsWith("[broker] complete")),
      "expected [broker] complete line",
    ).toBe(true);
  });

  // ------------------------------------------------------------------------
  // Test C — bypass preserved (negative)
  // ------------------------------------------------------------------------
  it("C: preserves broker bypass when sessionKey does NOT map to a known identity", async () => {
    const { logs } = await bindBrokerWithCapturedLogger();
    // sessionKey of shape `agent:main:telegram:direct:NOT_REGISTERED`. cfg.identities
    // is present but does NOT include the unknown peer — identity resolution
    // returns undefined.
    const { run } = buildRun({
      sessionKey: "agent:main:telegram:direct:NOT_REGISTERED",
    });

    await run();

    expect(executionState.capturedParams).toHaveLength(1);
    const params = executionState.capturedParams[0];
    expect(params).toBeDefined();
    // Identity must be undefined (registry miss). The bypass conditional
    // in agent-runner-execution.ts:202 (`broker !== undefined &&
    // identityId !== undefined`) forces broker undefined inside
    // `dispatchTurnViaBroker` so the direct-invocation regression-guard
    // path runs. The forwarded `concurrentBroker` field at the call site
    // MAY be defined (process broker is bound) — the bypass is enforced
    // by the helper, not by omitting the field.
    expect(params!["identityId"]).toBeUndefined();
    expect(
      logs.some((entry) => entry.message.startsWith("[broker] enqueued")),
      "expected NO [broker] enqueued line — bypass must be preserved",
    ).toBe(false);
    expect(
      logs.some((entry) => entry.message.startsWith("[broker] dispatch")),
      "expected NO [broker] dispatch line — bypass must be preserved",
    ).toBe(false);
  });

  // ------------------------------------------------------------------------
  // Test D — same-(identity, channel) FIFO via the fixed call site
  // ------------------------------------------------------------------------
  it("D: two concurrent turns on the same (identity, channel) serialize through the broker", async () => {
    await bindBrokerWithCapturedLogger();

    // Gate the LLM call so two turns can be in-flight concurrently. The
    // resolver pattern mirrors `dispatch-turn-via-broker.test.ts`.
    let resolveFirst: () => void = () => undefined;
    const firstPromise = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const sequence: string[] = [];
    state.runEmbeddedPiAgentMock.mockReset();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
      sequence.push("start-1");
      await firstPromise;
      sequence.push("end-1");
      return { payloads: [{ text: "ok-1" }], meta: { agentMeta: { usage: {} } } };
    });
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
      sequence.push("start-2");
      sequence.push("end-2");
      return { payloads: [{ text: "ok-2" }], meta: { agentMeta: { usage: {} } } };
    });

    const r1 = buildRun().run();
    const r2 = buildRun().run();

    // Allow the runReplyAgent setup chain (memoryRuntime bootstrap +
    // routing-snapshot resolve + model-fallback dispatch) to reach the
    // broker submit + admit. The chain is microtask-bound through the
    // mocks but does include macro-task seams (`setImmediate` inside
    // `runWithModelFallback` retry timers can introduce a real-tick
    // delay). 50 microtask ticks + a `setImmediate` boundary is the
    // shape the existing `agent-runner.runreplyagent.e2e.test.ts`
    // suite uses to settle a turn before sampling sequence ordering.
    for (let i = 0; i < 50; i += 1) {
      await Promise.resolve();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let i = 0; i < 50; i += 1) {
      await Promise.resolve();
    }
    // Both turns share the SAME (identityId=identity:vladimir,
    // channel-tuple) so they map to ONE BrokerQueueKey — turn-2 must
    // wait until turn-1 settles.
    expect(sequence, "turn-2 must NOT start before turn-1 completes").toEqual(["start-1"]);

    resolveFirst();
    await Promise.all([r1, r2]);
    expect(sequence).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });
});
