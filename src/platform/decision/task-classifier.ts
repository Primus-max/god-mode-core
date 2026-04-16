import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import { z } from "zod";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { parseModelRef } from "../../agents/model-selection.js";
import { resolveModelAsync } from "../../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../../agents/simple-completion-transport.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { BuildExecutionDecisionInputParams } from "./input.js";
import { inferRequestedEvidence } from "./execution-contract.js";
import {
  resolveResolutionContract,
  toRecipeRoutingHints,
  type ResolutionBridgePlannerInput,
  type ResolutionContract,
} from "./resolution-contract.js";
import type { CandidateExecutionFamily } from "./qualification-contract.js";
import type {
  QualificationConfidence,
  QualificationLowConfidenceStrategy,
} from "./qualification-contract.js";
import type { RecipePlannerInput } from "../recipe/planner.js";

const log = createSubsystemLogger("task-classifier");

export const DEFAULT_TASK_CLASSIFIER_BACKEND = "pi-simple";
export const DEFAULT_TASK_CLASSIFIER_MODEL = "hydra/gpt-5-mini";
export const DEFAULT_TASK_CLASSIFIER_TIMEOUT_MS = 20_000;
export const DEFAULT_TASK_CLASSIFIER_MAX_TOKENS = 450;
const FAIL_CLOSED_REASON = "task classifier unavailable";

const TASK_CONTRACT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://openclaw.dev/runtime/task-contract.schema.json",
  title: "TaskContract",
  type: "object",
  additionalProperties: false,
  required: [
    "primaryOutcome",
    "requiredCapabilities",
    "interactionMode",
    "confidence",
    "ambiguities",
  ],
  properties: {
    primaryOutcome: {
      type: "string",
      enum: [
        "answer",
        "workspace_change",
        "external_delivery",
        "comparison_report",
        "calculation_result",
        "document_package",
        "document_extraction",
        "clarification_needed",
      ],
    },
    requiredCapabilities: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "needs_visual_composition",
          "needs_multimodal_authoring",
          "needs_repo_execution",
          "needs_document_extraction",
          "needs_local_runtime",
          "needs_interactive_browser",
          "needs_high_reliability_provider",
          "needs_workspace_mutation",
          "needs_external_delivery",
          "needs_tabular_reasoning",
          "needs_web_research",
        ],
      },
      uniqueItems: true,
    },
    interactionMode: {
      type: "string",
      enum: ["respond_only", "clarify_first", "tool_execution", "artifact_iteration"],
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    ambiguities: {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
      },
      uniqueItems: true,
    },
  },
} as const;

const TASK_CLASSIFIER_SYSTEM_PROMPT =
  "You are a deterministic TaskContract classifier. Classify only. Do not execute, refuse, explain, chat, or ask for access. Return exactly one minified JSON object and nothing else.";

