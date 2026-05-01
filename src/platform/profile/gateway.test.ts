import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";

const hoisted = vi.hoisted(() => ({
  classifyTaskForDecisionMock: vi.fn(),
  loadConfigMock: vi.fn(() => ({ models: { providers: {} } })),
}));

async function loadGatewayMethod(entry?: SessionEntry) {
  vi.doMock("../../gateway/session-entry.js", () => ({
    loadSessionEntry: vi.fn(() => ({
      entry,
      storePath: entry ? "mock-store" : undefined,
    })),
  }));
  vi.doMock("../../gateway/session-utils.fs.js", () => ({
    readSessionMessages: vi.fn(() => []),
  }));
  vi.doMock("../../config/config.js", () => ({
    loadConfig: (...args: unknown[]) => (hoisted.loadConfigMock as (...a: unknown[]) => unknown)(...args),
  }));
  vi.doMock("../decision/task-classifier.js", () => ({
    classifyTaskForDecision: (...args: unknown[]) => hoisted.classifyTaskForDecisionMock(...args),
  }));
  const mod = await import("./gateway.js");
  return mod.createProfileResolveGatewayMethod();
}

describe("profile gateway method", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    hoisted.classifyTaskForDecisionMock.mockReset();
    hoisted.loadConfigMock.mockClear();
    hoisted.classifyTaskForDecisionMock.mockResolvedValue({
      source: "llm",
      taskContract: {
        primaryOutcome: "workspace_change",
        requiredCapabilities: [
          "needs_workspace_mutation",
          "needs_repo_execution",
          "needs_local_runtime",
        ],
        interactionMode: "tool_execution",
        confidence: 0.95,
        ambiguities: [],
      },
      plannerInput: {
        prompt: "Review this TypeScript repo, run tests if needed, and prepare a GitHub release.",
        contractFirst: true,
        intent: "code",
        requestedTools: ["apply_patch", "exec", "process"],
        artifactKinds: ["binary"],
        outcomeContract: "workspace_change",
        executionContract: {
          requiresTools: true,
          requiresWorkspaceMutation: true,
          requiresLocalProcess: true,
          requiresArtifactEvidence: false,
          requiresDeliveryEvidence: false,
          mayNeedBootstrap: true,
        },
        requestedEvidence: ["tool_receipt"],
        confidence: "high",
        ambiguityReasons: [],
        candidateFamilies: ["code_build"],
        resolutionContract: {
          selectedFamily: "code_build",
          candidateFamilies: ["code_build"],
          toolBundles: ["repo_mutation", "repo_run"],
          routing: {
            localEligible: false,
            remoteProfile: "code",
            preferRemoteFirst: false,
            needsVision: false,
          },
        },
        routing: {
          localEligible: false,
          remoteProfile: "code",
          preferRemoteFirst: false,
          needsVision: false,
        },
      },
    });
  });

  it("resolves a specialist runtime snapshot from the current draft", async () => {
    const respond = vi.fn();
    const method = await loadGatewayMethod();

    await method({
      params: {
        sessionKey: "main",
        draft: "Review this TypeScript repo, run tests if needed, and prepare a GitHub release.",
      },
      req: { type: "req", method: "platform.profile.resolve", id: "req-profile-1" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessionKey: "main",
        selectedProfileId: "developer",
        activeProfileId: "developer",
        recipeId: "code_build_publish",
        taskOverlayId: expect.any(String),
        draftApplied: true,
        requiredCapabilities: ["node", "git"],
        bootstrapRequiredCapabilities: expect.any(Array),
        capabilityRequirements: expect.arrayContaining([
          expect.objectContaining({
            id: "node",
            status: expect.any(String),
          }),
        ]),
        policyAutonomy: expect.any(String),
        requiresExplicitApproval: expect.any(Boolean),
        allowArtifactPersistence: expect.any(Boolean),
        allowPublish: expect.any(Boolean),
        allowCapabilityBootstrap: expect.any(Boolean),
        allowPrivilegedTools: expect.any(Boolean),
        policyReasons: expect.any(Array),
        policyDeniedReasons: expect.any(Array),
        availableProfiles: expect.arrayContaining([
          expect.objectContaining({ id: "developer", label: "Developer" }),
          expect.objectContaining({ id: "integrator", label: "Integrator" }),
          expect.objectContaining({ id: "operator", label: "Operator" }),
          expect.objectContaining({ id: "media_creator", label: "Media Creator" }),
        ]),
        override: expect.objectContaining({
          supported: true,
          mode: "auto",
        }),
      }),
    );

    const snapshot = respond.mock.calls[0]?.[1] as {
      reasoningSummary?: string;
      preferredTools?: string[];
      confidence?: number;
      policyDeniedReasons?: string[];
    };
    expect(snapshot.reasoningSummary).toContain("code_build_publish");
    expect(snapshot.preferredTools).toContain("exec");
    expect(snapshot.confidence).toBeGreaterThan(0);
    expect(snapshot.policyDeniedReasons?.length ?? 0).toBeGreaterThan(0);
  });

  it("reflects persisted base specialist overrides", async () => {
    const respond = vi.fn();
    const method = await loadGatewayMethod({
      sessionId: "sess-base",
      updatedAt: 1,
      specialistOverrideMode: "base",
      specialistBaseProfileId: "developer",
    } as SessionEntry);

    await method({
      params: { sessionKey: "main", draft: "Tell me a joke about robots." },
      req: { type: "req", method: "platform.profile.resolve", id: "req-profile-2" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    const snapshot = respond.mock.calls[0]?.[1] as {
      selectedProfileId: string;
      activeProfileId: string;
      override: { mode: string; baseProfileId?: string };
    };
    expect(snapshot.selectedProfileId).toBe("developer");
    expect(snapshot.activeProfileId).toBe("developer");
    expect(snapshot.override).toEqual(
      expect.objectContaining({
        mode: "base",
        baseProfileId: "developer",
      }),
    );
  });

  it("reflects persisted session specialist overrides", async () => {
    const respond = vi.fn();
    const method = await loadGatewayMethod({
      sessionId: "sess-session",
      updatedAt: 1,
      specialistOverrideMode: "session",
      specialistSessionProfileId: "builder",
    } as SessionEntry);

    await method({
      params: { sessionKey: "main", draft: "Tell me a joke about robots." },
      req: { type: "req", method: "platform.profile.resolve", id: "req-profile-3" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    const snapshot = respond.mock.calls[0]?.[1] as {
      selectedProfileId: string;
      activeProfileId: string;
      override: { mode: string; sessionProfileId?: string };
    };
    expect(snapshot.selectedProfileId).toBe("builder");
    expect(snapshot.activeProfileId).toBe("builder");
    expect(snapshot.override).toEqual(
      expect.objectContaining({
        mode: "session",
        sessionProfileId: "builder",
      }),
    );
  });
});
