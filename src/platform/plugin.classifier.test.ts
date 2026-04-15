import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../plugins/types.js";

vi.mock("./decision/task-classifier.js", () => ({
  classifyTaskForDecision: vi.fn(),
}));

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

describe("plugin classifier propagation", () => {
  it("uses the classified planner input instead of rebuilding routing from prompt heuristics", async () => {
    const taskClassifierModule = await import("./decision/task-classifier.js");
    const { registerPlatformProfilePlugin, resolveHookExecution } = await import("./plugin.js");
    vi.mocked(taskClassifierModule.classifyTaskForDecision).mockResolvedValue({
      source: "llm",
      taskContract: {
        primaryOutcome: "document_package",
        requiredCapabilities: ["needs_visual_composition"],
        interactionMode: "artifact_iteration",
        confidence: 0.93,
        ambiguities: [],
      },
      plannerInput: {
        prompt: "Tell me a joke about city cats.",
        contractFirst: true,
        intent: "document",
        artifactKinds: ["document"],
        requestedTools: ["pdf"],
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
    });

    registerPlatformProfilePlugin(createApiMock());
    const execution = await resolveHookExecution("Tell me a joke about city cats.");

    expect(execution.profileId).toBe("builder");
    expect(execution.recipeId).toBe("doc_authoring");
    expect(execution.requestedToolNames).toEqual(["pdf"]);
    expect(execution.artifactKinds).toEqual(["document"]);
  });
});
