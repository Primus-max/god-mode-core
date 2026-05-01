import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionTranscriptPathInDir } from "../../config/sessions/paths.js";
import type { FollowupRun } from "./queue.js";

const hoisted = vi.hoisted(() => {
  const resolveRunModelFallbacksOverrideMock = vi.fn();
  const buildClassifiedExecutionDecisionInputMock = vi.fn();
  return { resolveRunModelFallbacksOverrideMock, buildClassifiedExecutionDecisionInputMock };
});

vi.mock("../../agents/agent-scope.js", () => ({
  resolveRunModelFallbacksOverride: (...args: unknown[]) =>
    hoisted.resolveRunModelFallbacksOverrideMock(...args),
}));

vi.mock("../../platform/decision/input.js", async () => {
  const actual = await vi.importActual<typeof import("../../platform/decision/input.js")>(
    "../../platform/decision/input.js",
  );
  return {
    ...actual,
    buildClassifiedExecutionDecisionInput: (...args: unknown[]) =>
      hoisted.buildClassifiedExecutionDecisionInputMock(...args),
  };
});

const {
  buildThreadingToolContext,
  buildEmbeddedRunBaseParams,
  buildEmbeddedRunContexts,
  resolveRoutingSnapshotForTemplateRun,
  resolvePlatformExecutionContextForTemplateRun,
  resolveModelFallbackOptions,
  resolveProviderScopedAuthProfile,
} = await import("./agent-runner-utils.js");

function makeRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun["run"] {
  return {
    sessionId: "session-1",
    agentId: "agent-1",
    config: { models: { providers: {} } },
    provider: "openai",
    model: "gpt-4.1",
    agentDir: "/tmp/agent",
    sessionKey: "agent:test:session",
    sessionFile: "/tmp/session.json",
    workspaceDir: "/tmp/workspace",
    skillsSnapshot: [],
    ownerNumbers: ["+15550001"],
    enforceFinalTag: false,
    thinkLevel: "medium",
    verboseLevel: "off",
    reasoningLevel: "none",
    execOverrides: {},
    bashElevated: false,
    timeoutMs: 60_000,
    ...overrides,
  } as unknown as FollowupRun["run"];
}

