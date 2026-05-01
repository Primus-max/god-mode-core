import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSessionTranscriptPathInDir } from "../../config/sessions/paths.js";
import type { RecipePlannerInput } from "../recipe/planner.js";
import { planExecutionRecipe } from "../recipe/planner.js";
import { adaptExecutionPlanToRuntime } from "../recipe/runtime-adapter.js";
import { intentLedger } from "../session/intent-ledger.js";
import {
  buildExecutionDecisionInput,
  buildExecutionDecisionInputFromRuntimePlan,
  buildClassifiedExecutionDecisionInput,
  buildSessionBackedExecutionDecisionInput,
  shouldInjectWorkspaceContext,
  shouldUseLightweightBootstrapContext,
} from "./input.js";
import { resolveResolutionContract } from "./resolution-contract.js";
import type { TaskContract } from "./task-classifier.js";

describe("buildSessionBackedExecutionDecisionInput", () => {
  it("merges transcript-derived prompt and file names with the current draft prompt", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-decision-input-"));
    const storePath = path.join(tempDir, "sessions.json");
    const transcriptPath = resolveSessionTranscriptPathInDir("session-input", tempDir);
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        id: "msg-1",
        message: {
          role: "user",
          content: "Please inspect the CI log and fix the build failure",
          MediaPaths: ["/tmp/build.log"],
        },
      })}\n`,
      "utf8",
    );

    const decisionInput = buildSessionBackedExecutionDecisionInput({
      draftPrompt: "Then ship the patch.",
      storePath,
      sessionEntry: {
        sessionId: "session-input",
        sessionFile: "session-input.jsonl",
      },
      channelHints: {
        messageChannel: "telegram",
      },
    });

    expect(decisionInput.prompt).toContain("inspect the CI log");
    expect(decisionInput.prompt).toContain("Then ship the patch.");
    expect(decisionInput.fileNames).toEqual(["build.log"]);
    expect(decisionInput.channelHints).toEqual({ messageChannel: "telegram" });
  });

  it("ignores stale tabular attachments outside the recent user-turn window", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-decision-input-"));
    const storePath = path.join(tempDir, "sessions.json");
    const transcriptPath = resolveSessionTranscriptPathInDir("session-stale-files", tempDir);
    const transcriptLines = [
      {
        id: "msg-1",
        message: {
          role: "user",
          content: "Compare supplier exports.",
          MediaPaths: ["/tmp/old-a.csv", "/tmp/old-b.xlsx"],
        },
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `msg-${index + 2}`,
        message: {
          role: "user",
          content: `Recent short follow-up ${index + 1}`,
        },
      })),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    await fs.writeFile(transcriptPath, `${transcriptLines}\n`, "utf8");

    const decisionInput = buildSessionBackedExecutionDecisionInput({
      draftPrompt: "Привет! Как дела? Просто поздоровайся.",
      storePath,
      sessionEntry: {
        sessionId: "session-stale-files",
        sessionFile: "session-stale-files.jsonl",
      },
    });

    expect(decisionInput.prompt).toContain("Recent short follow-up 2");
    expect(decisionInput.prompt).toContain("Привет! Как дела? Просто поздоровайся.");
    expect(decisionInput.fileNames ?? []).toEqual([]);
    expect(decisionInput.intent).toBeUndefined();
    expect(decisionInput.artifactKinds ?? []).toEqual([]);
  });

  it("keeps a short follow-up from inheriting stale infographic routing hints", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-decision-input-"));
    const storePath = path.join(tempDir, "sessions.json");
    const transcriptPath = resolveSessionTranscriptPathInDir("session-infographic-followup", tempDir);
    await fs.writeFile(
      transcriptPath,
      [
        {
          id: "msg-1",
          message: {
            role: "user",
            content:
              "Сделай презентационную инфографику с веселым бананом и собери итог в PDF на 3 страницы.",
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf8",
    );

    const sessionBacked = buildSessionBackedExecutionDecisionInput({
      draftPrompt: "Проверь, установлен ли mempalace.",
      storePath,
      sessionEntry: {
        sessionId: "session-infographic-followup",
        sessionFile: "session-infographic-followup.jsonl",
      },
    });
    const routed = buildExecutionDecisionInput(sessionBacked);

    expect(sessionBacked.prompt).toContain("инфографику");
    expect(sessionBacked.prompt).toContain("установлен ли mempalace");
    expect(sessionBacked.inferencePrompt).toBe("Проверь, установлен ли mempalace.");
    expect(routed.requestedTools ?? []).toEqual([]);
    expect(routed.artifactKinds ?? []).toEqual([]);
    expect(routed.routing?.localEligible).toBe(true);
    expect(routed.routing?.remoteProfile).toBe("cheap");
  });

  it("anchors classified routing on the live draft instead of startup or recovery transcript noise", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-decision-input-"));
    const storePath = path.join(tempDir, "sessions.json");
    const transcriptPath = resolveSessionTranscriptPathInDir("session-draft-first", tempDir);
    await fs.writeFile(
      transcriptPath,
      [
        {
          id: "msg-1",
          message: {
            role: "user",
            content:
              "A new session was started via /new or /reset. Run your Session Startup sequence before replying.",
          },
        },
        {
          id: "msg-2",
          message: {
            role: "user",
            content:
              "The previous run did not satisfy the task well enough. Continue the same task and return only the final completed result.",
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf8",
    );

    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: {
              backend: "stub-backend",
            },
          },
        },
      },
    } as OpenClawConfig;

    const classify = vi.fn().mockResolvedValue({
      primaryOutcome: "document_package",
      requiredCapabilities: ["needs_visual_composition"],
      interactionMode: "artifact_iteration",
      confidence: 0.93,
      ambiguities: [],
    });

    const plannerInput = await buildClassifiedExecutionDecisionInput({
      prompt: "Сгенерируй яркую cartoon-картинку банана без уточняющих вопросов.",
      storePath,
      sessionEntry: {
        sessionId: "session-draft-first",
        sessionFile: "session-draft-first.jsonl",
      },
      cfg,
      adapterRegistry: {
        "stub-backend": {
          classify,
        },
      },
    });

    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Сгенерируй яркую cartoon-картинку банана без уточняющих вопросов.",
      }),
    );
    expect(plannerInput.requestedTools).toEqual(["image_generate"]);
    expect(plannerInput.artifactKinds).toEqual(["image"]);
    expect(plannerInput.resolutionContract?.selectedFamily).toBe("media_generation");
  });

  it("suppresses repeated clarification after the user replies to the same topic", async () => {
    intentLedger.invalidate(() => true);
    try {
      const cfg = {
        agents: {
          defaults: {
            embeddedPi: {
              taskClassifier: {
                backend: "stub-backend",
              },
            },
          },
        },
      } as OpenClawConfig;
      const ambigs = ["blocking: report destination is unclear"];
      intentLedger.recordFromBotTurn({
        turnId: "clarify-repeat-1",
        sessionId: "session-repeat",
        channelId: "telegram",
        summary: "Куда отправлять отчёт?",
        planOutput: { executionContract: { requiresTools: false } },
        ambigs,
      });

      const plannerInput = await buildClassifiedExecutionDecisionInput({
        prompt: "В этот чат",
        sessionEntry: {
          sessionId: "session-repeat",
          sessionFile: "session-repeat.jsonl",
        },
        channelHints: { messageChannel: "telegram" },
        cfg,
        adapterRegistry: {
          "stub-backend": {
            classify: vi.fn().mockResolvedValue({
              primaryOutcome: "clarification_needed",
              requiredCapabilities: [],
              interactionMode: "clarify_first",
              confidence: 0.72,
              ambiguities: ambigs,
              executionMode: "clarify",
            }),
          },
        },
      });

      expect(plannerInput.lowConfidenceStrategy).toBeUndefined();
      expect(plannerInput.ambiguityReasons ?? []).toEqual([]);
      expect(plannerInput.decisionTrace?.classifier?.finalContract).toEqual(
        expect.objectContaining({
          primaryOutcome: "answer",
          interactionMode: "respond_only",
          ambiguities: [],
        }),
      );
    } finally {
      intentLedger.invalidate(() => true);
    }
  });

  it("keeps short chat prompts local-eligible even inside runtime prepend context", () => {
    const routed = buildExecutionDecisionInput({
      prompt: `Profile: General.