const TASK_CLASSIFIER_USER_TEMPLATE = `Return exactly one minified JSON object matching this JSON Schema:
{{SCHEMA_JSON}}

Rules:
- Use only schema keys.
- Return valid JSON syntax only. No markdown. No prose. No code fences.
- Keep requiredCapabilities minimal. Prefer omission over invention.
- Do not infer tools, vendors, providers, products, frameworks, hosts, or brand names as capabilities.
- Normalize Russian and English wording to the same abstract contract.

Decision ladder:
1. Pick exactly one dominant primaryOutcome:
   - answer: direct text reply, summarization, rewrite, explanation, brainstorm.
   - workspace_change: edit repository, source files, config, tests, scripts, or local project state.
   - external_delivery: deploy, publish, release, ship, send, or deliver to an external system/environment.
   - comparison_report: compare, inspect, audit, evaluate, research, review, or summarize options/findings.
   - calculation_result: arithmetic, estimation, or numeric/tabular calculation where the result is mainly the calculation.
   - document_package: create an authored artifact such as PDF, deck, report, infographic, poster, image, or other deliverable asset.
   - document_extraction: extract fields/content from supplied files.
   - clarification_needed: only when the dominant outcome is materially unclear, or when the user asks to fix/change something and then send it to production without clear approval.
2. Pick the lightest valid interactionMode:
   - respond_only: text-only answer without external inspection or tool-dependent execution.
   - tool_execution: browser, web research, extraction, repo execution, or delivery is needed.
   - artifact_iteration: the main result is an authored artifact.
   - clarify_first: use only with primaryOutcome "clarification_needed".
3. Add only capabilities that are explicitly required by the task:
   - needs_workspace_mutation: only for editing repo/workspace contents.
   - needs_repo_execution: run checks, tests, builds, scripts, or validation.
   - needs_local_runtime: local runtime/process is explicitly requested or obviously required by the wording.
   - needs_document_extraction: extract from supplied docs/images/PDFs.
   - needs_interactive_browser: inspect/click/smoke-test/compare live pages in browser.
   - needs_web_research: latest public facts/pricing/news/web lookup.
   - needs_tabular_reasoning: structured table/spreadsheet comparison or numeric reasoning is central.
   - needs_visual_composition: image/poster/banner/illustration or strong visual layout is the primary artifact.
   - needs_multimodal_authoring: authored document/deck/PDF/infographic from mixed materials, notes, tables, or images.
   - needs_external_delivery: explicit deploy/publish/send external.
   - needs_high_reliability_provider: only for production/live external delivery.

Canonical mapping rules:
- Attached files alone do not imply document_extraction, multimodal_authoring, or tool_execution.
- Browser inspection and public web research are different:
  - live page interaction/audit/smoke/compare -> needs_interactive_browser
  - latest public info/pricing/facts -> needs_web_research
- Browser observation tasks are observational: usually comparison_report, not workspace_change.
- Opening or inspecting a local app in browser does not by itself imply needs_repo_execution or needs_local_runtime.
- Pure compare/summarize/calculate without live browsing or public research should prefer respond_only.
- For comparison_report or calculation_result, prefer respond_only unless browser interaction, public web research, repo execution, local runtime, external delivery, or workspace mutation is explicitly required.
- Pure summarization/rewriting of provided text should prefer answer with no capabilities.
- Code change requests imply workspace_change and needs_workspace_mutation.
- Add needs_repo_execution only when the user also wants checks/tests/builds/scripts/validation.
- Requests to leave something running locally, passing locally, validated locally, or previewable locally imply needs_local_runtime.
- Do not infer needs_workspace_mutation for document/image creation.
- Visual or image generation requests should usually be document_package + artifact_iteration + needs_visual_composition.
- PDF/deck/report/infographic authoring from notes or mixed inputs should usually be document_package + artifact_iteration + needs_multimodal_authoring.
- Extraction from supplied files should usually be document_extraction + tool_execution + needs_document_extraction.
- Field extraction from docs/forms/invoices should not add needs_tabular_reasoning unless table/spreadsheet comparison or numeric reasoning is central.
- Spreadsheet/table attachments used only for comparison do not imply needs_document_extraction.
- Deploy/publish/release requests should usually be external_delivery + tool_execution + needs_external_delivery.
- Release validation of an already-prepared build is not workspace mutation.
- Add needs_high_reliability_provider only for production/live external delivery.
- Explicit production/live publish or deploy of an already-prepared build should usually be external_delivery + tool_execution + needs_external_delivery + needs_repo_execution + needs_local_runtime + needs_high_reliability_provider, without needs_workspace_mutation unless source edits are explicitly requested.
- Do not add ambiguities for credentials, permissions, URLs, runtime access, browser matrix, page count, branding, tone, template, filenames, or delivery formatting when the dominant outcome is still clear.

Stability examples:
- "Extract fields from attached invoice PDF" -> document_extraction + tool_execution + needs_document_extraction
- "Compare attached pricing spreadsheets" -> comparison_report + respond_only + needs_tabular_reasoning
- "Fix the repo, run checks, leave local validation passing" -> workspace_change + tool_execution + needs_workspace_mutation + needs_repo_execution + needs_local_runtime
- "Open the local app in browser and report issues" -> comparison_report + tool_execution + needs_interactive_browser
- "Run release checks and publish the already-prepared build to production" -> external_delivery + tool_execution + needs_external_delivery + needs_repo_execution + needs_local_runtime + needs_high_reliability_provider

Output contract:
- confidence must be between 0 and 1.
- ambiguities should be an empty array unless the dominant outcome is genuinely unclear.
- Return exactly one minified JSON object and nothing else.

Attachment file names:
{{ATTACHMENT_FILE_NAMES}}

User request:
{{USER_REQUEST}}`;

type PrimaryOutcome =
  | "answer"
  | "workspace_change"
  | "external_delivery"
  | "comparison_report"
  | "calculation_result"
  | "document_package"
  | "document_extraction"
  | "clarification_needed";

