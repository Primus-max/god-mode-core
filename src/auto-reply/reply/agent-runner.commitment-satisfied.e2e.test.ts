/**
 * Slice C — post-LLM `commitmentSatisfied` evaluation on the production
 * turn path (END-TO-END, single-test cohort).
 *
 * Diagnostic: `.cursor/plans/DIAGNOSTIC-2026-05-08-kernel-vs-legacy-divergence.md`.
 * Production evidence: gateway-dev-2026-05-07.log turn `78ff2b60` («Удали
 * лишних» -> bot replied «Готово. Лишнее убрал, оставил только главного»
 * without ever calling `apply_patch` / `write`. The post-LLM done-predicate
 * was NEVER evaluated, so the LLM's text-only «Готово» reached the deliver
 * path even though zero repo work happened. PR #311 (Slice A) closed Test
 * B as BLOCKED because the post-LLM evaluation site did not exist on this
 * chain — THIS slice adds it.
 *
 * What this single test pins (the symptom from production turn `78ff2b60`):
 *
 *   Bundle = `repo_mutation`. Embedded LLM returned text-only
 *   «Готово, удалил» and `runResult.meta.completionOutcome` carries
 *   ZERO artifactIds. The post-LLM evaluator MUST suppress the LLM
 *   reply and substitute the structured `cannot_complete` Russian-locale
 *   copy (`REPO_MUTATION_CANNOT_COMPLETE_REPLY_RU`). Telemetry line
 *   `[commitment-predicate] kind=repo_operation_completed result=unsatisfied`
 *   MUST fire on the bound runtime logger.
 *
 * FAILS on parent (`859769c269`) because no evaluator exists at this
 * site — the LLM's «Готово» reaches the deliver path.
 *
 * Why one test here, not four:
 *   - The other dispatch-table contracts (positive, bundle dispatch
 *     negative, no-runtime fallback, embedded-error short-circuit,
 *     legacy boundary) are covered as focused unit tests in the sibling
 *     `post-llm-commitment-evaluator.test.ts` cohort. Those are robust
 *     to cross-file `vi.mock` races by design (no module-cache touch).
 *   - Co-running 4 e2e turns through the real `runReplyAgent` chain
 *     creates `--isolate=false` cohort interactions with PR #311's
 *     `agent-runner.thread-kernel-deps.e2e.test.ts` (both files mock the
 *     same `agent-runner-execution.runtime.js` seam). Per AGENTS.md
 *     "narrowly scoped tests prove the change itself" + cross-file
 *     `vi.mock` race precedent (PR #303-#311), we keep the e2e cohort
 *     small (one symptom test) and put dispatch-table coverage on a
 *     unit-test surface.
 *
 * Test discipline:
 *   - The function under test is `runReplyAgent`. We DO NOT spy on it
 *     and DO NOT spy on the evaluator (`evaluatePostLlmCommitment`) or
 *     on `runAgentTurnWithFallback`.
 *   - We mock `runEmbeddedPiAgent` (LLM) and the upstream routing-
 *     snapshot resolver — both are sibling dependencies, not the
 *     function under test. The post-LLM evaluator is exercised through
 *     real code (no `vi.spyOn` at any layer).
 *   - The `agent-runner-utils.js` mock delegates to the real
 *     implementation by default so a sibling test file in the same
 *     `--isolate=false` worker (notably PR #311's
 *     `agent-runner.thread-kernel-deps.e2e.test.ts`) is unaffected by
 *     our hoisted module replacement.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { TypingMode } from "../../config/types.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

/**
 * Normalize a `runReplyAgent` return value (which is
 * `ReplyPayload | ReplyPayload[] | undefined`) into a flat list of
 * payloads. We assert on the last payload's `text` field.
 */