Language continuity: Reply in the same language as the user's latest message unless they explicitly ask for another language.
Task overlay: General Chat.
Planner reasoning: Recipe general_reasoning selected for profile general. Task overlay: general_chat.

Sender (untrusted metadata):
\`\`\`json
{
  "label": "stage86-live-matrix (cli)",
  "id": "cli",
  "name": "stage86-live-matrix",
  "username": "stage86-live-matrix"
}
\`\`\`

[Sat 2026-04-11 14:39 GMT+3] Привет! Как дела? Просто поздоровайся одной короткой фразой.`,
    });

    expect(routed.intent).toBeUndefined();
    expect(routed.requestedTools ?? []).toEqual([]);
    expect(routed.artifactKinds ?? []).toEqual([]);
    expect(routed.routing?.localEligible).toBe(true);
    expect(routed.routing?.remoteProfile).toBe("cheap");
  });
});

describe("buildExecutionDecisionInputFromRuntimePlan", () => {
  it("keeps structured signals when the live prompt no longer matches the original heuristics", () => {
    const plannerInput: RecipePlannerInput = {
      prompt: "Parse this PDF estimate into a report",
      fileNames: ["estimate.pdf"],
      artifactKinds: ["document", "report"],
      intent: "document",
    };
    const priorPlan = planExecutionRecipe(plannerInput);
    const priorRuntime = adaptExecutionPlanToRuntime(priorPlan, { input: plannerInput });
    const replayInput = buildExecutionDecisionInputFromRuntimePlan({
      runtime: priorRuntime,
      prompt: "Thanks, continue.",
    });
    const fromScratch = buildExecutionDecisionInput({ prompt: "Thanks, continue." });

    expect(replayInput.intent).toBe("document");
    expect(replayInput.artifactKinds).toEqual(["document", "report"]);
    expect(replayInput.outcomeContract).toBe(priorRuntime.outcomeContract);
    expect(replayInput.executionContract).toEqual(priorRuntime.executionContract);
    expect(replayInput.requestedEvidence).toEqual(priorRuntime.requestedEvidence);
    expect(replayInput.routing).toEqual(priorRuntime.routing);
    expect(fromScratch.intent).toBeUndefined();
    expect(fromScratch.artifactKinds?.length ?? 0).toBe(0);
  });

  it("replays planner input that selects the same recipe without calling full platform resolution", () => {
    const plannerInput: RecipePlannerInput = {
      prompt: "Parse this PDF estimate into a report",
      fileNames: ["estimate.pdf"],
      artifactKinds: ["document", "report"],
      contractFirst: true,
      outcomeContract: "structured_artifact",
      executionContract: {
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: false,
        requiresArtifactEvidence: true,
        requiresDeliveryEvidence: false,
        mayNeedBootstrap: true,
      },
      candidateFamilies: ["document_render"],
      resolutionContract: {
        selectedFamily: "document_render",
        candidateFamilies: ["document_render"],
        toolBundles: ["document_extraction"],
        routing: {
          localEligible: false,
          remoteProfile: "strong",
          preferRemoteFirst: true,
          needsVision: true,
        },
      },
      routing: {
        localEligible: false,
        remoteProfile: "strong",
        preferRemoteFirst: true,
        needsVision: true,
      },
    };
    const priorPlan = planExecutionRecipe(plannerInput);
    const priorRuntime = adaptExecutionPlanToRuntime(priorPlan, { input: plannerInput });
    const replayPlannerInput = buildExecutionDecisionInputFromRuntimePlan({
      runtime: priorRuntime,
      prompt: "ok",
    });
    const replayPlan = planExecutionRecipe(replayPlannerInput);
    expect(replayPlan.recipe.id).toBe(priorPlan.recipe.id);
    expect(replayPlan.profile.selectedProfile.id).toBe(priorPlan.profile.selectedProfile.id);
  });
});