type Capability =
  | "needs_visual_composition"
  | "needs_multimodal_authoring"
  | "needs_repo_execution"
  | "needs_document_extraction"
  | "needs_local_runtime"
  | "needs_interactive_browser"
  | "needs_high_reliability_provider"
  | "needs_workspace_mutation"
  | "needs_external_delivery"
  | "needs_tabular_reasoning"
  | "needs_web_research";

type InteractionMode = "respond_only" | "clarify_first" | "tool_execution" | "artifact_iteration";

const TaskContractZodSchema = z
  .object({
    primaryOutcome: z.enum([
      "answer",
      "workspace_change",
      "external_delivery",
      "comparison_report",
      "calculation_result",
      "document_package",
      "document_extraction",
      "clarification_needed",
    ]),
    requiredCapabilities: z
      .array(
        z.enum([
          "needs_visual_composition",
          "needs_multimodal_authoring",
          "needs_repo_execution",
          "needs_document_extraction",
          "needs_local_runtime",
          "needs_interactive_browser",
          "needs_high_reliability_provider",
          "needs_workspace_mutation",
          "needs_external_delivery",
          "needs_tabular_reasoning",
          "needs_web_research",
        ]),
      )
      .superRefine((values, ctx) => {
        if (new Set(values).size !== values.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "requiredCapabilities must contain unique items",
          });
        }
      }),
    interactionMode: z.enum(["respond_only", "clarify_first", "tool_execution", "artifact_iteration"]),
    confidence: z.number().min(0).max(1),
    ambiguities: z
      .array(z.string().min(1))
      .superRefine((values, ctx) => {
        if (new Set(values).size !== values.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "ambiguities must contain unique items",
          });
        }
      }),
  })
  .strict();

export type TaskContract = {
  primaryOutcome: PrimaryOutcome;
  requiredCapabilities: Capability[];
  interactionMode: InteractionMode;
  confidence: number;
  ambiguities: string[];
};

export type TaskClassifierDebugEvent = {
  stage:
    | "model_unresolved"
    | "raw_response"
    | "fallback"
    | "disabled"
    | "unknown_backend";
  backend: string;
  configuredModel: string;
  provider?: string;
  modelId?: string;
  rawText?: string;
  normalizedCandidate?: string;
  parseResult?: "ok" | "empty" | "json_parse_failed" | "schema_invalid";
  parseErrorMessage?: string;
  message?: string;
};

export type ClassifiedTaskResolution = {
  source: "llm" | "fail_closed";
  taskContract: TaskContract;
  plannerInput: RecipePlannerInput;
  resolutionContract: ResolutionContract;
  candidateFamilies: CandidateExecutionFamily[];
};

export type TaskClassifierAdapter = {
  classify(params: {
    prompt: string;
    fileNames: string[];
    config: ResolvedTaskClassifierConfig;
    cfg: OpenClawConfig;
    agentDir?: string;
    onDebugEvent?: (event: TaskClassifierDebugEvent) => void;
  }): Promise<TaskContract | null>;
};

export type ResolvedTaskClassifierConfig = {
  enabled: boolean;
  backend: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
};

function normalizeUnique<T extends string>(values: readonly T[]): T[] {
  return Array.from(new Set(values)).toSorted();
}

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

function emitDebugEvent(
  callback: ((event: TaskClassifierDebugEvent) => void) | undefined,
  event: TaskClassifierDebugEvent,
): void {
  try {
    callback?.(event);
  } catch {
    // Debug hooks must never interfere with classifier execution.
  }
}

function normalizeTaskContractJsonCandidate(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim();
}

function normalizePromptForHeuristics(prompt: string): string {
  return prompt.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasAnyPhrase(prompt: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => prompt.includes(phrase));
}

