/**
 * V1-CLOSE charter T2 — Hot-path integration e2e (kernel deps reach the
 * production caller chain).
 *
 * Charter: `.cursor/plans/V1-CLOSE-2026-05-08-stabilization-charter.md` §4 T2.
 * Diagnostic: `.cursor/plans/DIAGNOSTIC-2026-05-08-kernel-vs-legacy-divergence.md`.
 *
 * Why this file exists, in one paragraph:
 *
 *   For ~10 days the commitment kernel ran as dead code on every Telegram
 *   turn because `agent-runner.ts:973` did NOT thread the kernel deps into
 *   `runAgentTurnWithFallback`. PRs #311–#315 plugged the threading gap
 *   slice-by-slice — each shipped a focused per-slice test (`agent-runner.
 *   thread-kernel-deps.e2e.test.ts` for broker; `agent-runner.coalescer-
 *   streaming-params.e2e.test.ts` for streaming coalescer; `agent-runner.
 *   commitment-satisfied.e2e.test.ts` for the post-LLM mirror predicate).
 *   None of those tests fail at the SAME time on a single end-to-end turn
 *   through the production caller. Charter §3 hard rule #9 — "tests must
 *   catch the actual symptom on the hot path" — requires ONE integration
 *   test that pins ALL deps simultaneously so a future regression on the
 *   call site at line 973 cannot pass CI green by silently bypassing one
 *   dep at a time. THIS file is that integration test.
 *
 * What this test cohort pins (per spec §4 T2 acceptance):
 *
 *   1. INT-A `[broker] enqueued` line emitted on the bound process
 *      broker for a real Telegram turn → identity resolution + broker
 *      threading reached the call site (kernel dep #1: `concurrentBroker`
 *      + `identityId`).
 *   2. INT-B `outboundCoalescerStreamingTurnId` + `outboundCoalescerStream
 *      ingChannelKey` are forwarded into the `runEmbeddedPiAgent` seam
 *      AND, when the streaming coalescer wrap is exercised against those
 *      params, `[outbound-coalescer] event=committed` fires on the
 *      runtime logger (kernel dep #2: streaming OutboundCoalescer wrap
 *      from PR #310/#312).
 *   3. INT-C `[commitment-predicate] kind=repo_operation_completed
 *      result=unsatisfied` fires on `defaultRuntime.log` for the
 *      production symptom (zero `artifactIds` on a `repo_mutation`
 *      bundle) → the post-LLM Brain-2 mirror predicate runs on the hot
 *      path (kernel dep #3: structural mirror of `monitoredRuntime` /
 *      done-predicate evaluation, per charter §2 "two brains" until the
 *      formal merge is post-v1 work).
 *   4. INT-D `memoryRuntime` is resolved on the hot path AND its
 *      `identityRegistry` is the seam used to derive `identityId` from
 *      the inbound `sessionKey` — observable as the `identityId`
 *      forwarded into `runAgentTurnWithFallback` matching the registry
 *      lookup result for the configured Telegram peer.
 *
 * Synthetic regressions (each MUST fail with a clear message naming the
 * missing dep when the corresponding wiring is removed):
 *
 *   REG-1 (broker bypass): if the process broker is NOT bound (= simulating
 *      `agent-runner.ts:1021` where `getProcessConcurrentTurnBroker()`
 *      returns undefined when bootstrap never bound it), the captured
 *      params at the `runAgentTurnWithFallback` seam will have
 *      `concurrentBroker: undefined` AND no `[broker] enqueued` line ever
 *      fires. The assertion message names "broker not bound" so a future
 *      reader of the failing test knows which thread is missing.
 *
 *   REG-2 (identity miss): if the inbound `sessionKey` does NOT map to a
 *      configured identity (`cfg.identities` lookup miss), the captured
 *      params will have `identityId: undefined`, the broker stays in
 *      bypass via `dispatch-turn-via-broker.ts:148-154`, and no
 *      `[broker] enqueued` line fires. Names "identity registry miss"
 *      in the failure message.
 *
 *   REG-3 (coalescer fields stripped): if the test injects a sentinel
 *      `runEmbeddedPiAgent` mock that ignores the streaming-coalescer
 *      params (= simulating an attempt.ts that never invokes
 *      `wrapStreamingOutboundWithCoalescer`), `[outbound-coalescer]
 *      event=committed` never fires. Names "streaming coalescer not
 *      engaged" in the failure message.
 *
 *   REG-4 (predicate evaluation skipped): if the routing-snapshot
 *      resolver returns `toolBundles: []` (= simulating a turn the
 *      classifier did NOT route to `repo_mutation`), the post-LLM
 *      evaluator emits `skipped reason=no_applicable_bundle` and the
 *      `kind=repo_operation_completed result=unsatisfied` line is NEVER
 *      emitted. Names "predicate dispatch skipped — bundle missing".
 *
 * Test discipline (charter §3 #9 + AGENTS.md "tests must catch real
 * bugs"):
 *
 *   - The function under test is `runReplyAgent` (the production
 *     caller). We do NOT spy on it. We do NOT spy on `runAgentTurnWith
 *     Fallback`, on `evaluatePostLlmCommitment`, or on `wrapStreaming
 *     OutboundWithCoalescer`. The whole point of T2 is that the real
 *     hot-path code runs and ONLY sibling-dependency seams are mocked.
 *   - The broker is a REAL `createConcurrentTurnBroker` instance bound
 *     via `bindProcessConcurrentTurnBroker`. No broker-internal mock.
 *   - The streaming coalescer is REAL — the test's `runEmbeddedPiAgent`
 *     mock invokes `wrapStreamingOutboundWithCoalescer` with the same
 *     params attempt.ts uses, exercising the wrap helper's `register`
 *     + `commit` flow so the real coalescer's `[outbound-coalescer]
 *     event=committed` telemetry line fires. This pins the streaming
 *     wrap activation behaviour without re-implementing what attempt.ts
 *     does internally.
 *   - The post-LLM mirror predicate (`evaluatePostLlmCommitment`) is
 *     REAL — exercised through the actual runtime path inside
 *     `runAgentTurnBody`.
 *   - `vi.resetModules()` + lazy import in `beforeAll` follows the same
 *     pattern PRs #303/#304/#305/#308/#309/#311/#313 established for
 *     cohort-flake resilience under `--isolate=false`.
 *
 * Note on kernel deps NOT in scope here:
 *
 *   `taskLedger` and `monitoredRuntime` observers are documented in the
 *   charter §2 "two brains" section as reachable post-v1 only. Today,
 *   `task-write-on-satisfied.ts` exists but no caller in production code
 *   imports it (verified 2026-05-08 via repo-wide grep), and
 *   `monitoredRuntime` lives on `runTurnDecision`, not on the
 *   `runAgentTurnWithFallback` chain. Asserting they "reach the call
 *   site" against a runtime path that has no consumer for them would
 *   be a no-op assertion (charter §3 hard rule "no test-fitting"). The
 *   hot-path observable surrogate for both today is the post-LLM
 *   `[commitment-predicate]` mirror line — covered by INT-C / REG-4
 *   above. When v2 wires them through this chain, this file extends in
 *   place; until then INT-A → INT-D is the closed contract.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { TypingMode } from "../../config/types.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

// ============================================================================
// vi.hoisted state — captures and module-level seams. Same harness
// pattern as PRs #311 (`agent-runner.thread-kernel-deps.e2e.test.ts`),
// #312 (`agent-runner.coalescer-streaming-params.e2e.test.ts`), #313
// (`agent-runner.commitment-satisfied.e2e.test.ts`).
// ============================================================================

const llmState = vi.hoisted(() => ({
  runEmbeddedPiAgentMock: vi.fn(),
  runCliAgentMock: vi.fn(),
  capturedEmbeddedParams: [] as Array<Record<string, unknown>>,
  /**
   * When true the embedded mock invokes the REAL streaming-coalescer
   * wrap (mirror of attempt.ts:2907-2917) so the wrap helper's
   * `[outbound-coalescer] event=committed` telemetry line fires.
   * REG-3 flips this to false to pin the synthetic regression where the
   * mock ignores the streaming params.
   */
  exerciseStreamingCoalescer: true,
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