describe("buildExecutionDecisionInput", () => {
  it("does not infer document authoring from a prompt-only pdf request", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Create a two-page PDF infographic about a city cat with a couple of generated images.",
    });

    expect(input.intent).toBeUndefined();
    expect(input.artifactKinds ?? []).toEqual([]);
    expect(input.requestedTools ?? []).toEqual([]);
    expect(input.publishTargets ?? []).toEqual([]);
    expect(input.outcomeContract).toBe("text_response");
    expect(input.executionContract).toEqual({
      requiresTools: false,
      requiresWorkspaceMutation: false,
      requiresLocalProcess: false,
      requiresArtifactEvidence: false,
      requiresDeliveryEvidence: false,
      mayNeedBootstrap: false,
    });
    expect(input.resolutionContract).toEqual(
      expect.objectContaining({
        selectedFamily: "general_assistant",
        candidateFamilies: ["general_assistant"],
        toolBundles: ["respond_only"],
        routing: expect.objectContaining({
          localEligible: true,
          remoteProfile: "cheap",
          preferRemoteFirst: false,
        }),
      }),
    );
    expect(input.routing).toEqual({
      localEligible: true,
      remoteProfile: "cheap",
    });
  });

  it("does not infer browser or compare routing from prompt text or file names alone", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Open https://example.com and compare the attached sheets.",
      fileNames: ["sheet_a.csv", "sheet_b.csv"],
    });

    expect(input.intent).toBeUndefined();
    expect(input.artifactKinds ?? []).toEqual([]);
    expect(input.requestedTools ?? []).toEqual([]);
    expect(input.publishTargets ?? []).toEqual([]);
    expect(input.outcomeContract).toBe("text_response");
  });

  it("passes through explicit structured routing fields without re-inferring from prompt", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Just chat about cats.",
      intent: "document",
      artifactKinds: ["image", "document", "image"],
      requestedTools: ["image_generate", "pdf", "image_generate"],
      publishTargets: ["PDF", "pdf"],
      integrations: ["Slack"],
      channelHints: {
        messageChannel: "Telegram",
        channel: "telegram",
      },
    });

    expect(input.intent).toBe("document");
    expect(input.artifactKinds).toEqual(["image", "document"]);
    expect(input.requestedTools).toEqual(["image_generate", "pdf"]);
    expect(input.publishTargets).toEqual(["pdf"]);
    expect(input.integrations).toEqual(["slack", "telegram"]);
    expect(input.outcomeContract).toBe("structured_artifact");
    expect(input.executionContract).toEqual(
      expect.objectContaining({
        requiresTools: true,
        requiresArtifactEvidence: true,
      }),
    );
    expect(input.requestedEvidence).toEqual([
      "tool_receipt",
      "artifact_descriptor",
      "capability_receipt",
    ]);
    expect(input.resolutionContract?.toolBundles).toEqual(["artifact_authoring", "external_delivery"]);
  });

  it("passes through explicit code/runtime fields without prompt guessing", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Please say hello only.",
      intent: "code",
      artifactKinds: ["binary"],
      requestedTools: ["process", "apply_patch", "exec"],
    });

    expect(input.intent).toBe("code");
    expect(input.artifactKinds).toEqual(["binary"]);
    expect(input.requestedTools).toEqual(["process", "apply_patch", "exec"]);
    expect(input.outcomeContract).toBe("structured_artifact");
    expect(input.executionContract).toEqual(
      expect.objectContaining({
        requiresTools: true,
        requiresWorkspaceMutation: false,
        requiresLocalProcess: true,
        requiresArtifactEvidence: true,
      }),
    );
    expect(input.resolutionContract?.toolBundles).toEqual(
      expect.arrayContaining(["artifact_authoring", "repo_mutation", "repo_run"]),
    );
  });

  it("normalizes inbound metadata but does not create semantic routing from it", () => {
    const input = buildExecutionDecisionInput({
      prompt: `Profile: Developer.
Planned tools: browser, exec

Sender (untrusted metadata):
\`\`\`json
{"id":"cli"}
\`\`\`

Create a PDF report and publish it.`,
    });

    expect(input.prompt).toContain("Create a PDF report and publish it.");
    expect(input.prompt).not.toContain("Sender (untrusted metadata)");
    expect(input.intent).toBeUndefined();
    expect(input.requestedTools ?? []).toEqual([]);
    expect(input.artifactKinds ?? []).toEqual([]);
    expect(input.publishTargets ?? []).toEqual([]);
  });

  it("marks prompt-only turns as lightweight bootstrap candidates when no structured routing is present", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Привет! Как дела?",
    });

    expect(shouldUseLightweightBootstrapContext(input)).toBe(true);
  });
});