describe("agent-runner-utils", () => {
  beforeEach(() => {
    hoisted.resolveRunModelFallbacksOverrideMock.mockClear();
    hoisted.buildClassifiedExecutionDecisionInputMock.mockReset();
    hoisted.buildClassifiedExecutionDecisionInputMock.mockImplementation(async (params?: unknown) => {
      const prompt =
        params && typeof params === "object" && "prompt" in params
          ? String((params as { prompt?: unknown }).prompt ?? "")
          : "";
      const channelHints =
        params && typeof params === "object" && "channelHints" in params
          ? ((params as { channelHints?: { messageChannel?: string; channel?: string } }).channelHints ??
            {})
          : {};
      const wantsCodeFlow = /build|publish|release|ship|patch|ci failure|repo/i.test(prompt);
      return {
        ...(wantsCodeFlow
          ? {
              prompt,
              contractFirst: true,
              intent: "publish",
              requestedTools: ["apply_patch", "exec", "process"],
              artifactKinds: ["binary", "release"],
              publishTargets: ["external"],
              integrations: [channelHints.messageChannel, channelHints.channel].filter(
                (value): value is string => Boolean(value),
              ),
              outcomeContract: "external_operation",
              executionContract: {
                requiresTools: true,
                requiresWorkspaceMutation: true,
                requiresLocalProcess: true,
                requiresArtifactEvidence: false,
                requiresDeliveryEvidence: true,
                mayNeedBootstrap: true,
              },
              requestedEvidence: ["tool_receipt", "delivery_receipt"],
              confidence: "high",
              ambiguityReasons: [],
              candidateFamilies: ["ops_execution"],
              resolutionContract: {
                selectedFamily: "code_build",
                candidateFamilies: ["code_build", "ops_execution"],
                toolBundles: ["repo_mutation", "repo_run", "external_delivery"],
                routing: {
                  localEligible: false,
                  remoteProfile: "code",
                  preferRemoteFirst: true,
                  needsVision: false,
                },
              },
              routing: {
                localEligible: false,
                remoteProfile: "code",
                preferRemoteFirst: true,
                needsVision: false,
              },
            }
          : {
              prompt,
              contractFirst: true,
              intent: "general",
              integrations: [channelHints.messageChannel, channelHints.channel].filter(
                (value): value is string => Boolean(value),
              ),
              outcomeContract: "text_response",
              executionContract: {
                requiresTools: false,
                requiresWorkspaceMutation: false,
                requiresLocalProcess: false,
                requiresArtifactEvidence: false,
                requiresDeliveryEvidence: false,
                mayNeedBootstrap: false,
              },
              requestedEvidence: ["assistant_text"],
              confidence: "high",
              ambiguityReasons: [],
              candidateFamilies: ["general_assistant"],
              resolutionContract: {
                selectedFamily: "general_assistant",
                candidateFamilies: ["general_assistant"],
                toolBundles: ["respond_only"],
                routing: {
                  localEligible: true,
                  remoteProfile: "cheap",
                  preferRemoteFirst: false,
                  needsVision: false,
                },
              },
              routing: {
                localEligible: true,
                remoteProfile: "cheap",
                preferRemoteFirst: false,
                needsVision: false,
              },
            }),
      };
    });
  });

  it("resolves model fallback options from run context", () => {
    hoisted.resolveRunModelFallbacksOverrideMock.mockReturnValue(["fallback-model"]);
    const run = makeRun();

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveRunModelFallbacksOverrideMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: run.agentId,
      sessionKey: run.sessionKey,
    });
    expect(resolved).toEqual({
      cfg: run.config,
      provider: run.provider,
      model: run.model,
      agentDir: run.agentDir,
      fallbacksOverride: ["fallback-model"],
    });
  });

  it("includes preflight fields when a prompt is provided", () => {
    hoisted.resolveRunModelFallbacksOverrideMock.mockReturnValue(["fallback-model"]);
    const run = makeRun();

    const resolved = resolveModelFallbackOptions(run, {
      preflightPrompt: "  hello  ",
      preflightMode: "force_stronger",
    });

    expect(resolved.preflightPrompt).toBe("hello");
    expect(resolved.preflightMode).toBe("force_stronger");
  });

  it("sets skipRoutePreflight when run.modelRoutePreflightDisabled is true", () => {
    hoisted.resolveRunModelFallbacksOverrideMock.mockReturnValue(undefined);
    const run = makeRun({ modelRoutePreflightDisabled: true });

    const resolved = resolveModelFallbackOptions(run, { preflightPrompt: "hi" });

    expect(resolved.skipRoutePreflight).toBe(true);
    expect(resolved.preflightPrompt).toBe("hi");
  });

  it("passes through missing agentId for helper-based fallback resolution", () => {
    hoisted.resolveRunModelFallbacksOverrideMock.mockReturnValue(["fallback-model"]);
    const run = makeRun({ agentId: undefined });

    const resolved = resolveModelFallbackOptions(run);

    expect(hoisted.resolveRunModelFallbacksOverrideMock).toHaveBeenCalledWith({
      cfg: run.config,
      agentId: undefined,
      sessionKey: run.sessionKey,
    });
    expect(resolved.fallbacksOverride).toEqual(["fallback-model"]);
  });

  it("builds embedded run base params with auth profile and run metadata", () => {
    const run = makeRun({ enforceFinalTag: true });
    const authProfile = resolveProviderScopedAuthProfile({
      provider: "openai",
      primaryProvider: "openai",
      authProfileId: "profile-openai",
      authProfileIdSource: "user",
    });

    const resolved = buildEmbeddedRunBaseParams({
      run,
      provider: "openai",
      model: "gpt-4.1-mini",
      runId: "run-1",
      authProfile,
    });

    expect(resolved).toMatchObject({
      sessionFile: run.sessionFile,
      workspaceDir: run.workspaceDir,
      agentDir: run.agentDir,
      config: run.config,
      skillsSnapshot: run.skillsSnapshot,
      ownerNumbers: run.ownerNumbers,
      enforceFinalTag: true,
      provider: "openai",
      model: "gpt-4.1-mini",
      authProfileId: "profile-openai",
      authProfileIdSource: "user",
      thinkLevel: run.thinkLevel,
      verboseLevel: run.verboseLevel,
      reasoningLevel: run.reasoningLevel,
      execOverrides: run.execOverrides,
      bashElevated: run.bashElevated,
      timeoutMs: run.timeoutMs,
      runId: "run-1",
    });
  });

  it("builds embedded contexts and scopes auth profile by provider", () => {
    const run = makeRun({
      authProfileId: "profile-openai",
      authProfileIdSource: "auto",
    });

    const resolved = buildEmbeddedRunContexts({
      run,
      sessionCtx: {
        Provider: "OpenAI",
        To: "channel-1",
        SenderId: "sender-1",
      },
      hasRepliedRef: undefined,
      provider: "anthropic",
    });

    expect(resolved.authProfile).toEqual({
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(resolved.embeddedContext).toMatchObject({
      sessionId: run.sessionId,
      sessionKey: run.sessionKey,
      agentId: run.agentId,
      messageProvider: "openai",
      messageTo: "channel-1",
    });
    expect(resolved.senderContext).toEqual({
      senderId: "sender-1",
      senderName: undefined,
      senderUsername: undefined,
      senderE164: undefined,
    });
  });

  it("prefers OriginatingChannel over Provider for messageProvider", () => {
    const run = makeRun();

    const resolved = buildEmbeddedRunContexts({
      run,
      sessionCtx: {
        Provider: "heartbeat",
        OriginatingChannel: "Telegram",
        OriginatingTo: "268300329",
      },
      hasRepliedRef: undefined,
      provider: "openai",
    });

    expect(resolved.embeddedContext.messageProvider).toBe("telegram");
    expect(resolved.embeddedContext.messageTo).toBe("268300329");
  });

  it("uses OriginatingTo for threading tool context on telegram native commands", () => {
    const context = buildThreadingToolContext({
      sessionCtx: {
        Provider: "telegram",
        To: "slash:8460800771",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:-1003841603622",
        MessageThreadId: 928,
        MessageSid: "2284",
      },
      config: { channels: { telegram: { allowFrom: ["*"] } } },
      hasRepliedRef: undefined,
    });

    expect(context).toMatchObject({
      currentChannelId: "telegram:-1003841603622",
      currentThreadTs: "928",
      currentMessageId: "2284",
    });
  });

  it("uses OriginatingTo for threading tool context on discord native commands", () => {
    const context = buildThreadingToolContext({
      sessionCtx: {
        Provider: "discord",
        To: "slash:1177378744822943744",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:123456789012345678",
        MessageSid: "msg-9",
      },
      config: {},
      hasRepliedRef: undefined,
    });

    expect(context).toMatchObject({
      currentChannelId: "channel:123456789012345678",
      currentMessageId: "msg-9",
    });
  });

  it("resolves a frozen platform execution context for template runs", async () => {
    const run = makeRun({ messageProvider: "telegram" });

    const resolved = await resolvePlatformExecutionContextForTemplateRun({
      prompt: "Build the repo and publish the release to GitHub",
      run,
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        Surface: "telegram",
      },
      sessionEntry: {
        sessionId: "session-override",
        specialistOverrideMode: "session",
        specialistSessionProfileId: "developer",
      },
    });

    expect(resolved.selectedProfileId).toBe("developer");
    expect(resolved.readinessStatus).toBe("approval_required");
    expect(resolved.requestedToolNames).toEqual(expect.arrayContaining(["exec", "process"]));
  });

  it("builds a unified routing snapshot for template runs", async () => {
    const run = makeRun({ messageProvider: "telegram" });

    const resolved = await resolveRoutingSnapshotForTemplateRun({
      prompt: "Build the repo and publish the release to GitHub",
      run,
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "telegram",
        Surface: "slack",
      },
      sessionEntry: {
        sessionId: "session-override",
        specialistOverrideMode: "session",
        specialistSessionProfileId: "developer",
      },
    });

    expect(resolved.channelHints).toEqual({
      messageChannel: "telegram",
      channel: "slack",
      replyChannel: "telegram",
    });
    expect(resolved.plannerInput.integrations).toEqual(
      expect.arrayContaining(["telegram", "slack"]),
    );
    expect(resolved.runtimePlan.selectedProfileId).toBe("developer");
    expect(resolved.runtimePlan.requestedToolNames).toEqual(
      expect.arrayContaining(["exec", "process"]),
    );
  });

  it("forwards inter_session inputProvenance to buildClassifiedExecutionDecisionInput so the gate can short-circuit announce-flow text", async () => {
    // Plumbing-level regression test for the self-feedback loop fix.
    // The announce flow ships the spawn receipt back through `callGateway`
    // with `inputProvenance: { kind: "inter_session", ... }`. The router /
    // queue then surfaces it on `FollowupRun.run.inputProvenance`. This test
    // verifies that `resolveRoutingSnapshotForTemplateRun` actually threads
    // that provenance into `buildClassifiedExecutionDecisionInput`. The
    // `kind !== "external_user"` short-circuit itself is covered by
    // `src/platform/decision/input.provenance-gate.test.ts`.
    const run = makeRun({
      messageProvider: "telegram",
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "subagent_announce",
        sourceSessionKey: "agent:main:subagent:fedot",
        sourceChannel: "internal",
      },
    });

    await resolveRoutingSnapshotForTemplateRun({
      prompt: "Квитанция: follow-up сессия Федот активна, на связи.",
      run,
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        Surface: "telegram",
      },
      sessionEntry: {
        sessionId: "session-feedback-loop",
      },
    });

    expect(hoisted.buildClassifiedExecutionDecisionInputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inputProvenance: expect.objectContaining({
          kind: "inter_session",
          sourceTool: "subagent_announce",
        }),
      }),
    );
  });

  it("omits inputProvenance from the planner call when the run has no provenance (back-compat)", async () => {
    const run = makeRun({ messageProvider: "telegram" });

    await resolveRoutingSnapshotForTemplateRun({
      prompt: "Привет",
      run,
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        Surface: "telegram",
      },
      sessionEntry: {
        sessionId: "session-legacy-undefined",
      },
    });

    const lastCall = hoisted.buildClassifiedExecutionDecisionInputMock.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const callArg = lastCall?.[0] as { inputProvenance?: unknown } | undefined;
    expect(callArg).toBeDefined();
    expect("inputProvenance" in (callArg ?? {})).toBe(false);
  });

  it("uses transcript-derived prompt and file names when store context exists", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stage9-input-"));
    const storePath = path.join(tmp, "sessions.json");
    const transcriptPath = resolveSessionTranscriptPathInDir("session-1", tmp);
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        id: "msg-1",
        message: {
          role: "user",
          content: "Please inspect the attached build log and fix the CI failure",
          MediaPaths: ["/tmp/build.log"],
        },
      })}\n`,
      "utf8",
    );
    const run = makeRun({ messageProvider: "telegram" });

    const resolved = await resolvePlatformExecutionContextForTemplateRun({
      prompt: "Then ship the patch.",
      run,
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        Surface: "telegram",
      },
      storePath,
      sessionEntry: {
        sessionId: "session-1",
        sessionFile: "session-1.jsonl",
      },
    });

    expect(resolved.requestedToolNames).toEqual(expect.arrayContaining(["exec", "process"]));
    expect(resolved.prependContext).toContain("Planner reasoning");
  });
});
