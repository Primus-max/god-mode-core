import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../plugins/types.js";
import type { ClassifiedTaskResolution } from "./decision/task-classifier.js";

vi.mock("./decision/run-turn-decision.js", () => ({
  runTurnDecision: vi.fn(),
}));

function buildClassified(overrides: {
  prompt: string;
  requestedTools: string[];
}): ClassifiedTaskResolution {
  return {
    source: "llm",
    taskContract: {
      primaryOutcome: "document_package",
      requiredCapabilities: ["needs_visual_composition"],
      interactionMode: "artifact_iteration",
      confidence: 0.93,
      ambiguities: [],
    },
    plannerInput: {
      prompt: overrides.prompt,
      contractFirst: true,
      intent: "document",
      artifactKinds: ["document"],
      requestedTools: overrides.requestedTools,
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: false,
      },
      requestedEvidence: ["tool_receipt", "artifact_descriptor", "capability_receipt"],
      confidence: "high",
      candidateFamilies: ["document_render"],
      resolutionContract: {
        selectedFamily: "document_render",
        candidateFamilies: ["document_render"],
        toolBundles: ["artifact_authoring"],
        routing: {
          localEligible: false,
          remoteProfile: "presentation",
          preferRemoteFirst: true,
          needsVision: false,
        },
      },
      routing: {
        localEligible: false,
        remoteProfile: "presentation",
        preferRemoteFirst: true,
      },
    },
    resolutionContract: {
      selectedFamily: "document_render",
      candidateFamilies: ["document_render"],
      toolBundles: ["artifact_authoring"],
      routing: {
        localEligible: false,
        remoteProfile: "presentation",
        preferRemoteFirst: true,
        needsVision: false,
      },
    },
    candidateFamilies: ["document_render"],
  };
}

function createApiMock(): OpenClawPluginApi {
  return {
    id: "platform-profile-foundation",
    name: "Platform Profile Foundation",
    source: "test",
    registrationMode: "full",
    config: {
      plugins: {
        enabled: true,
        slots: { memory: "none" },
      },
    },
    runtime: {} as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerGatewayMethod: vi.fn(),
  } as unknown as OpenClawPluginApi;
}

describe("plugin.ts call-sites — productionDecision wiring (G1, G2)", () => {
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("./decision/run-turn-decision.js");
    vi.mocked(mod.runTurnDecision).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("[plugin.ts:resolveHookExecution] passes monitoredRuntime + expectedDeltaResolver and consumes productionDecision (not legacyDecision)", async () => {
    const mod = await import("./decision/run-turn-decision.js");
    const legacyDecision = buildClassified({
      prompt: "hello",
      requestedTools: ["legacy-tool"],
    });
    const productionDecision = buildClassified({
      prompt: "hello",
      requestedTools: ["production-tool"],
    });
    vi.mocked(mod.runTurnDecision).mockResolvedValue({
      legacyDecision,
      productionDecision,
      shadowCommitment: { kind: "unsupported", reason: "low_confidence_intent" },
      cutoverGate: { kind: "gate_out", reason: "cutover_disabled" },
      kernelFallback: false,
      traceId: "decision_trace_test" as never,
    });

    const { registerPlatformProfilePlugin, resolveHookExecution } = await import("./plugin.js");
    registerPlatformProfilePlugin(createApiMock());
    const execution = await resolveHookExecution("hello", { agentId: "default" });

    const call = vi.mocked(mod.runTurnDecision).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call!.monitoredRuntime).toBeDefined();
    expect(typeof call!.expectedDeltaResolver).toBe("function");
    expect(execution.requestedToolNames).toEqual(["production-tool"]);
    expect(execution.requestedToolNames).not.toEqual(["legacy-tool"]);
  });

  it("[plugin.ts:before_tool_call] exec(host=node) fallback path passes monitoredRuntime + expectedDeltaResolver", async () => {
    const mod = await import("./decision/run-turn-decision.js");
    const legacyDecision = buildClassified({
      prompt: "machine call",
      requestedTools: ["legacy-tool"],
    });
    const productionDecision = buildClassified({
      prompt: "machine call",
      requestedTools: ["production-tool"],
    });
    vi.mocked(mod.runTurnDecision).mockResolvedValue({
      legacyDecision,
      productionDecision,
      shadowCommitment: { kind: "unsupported", reason: "low_confidence_intent" },
      cutoverGate: { kind: "gate_out", reason: "cutover_disabled" },
      kernelFallback: false,
      traceId: "decision_trace_test" as never,
    });

    const handlers: Array<{
      event: string;
      handler: (event: unknown, ctx: unknown) => unknown;
    }> = [];
    const api = createApiMock();
    (api.on as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (eventName: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.push({ event: eventName, handler });
      },
    );

    const { registerPlatformProfilePlugin } = await import("./plugin.js");
    registerPlatformProfilePlugin(api);

    const beforeToolCall = handlers.find((entry) => entry.event === "before_tool_call");
    expect(beforeToolCall).toBeDefined();

    await beforeToolCall!.handler(
      { toolName: "exec", params: { host: "node" } },
      { agentId: "default", toolName: "exec" },
    );

    const fallbackCall = vi
      .mocked(mod.runTurnDecision)
      .mock.calls.find((entry) => entry[0]?.prompt === "");
    expect(fallbackCall?.[0]?.monitoredRuntime).toBeDefined();
    expect(typeof fallbackCall?.[0]?.expectedDeltaResolver).toBe("function");
  });
});