describe("resolveResolutionContract", () => {
  it("maps code execution requirements to code-build routing", () => {
    const resolution = resolveResolutionContract({
      requestedTools: ["exec", "apply_patch", "process"],
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
      candidateFamilies: ["code_build"],
    });

    expect(resolution).toEqual(
      expect.objectContaining({
        selectedFamily: "code_build",
        toolBundles: expect.arrayContaining(["repo_run", "repo_mutation"]),
        routing: expect.objectContaining({
          remoteProfile: "code",
          localEligible: false,
        }),
      }),
    );
  });
});

describe("shouldInjectWorkspaceContext", () => {
  function makeContract(overrides: Partial<TaskContract> = {}): TaskContract {
    return {
      primaryOutcome: "answer",
      requiredCapabilities: [],
      interactionMode: "respond_only",
      confidence: 0.9,
      ambiguities: [],
      ...overrides,
    };
  }

  it("injects when deliverable.kind=code_change", () => {
    const contract = makeContract({
      primaryOutcome: "workspace_change",
      interactionMode: "tool_execution",
      requiredCapabilities: ["needs_workspace_mutation"],
      deliverable: { kind: "code_change", acceptedFormats: ["patch"] },
    });
    expect(shouldInjectWorkspaceContext({ taskContract: contract })).toBe(true);
  });

  it("injects when deliverable.kind=repo_operation", () => {
    const contract = makeContract({
      primaryOutcome: "workspace_change",
      interactionMode: "tool_execution",
      requiredCapabilities: ["needs_repo_execution"],
      deliverable: { kind: "repo_operation", acceptedFormats: ["exec"] },
    });
    expect(shouldInjectWorkspaceContext({ taskContract: contract })).toBe(true);
  });

  it("injects when deliverable.kind=external_delivery + tool_execution mode", () => {
    const contract = makeContract({
      primaryOutcome: "external_delivery",
      interactionMode: "tool_execution",
      requiredCapabilities: ["needs_external_delivery"],
      deliverable: { kind: "external_delivery", acceptedFormats: ["receipt"] },
    });
    expect(shouldInjectWorkspaceContext({ taskContract: contract })).toBe(true);
  });

  it("does NOT inject for external_delivery with artifact_iteration mode", () => {
    const contract = makeContract({
      primaryOutcome: "external_delivery",
      interactionMode: "artifact_iteration",
      requiredCapabilities: ["needs_multimodal_authoring"],
      deliverable: { kind: "external_delivery", acceptedFormats: ["receipt"] },
    });
    expect(shouldInjectWorkspaceContext({ taskContract: contract })).toBe(false);
  });

  it("injects when requestedTools contains exec", () => {
    const contract = makeContract();
    expect(
      shouldInjectWorkspaceContext({ taskContract: contract, requestedTools: ["exec"] }),
    ).toBe(true);
  });

  it("injects when requestedTools contains apply_patch (case-insensitive)", () => {
    const contract = makeContract();
    expect(
      shouldInjectWorkspaceContext({ taskContract: contract, requestedTools: ["APPLY_PATCH"] }),
    ).toBe(true);
  });

  it("injects when requestedTools contains process", () => {
    const contract = makeContract();
    expect(
      shouldInjectWorkspaceContext({ taskContract: contract, requestedTools: ["process"] }),
    ).toBe(true);
  });

  it("injects when requestedTools contains bootstrap", () => {
    const contract = makeContract();
    expect(
      shouldInjectWorkspaceContext({ taskContract: contract, requestedTools: ["bootstrap"] }),
    ).toBe(true);
  });

  it("injects when requiredCapabilities contains needs_workspace_mutation", () => {
    const contract = makeContract({
      requiredCapabilities: ["needs_workspace_mutation"],
    });
    expect(shouldInjectWorkspaceContext({ taskContract: contract })).toBe(true);
  });

  it("injects when requiredCapabilities contains needs_repo_execution", () => {
    const contract = makeContract({
      requiredCapabilities: ["needs_repo_execution"],
    });
    expect(shouldInjectWorkspaceContext({ taskContract: contract })).toBe(true);
  });

  it("injects when requiredCapabilities contains needs_local_runtime", () => {
    const contract = makeContract({
      requiredCapabilities: ["needs_local_runtime"],
    });
    expect(shouldInjectWorkspaceContext({ taskContract: contract })).toBe(true);
  });

  it("does NOT inject for clarification_needed", () => {
    const contract = makeContract({
      primaryOutcome: "clarification_needed",
      interactionMode: "clarify_first",
      ambiguities: ["unclear"],
      deliverable: { kind: "answer", acceptedFormats: ["text"] },
    });
    expect(
      shouldInjectWorkspaceContext({ taskContract: contract, requestedTools: [] }),
    ).toBe(false);
  });

  it("does NOT inject for plain answer / respond_only", () => {
    const contract = makeContract({
      deliverable: { kind: "answer", acceptedFormats: ["text"] },
    });
    expect(
      shouldInjectWorkspaceContext({ taskContract: contract, requestedTools: [] }),
    ).toBe(false);
  });

  it("does NOT inject for pure image generation (visual artifact)", () => {
    const contract = makeContract({
      primaryOutcome: "document_package",
      interactionMode: "artifact_iteration",
      requiredCapabilities: ["needs_visual_composition"],
      deliverable: { kind: "image", acceptedFormats: ["png", "jpg"] },
    });
    expect(
      shouldInjectWorkspaceContext({
        taskContract: contract,
        requestedTools: ["image_generate"],
      }),
    ).toBe(false);
  });

  it("does NOT inject for pure web_search lookup (no workspace touch)", () => {
    const contract = makeContract({
      primaryOutcome: "comparison_report",
      interactionMode: "tool_execution",
      requiredCapabilities: ["needs_web_research"],
      deliverable: { kind: "answer", acceptedFormats: ["text"] },
    });
    expect(
      shouldInjectWorkspaceContext({
        taskContract: contract,
        requestedTools: ["web_search"],
      }),
    ).toBe(false);
  });
});