function resolveDeterministicTaskContract(prompt: string): TaskContract | null {
  const normalized = normalizePromptForHeuristics(prompt);
  if (!normalized) {
    return null;
  }

  const createVerbs = [
    "generate",
    "create",
    "make",
    "draw",
    "render",
    "сгенерируй",
    "сделай",
    "создай",
    "нарисуй",
  ] as const;
  const extractionVerbs = [
    "extract",
    "parse",
    "ocr",
    "read from",
    "pull from",
    "извлеки",
    "распознай",
    "вытащи",
    "прочитай из",
  ] as const;
  const imageNouns = [
    "image",
    "picture",
    "illustration",
    "poster",
    "banner",
    "photo",
    "artwork",
    "avatar",
    "icon",
    "картинк",
    "изображен",
    "иллюстрац",
    "постер",
    "баннер",
    "иконк",
    "аватар",
    "арт",
  ] as const;
  const pdfNouns = [
    "pdf",
    "deck",
    "slide deck",
    "slides",
    "report",
    "brochure",
    "infographic",
    "презентац",
    "слайды",
    "отч",
    "брошюр",
    "инфографик",
  ] as const;

  const mentionsCreation = hasAnyPhrase(normalized, createVerbs);
  const mentionsExtraction = hasAnyPhrase(normalized, extractionVerbs);
  const wantsImageArtifact =
    mentionsCreation &&
    hasAnyPhrase(normalized, imageNouns) &&
    !normalized.includes("pdf") &&
    !mentionsExtraction;
  if (wantsImageArtifact) {
    return {
      primaryOutcome: "document_package",
      requiredCapabilities: ["needs_visual_composition"],
      interactionMode: "artifact_iteration",
      confidence: 0.97,
      ambiguities: [],
    };
  }

  const wantsPdfArtifact =
    mentionsCreation && normalized.includes("pdf") && !mentionsExtraction;
  const wantsOtherDocumentArtifact =
    mentionsCreation &&
    hasAnyPhrase(normalized, pdfNouns) &&
    !hasAnyPhrase(normalized, imageNouns) &&
    !mentionsExtraction;
  if (wantsPdfArtifact || wantsOtherDocumentArtifact) {
    return {
      primaryOutcome: "document_package",
      requiredCapabilities: ["needs_multimodal_authoring"],
      interactionMode: "artifact_iteration",
      confidence: 0.97,
      ambiguities: [],
    };
  }

  return null;
}

function extractJsonObjectCandidate(raw: string): string | null {
  const normalized = normalizeTaskContractJsonCandidate(raw);
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("{") && normalized.endsWith("}")) {
    return normalized;
  }
  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  return normalized.slice(firstBrace, lastBrace + 1).trim();
}