const executionState = vi.hoisted(() => ({
  runAgentTurnWithFallbackMock: vi.fn(),
  runAgentTurnWithFallbackActual: null as null | ((params: unknown) => Promise<unknown>),
  capturedParams: [] as Array<Record<string, unknown>>,
}));

const routingState = vi.hoisted(() => ({
  resolveRoutingSnapshotForTemplateRunMock: vi.fn(),
  resolveRoutingSnapshotForTemplateRunActual: null as
    | null
    | ((params: unknown) => Promise<unknown>),
}));

// ============================================================================
// Module mocks — sibling dependencies of `runReplyAgent`. NEITHER the
// function under test NOR the kernel-dep code paths (broker bootstrap,
// streaming coalescer, post-LLM evaluator, identity registry) are
// mocked.
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
    runEmbeddedPiAgent: (params: unknown) => llmState.runEmbeddedPiAgentMock(params),
  };
});

vi.mock("../../agents/cli-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/cli-runner.js")>();
  return {
    ...actual,
    runCliAgent: (params: unknown) => llmState.runCliAgentMock(params),
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

// Capture the `runAgentTurnWithFallback` boundary while still letting the
// real implementation run. Needed for INT-A / INT-D / REG-1 / REG-2
// assertions on the kernel-dep params.
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

// Stub the routing-snapshot resolver so we can drive the toolBundles
// dispatch deterministically (INT-C requires `repo_mutation`; REG-4
// drives `[]`). Default delegates to actual so cohort sibling test files
// in the same `--isolate=false` worker continue byte-identical.
vi.mock("./agent-runner-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-runner-utils.js")>();
  routingState.resolveRoutingSnapshotForTemplateRunActual =
    actual.resolveRoutingSnapshotForTemplateRun as (params: unknown) => Promise<unknown>;
  return {
    ...actual,
    resolveRoutingSnapshotForTemplateRun: (params: unknown) =>
      routingState.resolveRoutingSnapshotForTemplateRunMock(params),
  };
});