describe("buildClassifiedExecutionDecisionInput identity injection on respond_only", () => {
  it("passes identityContext to the classifier even on a respond_only turn and skips the workspace second pass", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-decision-identity-"));
    const storePath = path.join(tempDir, "sessions.json");
    const transcriptPath = resolveSessionTranscriptPathInDir("session-identity-only", tempDir);
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        id: "msg-1",
        message: { role: "user", content: "Привет!" },
      })}\n`,
      "utf8",
    );

    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            taskClassifier: { backend: "stub-backend" },
          },
        },
      },
    } as OpenClawConfig;

    const classify = vi.fn().mockResolvedValue({
      primaryOutcome: "answer",
      requiredCapabilities: [],
      interactionMode: "respond_only",
      confidence: 0.9,
      ambiguities: [],
    });

    await buildClassifiedExecutionDecisionInput({
      prompt: "Просто поздоровайся одной короткой фразой.",
      storePath,
      sessionEntry: {
        sessionId: "session-identity-only",
        sessionFile: "session-identity-only.jsonl",
      },
      channelHints: { messageChannel: "telegram" },
      cfg,
      adapterRegistry: {
        "stub-backend": { classify },
      },
    });

    // Identity is unconditional; workspace must NOT trigger a second pass for respond_only.
    expect(classify).toHaveBeenCalledTimes(1);
    const call = classify.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(typeof call.identityContext === "string" && call.identityContext.length > 0).toBe(true);
    expect(call.workspaceContext ?? "").toBe("");
  });
});