function safeParseTaskContract(raw: string): {
  taskContract: TaskContract | null;
  parseResult: "ok" | "empty" | "json_parse_failed" | "schema_invalid";
  normalizedCandidate?: string;
  parseErrorMessage?: string;
} {
  const candidate = extractJsonObjectCandidate(raw);
  if (!candidate) {
    return { taskContract: null, parseResult: "empty" };
  }
  try {
    const parsed = JSON.parse(candidate) as TaskContract;
    const validation = TaskContractZodSchema.safeParse(parsed);
    return validation.success
      ? { taskContract: validation.data, parseResult: "ok", normalizedCandidate: candidate }
      : { taskContract: null, parseResult: "schema_invalid", normalizedCandidate: candidate };
  } catch (error) {
    return {
      taskContract: null,
      parseResult: "json_parse_failed",
      normalizedCandidate: candidate,
      parseErrorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function clampConfidence(confidence: number): number {
  return Math.min(1, Math.max(0, confidence));
}

function normalizeTaskContract(contract: TaskContract): TaskContract {
  const capabilities = new Set(contract.requiredCapabilities);
  let primaryOutcome = contract.primaryOutcome;
  let interactionMode = contract.interactionMode;
  if (primaryOutcome === "clarification_needed") {
    interactionMode = "clarify_first";
  } else if (interactionMode === "clarify_first") {
    primaryOutcome = "clarification_needed";
  }

  if (primaryOutcome === "document_package") {
    interactionMode = "artifact_iteration";
    capabilities.delete("needs_document_extraction");
  }

  if (primaryOutcome === "document_extraction") {
    interactionMode = "tool_execution";
    capabilities.add("needs_document_extraction");
    capabilities.delete("needs_tabular_reasoning");
    capabilities.delete("needs_multimodal_authoring");
    capabilities.delete("needs_visual_composition");
  }

  if (capabilities.has("needs_workspace_mutation") && primaryOutcome !== "external_delivery") {
    primaryOutcome = "workspace_change";
    interactionMode = "tool_execution";
  }

  if (primaryOutcome === "workspace_change") {
    capabilities.add("needs_workspace_mutation");
    interactionMode = "tool_execution";
  }

  if (capabilities.has("needs_interactive_browser")) {
    interactionMode = "tool_execution";
    if (primaryOutcome === "comparison_report") {
      capabilities.delete("needs_local_runtime");
      capabilities.delete("needs_repo_execution");
    }
    if (primaryOutcome === "answer") {
      primaryOutcome = "comparison_report";
    }
  }
  if (capabilities.has("needs_web_research")) {
    interactionMode = "tool_execution";
    capabilities.delete("needs_tabular_reasoning");
    if (primaryOutcome === "answer") {
      primaryOutcome = "comparison_report";
    }
  }

  if (primaryOutcome !== "external_delivery") {
    capabilities.delete("needs_external_delivery");
    capabilities.delete("needs_high_reliability_provider");
  }
  if (primaryOutcome === "external_delivery") {
    capabilities.delete("needs_workspace_mutation");
    capabilities.add("needs_external_delivery");
    if (capabilities.has("needs_local_runtime")) {
      capabilities.add("needs_high_reliability_provider");
    }
    interactionMode = "tool_execution";
  }

  if (
    (primaryOutcome === "comparison_report" || primaryOutcome === "calculation_result") &&
    !capabilities.has("needs_interactive_browser") &&
    !capabilities.has("needs_web_research") &&
    !capabilities.has("needs_repo_execution") &&
    !capabilities.has("needs_local_runtime") &&
    !capabilities.has("needs_external_delivery") &&
    !capabilities.has("needs_workspace_mutation")
  ) {
    interactionMode = "respond_only";
  }

  return {
    ...contract,
    primaryOutcome,
    interactionMode,
    requiredCapabilities: normalizeUnique(Array.from(capabilities)),
    confidence: clampConfidence(contract.confidence),
    ambiguities: normalizeUnique(contract.ambiguities),
  };
}

function buildFailClosedTaskContract(reason: string): TaskContract {
  return {
    primaryOutcome: "clarification_needed",
    requiredCapabilities: [],
    interactionMode: "clarify_first",
    confidence: 0,
    ambiguities: [reason],
  };
}

function taskContractConfidenceToQualification(confidence: number): QualificationConfidence {
  if (confidence >= 0.8) {
    return "high";
  }
  if (confidence >= 0.55) {
    return "medium";
  }
  return "low";
}

function taskContractLowConfidenceStrategy(
  contract: TaskContract,
): QualificationLowConfidenceStrategy | undefined {
  if (
    contract.primaryOutcome === "clarification_needed" ||
    contract.interactionMode === "clarify_first"
  ) {
    return "clarify";
  }
  return undefined;
}

function mapTaskContractToBridge(contract: TaskContract): ResolutionBridgePlannerInput {
  const capabilities = new Set(contract.requiredCapabilities);
  const hasVisualComposition = capabilities.has("needs_visual_composition");
  const hasMultimodalAuthoring = capabilities.has("needs_multimodal_authoring");
  const isPureVisualArtifact =
    contract.primaryOutcome === "document_package" &&
    hasVisualComposition &&
    !hasMultimodalAuthoring;
  const artifactKinds: ("document" | "estimate" | "site" | "release" | "binary" | "report" | "video" | "image" | "audio" | "archive" | "data" | "other")[] = [];
  const requestedTools: string[] = [];
  let intent: ResolutionBridgePlannerInput["intent"];

  switch (contract.primaryOutcome) {
    case "workspace_change":
      intent = "code";
      artifactKinds.push("binary");
      break;
    case "external_delivery":
      intent = "publish";
      artifactKinds.push("release");
      break;
    case "comparison_report":
      intent = "compare";
      artifactKinds.push("data", "report");
      break;
    case "calculation_result":
      intent = "calculation";
      artifactKinds.push("data", "report");
      break;
    case "document_package":
      if (!isPureVisualArtifact) {
        intent = "document";
        artifactKinds.push("document");
      }
      // For pure visual artifacts, intent remains undefined (no document intent needed)
      break;
    case "document_extraction":
      intent = "document";
      artifactKinds.push("document", "report");
      break;
    default:
      intent = "general";
      break;
  }

  if (hasVisualComposition) {
    artifactKinds.push("image");
  }
  if (hasMultimodalAuthoring) {
    artifactKinds.push("document", "image");
  }
  if (capabilities.has("needs_repo_execution")) {
    requestedTools.push("exec");
  }
  if (capabilities.has("needs_workspace_mutation")) {
    requestedTools.push("apply_patch");
  }
  if (capabilities.has("needs_local_runtime")) {
    requestedTools.push("process");
  }
  if (capabilities.has("needs_interactive_browser")) {
    requestedTools.push("browser");
  }
  if (capabilities.has("needs_web_research")) {
    requestedTools.push("web_search");
  }
  if (
    contract.primaryOutcome === "document_package" &&
    (!hasVisualComposition || hasMultimodalAuthoring)
  ) {
    requestedTools.push("pdf");
  }
  if (hasMultimodalAuthoring || hasVisualComposition) {
    requestedTools.push("image_generate");
  }

  const normalizedArtifactKinds = normalizeUnique(artifactKinds);
  const normalizedRequestedTools = normalizeUnique(requestedTools);
  const hasStructuredArtifact =
    normalizedArtifactKinds.includes("document") ||
    normalizedArtifactKinds.includes("estimate") ||
    normalizedArtifactKinds.includes("image") ||
    normalizedArtifactKinds.includes("video") ||
    normalizedArtifactKinds.includes("audio") ||
    normalizedArtifactKinds.includes("archive");
  const requiresTools =
    normalizedRequestedTools.length > 0 ||
    contract.interactionMode === "tool_execution" ||
    contract.interactionMode === "artifact_iteration";

  return {
    intent,
    artifactKinds: normalizedArtifactKinds,
    requestedTools: normalizedRequestedTools,
    publishTargets: capabilities.has("needs_external_delivery") ? ["external"] : [],
    outcomeContract:
      contract.primaryOutcome === "workspace_change"
        ? "workspace_change"
        : contract.primaryOutcome === "external_delivery"
          ? "external_operation"
          : normalizedArtifactKinds.includes("site")
            ? "interactive_local_result"
            : hasStructuredArtifact
              ? "structured_artifact"
          : contract.primaryOutcome === "comparison_report" ||
              contract.primaryOutcome === "calculation_result" ||
              contract.primaryOutcome === "answer" ||
              contract.primaryOutcome === "clarification_needed"
            ? "text_response"
            : "structured_artifact",
    executionContract: {
      requiresTools,
      requiresWorkspaceMutation: capabilities.has("needs_workspace_mutation"),
      requiresLocalProcess: capabilities.has("needs_local_runtime"),
      requiresArtifactEvidence:
        contract.primaryOutcome === "document_package" ||
        contract.primaryOutcome === "document_extraction",
      requiresDeliveryEvidence: capabilities.has("needs_external_delivery"),
      mayNeedBootstrap:
        capabilities.has("needs_repo_execution") ||
        capabilities.has("needs_document_extraction") ||
        capabilities.has("needs_local_runtime"),
    },
  };
}

export function buildPlannerInputFromTaskContract(params: {
  prompt: string;
  fileNames?: string[];
  taskContract: TaskContract;
}): RecipePlannerInput {
  const fileNames = Array.from(
    new Set(
      (params.fileNames ?? [])
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim()),
    ),
  );
  const bridge = mapTaskContractToBridge(params.taskContract);
  const resolutionContract = resolveResolutionContract({
    contractFirst: true,
    ...(fileNames.length > 0 ? { fileNames } : {}),
    ...bridge,
  });
  const ambiguityReasons = normalizeUnique(params.taskContract.ambiguities);
  const confidence = taskContractConfidenceToQualification(params.taskContract.confidence);
  const lowConfidenceStrategy = taskContractLowConfidenceStrategy(params.taskContract);
  return {
    prompt: params.prompt,
    contractFirst: true,
    ...(fileNames.length > 0 ? { fileNames } : {}),
    ...(bridge.intent ? { intent: bridge.intent } : {}),
    ...(bridge.artifactKinds?.length ? { artifactKinds: bridge.artifactKinds } : {}),
    ...(bridge.requestedTools?.length ? { requestedTools: bridge.requestedTools } : {}),
    ...(bridge.publishTargets?.length ? { publishTargets: bridge.publishTargets } : {}),
    outcomeContract: bridge.outcomeContract,
    executionContract: bridge.executionContract,
    requestedEvidence: inferRequestedEvidence(bridge.outcomeContract, bridge.executionContract),
    confidence,
    ...(ambiguityReasons.length > 0 ? { ambiguityReasons } : {}),
    ...(lowConfidenceStrategy ? { lowConfidenceStrategy } : {}),
    candidateFamilies: [...resolutionContract.candidateFamilies],
    resolutionContract,
    routing: toRecipeRoutingHints(resolutionContract),
  };
}

export function resolveTaskClassifierConfig(params: {
  cfg: OpenClawConfig;
}): ResolvedTaskClassifierConfig {
  const classifierConfig = params.cfg.agents?.defaults?.embeddedPi?.taskClassifier;
  return {
    enabled: classifierConfig?.enabled !== false,
    backend: classifierConfig?.backend?.trim() || DEFAULT_TASK_CLASSIFIER_BACKEND,
    model: classifierConfig?.model?.trim() || DEFAULT_TASK_CLASSIFIER_MODEL,
    timeoutMs: classifierConfig?.timeoutMs ?? DEFAULT_TASK_CLASSIFIER_TIMEOUT_MS,
    maxTokens: classifierConfig?.maxTokens ?? DEFAULT_TASK_CLASSIFIER_MAX_TOKENS,
  };
}

class PiTaskClassifierAdapter implements TaskClassifierAdapter {
  async classify(params: {
    prompt: string;
    fileNames: string[];
    config: ResolvedTaskClassifierConfig;
    cfg: OpenClawConfig;
    agentDir?: string;
    onDebugEvent?: (event: TaskClassifierDebugEvent) => void;
  }): Promise<TaskContract | null> {
    const modelRefRaw = params.config.model;
    const parsedRef = parseModelRef(modelRefRaw, "openai");
    if (!parsedRef) {
      return null;
    }
    const resolved = await resolveModelAsync(parsedRef.provider, parsedRef.model, params.agentDir, params.cfg);
    if (!resolved.model) {
      emitDebugEvent(params.onDebugEvent, {
        stage: "model_unresolved",
        backend: params.config.backend,
        configuredModel: params.config.model,
        provider: parsedRef.provider,
        modelId: parsedRef.model,
        message: resolved.error ?? "model could not be resolved",
      });
      return null;
    }
    const model = prepareModelForSimpleCompletion({ model: resolved.model, cfg: params.cfg });
    const auth = await getApiKeyForModel({ model, cfg: params.cfg, agentDir: params.agentDir });
    const apiKey = requireApiKey(auth, model.provider);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.config.timeoutMs);
    try {
      const prompt = TASK_CLASSIFIER_USER_TEMPLATE.replace(
        "{{SCHEMA_JSON}}",
        JSON.stringify(TASK_CONTRACT_SCHEMA),
      )
        .replace("{{ATTACHMENT_FILE_NAMES}}", JSON.stringify(params.fileNames))
        .replace("{{USER_REQUEST}}", params.prompt);
      const result = await completeSimple(
        model,
        {
          systemPrompt: TASK_CLASSIFIER_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: prompt,
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          maxTokens: params.config.maxTokens,
          temperature: 0,
          signal: controller.signal,
        },
      );
      const text = result.content
        .filter(isTextContentBlock)
        .map((block) => block.text)
        .join("")
        .trim();
      const parsed = safeParseTaskContract(text);
      emitDebugEvent(params.onDebugEvent, {
        stage: "raw_response",
        backend: params.config.backend,
        configuredModel: params.config.model,
        provider: model.provider,
        modelId: model.id,
        rawText: text,
        normalizedCandidate: parsed.normalizedCandidate,
        parseResult: parsed.parseResult,
        parseErrorMessage: parsed.parseErrorMessage,
      });
      if (parsed.taskContract) {
        return normalizeTaskContract(parsed.taskContract);
      }
      const retryableParseFailure = parsed.parseResult !== "ok";
      if (retryableParseFailure) {
        const retryResult = await completeSimple(
          model,
          {
            systemPrompt: TASK_CLASSIFIER_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: `${prompt}\n\nReminder: return exactly one minified JSON object only.`,
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey,
            maxTokens: params.config.maxTokens,
            temperature: 0,
            signal: controller.signal,
          },
        );
        const retryText = retryResult.content
          .filter(isTextContentBlock)
          .map((block) => block.text)
          .join("")
          .trim();
        const retryParsed = safeParseTaskContract(retryText);
        emitDebugEvent(params.onDebugEvent, {
          stage: "raw_response",
          backend: params.config.backend,
          configuredModel: params.config.model,
          provider: model.provider,
          modelId: model.id,
          rawText: retryText,
          normalizedCandidate: retryParsed.normalizedCandidate,
          parseResult: retryParsed.parseResult,
          parseErrorMessage: retryParsed.parseErrorMessage,
        });
        return retryParsed.taskContract ? normalizeTaskContract(retryParsed.taskContract) : null;
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildFailClosedResolution(params: {
  prompt: string;
  fileNames?: string[];
  reason: string;
}): ClassifiedTaskResolution {
  const taskContract = buildFailClosedTaskContract(params.reason);
  const plannerInput = buildPlannerInputFromTaskContract({
    prompt: params.prompt,
    fileNames: params.fileNames,
    taskContract,
  });
  return {
    source: "fail_closed",
    taskContract,
    plannerInput,
    resolutionContract: plannerInput.resolutionContract!,
    candidateFamilies: plannerInput.candidateFamilies ?? [],
  };
}

export function resolveTaskClassifierAdapter(
  backend: string,
  registry: Readonly<Record<string, TaskClassifierAdapter>> = {},
): TaskClassifierAdapter | undefined {
  if (registry[backend]) {
    return registry[backend];
  }
  if (backend === DEFAULT_TASK_CLASSIFIER_BACKEND) {
    return new PiTaskClassifierAdapter();
  }
  return undefined;
}

export async function classifyTaskForDecision(params: {
  prompt: string;
  fileNames?: string[];
  cfg: OpenClawConfig;
  agentDir?: string;
  input?: BuildExecutionDecisionInputParams;
  adapterRegistry?: Readonly<Record<string, TaskClassifierAdapter>>;
  onDebugEvent?: (event: TaskClassifierDebugEvent) => void;
}): Promise<ClassifiedTaskResolution> {
  const deterministic = resolveDeterministicTaskContract(params.prompt);
  if (deterministic) {
    const normalizedContract = normalizeTaskContract(deterministic);
    const plannerInput = buildPlannerInputFromTaskContract({
      prompt: params.prompt,
      fileNames: params.fileNames,
      taskContract: normalizedContract,
    });
    return {
      source: "llm",
      taskContract: normalizedContract,
      plannerInput,
      resolutionContract: plannerInput.resolutionContract!,
      candidateFamilies: plannerInput.candidateFamilies ?? [],
    };
  }
  const classifierConfig = resolveTaskClassifierConfig({ cfg: params.cfg });
  if (!classifierConfig.enabled) {
    emitDebugEvent(params.onDebugEvent, {
      stage: "disabled",
      backend: classifierConfig.backend,
      configuredModel: classifierConfig.model,
      message: "classifier disabled; returning fail-closed clarification contract",
    });
    return buildFailClosedResolution({
      prompt: params.prompt,
      fileNames: params.fileNames,
      reason: FAIL_CLOSED_REASON,
    });
  }
  const adapter = resolveTaskClassifierAdapter(classifierConfig.backend, params.adapterRegistry);
  if (!adapter) {
    const error = new Error(`task-classifier: unknown backend "${classifierConfig.backend}"`);
    emitDebugEvent(params.onDebugEvent, {
      stage: "unknown_backend",
      backend: classifierConfig.backend,
      configuredModel: classifierConfig.model,
      message: error.message,
    });
    log.warn(error.message);
    return buildFailClosedResolution({
      prompt: params.prompt,
      fileNames: params.fileNames,
      reason: FAIL_CLOSED_REASON,
    });
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const classified = await adapter.classify({
        prompt: params.prompt,
        fileNames: params.fileNames ?? [],
        config: classifierConfig,
        cfg: params.cfg,
        agentDir: params.agentDir,
        onDebugEvent: params.onDebugEvent,
      });
      if (classified) {
        const normalizedContract = normalizeTaskContract(classified);
        const plannerInput = buildPlannerInputFromTaskContract({
          prompt: params.prompt,
          fileNames: params.fileNames,
          taskContract: normalizedContract,
        });
        return {
          source: "llm",
          taskContract: normalizedContract,
          plannerInput,
          resolutionContract: plannerInput.resolutionContract!,
          candidateFamilies: plannerInput.candidateFamilies ?? [],
        };
      }
      emitDebugEvent(params.onDebugEvent, {
        stage: "fallback",
        backend: classifierConfig.backend,
        configuredModel: classifierConfig.model,
        message: "classifier returned no valid contract; returning fail-closed clarification contract",
      });
      return buildFailClosedResolution({
        prompt: params.prompt,
        fileNames: params.fileNames,
        reason: FAIL_CLOSED_REASON,
      });
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        emitDebugEvent(params.onDebugEvent, {
          stage: "fallback",
          backend: classifierConfig.backend,
          configuredModel: classifierConfig.model,
          message: `classifier attempt ${attempt} failed; retrying once (${error instanceof Error ? error.message : String(error)})`,
        });
        continue;
      }
    }
  }
  emitDebugEvent(params.onDebugEvent, {
    stage: "fallback",
    backend: classifierConfig.backend,
    configuredModel: classifierConfig.model,
    message: `classifier failed after retry; returning fail-closed clarification contract (${lastError instanceof Error ? lastError.message : String(lastError)})`,
  });
  log.warn(
    `task-classifier: fail-closed after retry (${lastError instanceof Error ? lastError.message : String(lastError)})`,
  );
  return buildFailClosedResolution({
    prompt: params.prompt,
    fileNames: params.fileNames,
    reason: FAIL_CLOSED_REASON,
  });
}