// ============================================================================
// Lazy-load runReplyAgent + apply the `vi.resetModules() + beforeAll dynamic
// re-import` pattern (PR #303 / #304 / #305 / #308 / #309 / #311 / #313
// precedent).
// ============================================================================

let runReplyAgent: (typeof import("./agent-runner.js"))["runReplyAgent"];

async function getRunReplyAgent() {
  return runReplyAgent;
}

// ============================================================================
// Helpers — broker binding, runtime log capture, memory-runtime reset.
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

type RuntimeLogEntry = { message: string };

let runtimeLog:
  | { entries: RuntimeLogEntry[]; restore: () => void }
  | undefined;

async function bindRuntimeLogCapture(): Promise<{
  entries: RuntimeLogEntry[];
  restore: () => void;
}> {
  const runtime = await import("../../runtime.js");
  const originalLog = runtime.defaultRuntime.log;
  const entries: RuntimeLogEntry[] = [];
  (runtime.defaultRuntime as unknown as { log: (msg: string) => void }).log = (msg: string) => {
    entries.push({ message: msg });
    originalLog.call(runtime.defaultRuntime, msg);
  };
  return {
    entries,
    restore: () => {
      (runtime.defaultRuntime as unknown as { log: typeof originalLog }).log = originalLog;
    },
  };
}

// ============================================================================
// Run-builder — Telegram-shaped sessionKey that maps to `identity:vladimir`
// when `cfg.identities` carries the matching mapping. Mirrors the live-
// evidence trace `78ff2b60` from the diagnostic.
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

