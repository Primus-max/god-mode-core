import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import { z } from "zod";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { parseModelRef } from "../../agents/model-selection.js";
import { resolveModelAsync } from "../../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../../agents/simple-completion-transport.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  buildQualificationResultFromPlannerInput,
  buildExecutionDecisionInput,
  type BuildExecutionDecisionInputParams,
} from "./input.js";
import { countTabularFiles } from "./intent-signals.js";
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
- Pure compare/summarize/calculate without live browsing or public research should prefer respond_only.
- Pure summarization/rewriting of provided text should prefer answer with no capabilities.
- Code change requests imply workspace_change and needs_workspace_mutation.
- Add needs_repo_execution only when the user also wants checks/tests/builds/scripts/validation.
- Do not infer needs_workspace_mutation for document/image creation.
- Visual or image generation requests should usually be document_package + artifact_iteration + needs_visual_composition.
- PDF/deck/report/infographic authoring from notes or mixed inputs should usually be document_package + artifact_iteration + needs_multimodal_authoring.
- Extraction from supplied files should usually be document_extraction + tool_execution + needs_document_extraction.
- Deploy/publish/release requests should usually be external_delivery + tool_execution + needs_external_delivery.
- Add needs_high_reliability_provider only for production/live external delivery.
- Do not add ambiguities for credentials, permissions, URLs, runtime access, browser matrix, page count, branding, tone, template, filenames, or delivery formatting when the dominant outcome is still clear.

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
  source: "llm" | "heuristic";
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
  allowHeuristicFallback: boolean;
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

function promptSuggestsProductionDelivery(prompt: string): boolean {
  return /\b(production|prod\b|live environment|go live|в прод|в продакшн|продакшн|боев)/iu.test(prompt);
}

function promptSuggestsRepoValidation(prompt: string): boolean {
  return /\b(checks?|tests?|builds?|scripts?|validation|verify|release checks?|прогони|провер(к|ки)|тест(ы|ы)?|валид|сборк|релизн)/iu.test(
    prompt,
  );
}

function promptSuggestsLocalRuntime(prompt: string): boolean {
  return /\b(local|locally|local preview|preview working|run locally|dev server|local validation|локальн|локально|локальный|предпросмотр|рантайм)\b/iu.test(
    prompt,
  );
}

function promptSuggestsVisualArtifact(prompt: string): boolean {
  return /\b(image|picture|poster|banner|illustration|cartoon|logo|icon|thumbnail|картин|изображен|постер|баннер|иллюстрац|мультяш)/iu.test(
    prompt,
  );
}

function promptSuggestsDocumentAuthoring(prompt: string): boolean {
  return /\b(pdf|deck|slide|slides|report|infographic|document|презентац|слайд|отч[её]т|документ|инфограф|пдф)\b/iu.test(
    prompt,
  );
}

