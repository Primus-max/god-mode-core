import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSessionTranscriptPathInDir } from "../../config/sessions/paths.js";
import type { ClassifiedTaskResolution } from "./task-classifier.js";

const { runTurnDecisionMock } = vi.hoisted(() => ({
  runTurnDecisionMock: vi.fn(),
}));

vi.mock("./run-turn-decision.js", () => ({
  runTurnDecision: runTurnDecisionMock,
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

const cfg: OpenClawConfig = {
  classifier: { backend: "stub" },
  intentContractor: {
    backend: "stub",
    confidenceThreshold: 0.6,
  },
  cutover: {
    enabled: false,
    persistentSession: { enabled: false },
  },
} as unknown as OpenClawConfig;

describe("decision/input.ts call-sites — productionDecision wiring (G1, G2)", () => {
  beforeEach(() => {
    runTurnDecisionMock.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("[input.ts:initial classifier call] consumes productionDecision and passes monitoredRuntime + expectedDeltaResolver", async () => {
    const legacyDecision = buildClassified({
      prompt: "do thing",
      requestedTools: ["legacy-tool"],
    });
    const productionDecision = buildClassified({
      prompt: "do thing",
      requestedTools: ["production-tool"],
    });
    runTurnDecisionMock.mockResolvedValue({
      legacyDecision,
      productionDecision,
      shadowCommitment: { kind: "unsupported", reason: "low_confidence_intent" },
      cutoverGate: { kind: "gate_out", reason: "cutover_disabled" },
      kernelFallback: false,
      traceId: "decision_trace_test" as never,
    });

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-callsites-input-"));
    const storePath = path.join(tempDir, "sessions.json");
    const transcriptPath = resolveSessionTranscriptPathInDir("session-cs", tempDir);
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        id: "msg-1",
        message: { role: "user", content: "do thing" },
      })}\n`,
      "utf8",
    );

    const { buildClassifiedExecutionDecisionInput } = await import("./input.js");
    const planner = await buildClassifiedExecutionDecisionInput({
      prompt: "do thing",
      storePath,
      sessionEntry: { sessionId: "session-cs", sessionFile: "session-cs.jsonl" },
      cfg,
    });

    const firstCallArgs = runTurnDecisionMock.mock.calls[0]?.[0];
    expect(firstCallArgs).toBeDefined();
    expect(firstCallArgs!.monitoredRuntime).toBeDefined();
    expect(typeof firstCallArgs!.expectedDeltaResolver).toBe("function");
    expect(planner.requestedTools).toEqual(["production-tool"]);
    expect(planner.requestedTools).not.toEqual(["legacy-tool"]);
  });

  it("[input.ts:workspace-inject reclassify] also consumes productionDecision and passes monitoredRuntime + expectedDeltaResolver", async () => {
    const initialLegacy = buildClassified({
      prompt: "fix repo",
      requestedTools: ["legacy-initial"],
    });
    const initialProduction = buildClassified({
      prompt: "fix repo",
      requestedTools: ["production-initial"],
    });
    const reclassifiedLegacy = buildClassified({
      prompt: "fix repo",
      requestedTools: ["legacy-reclassified"],
    });
    const reclassifiedProduction = buildClassified({
      prompt: "fix repo",
      requestedTools: ["production-reclassified"],
    });

    runTurnDecisionMock
      .mockResolvedValueOnce({
        legacyDecision: initialLegacy,
        productionDecision: initialProduction,
        shadowCommitment: { kind: "unsupported", reason: "low_confidence_intent" },
        cutoverGate: { kind: "gate_out", reason: "cutover_disabled" },
        kernelFallback: false,
        traceId: "decision_trace_test_a" as never,
      })
      .mockResolvedValueOnce({
        legacyDecision: reclassifiedLegacy,
        productionDecision: reclassifiedProduction,
        shadowCommitment: { kind: "unsupported", reason: "low_confidence_intent" },
        cutoverGate: { kind: "gate_out", reason: "cutover_disabled" },
        kernelFallback: false,
        traceId: "decision_trace_test_b" as never,
      });

    const ledgerSessionId = "session-workspace";
    const channelId = "telegram";
    const intentLedgerModule = await import("../session/intent-ledger.js");
    vi.spyOn(intentLedgerModule.intentLedger, "getOrProbeWorkspace").mockResolvedValue({
      summary: "workspace summary",
      capturedAt: Date.now(),
      workspaceRoot: "/tmp/repo",
    } as never);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-callsites-workspace-"));
    const storePath = path.join(tempDir, "sessions.json");
    const transcriptPath = resolveSessionTranscriptPathInDir(ledgerSessionId, tempDir);
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        id: "msg-1",
        message: { role: "user", content: "fix repo" },
      })}\n`,
      "utf8",
    );

    const { buildClassifiedExecutionDecisionInput } = await import("./input.js");
    await buildClassifiedExecutionDecisionInput({
      prompt: "fix repo",
      storePath,
      sessionEntry: { sessionId: ledgerSessionId, sessionFile: `${ledgerSessionId}.jsonl` },
      channelHints: { messageChannel: channelId },
      cfg,
    });

    const calls = runTurnDecisionMock.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const [args] of calls) {
      expect(args.monitoredRuntime).toBeDefined();
      expect(typeof args.expectedDeltaResolver).toBe("function");
    }
  });
});
