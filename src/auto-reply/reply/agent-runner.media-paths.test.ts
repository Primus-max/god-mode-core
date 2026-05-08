import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
}));

vi.mock("../../agents/pi-embedded.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/pi-embedded.js")>(
    "../../agents/pi-embedded.js",
  );
  return {
    ...actual,
    queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
    runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
  };
});

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
});

// `agent-runner.ts` lazy-loads `memory-store-bootstrap.runtime.js`
// (remediation slice "Fix 1+2 — thread kernel deps", 2026-05-08).
// Without `vi.resetModules()` + dynamic re-import in `beforeAll`,
// when this file shares an `--isolate=false` worker with sibling
// tests (e.g. `agent-runner-utils.test.ts`) the SUT's mocks lose
// the race against `test/setup.ts` pre-loads — same root cause as
// PR #303 / #304 / #305 / #308 / #309.
let runReplyAgent: (typeof import("./agent-runner.js"))["runReplyAgent"];

beforeAll(async () => {
  vi.resetModules();
  ({ runReplyAgent } = await import("./agent-runner.js"));
});

describe("runReplyAgent media path normalization", () => {
  beforeEach(() => {
    runEmbeddedPiAgentMock.mockReset();
    runWithModelFallbackMock.mockReset();
    runWithModelFallbackMock.mockImplementation(
      async ({
        provider,
        model,
        run,
      }: {
        provider: string;
        model: string;
        run: (...args: unknown[]) => Promise<unknown>;
      }) => ({
        result: await run(provider, model),
        provider,
        model,
      }),
    );
  });

  it("normalizes final MEDIA replies against the run workspace", async () => {
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "MEDIA:./out/generated.png" }],
      meta: {
        agentMeta: {
          sessionId: "session",
          provider: "anthropic",
          model: "claude",
        },
      },
    });

    const result = await runReplyAgent({
      commandBody: "generate",
      followupRun: createMockFollowupRun({
        prompt: "generate",
        run: {
          agentId: "main",
          agentDir: "/tmp/agent",
          messageProvider: "telegram",
          workspaceDir: "/tmp/workspace",
        },
      }) as unknown as FollowupRun,
      queueKey: "main",
      resolvedQueue: { mode: "interrupt" } as QueueSettings,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing: createMockTypingController(),
      sessionCtx: {
        Provider: "telegram",
        Surface: "telegram",
        To: "chat-1",
        OriginatingTo: "chat-1",
        AccountId: "default",
        MessageSid: "msg-1",
      } as unknown as TemplateContext,
      defaultModel: "anthropic/claude",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    // Use path.resolve to match production behavior: on Windows path.resolve
    // prepends the current drive letter (e.g. "C:\tmp\..."), so a raw path.join
    // expectation diverges from the actual normalized output. resolveSandboxInputPath
    // delegates to path.resolve(cwd, expanded), so the assertion must mirror that.
    const expectedMediaPath = path.resolve("/tmp/workspace", "out", "generated.png");
    expect(result).toMatchObject({
      mediaUrl: expectedMediaPath,
      mediaUrls: [expectedMediaPath],
    });
  });
});
