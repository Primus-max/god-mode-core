import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { TypingController } from "./typing.js";

vi.mock("../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/agent-scope.js")>();
  return {
    ...actual,
    listAgentEntries: () => [],
  };
});

vi.mock("../../agents/fast-mode.js", () => ({
  resolveFastModeState: () => ({ enabled: false, source: "default" }),
}));

vi.mock("../../agents/sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
}));

vi.mock("../commands-text-routing.js", () => ({
  shouldHandleTextCommands: () => true,
}));

vi.mock("../commands-registry.runtime.js", () => ({
  listChatCommands: () => [],
}));

vi.mock("./block-streaming.js", () => ({
  resolveBlockStreamingChunking: () => undefined,
}));

vi.mock("./model-selection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-selection.js")>();
  return {
    ...actual,
    createModelSelectionState: async () => ({
      provider: "ollama",
      model: "gemma4:e4b",
      allowedModelKeys: new Set(["hydra/gpt-4o", "ollama/gemma4:e4b"]),
      allowedModelCatalog: [
        { provider: "hydra", id: "gpt-4o" },
        { provider: "ollama", id: "gemma4:e4b" },
      ],
      resetModelOverride: false,
      resolveDefaultThinkingLevel: async () => undefined,
      resolveDefaultReasoningLevel: async () => "off",
    }),
    resolveContextTokens: () => 200_000,
  };
});

vi.mock("./reply-elevated.js", () => ({
  resolveElevatedPermissions: () => ({ enabled: false, allowed: false, failures: [] }),
  formatElevatedUnavailableMessage: () => "elevated unavailable",
}));

const { resolveReplyDirectives } = await import("./get-reply-directives.js");

describe("resolveReplyDirectives mixed inline directives", () => {
  it("preserves a mixed-content model directive for authorized webchat operators", async () => {
    const body =
      'Используй model:hydra/gpt-4o. Переведи на английский: "Умный роутинг экономит токены"';
    const sessionEntry = { sessionId: "agent:main:thread:test", updatedAt: Date.now() } as unknown as SessionEntry;

    const result = await resolveReplyDirectives({
      ctx: {
        Provider: "webchat",
        Surface: "webchat",
        GatewayClientScopes: ["operator.admin", "operator.read", "operator.write"],
        CommandSource: "text",
        Body: body,
        RawBody: body,
        CommandBody: body,
        BodyForCommands: body,
        SessionKey: "agent:main:thread:test",
        From: "webchat:test",
        To: "webchat:test",
      },
      cfg: { agents: { defaults: { models: {} } } },
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      agentCfg: {},
      sessionCtx: {
        Body: body,
        BodyStripped: body,
        BodyForAgent: body,
        BodyForCommands: body,
        RawBody: body,
        CommandBody: body,
      },
      sessionEntry,
      sessionStore: { "agent:main:thread:test": sessionEntry },
      sessionKey: "agent:main:thread:test",
      storePath: "/tmp/sessions.json",
      sessionScope: "per-sender",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: body,
      commandAuthorized: false,
      defaultProvider: "ollama",
      defaultModel: "gemma4:e4b",
      aliasIndex: {} as never,
      provider: "ollama",
      model: "gemma4:e4b",
      hasResolvedHeartbeatModelOverride: false,
      typing: { cleanup() {} } as unknown as TypingController,
      opts: undefined,
      skillFilter: undefined,
    });

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error("expected directive resolution to continue");
    }
    expect(result.result.directives).toMatchObject({
      hasModelDirective: true,
      rawModelDirective: "hydra/gpt-4o",
    });
    expect(result.result.directives.cleaned).toContain("Переведи на английский");
  });
});