function makeRoutingSnapshotMockReturn(toolBundles: string[]) {
  return Promise.resolve({
    plannerInput: {
      requestedTools: [],
      resolutionContract: {
        selectedFamily: "general_assistant",
        candidateFamilies: [],
        toolBundles,
        routing: {
          localEligible: false,
          remoteProfile: "code",
          preferRemoteFirst: true,
          needsVision: false,
        },
      },
      routing: {
        needsVision: false,
      },
    },
    runtimePlan: {
      ackThenDefer: false,
    },
    channelHints: {
      provider: "telegram",
      channel: "telegram",
      replyChannel: "telegram",
    },
  });
}

type BuildOpts = {
  sessionKey?: string;
  withIdentities?: boolean;
  toolBundles?: string[];
};

function buildRun(buildOpts: BuildOpts = {}) {
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
  const sessionKey = buildOpts.sessionKey ?? VLADIMIR_SESSION_KEY;
  const cfg: Record<string, unknown> = {};
  if (buildOpts.withIdentities ?? true) {
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

  // Configure the routing-snapshot stub for THIS run. Reset every
  // beforeEach so cross-test bleed cannot misroute a turn.
  routingState.resolveRoutingSnapshotForTemplateRunMock.mockImplementation(() =>
    makeRoutingSnapshotMockReturn(buildOpts.toolBundles ?? ["repo_mutation"]),
  );

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

/**
 * Mirror of `attempt.ts:2907-2917` — when the embedded run sees the two
 * streaming-coalescer opt-in fields, it wraps `onBlockReply` with the
 * real coalescer and routes a synthetic block payload through it. The
 * real `[outbound-coalescer] event=committed` telemetry line fires on
 * `defaultRuntime.log` when `commit()` flushes the bucket. This is the
 * closest we can get to attempt.ts behavior without booting the full
 * pi-embedded session machine — and it exercises the SAME wrap helper
 * the production code uses (no re-implementation).
 */
async function exerciseStreamingCoalescerOn(
  params: Record<string, unknown>,
): Promise<void> {
  const turnId = params["outboundCoalescerStreamingTurnId"] as string | undefined;
  const channelKey = params["outboundCoalescerStreamingChannelKey"] as string | undefined;
  const onBlockReply = params["onBlockReply"] as
    | ((p: { text?: string; isReasoning?: boolean }) => void | Promise<void>)
    | undefined;
  if (!turnId || !channelKey) {
    return;
  }
  const { wrapStreamingOutboundWithCoalescer } = await import(
    "../../agents/pi-embedded-runner/run/outbound-coalescer-wiring.js"
  );
  const { defaultRuntime } = await import("../../runtime.js");
  const wrap = wrapStreamingOutboundWithCoalescer({
    onBlockReply: onBlockReply ?? (async () => {}),
    turnId,
    channelKey,
    logTelemetry: (line: string) => defaultRuntime.log(line),
  });
  await wrap.onBlockReply({ text: "ok" });
  await wrap.commit();
}

// ============================================================================
// Suite.
// ============================================================================

beforeAll(async () => {
  vi.resetModules();
  ({ runReplyAgent } = await import("./agent-runner.js"));
});

beforeEach(async () => {
  llmState.runEmbeddedPiAgentMock.mockClear();
  llmState.runCliAgentMock.mockClear();
  llmState.capturedEmbeddedParams = [];
  llmState.exerciseStreamingCoalescer = true;
  accountingState.persistRunSessionUsageMock.mockReset();
  accountingState.incrementRunCompactionCountMock.mockReset();
  helperState.finalizeWithFollowupMock.mockReset();
  executionState.runAgentTurnWithFallbackMock.mockReset();
  executionState.capturedParams = [];
  routingState.resolveRoutingSnapshotForTemplateRunMock.mockReset();

  accountingState.persistRunSessionUsageMock.mockImplementation(async (params: unknown) => {
    await accountingState.persistRunSessionUsageActual?.(params);
  });
  accountingState.incrementRunCompactionCountMock.mockImplementation(async (params: unknown) => {
    return await accountingState.incrementRunCompactionCountActual?.(params);
  });
  helperState.finalizeWithFollowupMock.mockImplementation((...args: unknown[]) => {
    return helperState.finalizeWithFollowupActual?.(...args);
  });
  executionState.runAgentTurnWithFallbackMock.mockImplementation(async (params: unknown) => {
    executionState.capturedParams.push(params as Record<string, unknown>);
    return await executionState.runAgentTurnWithFallbackActual?.(params);
  });
  routingState.resolveRoutingSnapshotForTemplateRunMock.mockImplementation(
    async (params: unknown) =>
      routingState.resolveRoutingSnapshotForTemplateRunActual?.(params),
  );

  // Default LLM mock — captures params, optionally invokes the real
  // streaming-coalescer wrap (mirror of attempt.ts), returns a benign
  // payload with a `repo_mutation`-shaped completionOutcome carrying
  // ZERO artifactIds. That last bit is the production symptom from
  // turn `78ff2b60` and is what drives the post-LLM mirror predicate
  // to emit `result=unsatisfied`.
  llmState.runEmbeddedPiAgentMock.mockImplementation(async (params: unknown) => {
    const captured = params as Record<string, unknown>;
    llmState.capturedEmbeddedParams.push(captured);
    if (llmState.exerciseStreamingCoalescer) {
      await exerciseStreamingCoalescerOn(captured);
    }
    return {
      payloads: [{ text: "Готово. Лишнее убрал, оставил только главного" }],
      meta: {
        agentMeta: { usage: { input: 1, output: 1 } },
        completionOutcome: {
          runId: "test-run-symptom",
          status: "completed",
          checkpointIds: [],
          blockedCheckpointIds: [],
          completedCheckpointIds: [],
          deniedCheckpointIds: [],
          pendingApprovalIds: [],
          artifactIds: [],
          bootstrapRequestIds: [],
          actionIds: [],
          attemptedActionIds: [],
          confirmedActionIds: [],
          failedActionIds: [],
          boundaries: [],
        },
      },
    };
  });

  vi.stubEnv("OPENCLAW_DEBUG_REPLY_ROUTING", "0");
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");

  await resetMemoryRuntime();
  runtimeLog = await bindRuntimeLogCapture();
});

afterEach(async () => {
  runtimeLog?.restore();
  await unbindBroker();
  await resetMemoryRuntime();
  vi.unstubAllEnvs();
});

describe("agent-runner — V1-CLOSE T2 hot-path integration (kernel deps reach call site)", () => {
  // ------------------------------------------------------------------------
  // INT-A — broker enqueued (kernel dep #1: concurrentBroker + identityId)
  // ------------------------------------------------------------------------
  it("INT-A: broker enqueued for a real Telegram turn (concurrentBroker + identityId reach the call site)", async () => {
    const { logs } = await bindBrokerWithCapturedLogger();
    const { run } = buildRun();

    await run();

    // Kernel-dep observability at the boundary: both fields are present
    // on the params handed to `runAgentTurnWithFallback`.
    expect(executionState.capturedParams).toHaveLength(1);
    const params = executionState.capturedParams[0];
    expect(params, "runAgentTurnWithFallback was not invoked").toBeDefined();
    expect(
      params!["concurrentBroker"],
      "kernel dep missing: concurrentBroker not threaded from agent-runner.ts:1021",
    ).toBeDefined();
    expect(
      params!["identityId"],
      "kernel dep missing: identityId not resolved from sessionKey (memoryRuntime.identityRegistry)",
    ).toBe("identity:vladimir");

    // End-to-end telemetry: the broker actually saw the turn.
    expect(
      logs.some((entry) => entry.message.startsWith("[broker] enqueued")),
      "kernel dep #1 did not fire end-to-end: expected `[broker] enqueued` line on the bound process broker",
    ).toBe(true);
  });

  // ------------------------------------------------------------------------
  // INT-B — streaming OutboundCoalescer (kernel dep #2)
  // ------------------------------------------------------------------------
  it("INT-B: streaming-coalescer opt-ins reach runEmbeddedPiAgent and `[outbound-coalescer] event=committed` fires", async () => {
    await bindBrokerWithCapturedLogger();
    const { run } = buildRun();

    await run();

    // The two opt-in fields are forwarded to the embedded seam.
    expect(llmState.capturedEmbeddedParams).toHaveLength(1);
    const captured = llmState.capturedEmbeddedParams[0]!;
    expect(
      typeof captured["outboundCoalescerStreamingTurnId"],
      "kernel dep missing: outboundCoalescerStreamingTurnId not threaded from agent-runner-execution.ts:505",
    ).toBe("string");
    expect(
      typeof captured["outboundCoalescerStreamingChannelKey"],
      "kernel dep missing: outboundCoalescerStreamingChannelKey not threaded from agent-runner-execution.ts:486",
    ).toBe("string");
    expect(captured["outboundCoalescerStreamingChannelKey"]).toBe(
      `telegram:primary:${VLADIMIR_TELEGRAM_PEER}`,
    );

    // The wrap helper actually fired its commit telemetry — the
    // attempt.ts mirror (`exerciseStreamingCoalescerOn`) registered +
    // committed against the real coalescer.
    const coalescerLines = (runtimeLog?.entries ?? [])
      .map((entry) => entry.message)
      .filter((message) => message.startsWith("[outbound-coalescer]"));
    expect(
      coalescerLines.some((line) => line.includes("event=committed")),
      `kernel dep #2 did not fire end-to-end: expected \`[outbound-coalescer] event=committed\`; saw ${
        coalescerLines.length === 0 ? "no [outbound-coalescer] lines" : coalescerLines.join(" | ")
      }`,
    ).toBe(true);
  });

  // ------------------------------------------------------------------------
  // INT-C / REG-4 — post-LLM mirror predicate REMOVED.
  // V1-CUTOVER S12-narrow (2026-05-09): the post-LLM commitment
  // evaluator was deleted. Orchestrator-v1 (`OPENCLAW_USE_V1_ORCHESTRATOR=1`)
  // is the canonical reply path; its dispatcher renders replies from
  // `reply-templates.ts` against real tool-runner output, so the
  // false-«Готово» symptom (turn `78ff2b60`) cannot recur on the v1
  // path by construction. The legacy path (env flag off) loses the
  // post-LLM gate as documented in V1-CUTOVER plan Phase 3.
  // ------------------------------------------------------------------------

  // ------------------------------------------------------------------------
  // INT-D — memoryRuntime resolved + recall observable (kernel dep #4)
  // ------------------------------------------------------------------------
  it("INT-D: memoryRuntime is resolved on the hot path and identity recall is observable", async () => {
    await bindBrokerWithCapturedLogger();
    const { run } = buildRun();

    await run();

    // The fact that `identityId === 'identity:vladimir'` reached the
    // call site is the structural proof that `memoryRuntime` was
    // resolved on the hot path AND its `identityRegistry` was the seam
    // used for the lookup. `agent-runner.ts:1005-1010` is the only path
    // that produces this brand from a sessionKey + cfg.identities pair.
    expect(executionState.capturedParams).toHaveLength(1);
    const params = executionState.capturedParams[0]!;
    expect(
      params["identityId"],
      "kernel dep missing: memoryRuntime.identityRegistry recall did not happen on hot path",
    ).toBe("identity:vladimir");

    // Cross-check: the same `IdentityRegistry` MUST resolve the same
    // identity when called directly (the recall is observable through
    // the public registry surface, not just the internal seam).
    const { getMemoryRuntime } = await import(
      "../../server/memory-store-bootstrap.js"
    );
    const memoryRuntime = await getMemoryRuntime({
      identities: buildIdentitiesConfig(),
    } as unknown as Parameters<typeof getMemoryRuntime>[0]);
    const observed = memoryRuntime.identityRegistry.resolve(
      "telegram" as Parameters<typeof memoryRuntime.identityRegistry.resolve>[0],
      VLADIMIR_TELEGRAM_PEER,
    );
    expect(observed).toBe("identity:vladimir");
  });

  // ------------------------------------------------------------------------
  // REG-1 — synthetic regression: broker not bound
  // ------------------------------------------------------------------------
  it("REG-1: when the process broker is NOT bound, no `[broker] enqueued` line fires (synthetic regression)", async () => {
    // Deliberately do NOT call `bindBrokerWithCapturedLogger`. We still
    // need a logger sink — the broker bootstrap returns undefined in
    // this state, and `agent-runner.ts:1021` will set `concurrentBroker`
    // to undefined accordingly. We capture the boundary params instead
    // of broker logs (the broker doesn't exist to log into).
    const { run } = buildRun();
    await run();

    expect(executionState.capturedParams).toHaveLength(1);
    const params = executionState.capturedParams[0]!;
    expect(
      params["concurrentBroker"],
      "REG-1: synthetic regression failed — concurrentBroker should be undefined when broker not bound",
    ).toBeUndefined();
    // No broker means no broker-issued log lines. The runtime log
    // capture will not contain `[broker] enqueued`.
    const brokerLines = (runtimeLog?.entries ?? [])
      .map((entry) => entry.message)
      .filter((message) => message.startsWith("[broker]"));
    expect(
      brokerLines,
      "REG-1: synthetic regression failed — [broker] lines unexpectedly emitted with no broker bound",
    ).toEqual([]);
  });

  // ------------------------------------------------------------------------
  // REG-2 — synthetic regression: identity registry miss
  // ------------------------------------------------------------------------
  it("REG-2: when sessionKey misses the identity registry, identityId is undefined and broker stays in bypass", async () => {
    const { logs } = await bindBrokerWithCapturedLogger();
    const { run } = buildRun({
      sessionKey: "agent:main:telegram:direct:NOT_REGISTERED",
    });

    await run();

    expect(executionState.capturedParams).toHaveLength(1);
    const params = executionState.capturedParams[0]!;
    expect(
      params["identityId"],
      "REG-2: synthetic regression failed — identityId should be undefined on registry miss",
    ).toBeUndefined();
    // The bypass conditional in `dispatch-turn-via-broker.ts:148-154`
    // means the broker is NOT consulted when identity is undefined.
    expect(
      logs.some((entry) => entry.message.startsWith("[broker] enqueued")),
      "REG-2: synthetic regression failed — [broker] enqueued fired despite identity registry miss",
    ).toBe(false);
  });

  // ------------------------------------------------------------------------
  // REG-3 — synthetic regression: streaming coalescer not engaged
  // ------------------------------------------------------------------------
  it("REG-3: when runEmbeddedPiAgent ignores the streaming-coalescer params, `[outbound-coalescer] event=committed` never fires", async () => {
    await bindBrokerWithCapturedLogger();
    // Flip the flag so the embedded mock SKIPS invoking the wrap
    // helper, simulating an attempt.ts that does not honor the opt-in
    // fields. The fields are still forwarded into `params` (we test
    // INT-B's positive shape elsewhere), but the wrap never runs and
    // its telemetry never fires.
    llmState.exerciseStreamingCoalescer = false;
    const { run } = buildRun();

    await run();

    expect(llmState.capturedEmbeddedParams).toHaveLength(1);
    const captured = llmState.capturedEmbeddedParams[0]!;
    // Sanity — the params still made it across the param boundary.
    expect(typeof captured["outboundCoalescerStreamingTurnId"]).toBe("string");
    expect(typeof captured["outboundCoalescerStreamingChannelKey"]).toBe("string");

    const coalescerLines = (runtimeLog?.entries ?? [])
      .map((entry) => entry.message)
      .filter((message) => message.startsWith("[outbound-coalescer]"));
    expect(
      coalescerLines.some((line) => line.includes("event=committed")),
      "REG-3: synthetic regression failed — [outbound-coalescer] event=committed fired despite the wrap helper being skipped",
    ).toBe(false);
  });

  // REG-4 removed alongside INT-C — see comment above.
});