function flattenReplyValue(
  value: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

// ============================================================================
// vi.hoisted state — captures and module-level seams.
// ============================================================================

const llmState = vi.hoisted(() => ({
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

const helperState = vi.hoisted(() => ({
  finalizeWithFollowupMock: vi.fn(),
  finalizeWithFollowupActual: null as null | ((...args: unknown[]) => unknown),
}));

const routingState = vi.hoisted(() => ({
  resolveRoutingSnapshotForTemplateRunMock: vi.fn(),
  resolveRoutingSnapshotForTemplateRunActual: null as
    | null
    | ((params: unknown) => Promise<unknown>),
}));

// ============================================================================
// Module mocks — sibling dependencies of `runReplyAgent`. The function
// under test (`runReplyAgent`) and the post-LLM evaluator
// (`evaluatePostLlmCommitment`) are NOT mocked.
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

// Stub the routing-snapshot resolver so we can drive the toolBundles
// dispatch deterministically. The mock DELEGATES to the real
// implementation by default so cohort sibling test files (notably
// PR #311's `agent-runner.thread-kernel-deps.e2e.test.ts`) that don't
// register their own routing-snapshot mock continue to behave
// byte-identical to their isolated-run shape.
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
// re-import` pattern (PR #303 / #304 / #305 / #308 / #309 / #311 precedent).
// `agent-runner.ts` lazy-loads `memory-store-bootstrap.runtime.js` which
// transitively pulls `agents/agent-scope.js`. When sibling base-lane test
// files in the same `--isolate=false` worker import that chain before our
// `vi.mock`s register, the mocks silently fail to apply and `runResult`
// ends up undefined when the embedded LLM mock isn't reached.
// ============================================================================

let runReplyAgent: (typeof import("./agent-runner.js"))["runReplyAgent"];

async function getRunReplyAgent() {
  return runReplyAgent;
}

// ============================================================================
// Per-test runtime-log capture — the post-LLM evaluator emits
// `[commitment-predicate] ...` lines via `defaultRuntime.log`.
// ============================================================================

type RuntimeLogEntry = { message: string };

let runtimeLog: { entries: RuntimeLogEntry[]; restore: () => void } | undefined;

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

async function resetMemoryRuntime() {
  const { __resetMemoryRuntimeForTests } = await import("../../server/memory-store-bootstrap.js");
  __resetMemoryRuntimeForTests();
}

// ============================================================================
// Run-builder — same shape as `agent-runner.thread-kernel-deps.e2e.test.ts`
// so the harness stays uniform across PR #311 + this slice.
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

function buildRun(params: { toolBundles: string[] }) {
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
  const sessionKey = VLADIMIR_SESSION_KEY;
  const cfg: Record<string, unknown> = {
    identities: buildIdentitiesConfig(),
  };
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

  // Configure the routing-snapshot stub to return the requested bundle
  // list. The mock is reset every `beforeEach` so cross-test bleed
  // cannot misroute a turn through the wrong bundle.
  routingState.resolveRoutingSnapshotForTemplateRunMock.mockImplementation(() =>
    makeRoutingSnapshotMockReturn(params.toolBundles),
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
  accountingState.persistRunSessionUsageMock.mockReset();
  accountingState.incrementRunCompactionCountMock.mockReset();
  helperState.finalizeWithFollowupMock.mockReset();
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
  // Default delegate-to-actual so cohort sibling test files that don't
  // register their own routing-snapshot mock continue to behave
  // byte-identical to their isolated-run shape.
  routingState.resolveRoutingSnapshotForTemplateRunMock.mockImplementation(
    async (params: unknown) =>
      routingState.resolveRoutingSnapshotForTemplateRunActual?.(params),
  );

  vi.stubEnv("OPENCLAW_DEBUG_REPLY_ROUTING", "0");
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");

  await resetMemoryRuntime();
  runtimeLog = await bindRuntimeLogCapture();
});

afterEach(async () => {
  runtimeLog?.restore();
  await resetMemoryRuntime();
  vi.unstubAllEnvs();
});

describe("agent-runner — Slice C post-LLM commitmentSatisfied evaluation", () => {
  it("symptom: suppresses LLM text reply and substitutes cannot_complete when bundle=repo_mutation has zero artifactIds", async () => {
    // Reproduces the exact symptom from gateway-dev-2026-05-07.log turn
    // `78ff2b60`: bundle=repo_mutation, LLM returns text-only «Готово,
    // удалил» with no tool_calls -> `completionOutcome.artifactIds.length
    // === 0`. On parent (`859769c269`) the LLM's reply reached the
    // deliver path because no post-LLM predicate was evaluated; the user
    // saw a false confirmation. After Slice C the evaluator MUST
    // substitute the structured `cannot_complete` Russian-locale copy
    // and emit `[commitment-predicate] kind=repo_operation_completed
    // result=unsatisfied` telemetry.
    llmState.runEmbeddedPiAgentMock.mockResolvedValueOnce({
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
    });

    const { run } = buildRun({
      toolBundles: ["repo_mutation"],
    });

    const reply = await run();
    const payloads = flattenReplyValue(reply);

    // The returned payload MUST be the structured cannot_complete copy —
    // NOT the LLM's «Готово».
    expect(payloads.length).toBeGreaterThanOrEqual(1);
    const finalReplyText = payloads[payloads.length - 1]?.text ?? "";
    expect(finalReplyText).not.toContain("Готово");
    expect(finalReplyText).toContain("Не могу подтвердить выполнение правки");

    // Telemetry MUST fire with the unsatisfied result so ops can grep
    // gateway-dev-*.log for the predicate evaluation.
    const predicateLines = (runtimeLog?.entries ?? [])
      .map((entry) => entry.message)
      .filter((message) => message.startsWith("[commitment-predicate]"));
    expect(
      predicateLines.some(
        (message) =>
          message.includes("kind=repo_operation_completed") &&
          message.includes("result=unsatisfied"),
      ),
      `expected [commitment-predicate] result=unsatisfied; got ${predicateLines.join(" | ")}`,
    ).toBe(true);
  });
});
