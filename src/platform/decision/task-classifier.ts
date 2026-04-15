import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { parseModelRef } from "../../agents/model-selection.js";
import { resolveModelAsync } from "../../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../../agents/simple-completion-transport.js";
import type { OpenClawConfig } from "../../config/config.js";
import { validateJsonSchemaValue } from "../../plugins/schema-validator.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  buildQualificationResultFromPlannerInput,
  buildExecutionDecisionInput,
  type BuildExecutionDecisionInputParams,
} from "./input.js";
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
export const DEFAULT_TASK_CLASSIFIER_MODEL = "openai/gpt-5-mini";
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
  "Classify the request into a TaskContract. This is classification only, not execution. Never refuse or ask for access because of environment limits. Return exactly one minified JSON object and nothing else.";

const TASK_CLASSIFIER_USER_TEMPLATE = `Return exactly one minified JSON object matching this JSON Schema:
{{SCHEMA_JSON}}

Rules:
- Use only schema keys.
- Keep requiredCapabilities minimal.
- Prefer omission over invention.
- Do not infer tools, vendors, providers, products, frameworks, or hosts as capabilities.
- Map brand/platform words to abstract intent.
- Attached files do not automatically imply document_extraction, multimodal_authoring, or tool_execution. Infer capabilities from the task, not from file presence alone.
- Do not add ambiguities just because execution would require credentials, permissions, URLs, test data, environment setup, browser matrices, runtime access, review process, branch choice, deployment permissions, page count, branding, filename, or template selection.
- Use "clarification_needed" only when the user request itself leaves the dominant outcome materially unclear or asks for production delivery without clear approval.
- If the request already clearly asks to fix, refactor, implement, update, add, generate, draft, summarize, inspect, test, compare, deploy, or publish something, do not downgrade to clarification_needed.
- If the request already clearly asks to fix, refactor, implement, update, or add something in a repo, prefer workspace_change plus tool_execution, not clarification_needed.
- Code change requests imply needs_workspace_mutation. Add needs_repo_execution when the user asks to run checks, tests, builds, scripts, or validation. Add needs_local_runtime only when execution is explicitly requested or obviously required by the task wording.
- Creating the requested artifact itself does not imply needs_workspace_mutation. Only use needs_workspace_mutation when the user is asking to edit repository or source files.
- Requests to open, inspect, click through, smoke-test, or compare live pages imply needs_interactive_browser, not needs_web_research.
- Requests to research latest public facts or pricing imply needs_web_research, not needs_interactive_browser.
- Requests to find latest public information and compare or summarize options for a decision should prefer comparison_report plus tool_execution.
- Browser audits, smoke tests, and inspections are observational tasks: prefer answer or comparison_report, not workspace_change.
- Browser inspection tasks should not add ambiguities for missing browser matrix, viewport, credentials, test accounts, or staging URL if the request is otherwise clear; assume defaults.
- Browser smoke or audit tasks should usually stay answer or comparison_report even when they mention signup, checkout, console, or network failures.
- Requests that depend on browser inspection or public web research should usually prefer tool_execution.
- Pure compare/summarize/calculate requests without live browsing or public research should prefer interactionMode respond_only.
- Pure summarization or rewriting of provided text should prefer answer with no capabilities.
- Straightforward arithmetic or estimation requests should avoid extra capabilities unless the task clearly requires one. Prefer no capabilities or only needs_tabular_reasoning when structured numeric reasoning is central.
- Requests to compare live pages should prefer comparison_report and default to current desktop rendering unless the user asks otherwise.
- Comparison over simple structured files can stay comparison_report with respond_only and may omit capabilities when no external tools are clearly required.
- Requests to create a document, report, deck, infographic, image, or visual asset from supplied materials should usually prefer document_package. Use artifact_iteration when the main result is the authored artifact.
- Document authoring from notes, docs, tables, or mixed inputs should usually prefer needs_multimodal_authoring and should not add ambiguities for page count, branding, tone, template, section list, or delivery formatting unless the user explicitly makes those central to the request.
- Requests to create an image or visual asset from attached materials should prefer document_package plus artifact_iteration, not workspace_change.
- Requests to deploy or publish to preview, staging, or live environments should prefer external_delivery plus tool_execution when that is the clear dominant outcome.
- Deploy/publish requests imply needs_external_delivery. If the request includes running checks or release validation, also prefer needs_repo_execution plus needs_local_runtime.
- Production or live delivery requests should usually include needs_high_reliability_provider.
- Do not infer needs_workspace_mutation unless the user explicitly asks to edit repository contents.
- Do not downgrade deploy/publish requests to clarification_needed just because branch, environment, or credentials are unspecified.
- Requests to fix code and then deploy to production should prefer clarification_needed with clarify_first unless approval for production is already explicit.
- Output must be valid JSON syntax with no trailing commas, no dangling quotes, and no extra characters before or after the object.
- Do not answer the task. Do not explain. Do not add markdown.

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

export type TaskContract = {
  primaryOutcome: PrimaryOutcome;
  requiredCapabilities: Capability[];
  interactionMode: InteractionMode;
  confidence: number;
  ambiguities: string[];
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

function safeParseTaskContract(raw: string): TaskContract | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as TaskContract;
    const validation = validateJsonSchemaValue({
      cacheKey: "platform-task-classifier-schema-v1",
      schema: TASK_CONTRACT_SCHEMA as Record<string, unknown>,
      value: parsed,
    });
    return validation.valid ? parsed : null;
  } catch {
    return null;
  }
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
    ...(fileNames.length > 0 ? { fileNames } : {}),
    ...bridge,
  });
  const ambiguityReasons = normalizeUnique(params.taskContract.ambiguities);
  const confidence = taskContractConfidenceToQualification(params.taskContract.confidence);
  const lowConfidenceStrategy = taskContractLowConfidenceStrategy(params.taskContract);
  return {
    prompt: params.prompt,
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
  }): Promise<TaskContract | null> {
    const modelRefRaw = params.config.model;
    const parsedRef = parseModelRef(modelRefRaw, "openai");
    if (!parsedRef) {
      return null;
    }
    const resolved = await resolveModelAsync(parsedRef.provider, parsedRef.model, params.agentDir, params.cfg);
    if (!resolved.model) {
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
      return safeParseTaskContract(text);
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
}): Promise<ClassifiedTaskResolution> {
  const baseInput = params.input ?? buildExecutionDecisionInput({
    prompt: params.prompt,
    ...(params.fileNames?.length ? { fileNames: params.fileNames } : {}),
  });
  const classifierConfig = resolveTaskClassifierConfig({ cfg: params.cfg });
  if (!classifierConfig.enabled) {
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
      });
      if (classified) {
        const plannerInput = buildPlannerInputFromTaskContract({
          prompt: params.prompt,
          fileNames: params.fileNames,
          taskContract: classified,
        });
        return {
          source: "llm",
          taskContract: classified,
          plannerInput,
          resolutionContract: plannerInput.resolutionContract!,
          candidateFamilies: plannerInput.candidateFamilies ?? [],
        };
      }
    }
  } catch (error) {
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