function promptExplicitlyRequestsRepoEdits(prompt: string): boolean {
  return /\b(edit|modify|patch|change|fix code|update code|source files?|repo|repository|правк|исправ.*код|исходник|репозитор)\b/iu.test(
    prompt,
  );
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

function normalizeTaskContract(params: {
  contract: TaskContract;
  prompt: string;
  fileNames?: string[];
}): TaskContract {
  const contract = params.contract;
  const capabilities = new Set(contract.requiredCapabilities);
  const originalPrimaryOutcome = contract.primaryOutcome;
  let primaryOutcome = contract.primaryOutcome;
  let interactionMode = contract.interactionMode;
  const fileNames = params.fileNames ?? [];
  const hasOnlyTabularAttachments =
    fileNames.length >= 2 && countTabularFiles(fileNames) === fileNames.length;

  if (originalPrimaryOutcome === "external_delivery") {
    primaryOutcome = "external_delivery";
    interactionMode = "tool_execution";
    capabilities.add("needs_external_delivery");
    if (promptSuggestsProductionDelivery(params.prompt)) {
      capabilities.add("needs_high_reliability_provider");
    }
    if (promptSuggestsRepoValidation(params.prompt)) {
      capabilities.add("needs_repo_execution");
    }
    if (promptSuggestsLocalRuntime(params.prompt) || promptSuggestsRepoValidation(params.prompt)) {
      capabilities.add("needs_local_runtime");
    }
    if (!promptExplicitlyRequestsRepoEdits(params.prompt)) {
      capabilities.delete("needs_workspace_mutation");
    }
  }

  if (originalPrimaryOutcome === "document_extraction") {
    primaryOutcome = "document_extraction";
    interactionMode = "tool_execution";
    capabilities.add("needs_document_extraction");
    capabilities.delete("needs_multimodal_authoring");
    capabilities.delete("needs_visual_composition");
    capabilities.delete("needs_workspace_mutation");
    capabilities.delete("needs_repo_execution");
    capabilities.delete("needs_local_runtime");
    capabilities.delete("needs_external_delivery");
    capabilities.delete("needs_high_reliability_provider");
  }

  if (originalPrimaryOutcome === "document_package") {
    interactionMode = "artifact_iteration";
    capabilities.delete("needs_workspace_mutation");
    capabilities.delete("needs_external_delivery");
    capabilities.delete("needs_high_reliability_provider");
    if (promptSuggestsVisualArtifact(params.prompt) && !promptSuggestsDocumentAuthoring(params.prompt)) {
      capabilities.add("needs_visual_composition");
      capabilities.delete("needs_multimodal_authoring");
    }
  }

  if (
    originalPrimaryOutcome === "comparison_report" &&
    hasOnlyTabularAttachments &&
    !capabilities.has("needs_interactive_browser") &&
    !capabilities.has("needs_web_research") &&
    !capabilities.has("needs_workspace_mutation") &&
    !capabilities.has("needs_external_delivery")
  ) {
    interactionMode = "respond_only";
    capabilities.add("needs_tabular_reasoning");
    capabilities.delete("needs_document_extraction");
    capabilities.delete("needs_repo_execution");
    capabilities.delete("needs_local_runtime");
  }

  if (originalPrimaryOutcome === "workspace_change") {
    primaryOutcome = "workspace_change";
    interactionMode = "tool_execution";
    capabilities.add("needs_workspace_mutation");
    if (promptSuggestsRepoValidation(params.prompt)) {
      capabilities.add("needs_repo_execution");
    }
    if (promptSuggestsLocalRuntime(params.prompt) || /\blocal validation\b/iu.test(params.prompt)) {
      capabilities.add("needs_local_runtime");
    }
  }

  if (capabilities.has("needs_workspace_mutation") && originalPrimaryOutcome !== "external_delivery") {
    primaryOutcome = "workspace_change";
  }
  if (capabilities.has("needs_interactive_browser")) {
    interactionMode = "tool_execution";
    if (primaryOutcome === "answer") {
      primaryOutcome = "comparison_report";
    }
  }
  if (capabilities.has("needs_web_research")) {
    interactionMode = "tool_execution";
    if (primaryOutcome === "answer") {
      primaryOutcome = "comparison_report";
    }
  }

  if (originalPrimaryOutcome !== "external_delivery") {
    capabilities.delete("needs_external_delivery");
    capabilities.delete("needs_high_reliability_provider");
  }
  if (originalPrimaryOutcome === "external_delivery") {
    capabilities.add("needs_external_delivery");
  }
  if (
    originalPrimaryOutcome === "external_delivery" &&
    capabilities.has("needs_high_reliability_provider")
  ) {
    capabilities.add("needs_external_delivery");
    primaryOutcome = "external_delivery";
    interactionMode = "tool_execution";
  }

  return {
    ...contract,
    primaryOutcome,
    interactionMode,
    requiredCapabilities: normalizeUnique(Array.from(capabilities)),
    ambiguities: normalizeUnique(contract.ambiguities),
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
  const artifactKinds: string[] = [];
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
      intent = "document";
      artifactKinds.push("document");
      break;
    case "document_extraction":
      intent = "document";
      artifactKinds.push("document", "report");
      break;
    default:
      intent = "general";
      break;
  }

  if (capabilities.has("needs_visual_composition")) {
    artifactKinds.push("image");
  }
  if (capabilities.has("needs_multimodal_authoring")) {
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
  if (contract.primaryOutcome === "document_package") {
    requestedTools.push("pdf");
  }
  if (capabilities.has("needs_multimodal_authoring") || capabilities.has("needs_visual_composition")) {
    requestedTools.push("image_generate");
  }

  return {
    intent,
    artifactKinds: normalizeUnique(artifactKinds),
    requestedTools: normalizeUnique(requestedTools),
    publishTargets: capabilities.has("needs_external_delivery") ? ["external"] : [],
    outcomeContract:
      contract.primaryOutcome === "workspace_change"
        ? "workspace_change"
        : contract.primaryOutcome === "external_delivery"
          ? "external_operation"
          : contract.primaryOutcome === "comparison_report" ||
              contract.primaryOutcome === "calculation_result" ||
              contract.primaryOutcome === "answer" ||
              contract.primaryOutcome === "clarification_needed"
            ? "text_response"
            : "structured_artifact",
    executionContract: {
      requiresTools:
        contract.interactionMode === "tool_execution" || contract.interactionMode === "artifact_iteration",
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
    prompt: params.prompt,
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

function heuristicTaskContract(
  input: ReturnType<typeof buildExecutionDecisionInput>,
): TaskContract {
  const requiredCapabilities: Capability[] = [];
  const tools = new Set(input.requestedTools ?? []);
  const artifactKinds = new Set(input.artifactKinds ?? []);
  const outcome = input.outcomeContract;

  if (input.executionContract?.requiresWorkspaceMutation) {
    requiredCapabilities.push("needs_workspace_mutation");
  }
  if (tools.has("exec")) {
    requiredCapabilities.push("needs_repo_execution");
  }
  if (tools.has("process") || input.executionContract?.requiresLocalProcess) {
    requiredCapabilities.push("needs_local_runtime");
  }
  if (tools.has("browser")) {
    requiredCapabilities.push("needs_interactive_browser");
  }
  if (tools.has("web_search")) {
    requiredCapabilities.push("needs_web_research");
  }
  if (tools.has("pdf") && artifactKinds.has("document") && artifactKinds.has("image")) {
    requiredCapabilities.push("needs_multimodal_authoring");
  } else if (tools.has("pdf") && artifactKinds.has("document")) {
    requiredCapabilities.push("needs_visual_composition");
  }
  if (artifactKinds.has("image") && tools.has("image_generate")) {
    requiredCapabilities.push("needs_visual_composition");
  }
  if (
    input.candidateFamilies?.includes("document_render") &&
    input.intent === "document" &&
    (input.fileNames ?? []).some((name) => /\.(pdf|png|jpe?g|webp|gif|tiff?|bmp|heic)$/iu.test(name))
  ) {
    requiredCapabilities.push("needs_document_extraction");
  }
  if ((input.publishTargets?.length ?? 0) > 0 || outcome === "external_operation") {
    requiredCapabilities.push("needs_external_delivery");
  }

  const primaryOutcome: PrimaryOutcome =
    outcome === "workspace_change"
      ? "workspace_change"
      : outcome === "external_operation"
        ? "external_delivery"
        : input.intent === "compare"
          ? "comparison_report"
          : input.intent === "calculation"
            ? "calculation_result"
            : input.intent === "document" && (input.fileNames?.length ?? 0) > 0
              ? "document_extraction"
              : input.intent === "document" || artifactKinds.has("document")
                ? "document_package"
                : input.lowConfidenceStrategy === "clarify"
                  ? "clarification_needed"
                  : "answer";

  const interactionMode: InteractionMode =
    input.lowConfidenceStrategy === "clarify"
      ? "clarify_first"
      : primaryOutcome === "document_package"
        ? "artifact_iteration"
        : (input.requestedTools?.length ?? 0) > 0
          ? "tool_execution"
          : "respond_only";

  return {
    primaryOutcome,
    requiredCapabilities: normalizeUnique(requiredCapabilities),
    interactionMode,
    confidence: input.confidence === "high" ? 0.92 : input.confidence === "medium" ? 0.68 : 0.45,
    ambiguities: normalizeUnique(input.ambiguityReasons ?? []),
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
    allowHeuristicFallback: classifierConfig?.allowHeuristicFallback !== false,
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
          system: TASK_CLASSIFIER_SYSTEM_PROMPT,
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
        return normalizeTaskContract({
          contract: parsed.taskContract,
          prompt: params.prompt,
          fileNames: params.fileNames,
        });
      }
      const retryableParseFailure = parsed.parseResult !== "ok";
      if (retryableParseFailure) {
        const retryResult = await completeSimple(
          model,
          {
            system: TASK_CLASSIFIER_SYSTEM_PROMPT,
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
        return retryParsed.taskContract
          ? normalizeTaskContract({
              contract: retryParsed.taskContract,
              prompt: params.prompt,
              fileNames: params.fileNames,
            })
          : null;
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
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
  const baseInput = params.input ?? buildExecutionDecisionInput({
    prompt: params.prompt,
    ...(params.fileNames?.length ? { fileNames: params.fileNames } : {}),
  });
  const classifierConfig = resolveTaskClassifierConfig({ cfg: params.cfg });
  if (!classifierConfig.enabled) {
    emitDebugEvent(params.onDebugEvent, {
      stage: "disabled",
      backend: classifierConfig.backend,
      configuredModel: classifierConfig.model,
      message: "classifier disabled; using heuristic path",
    });
    const taskContract = heuristicTaskContract(baseInput);
    const resolutionContract =
      baseInput.resolutionContract ?? resolveResolutionContract(mapTaskContractToBridge(taskContract));
    return {
      source: "heuristic",
      taskContract,
      plannerInput: baseInput,
      resolutionContract,
      candidateFamilies: baseInput.candidateFamilies ?? [],
    };
  }
  const adapter = resolveTaskClassifierAdapter(classifierConfig.backend, params.adapterRegistry);
  if (!adapter) {
    const error = new Error(
      `task-classifier: unknown backend "${classifierConfig.backend}"`,
    );
    emitDebugEvent(params.onDebugEvent, {
      stage: "unknown_backend",
      backend: classifierConfig.backend,
      configuredModel: classifierConfig.model,
      message: error.message,
    });
    if (!classifierConfig.allowHeuristicFallback) {
      throw error;
    }
    log.warn(error.message);
  }
  try {
    if (adapter) {
      const classified = await adapter.classify({
        prompt: params.prompt,
        fileNames: params.fileNames ?? [],
        config: classifierConfig,
        cfg: params.cfg,
        agentDir: params.agentDir,
        onDebugEvent: params.onDebugEvent,
      });
      if (classified) {
        const normalizedContract = normalizeTaskContract({
          contract: classified,
          prompt: params.prompt,
          fileNames: params.fileNames,
        });
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
        message: "adapter returned null; using heuristic fallback",
      });
    }
  } catch (error) {
    emitDebugEvent(params.onDebugEvent, {
      stage: "fallback",
      backend: classifierConfig.backend,
      configuredModel: classifierConfig.model,
      message: error instanceof Error ? error.message : String(error),
    });
    log.warn(
      `task-classifier: falling back to heuristics (${error instanceof Error ? error.message : String(error)})`,
    );
    if (!classifierConfig.allowHeuristicFallback) {
      throw error;
    }
  }

  const taskContract = heuristicTaskContract(baseInput);
  const qualification = buildQualificationResultFromPlannerInput({
    ...(baseInput.intent ? { intent: baseInput.intent } : {}),
    ...(baseInput.artifactKinds?.length ? { artifactKinds: baseInput.artifactKinds } : {}),
    ...(baseInput.requestedTools?.length ? { requestedTools: baseInput.requestedTools } : {}),
    ...(baseInput.publishTargets?.length ? { publishTargets: baseInput.publishTargets } : {}),
  });
  const resolutionContract = resolveResolutionContract({
    prompt: params.prompt,
    ...(params.fileNames?.length ? { fileNames: params.fileNames } : {}),
    ...(baseInput.intent ? { intent: baseInput.intent } : {}),
    ...(baseInput.artifactKinds?.length ? { artifactKinds: baseInput.artifactKinds } : {}),
    ...(baseInput.requestedTools?.length ? { requestedTools: baseInput.requestedTools } : {}),
    ...(baseInput.publishTargets?.length ? { publishTargets: baseInput.publishTargets } : {}),
    outcomeContract: qualification.outcomeContract,
    executionContract: qualification.executionContract,
    candidateFamilies: qualification.candidateFamilies,
  });
  return {
    source: "heuristic",
    taskContract,
    plannerInput: {
      ...baseInput,
      candidateFamilies: [...resolutionContract.candidateFamilies],
      resolutionContract,
      routing: toRecipeRoutingHints(resolutionContract),
    },
    resolutionContract,
    candidateFamilies: resolutionContract.candidateFamilies,
  };
}
