import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSessionTranscriptPathInDir } from "../../config/sessions/paths.js";
import { planExecutionRecipe } from "../recipe/planner.js";
import { adaptExecutionPlanToRuntime } from "../recipe/runtime-adapter.js";
import {
  buildExecutionDecisionInput,
  buildExecutionDecisionInputFromRuntimePlan,
  buildSessionBackedExecutionDecisionInput,
  shouldUseLightweightBootstrapContext,
} from "./input.js";
import { resolveResolutionContract } from "./resolution-contract.js";

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

    expect(routed.intent).toBe("general");
    expect(routed.requestedTools ?? []).toEqual([]);
    expect(routed.artifactKinds ?? []).toEqual([]);
    expect(routed.routing?.localEligible).toBe(true);
    expect(routed.routing?.remoteProfile).toBe("cheap");
  });
});

describe("buildExecutionDecisionInputFromRuntimePlan", () => {
  it("keeps structured signals when the live prompt no longer matches the original heuristics", () => {
    const plannerInput = {
      prompt: "Parse this PDF estimate into a report",
      fileNames: ["estimate.pdf"],
      artifactKinds: ["document", "report"],
      intent: "document" as const,
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
    const plannerInput = {
      prompt: "Parse this PDF estimate into a report",
      fileNames: ["estimate.pdf"],
      artifactKinds: ["document", "report"],
      intent: "document" as const,
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
  it("builds a resolution contract for prompt-only pdf authoring", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Create a two-page PDF infographic about a city cat with a couple of generated images.",
    });

    expect(input.resolutionContract).toEqual(
      expect.objectContaining({
        selectedFamily: "document_render",
        candidateFamilies: expect.arrayContaining(["document_render"]),
        toolBundles: expect.arrayContaining(["artifact_authoring"]),
        routing: expect.objectContaining({
          remoteProfile: "presentation",
          preferRemoteFirst: true,
        }),
      }),
    );
    expect(input.routing).toEqual(input.resolutionContract?.routing);
  });

  it("builds a resolution contract for browser observation work", () => {
    const qualification = buildExecutionDecisionInput({
      prompt: "Open https://example.com in the browser and tell me the page title.",
    });

    expect(qualification.resolutionContract).toEqual(
      expect.objectContaining({
        candidateFamilies: expect.arrayContaining(["general_assistant"]),
        toolBundles: expect.arrayContaining(["interactive_browser"]),
        routing: expect.objectContaining({
          remoteProfile: "strong",
          preferRemoteFirst: true,
          localEligible: false,
        }),
      }),
    );
  });

  it("infers document intent and artifact kinds for pdf-style prompts", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Create a PDF report with a short summary for the customer.",
    });

    expect(input.intent).toBe("document");
    expect(input.artifactKinds).toEqual(["document", "report"]);
    expect(input.outcomeContract).toBe("structured_artifact");
    expect(input.executionContract).toEqual(
      expect.objectContaining({
        requiresArtifactEvidence: true,
        requiresTools: true,
      }),
    );
    expect(input.requestedEvidence).toEqual([
      "tool_receipt",
      "artifact_descriptor",
      "capability_receipt",
    ]);
    expect(input.confidence).toBe("high");
    expect(input.ambiguityReasons).toEqual([]);
    expect(input.lowConfidenceStrategy).toBeUndefined();
  });

  it("keeps prompt-only pdf plus supporting images as a high-confidence document turn", () => {
    const input = buildExecutionDecisionInput({
      prompt:
        "Надо сделать pdf файл, с инфографикой о жизни городского котика, это просто прикол, но надо пару страниц, красивый формат, можно добавить пару картинок.",
    });

    expect(input.intent).toBe("document");
    expect(input.artifactKinds ?? []).toEqual(expect.arrayContaining(["document", "image"]));
    expect(input.requestedTools ?? []).toEqual(expect.arrayContaining(["pdf", "image_generate"]));
    expect(input.confidence).toBe("high");
    expect(input.ambiguityReasons).toEqual([]);
    expect(input.lowConfidenceStrategy).toBeUndefined();
  });

  it("infers site artifact kinds and code intent for website prompts", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Сделай простой сайт на Vue, localhost на 5173",
    });

    expect(input.intent).toBe("code");
    expect(input.artifactKinds ?? []).toEqual(expect.arrayContaining(["site"]));
    expect(input.outcomeContract).toBe("interactive_local_result");
    expect(input.executionContract).toEqual(
      expect.objectContaining({
        requiresWorkspaceMutation: true,
        requiresLocalProcess: true,
      }),
    );
    expect(input.requestedEvidence).toEqual(["tool_receipt", "process_receipt", "capability_receipt"]);
    expect(input.requestedTools ?? []).toEqual(
      expect.arrayContaining(["exec", "apply_patch", "process"]),
    );
    expect(input.confidence).toBe("high");
    expect(input.ambiguityReasons).toEqual([]);
    expect(input.lowConfidenceStrategy).toBeUndefined();
  });

  it("routes underspecified publish requests into explicit clarification instead of forced execution", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Ship it.",
    });

    expect(input.intent).toBe("publish");
    expect(input.confidence).toBe("medium");
    expect(input.ambiguityReasons).toEqual([
      "external operation is inferred without an explicit publish target",
    ]);
    expect(input.lowConfidenceStrategy).toBe("clarify");
    expect(input.outcomeContract).toBe("external_operation");
    expect(input.requestedEvidence).toEqual(["tool_receipt", "capability_receipt"]);
    expect(input.candidateFamilies).toEqual(["ops_execution"]);
    expect(input.requestedTools ?? []).toEqual(["exec", "apply_patch", "process"]);
  });

  it.each([
    "Сделай простой сайт на Vue, localhost на 5173",
    "Собери локальный Vite preview для простого сайта и запусти его на localhost",
  ])("keeps interactive-local-result paraphrases on the same contract: %s", (prompt) => {
    const input = buildExecutionDecisionInput({ prompt });

    expect(input.outcomeContract).toBe("interactive_local_result");
    expect(input.confidence).toBe("high");
    expect(input.lowConfidenceStrategy).toBeUndefined();
  });

  it.each([
    "Create a PDF report with a short summary for the customer.",
    "Assemble a one-page PDF summary for the customer with the same report content.",
  ])("keeps structured-artifact paraphrases on the same contract: %s", (prompt) => {
    const input = buildExecutionDecisionInput({ prompt });

    expect(input.outcomeContract).toBe("structured_artifact");
    expect(input.confidence).toBe("high");
    expect(input.lowConfidenceStrategy).toBeUndefined();
  });

  it("infers image artifact kinds for media-generation prompts", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Generate an image banner with the text Stage 86 OK.",
    });

    expect(input.intent).toBeUndefined();
    expect(input.artifactKinds).toEqual(["image"]);
    expect(input.requestedTools).toEqual(["image_generate"]);
  });

  it("does not misclassify image generation prompts as publish work when image text mentions release", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Generate a PNG banner with the text Atlas Release Ready and return the image.",
    });

    expect(input.intent).toBeUndefined();
    expect(input.artifactKinds).toEqual(["image"]);
    expect(input.requestedTools).toEqual(["image_generate"]);
  });

  it("infers artifact kinds from Russian media and document prompts", () => {
    const imageInput = buildExecutionDecisionInput({
      prompt: "Сгенерируй изображение баннера с текстом Stage 86 OK.",
    });
    const pdfInput = buildExecutionDecisionInput({
      prompt: "Создай PDF-отчёт с краткой сводкой результатов теста.",
    });

    expect(imageInput.artifactKinds).toEqual(["image"]);
    expect(imageInput.requestedTools).toEqual(["image_generate"]);
    expect(pdfInput.intent).toBe("document");
    expect(pdfInput.artifactKinds).toEqual(["document"]);
    expect(pdfInput.requestedTools).toEqual(["pdf"]);
  });

  it("infers both image and document artifacts for Russian media plus пдф requests", () => {
    const input = buildExecutionDecisionInput({
      prompt:
        "Можешь сгенерировать картинку котёнка и создать файл пдф с его расписанием и жизнью, в графиках и таблицах?",
    });

    expect(input.artifactKinds).toEqual(expect.arrayContaining(["image", "document"]));
    expect(input.requestedTools).toEqual(expect.arrayContaining(["image_generate", "pdf"]));
  });

  it.each([
    {
      name: "explicit mixed artifacts without generation verbs",
      params: {
        prompt: "kitten life layout in pdf with charts and tables",
        artifactKinds: ["image", "document"] as const,
      },
      expectedTools: ["image_generate", "pdf"],
    },
    {
      name: "pdf artifact inferred from target filename",
      params: {
        prompt: "Customer summary for April",
        fileNames: ["april-summary.pdf"],
        artifactKinds: ["document"] as const,
      },
      expectedTools: ["pdf"],
    },
    {
      name: "mixed artifacts inferred from filename target and image artifact",
      params: {
        prompt: "Kitten schedule and life overview",
        fileNames: ["kitten-life.pdf"],
        artifactKinds: ["image", "document"] as const,
      },
      expectedTools: ["image_generate", "pdf"],
    },
  ])("derives requested tools from artifact requirements: $name", ({ params, expectedTools }) => {
    const input = buildExecutionDecisionInput({
      prompt: params.prompt,
      fileNames: params.fileNames ? [...params.fileNames] : undefined,
      artifactKinds: [...params.artifactKinds],
    });

    expect(input.requestedTools).toEqual(expect.arrayContaining(expectedTools));
  });

  it("infers both image and pdf tools for infographic presentation requests", () => {
    const input = buildExecutionDecisionInput({
      prompt:
        "Сделай презентационную инфографику с веселым бананом и собери итог в PDF на 3 страницы.",
    });

    expect(input.artifactKinds).toEqual(expect.arrayContaining(["document", "image"]));
    expect(input.requestedTools).toEqual(expect.arrayContaining(["image_generate", "pdf"]));
  });

  it("keeps PDF generation prompts on the document path even when they mention tests", () => {
    const input = buildExecutionDecisionInput({
      prompt:
        "Создай PDF-отчёт с краткой сводкой результатов теста и заголовком Stage 86 PDF Test.",
    });

    expect(input.intent).toBe("document");
    expect(input.artifactKinds).toEqual(["document"]);
  });

  it("keeps PDF generation prompts on the document path even when prior context mentions publish work", () => {
    const input = buildExecutionDecisionInput({
      prompt:
        "Build the app, publish the release, and ship the preview.\n\nСоздай PDF с презентацией о жизни котика.",
    });

    expect(input.intent).toBe("document");
    expect(input.requestedTools ?? []).toEqual(["pdf"]);
    expect(input.artifactKinds).toEqual(["document"]);
  });

  it("does not force ordinary summary requests onto the document path", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Сильно сожми этот раздутый запрос и дай краткую сводку по статусу stage 86.",
    });

    expect(input.intent).toBeUndefined();
    expect(input.artifactKinds ?? []).toEqual([]);
  });

  it("infers general intent for Russian greeting prompts without attachments", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Привет! Как дела? Просто поздоровайся.",
    });

    expect(input.intent).toBe("general");
    expect(input.artifactKinds ?? []).toEqual([]);
  });

  it("infers compare intent and tabular artifacts for English comparison prompts", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Compare vendor_prices.csv and internal_prices.csv for price drift by SKU.",
    });

    expect(input.intent).toBe("compare");
    expect(input.artifactKinds).toEqual(expect.arrayContaining(["data", "report"]));
  });

  it("infers compare intent from two tabular attachments even with a short prompt", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Please analyze.",
      fileNames: ["sheet_a.csv", "sheet_b.csv"],
    });

    expect(input.intent).toBe("compare");
    expect(input.artifactKinds).toEqual(expect.arrayContaining(["data", "report"]));
  });

  it("infers calculation intent for Russian engineering-style prompts without document artifact noise", () => {
    const input = buildExecutionDecisionInput({
      prompt:
        "Нужен расчёт вентиляции для кабинета 20 м²: приток и вытяжка, итог в кратком отчёте.",
    });

    expect(input.intent).toBe("calculation");
    expect(input.artifactKinds).toEqual(expect.arrayContaining(["report", "data"]));
    expect(input.artifactKinds).not.toContain("document");
  });

  it("infers calculation intent for English dimensional prompts", () => {
    const input = buildExecutionDecisionInput({
      prompt:
        "Run a quick square feet to square meters conversion table for the listed room sizes.",
    });

    expect(input.intent).toBe("calculation");
  });

  it("infers code intent for Russian bugfix prompts", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Исправь фейлящий e2e тест, предложи план правки и укажи какие проверки прогнать.",
    });

    expect(input.intent).toBe("code");
    expect(input.artifactKinds).toContain("binary");
  });

  it("does not misread pnpm as an npm publish target", () => {
    const input = buildExecutionDecisionInput({
      prompt: "refactor the repo to use pnpm workspaces",
    });

    expect(input.intent).toBe("code");
    expect(input.publishTargets ?? []).toEqual([]);
    expect(input.artifactKinds).toEqual(["binary"]);
  });

  it("marks browser navigation prompts with the browser tool", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Открой в браузере https://example.com и скажи заголовок страницы.",
    });

    expect(input.requestedTools).toEqual(["browser"]);
  });

  it("marks casual chat prompts as lightweight bootstrap candidates", () => {
    const input = buildExecutionDecisionInput({
      prompt: "Привет! Как дела?",
    });

    expect(shouldUseLightweightBootstrapContext(input)).toBe(true);
  });
});

describe("resolveResolutionContract", () => {
  it("maps code execution requirements to code-build routing", () => {
    const resolution = resolveResolutionContract({
      prompt: "Fix the failing build and run the checks.",
      intent: "code",
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
