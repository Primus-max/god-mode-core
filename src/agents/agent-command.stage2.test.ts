import { describe, expect, it } from "vitest";
import type { ResolvedPlatformRuntimePlan } from "../platform/recipe/runtime-adapter.js";
import {
  buildEmbeddedAgentRunParams,
  resolveAgentCommandFallbackOverride,
  shouldFailoverEmptySemanticRetryResult,
} from "./agent-command.js";

function makeOpts(overrides?: Record<string, unknown>) {
  return {
    message: "hello",
    to: "+1555",
    senderIsOwner: false,
    ...overrides,
  } as never;
}

function makePlatformPlan(
  overrides?: Partial<ResolvedPlatformRuntimePlan["runtime"]>,
): ResolvedPlatformRuntimePlan {
  return {
    runtime: {
      selectedRecipeId: "code_build_publish",
      selectedProfileId: "developer",
      taskOverlayId: "code_heavy",
      plannerReasoning: "code_build_publish matched the publish-oriented prompt.",
      timeoutSeconds: 300,
      ...overrides,
    },
  } as unknown as ResolvedPlatformRuntimePlan;
}

describe("agent-command Stage 2 wiring helpers", () => {
  it("attaches structured platform execution context to embedded run params", () => {
    const platformRuntimePlan = makePlatformPlan({
      selectedRecipeId: "doc_ingest",
      selectedProfileId: "builder",
      taskOverlayId: "document_first",
      plannerReasoning: "doc_ingest matched the document-heavy prompt.",
      timeoutSeconds: 180,
      prependContext: "Profile: Builder.\nPlanner reasoning: doc_ingest.",
      prependSystemContext: "Execution recipe: doc_ingest.",
    });

    const params = buildEmbeddedAgentRunParams({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      messageChannel: "webchat",
      runContext: {
        accountId: undefined,
        groupId: undefined,
        groupChannel: undefined,
        groupSpace: undefined,
        currentChannelId: undefined,
        currentThreadTs: undefined,
        replyToMode: undefined,
        hasRepliedRef: undefined,
      },
      spawnedBy: undefined,
      opts: makeOpts({ message: "Parse this PDF estimate into a report" }),
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      cfg: {} as never,
      skillsSnapshot: undefined,
      effectivePrompt: "Parse this PDF estimate into a report",
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-5",
      sessionEntry: undefined,
      resolvedThinkLevel: "high",
      resolvedVerboseLevel: "on",
      timeoutMs: 180_000,
      runId: "run-stage2",
      agentDir: "/tmp/agent",
      platformRuntimePlan,
      authProfileId: undefined,
      images: undefined,
      allowTransientCooldownProbe: false,
      onAgentEvent: () => undefined,
      bootstrapPromptWarningSignaturesSeen: [],
      bootstrapPromptWarningSignature: undefined,
    });

    expect(params.platformExecutionContext).toEqual({
      selectedRecipeId: "doc_ingest",
      selectedProfileId: "builder",
      taskOverlayId: "document_first",
      plannerReasoning: "doc_ingest matched the document-heavy prompt.",
      timeoutSeconds: 180,
      prependContext: "Profile: Builder.\nPlanner reasoning: doc_ingest.",
      prependSystemContext: "Execution recipe: doc_ingest.",
    });
    expect(params.prompt).toBe("Parse this PDF estimate into a report");
    expect(params.disableMessageTool).toBe(false);
  });

  it("disables the message tool when delivery is handled by the command pipeline", () => {
    const platformRuntimePlan = makePlatformPlan();
    const params = buildEmbeddedAgentRunParams({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionAgentId: "main",
      messageChannel: "telegram",
      runContext: {
        accountId: undefined,
        groupId: undefined,
        groupChannel: undefined,
        groupSpace: undefined,
        currentChannelId: undefined,
        currentThreadTs: undefined,
        replyToMode: undefined,
        hasRepliedRef: undefined,
      },
      spawnedBy: undefined,
      opts: makeOpts({ message: "Send the report", deliver: true, channel: "telegram" }),
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      cfg: {} as never,
      skillsSnapshot: undefined,
      effectivePrompt: "Send the report",
      providerOverride: "ollama",
      modelOverride: "qwen2.5-coder:7b",
      sessionEntry: undefined,
      resolvedThinkLevel: "low",
      resolvedVerboseLevel: "on",
      timeoutMs: 180_000,
      runId: "run-stage2-deliver",
      agentDir: "/tmp/agent",
      platformRuntimePlan,
      authProfileId: undefined,
      images: undefined,
      allowTransientCooldownProbe: false,
      onAgentEvent: () => undefined,
      bootstrapPromptWarningSignaturesSeen: [],
      bootstrapPromptWarningSignature: undefined,
    });

    expect(params.disableMessageTool).toBe(true);
    expect(params.extraSystemPrompt).toContain("Final reply delivery is handled by the command pipeline");
    expect(params.extraSystemPrompt).toContain("Do not call the message tool");
    expect(params.extraSystemPrompt).toContain("Do not read or verify a generated artifact");
  });

  it("prefers recipe fallback chains over configured model fallbacks", () => {
    const platformRuntimePlan = makePlatformPlan({
      fallbackModels: ["fallback/recipe-primary", "fallback/recipe-secondary"],
    });

    expect(
      resolveAgentCommandFallbackOverride({
        platformRuntimePlan,
        configuredFallbacks: ["configured/fallback"],
      }),
    ).toEqual(["fallback/recipe-primary", "fallback/recipe-secondary"]);
  });

  it("keeps configured fallbacks when the recipe does not define overrides", () => {
    const platformRuntimePlan = makePlatformPlan();

    expect(
      resolveAgentCommandFallbackOverride({
        platformRuntimePlan,
        configuredFallbacks: ["configured/fallback"],
      }),
    ).toEqual(["configured/fallback"]);
  });

  it("fails over when a run returns no payloads and requests semantic retry", () => {
    expect(
      shouldFailoverEmptySemanticRetryResult({
        payloads: [],
        meta: {
          durationMs: 1,
          supervisorVerdict: {
            runId: "run-1",
            status: "retryable",
            action: "retry",
            remediation: "semantic_retry",
            reasonCode: "contract_mismatch",
            reasons: ["no output"],
            recoveryPolicy: {
              remediation: "semantic_retry",
              recoveryClass: "semantic",
              cadence: "immediate",
              continuous: false,
              attemptCount: 0,
              maxAttempts: 1,
              remainingAttempts: 1,
              exhausted: false,
              exhaustedAction: "stop",
              nextAttemptDelayMs: 0,
            },
          },
        },
      } as never),
    ).toBe(true);
  });

  it("does not fail over when payloads are present", () => {
    expect(
      shouldFailoverEmptySemanticRetryResult({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          supervisorVerdict: {
            runId: "run-1",
            status: "retryable",
            action: "retry",
            remediation: "semantic_retry",
            reasonCode: "contract_mismatch",
            reasons: ["retry"],
            recoveryPolicy: {
              remediation: "semantic_retry",
              recoveryClass: "semantic",
              cadence: "immediate",
              continuous: false,
              attemptCount: 0,
              maxAttempts: 1,
              remainingAttempts: 1,
              exhausted: false,
              exhaustedAction: "stop",
              nextAttemptDelayMs: 0,
            },
          },
        },
      } as never),
    ).toBe(false);
  });

  it("fails over when payloads contain only standalone pseudo-tool JSON", () => {
    expect(
      shouldFailoverEmptySemanticRetryResult({
        payloads: [
          {
            text: '```json\n{"name":"pdf","arguments":{"prompt":"cat"}}\n```',
            mediaUrl: null,
          },
        ],
        meta: {
          durationMs: 1,
        },
      } as never),
    ).toBe(true);
  });

  it("does not fail over on ordinary JSON payload text", () => {
    expect(
      shouldFailoverEmptySemanticRetryResult({
        payloads: [
          {
            text: '{"status":"ok","message":"ready"}',
            mediaUrl: null,
          },
        ],
        meta: {
          durationMs: 1,
        },
      } as never),
    ).toBe(false);
  });
});
