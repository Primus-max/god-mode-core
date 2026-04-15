import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { completeSimple, type Api, type Model, type TextContent } from "@mariozechner/pi-ai";
import { resolveOpenClawAgentDir } from "../../src/agents/agent-paths.js";
import { getApiKeyForModel, requireApiKey } from "../../src/agents/model-auth.js";
import { resolveModelAsync } from "../../src/agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../../src/agents/simple-completion-transport.js";
import { loadConfig } from "../../src/config/config.js";
import { buildExecutionDecisionInput } from "../../src/platform/decision/input.js";
import type { RecipePlannerInput } from "../../src/platform/recipe/planner.js";
import { validateJsonSchemaValue } from "../../src/plugins/schema-validator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EVAL_DIR = path.join(__dirname, "task-contract-eval");
const CORPUS_PATH = path.join(EVAL_DIR, "corpus.json");
const SCHEMA_PATH = path.join(EVAL_DIR, "schema", "task-contract.schema.json");
const RESOLUTION_SCHEMA_PATH = path.join(EVAL_DIR, "schema", "resolution-contract.schema.json");
const PROMPT_TEMPLATE_PATH = path.join(EVAL_DIR, "prompt-template.json");
const OUTPUT_DIR = path.join(EVAL_DIR, "output");

const REQUEST_TIMEOUT_MS = 60_000;
const LOCAL_REQUEST_TIMEOUT_MS = 8_000;
const MAX_TOKENS = 700;
const LOCAL_MAX_TOKENS = 350;
const DEFAULT_CASE_LIMIT = 0;
const SCHEMA_CACHE_KEY = "task-contract-eval-schema-v2-minimal";

type TaskClass =
  | "general"
  | "code"
  | "publish"
  | "compare"
  | "calculation"
  | "document_authoring"
  | "document_ingest"
  | "browser_site"
  | "media_image"
  | "mixed_ambiguous";

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

type ResolutionFamily =
  | "general_assistant"
  | "document_render"
  | "media_generation"
  | "code_build"
  | "analysis_transform"
  | "ops_execution";

type ToolBundle =
  | "respond_only"
  | "repo_run"
  | "repo_mutation"
  | "interactive_browser"
  | "public_web_lookup"
  | "document_extraction"
  | "artifact_authoring"
  | "external_delivery";

type ResolvedRemoteProfile = "cheap" | "code" | "strong" | "presentation";

type TaskContract = {
  primaryOutcome: PrimaryOutcome;
  requiredCapabilities: Capability[];
  interactionMode: InteractionMode;
  confidence: number;
  ambiguities: string[];
};

type ResolutionContract = {
  selectedFamily: ResolutionFamily;
  candidateFamilies: ResolutionFamily[];
  toolBundles: ToolBundle[];
  routing: {
    remoteProfile: ResolvedRemoteProfile;
    preferRemoteFirst: boolean;
    needsVision: boolean;
    localEligible: boolean;
  };
};

type LegacyTaskContract = {
  taskClass?: TaskClass;
  primaryOutcome: string;
  requiredCapabilities?: string[];
  constraints?: string[];
  suggestedArtifacts?: string[];
  interactionMode: string;
  confidence: number;
  ambiguities?: string[];
  suggestedFamily?: string;
  suggestedTools?: string[];
};

type CorpusCase = {
  id: string;
  language: string;
  taskClass: TaskClass;
  prompt: string;
  fileNames: string[];
  expected: TaskContract;
  expectedResolutionFamily: ResolutionFamily | null;
};

type PromptTemplate = {
  systemPrompt: string;
  userTemplate: string;
};

type CandidateModelRef = {
  provider: string;
  modelId: string;
};

type ExperimentModelSpec = {
  slot: "cheap_remote" | "balanced_remote" | "arbiter_remote" | "local_baseline";
  label: string;
  why: string;
  candidates: CandidateModelRef[];
};

type ResolvedExperimentModel = {
  slot: ExperimentModelSpec["slot"];
  label: string;
  why: string;
  resolvedFrom: CandidateModelRef;
  fallbacksSkipped: CandidateModelRef[];
  model: Model<Api>;
  apiKey: string;
};

type FieldSetScore = {
  score: number;
  exact: boolean;
  precision: number;
  recall: number;
  f1: number;
  missing: string[];
  extras: string[];
};

type FieldScalarScore = {
  score: number;
  exact: boolean;
  partial: boolean;
};

type ScoreBreakdown = {
  schemaValid: boolean;
  primaryOutcome: FieldScalarScore;
  requiredCapabilities: FieldSetScore;
  interactionMode: FieldScalarScore;
  confidence: FieldScalarScore;
  ambiguities: FieldSetScore;
  total: number;
  verdict: "strong" | "usable" | "weak";
};

type CaseRunResult = {
  caseId: string;
  caseTaskClass: TaskClass;
  modelKey: string;
  modelLabel: string;
  modelId: string;
  provider: string;
  slot: string;
  latencyMs: number;
  ok: boolean;
  error?: string;
  schemaValid: boolean;
  rawOutput: string;
  parsedJson: TaskContract | null;
  resolvedContract: ResolutionContract | null;
  expected: TaskContract;
  expectedResolutionFamily: ResolutionFamily | null;
  resolutionFamilyExact: boolean | null;
  score: ScoreBreakdown;
};

type AggregateMetrics = {
  modelKey: string;
  modelLabel: string;
  slot: string;
  provider: string;
  modelId: string;
  why: string;
  resolvedFrom: string;
  avgScore: number;
  medianScore: number;
  avgLatencyMs: number;
  schemaValidRate: number;
  exactPrimaryOutcomeRate: number;
  exactInteractionModeRate: number;
  resolutionFamilyAccuracy: number;
  capabilityPrecision: number;
  capabilityRecall: number;
  capabilityF1: number;
  worstCases: Array<{
    caseId: string;
    score: number;
    schemaValid: boolean;
    rawOutput: string;
  }>;
};

const MODEL_SPECS: ExperimentModelSpec[] = [
  {
    slot: "cheap_remote",
    label: "hydra-cheap",
    why: "Cheap remote first-pass candidate for high-volume shadow classification.",
    candidates: [
      { provider: "hydra", modelId: "hydra-gpt-mini" },
      { provider: "hydra", modelId: "gpt-5-nano" },
      { provider: "hydra", modelId: "gpt-4.1-nano" }
    ]
  },
  {
    slot: "balanced_remote",
    label: "hydra-balanced",
    why: "Stronger remote candidate with better reasoning headroom than the cheap tier.",
    candidates: [
      { provider: "hydra", modelId: "gpt-5-mini" },
      { provider: "hydra", modelId: "gpt-4.1-mini" },
      { provider: "hydra", modelId: "hydra-gpt" }
    ]
  },
  {
    slot: "arbiter_remote",
    label: "hydra-arbiter",
    why: "High-end remote control model for arbitration and failure analysis.",
    candidates: [
      { provider: "hydra", modelId: "gpt-5.4" },
      { provider: "hydra", modelId: "gpt-5.2" },
      { provider: "hydra", modelId: "gpt-4o" }
    ]
  },
  {
    slot: "local_baseline",
    label: "ollama-local",
    why: "Local baseline to measure the floor for zero-cost classification.",
    candidates: [
      { provider: "ollama", modelId: "gemma4:e4b" },
      { provider: "ollama", modelId: "qwen2.5-coder:7b" },
      { provider: "ollama", modelId: "gpt-oss:20b" }
    ]
  }
];

const PRIMARY_OUTCOME_WEIGHT = 32;
const CAPABILITIES_WEIGHT = 38;
const INTERACTION_WEIGHT = 15;
const CONFIDENCE_WEIGHT = 5;
const AMBIGUITIES_WEIGHT = 5;
const SCHEMA_WEIGHT = 5;

function parseArgs() {
  const args = process.argv.slice(2);
  const modelFilter = readCsvFlag(args, "--models");
  const caseFilter = readCsvFlag(args, "--cases");
  const limitRaw = readSingleFlag(args, "--limit");
  const limit = limitRaw ? Number(limitRaw) : DEFAULT_CASE_LIMIT;
  return {
    modelFilter,
    caseFilter,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0
  };
}

function readSingleFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return args[index + 1];
}

function readCsvFlag(args: string[], flag: string): Set<string> | null {
  const raw = readSingleFlag(args, flag)?.trim();
  if (!raw) {
    return null;
  }
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function normalizeSchemaForAjv(schema: Record<string, unknown>): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  delete cloned.$schema;
  delete cloned.$id;
  return cloned;
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

function extractText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block): block is TextContent => Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

async function resolveExperimentModels(): Promise<ResolvedExperimentModel[]> {
  const cfg = loadConfig();
  const agentDir = resolveOpenClawAgentDir();
  const resolved: ResolvedExperimentModel[] = [];

  for (const spec of MODEL_SPECS) {
    const skipped: CandidateModelRef[] = [];
    let selected: ResolvedExperimentModel | null = null;
    for (const candidate of spec.candidates) {
      const modelResolution = await resolveModelAsync(
        candidate.provider,
        candidate.modelId,
        agentDir,
        cfg,
        { retryTransientProviderRuntimeMiss: true }
      );
      if (!modelResolution.model) {
        skipped.push(candidate);
        continue;
      }
      const model = prepareModelForSimpleCompletion({ model: modelResolution.model, cfg });
      const apiKey = await resolveEvalApiKey({
        model,
        provider: candidate.provider,
        cfg,
        agentDir
      });
      selected = {
        slot: spec.slot,
        label: spec.label,
        why: spec.why,
        resolvedFrom: candidate,
        fallbacksSkipped: skipped,
        model,
        apiKey
      };
      break;
    }
    if (!selected) {
      throw new Error(
        `Unable to resolve any model for slot ${spec.slot}: ${spec.candidates
          .map((entry) => `${entry.provider}/${entry.modelId}`)
          .join(", ")}`
      );
    }
    resolved.push(selected);
  }
  return resolved;
}

async function resolveEvalApiKey(params: {
  model: Model<Api>;
  provider: string;
  cfg: ReturnType<typeof loadConfig>;
  agentDir: string;
}): Promise<string> {
  try {
    return requireApiKey(
      await getApiKeyForModel({
        model: params.model,
        cfg: params.cfg,
        agentDir: params.agentDir
      }),
      params.provider
    );
  } catch {
    if (params.provider === "hydra") {
      const envKey = process.env.HYDRA_API_KEY?.trim();
      if (envKey) {
        return envKey;
      }
    }
    if (params.provider === "ollama") {
      return process.env.OLLAMA_API_KEY?.trim() || "ollama-local";
    }
    throw new Error(`No eval API key resolved for ${params.provider}/${params.model.id}.`);
  }
}

function renderUserPrompt(params: {
  template: string;
  schema: Record<string, unknown>;
  caseItem: CorpusCase;
}): string {
  return params.template
    .replace("{{SCHEMA_JSON}}", JSON.stringify(params.schema, null, 2))
    .replace(
      "{{ATTACHMENT_FILE_NAMES}}",
      params.caseItem.fileNames.length > 0 ? JSON.stringify(params.caseItem.fileNames) : "[]"
    )
    .replace("{{USER_REQUEST}}", params.caseItem.prompt);
}

function safeParseTaskContract(raw: string): TaskContract | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as TaskContract;
  } catch {
    return null;
  }
}

function normalizePrimaryOutcome(outcome: string, taskClass?: TaskClass): PrimaryOutcome {
  switch (outcome) {
    case "answer":
      return "answer";
    case "workspace_change":
      return "workspace_change";
    case "external_delivery":
    case "publish_release":
      return "external_delivery";
    case "comparison_report":
      return "comparison_report";
    case "calculation_result":
      return "calculation_result";
    case "document_package":
      return "document_package";
    case "document_extraction":
      return "document_extraction";
    case "site_or_browser_result":
      return taskClass === "browser_site" ? "comparison_report" : "clarification_needed";
    case "image_asset":
      return "document_package";
    case "clarification_needed":
      return "clarification_needed";
    default:
      return "clarification_needed";
  }
}

function normalizeInteractionMode(mode: string): InteractionMode {
  switch (mode) {
    case "respond_only":
    case "clarify_first":
    case "tool_execution":
    case "artifact_iteration":
      return mode;
    default:
      return "clarify_first";
  }
}

function normalizeResolutionFamily(value: string | undefined): ResolutionFamily | null {
  switch (value) {
    case "general_assistant":
    case "document_render":
    case "media_generation":
    case "code_build":
    case "analysis_transform":
    case "ops_execution":
      return value;
    default:
      return null;
  }
}

function normalizeCapabilities(values: readonly string[] | undefined): Capability[] {
  const allowed = new Set<Capability>([
    "needs_repo_execution",
    "needs_workspace_mutation",
    "needs_local_runtime",
    "needs_external_delivery",
    "needs_document_extraction",
    "needs_visual_composition",
    "needs_multimodal_authoring",
    "needs_tabular_reasoning",
    "needs_interactive_browser",
    "needs_web_research",
    "needs_high_reliability_provider"
  ]);
  return sortUnique((values ?? []).filter((value): value is Capability => allowed.has(value as Capability)));
}

function normalizeCorpusCase(caseItem: {
  id: string;
  language: string;
  taskClass: TaskClass;
  prompt: string;
  fileNames?: string[];
  expected: LegacyTaskContract;
}): CorpusCase {
  return {
    id: caseItem.id,
    language: caseItem.language,
    taskClass: caseItem.taskClass,
    prompt: caseItem.prompt,
    fileNames: caseItem.fileNames ?? [],
    expectedResolutionFamily: normalizeResolutionFamily(caseItem.expected.suggestedFamily),
    expected: {
      primaryOutcome: normalizePrimaryOutcome(caseItem.expected.primaryOutcome, caseItem.taskClass),
      requiredCapabilities: normalizeCapabilities(caseItem.expected.requiredCapabilities),
      interactionMode: normalizeInteractionMode(caseItem.expected.interactionMode),
      confidence: caseItem.expected.confidence,
      ambiguities: sortUnique(caseItem.expected.ambiguities ?? [])
    }
  };
}

function deriveResolutionFamilies(contract: TaskContract): ResolutionFamily[] {
  switch (contract.primaryOutcome) {
    case "comparison_report":
    case "calculation_result":
      return ["analysis_transform", "general_assistant"];
    case "document_package":
      return contract.requiredCapabilities.includes("needs_visual_composition") ||
        contract.requiredCapabilities.includes("needs_multimodal_authoring")
        ? ["media_generation", "document_render"]
        : ["document_render", "media_generation"];
    case "document_extraction":
      return ["document_render", "analysis_transform"];
    case "workspace_change":
      return ["code_build"];
    case "external_delivery":
      return ["ops_execution", "code_build"];
    case "answer":
    case "clarification_needed":
    default:
      return ["general_assistant", "analysis_transform"];
  }
}

function selectResolutionFamily(
  contract: TaskContract,
  candidateFamilies: ResolutionFamily[],
): ResolutionFamily {
  switch (contract.primaryOutcome) {
    case "comparison_report":
    case "calculation_result":
      return "analysis_transform";
    case "document_package":
      return contract.requiredCapabilities.includes("needs_visual_composition") ||
        contract.requiredCapabilities.includes("needs_multimodal_authoring")
        ? "media_generation"
        : "document_render";
    case "document_extraction":
      return "document_render";
    case "workspace_change":
      return "code_build";
    case "external_delivery":
      return "ops_execution";
    case "answer":
    case "clarification_needed":
    default:
      return candidateFamilies[0] ?? "general_assistant";
  }
}

function deriveToolBundles(contract: TaskContract): ToolBundle[] {
  const bundles = new Set<ToolBundle>();
  const capabilities = new Set(contract.requiredCapabilities);

  if (contract.interactionMode === "respond_only" || contract.primaryOutcome === "answer") {
    bundles.add("respond_only");
  }
  if (capabilities.has("needs_repo_execution") || capabilities.has("needs_local_runtime")) {
    bundles.add("repo_run");
  }
  if (capabilities.has("needs_workspace_mutation")) {
    bundles.add("repo_mutation");
  }
  if (capabilities.has("needs_interactive_browser")) {
    bundles.add("interactive_browser");
  }
  if (capabilities.has("needs_web_research")) {
    bundles.add("public_web_lookup");
  }
  if (capabilities.has("needs_document_extraction") || contract.primaryOutcome === "document_extraction") {
    bundles.add("document_extraction");
  }
  if (
    capabilities.has("needs_visual_composition") ||
    capabilities.has("needs_multimodal_authoring") ||
    contract.primaryOutcome === "document_package"
  ) {
    bundles.add("artifact_authoring");
  }
  if (capabilities.has("needs_external_delivery") || contract.primaryOutcome === "external_delivery") {
    bundles.add("external_delivery");
  }

  return sortUnique(Array.from(bundles));
}

function deriveRoutingProfile(contract: TaskContract): ResolvedRemoteProfile {
  const capabilities = new Set(contract.requiredCapabilities);
  if (
    capabilities.has("needs_visual_composition") ||
    capabilities.has("needs_multimodal_authoring")
  ) {
    return "presentation";
  }
  if (
    capabilities.has("needs_external_delivery") ||
    capabilities.has("needs_interactive_browser") ||
    capabilities.has("needs_web_research")
  ) {
    return "strong";
  }
  if (
    capabilities.has("needs_repo_execution") ||
    capabilities.has("needs_workspace_mutation") ||
    capabilities.has("needs_local_runtime")
  ) {
    return "code";
  }
  return "cheap";
}

function resolveTaskContract(contract: TaskContract): ResolutionContract {
  const candidateFamilies = deriveResolutionFamilies(contract);
  const remoteProfile = deriveRoutingProfile(contract);
  const capabilities = new Set(contract.requiredCapabilities);
  return {
    selectedFamily: selectResolutionFamily(contract, candidateFamilies),
    candidateFamilies,
    toolBundles: deriveToolBundles(contract),
    routing: {
      remoteProfile,
      preferRemoteFirst:
        remoteProfile === "presentation" ||
        remoteProfile === "strong" ||
        contract.primaryOutcome === "external_delivery",
      needsVision:
        capabilities.has("needs_visual_composition") ||
        capabilities.has("needs_multimodal_authoring") ||
        capabilities.has("needs_document_extraction"),
      localEligible:
        !capabilities.has("needs_interactive_browser") &&
        !capabilities.has("needs_web_research") &&
        !capabilities.has("needs_multimodal_authoring")
    }
  };
}

function sortUnique<T extends string>(values: readonly T[]): T[] {
  return Array.from(new Set(values)).sort() as T[];
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid] ?? 0;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function toPercent(value: number): number {
  return round(value * 100, 1);
}

function scalarScore(score: number, exact: boolean, partial: boolean): FieldScalarScore {
  return { score, exact, partial };
}

function setScore(expected: string[], predicted: string[]): FieldSetScore {
  const expectedSet = new Set(expected);
  const predictedSet = new Set(predicted);
  const tp = predicted.filter((item) => expectedSet.has(item)).length;
  const precision = predicted.length === 0 ? (expected.length === 0 ? 1 : 0) : tp / predicted.length;
  const recall = expected.length === 0 ? (predicted.length === 0 ? 1 : 0) : tp / expected.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    score: f1,
    exact: expected.length === predicted.length && tp === expected.length,
    precision,
    recall,
    f1,
    missing: expected.filter((item) => !predictedSet.has(item)),
    extras: predicted.filter((item) => !expectedSet.has(item))
  };
}

const PRIMARY_OUTCOME_GROUPS: Record<PrimaryOutcome, string> = {
  answer: "answering",
  workspace_change: "execution",
  external_delivery: "execution",
  comparison_report: "analysis",
  calculation_result: "analysis",
  document_package: "document",
  document_extraction: "document",
  clarification_needed: "answering"
};

function scorePrimaryOutcome(expected: PrimaryOutcome, predicted: unknown): FieldScalarScore {
  if (predicted === expected) {
    return scalarScore(1, true, true);
  }
  if (typeof predicted !== "string") {
    return scalarScore(0, false, false);
  }
  const predictedValue = predicted as PrimaryOutcome;
  if (PRIMARY_OUTCOME_GROUPS[predictedValue] && PRIMARY_OUTCOME_GROUPS[predictedValue] === PRIMARY_OUTCOME_GROUPS[expected]) {
    return scalarScore(0.5, false, true);
  }
  return scalarScore(0, false, false);
}

function scoreInteractionMode(expected: InteractionMode, predicted: unknown): FieldScalarScore {
  if (predicted === expected) {
    return scalarScore(1, true, true);
  }
  if (
    (expected === "tool_execution" && predicted === "clarify_first") ||
    (expected === "clarify_first" && predicted === "tool_execution")
  ) {
    return scalarScore(0.4, false, true);
  }
  if (
    (expected === "artifact_iteration" && predicted === "tool_execution") ||
    (expected === "tool_execution" && predicted === "artifact_iteration")
  ) {
    return scalarScore(0.5, false, true);
  }
  return scalarScore(0, false, false);
}

function scoreConfidence(expected: number, predicted: unknown): FieldScalarScore {
  if (typeof predicted !== "number" || !Number.isFinite(predicted)) {
    return scalarScore(0, false, false);
  }
  const delta = Math.abs(expected - predicted);
  const score = Math.max(0, 1 - delta / 0.5);
  return scalarScore(score, delta <= 0.05, score > 0);
}

function scoreContract(params: {
  expected: TaskContract;
  predicted: TaskContract | null;
  schemaValid: boolean;
}): ScoreBreakdown {
  const predicted = params.predicted;
  const primaryOutcome = scorePrimaryOutcome(params.expected.primaryOutcome, predicted?.primaryOutcome);
  const requiredCapabilities = setScore(
    sortUnique(params.expected.requiredCapabilities),
    sortUnique(predicted?.requiredCapabilities ?? [])
  );
  const interactionMode = scoreInteractionMode(params.expected.interactionMode, predicted?.interactionMode);
  const confidence = scoreConfidence(params.expected.confidence, predicted?.confidence);
  const ambiguities = setScore(
    sortUnique(params.expected.ambiguities),
    sortUnique(predicted?.ambiguities ?? [])
  );

  const total =
    (params.schemaValid ? SCHEMA_WEIGHT : 0) +
    primaryOutcome.score * PRIMARY_OUTCOME_WEIGHT +
    requiredCapabilities.score * CAPABILITIES_WEIGHT +
    interactionMode.score * INTERACTION_WEIGHT +
    confidence.score * CONFIDENCE_WEIGHT +
    ambiguities.score * AMBIGUITIES_WEIGHT;

  const roundedTotal = round(total, 1);
  return {
    schemaValid: params.schemaValid,
    primaryOutcome,
    requiredCapabilities,
    interactionMode,
    confidence,
    ambiguities,
    total: roundedTotal,
    verdict: roundedTotal >= 85 ? "strong" : roundedTotal >= 70 ? "usable" : "weak"
  };
}

function heuristicToTaskClass(input: RecipePlannerInput): TaskClass {
  const intent = input.intent;
  const tools = new Set(input.requestedTools ?? []);
  const artifacts = new Set(input.artifactKinds ?? []);
  const files = input.fileNames ?? [];

  if (tools.has("browser") || tools.has("web_search")) {
    return "browser_site";
  }
  if (artifacts.has("image") && tools.has("image_generate")) {
    return "media_image";
  }
  if (intent === "general") {
    return "general";
  }
  if (intent === "code") {
    return "code";
  }
  if (intent === "publish") {
    return "publish";
  }
  if (intent === "compare") {
    return "compare";
  }
  if (intent === "calculation") {
    return "calculation";
  }
  if (intent === "document") {
    if (tools.has("pdf") && files.length === 0) {
      return "document_authoring";
    }
    return "document_ingest";
  }
  return "mixed_ambiguous";
}

function heuristicCapabilities(input: RecipePlannerInput, taskClass: TaskClass): Capability[] {
  const tools = new Set(input.requestedTools ?? []);
  const artifacts = new Set(input.artifactKinds ?? []);
  const files = input.fileNames ?? [];
  const capabilities = new Set<Capability>();

  if (tools.has("exec") || tools.has("process") || taskClass === "code" || taskClass === "publish") {
    capabilities.add("needs_repo_execution");
    capabilities.add("needs_local_runtime");
  }
  if (tools.has("apply_patch") || taskClass === "code") {
    capabilities.add("needs_workspace_mutation");
  }
  if (taskClass === "publish" || (input.publishTargets?.length ?? 0) > 0) {
    capabilities.add("needs_external_delivery");
  }
  if (tools.has("browser")) {
    capabilities.add("needs_interactive_browser");
  }
  if (tools.has("web_search")) {
    capabilities.add("needs_web_research");
  }
  if (
    taskClass === "document_ingest" ||
    files.some((file) => /\.(pdf|png|jpe?g|docx?)$/iu.test(file))
  ) {
    capabilities.add("needs_document_extraction");
  }
  if (tools.has("image_generate") || taskClass === "media_image") {
    capabilities.add("needs_visual_composition");
    capabilities.add("needs_multimodal_authoring");
  }
  if (taskClass === "document_authoring") {
    capabilities.add("needs_visual_composition");
  }
  if (
    taskClass === "compare" ||
    taskClass === "calculation" ||
    artifacts.has("data") ||
    files.some((file) => /\.(csv|xlsx?)$/iu.test(file))
  ) {
    capabilities.add("needs_tabular_reasoning");
  }
  if (
    input.routing?.remoteProfile === "strong" ||
    input.routing?.remoteProfile === "presentation" ||
    taskClass === "publish" ||
    tools.has("browser")
  ) {
    capabilities.add("needs_high_reliability_provider");
  }

  return sortUnique(Array.from(capabilities));
}

function heuristicPrimaryOutcome(taskClass: TaskClass, input: RecipePlannerInput): PrimaryOutcome {
  if (input.lowConfidenceStrategy === "clarify") {
    return "clarification_needed";
  }
  switch (taskClass) {
    case "general":
    case "browser_site":
      return "answer";
    case "code":
      return "workspace_change";
    case "publish":
      return "external_delivery";
    case "compare":
      return "comparison_report";
    case "calculation":
      return "calculation_result";
    case "document_authoring":
    case "media_image":
      return "document_package";
    case "document_ingest":
      return "document_extraction";
    default:
      return "clarification_needed";
  }
}

function heuristicInteractionMode(taskClass: TaskClass, input: RecipePlannerInput): InteractionMode {
  if (input.lowConfidenceStrategy === "clarify") {
    return "clarify_first";
  }
  if (taskClass === "document_authoring" || taskClass === "media_image") {
    return "artifact_iteration";
  }
  if ((input.requestedTools?.length ?? 0) > 0 || (input.fileNames?.length ?? 0) > 0 || taskClass === "code" || taskClass === "publish") {
    return "tool_execution";
  }
  return "respond_only";
}

function heuristicConfidence(input: RecipePlannerInput): number {
  switch (input.confidence) {
    case "high":
      return 0.92;
    case "medium":
      return 0.68;
    case "low":
      return 0.4;
    default:
      return 0.7;
  }
}

function heuristicContract(prompt: string, fileNames: string[]): TaskContract {
  const input = buildExecutionDecisionInput({ prompt, fileNames });
  const taskClass = heuristicToTaskClass(input);
  return {
    primaryOutcome: heuristicPrimaryOutcome(taskClass, input),
    requiredCapabilities: heuristicCapabilities(input, taskClass),
    interactionMode: heuristicInteractionMode(taskClass, input),
    confidence: heuristicConfidence(input),
    ambiguities: sortUnique(input.ambiguityReasons ?? [])
  };
}

async function runModelCase(params: {
  caseItem: CorpusCase;
  model: ResolvedExperimentModel;
  schema: Record<string, unknown>;
  promptTemplate: PromptTemplate;
}): Promise<CaseRunResult> {
  const renderedPrompt = renderUserPrompt({
    template: params.promptTemplate.userTemplate,
    schema: params.schema,
    caseItem: params.caseItem
  });

  const startedAt = Date.now();
  const isLocalBaseline = params.model.slot === "local_baseline";
  try {
    const result = await completeSimple(
      params.model.model,
      {
        messages: [
          {
            role: "system",
            content: params.promptTemplate.systemPrompt,
            timestamp: Date.now()
          },
          {
            role: "user",
            content: renderedPrompt,
            timestamp: Date.now()
          }
        ]
      },
      {
        apiKey: params.model.apiKey,
        maxTokens: isLocalBaseline ? LOCAL_MAX_TOKENS : MAX_TOKENS,
        temperature: 0,
        signal: AbortSignal.timeout(isLocalBaseline ? LOCAL_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS)
      }
    );
    const rawOutput = extractText(result) || "";
    const parsed = safeParseTaskContract(rawOutput);
    const validation = parsed
      ? validateJsonSchemaValue({
          schema: params.schema,
          cacheKey: SCHEMA_CACHE_KEY,
          value: parsed
        })
      : { ok: false as const };
    const schemaValid = validation.ok === true;
    const score = scoreContract({
      expected: params.caseItem.expected,
      predicted: parsed,
      schemaValid
    });
    const resolvedContract = parsed ? resolveTaskContract(parsed) : null;
    return {
      caseId: params.caseItem.id,
      caseTaskClass: params.caseItem.taskClass,
      modelKey: `${params.model.slot}:${params.model.label}`,
      modelLabel: params.model.label,
      modelId: params.model.model.id,
      provider: params.model.model.provider,
      slot: params.model.slot,
      latencyMs: Date.now() - startedAt,
      ok: true,
      schemaValid,
      rawOutput,
      parsedJson: parsed,
      resolvedContract,
      expected: params.caseItem.expected,
      expectedResolutionFamily: params.caseItem.expectedResolutionFamily,
      resolutionFamilyExact: resolvedContract
        ? resolvedContract.selectedFamily === params.caseItem.expectedResolutionFamily
        : null,
      score
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const score = scoreContract({
      expected: params.caseItem.expected,
      predicted: null,
      schemaValid: false
    });
    return {
      caseId: params.caseItem.id,
      caseTaskClass: params.caseItem.taskClass,
      modelKey: `${params.model.slot}:${params.model.label}`,
      modelLabel: params.model.label,
      modelId: params.model.model.id,
      provider: params.model.model.provider,
      slot: params.model.slot,
      latencyMs: Date.now() - startedAt,
      ok: false,
      error: message,
      schemaValid: false,
      rawOutput: "",
      parsedJson: null,
      resolvedContract: null,
      expected: params.caseItem.expected,
      expectedResolutionFamily: params.caseItem.expectedResolutionFamily,
      resolutionFamilyExact: null,
      score
    };
  }
}

function runHeuristicBaseline(caseItem: CorpusCase, schema: Record<string, unknown>): CaseRunResult {
  const startedAt = Date.now();
  const predicted = heuristicContract(caseItem.prompt, caseItem.fileNames);
  const validation = validateJsonSchemaValue({
    schema,
    cacheKey: SCHEMA_CACHE_KEY,
    value: predicted
  });
  const schemaValid = validation.ok === true;
  const score = scoreContract({
    expected: caseItem.expected,
    predicted,
    schemaValid
  });
  return {
    caseId: caseItem.id,
    caseTaskClass: caseItem.taskClass,
    modelKey: "baseline:heuristic",
    modelLabel: "heuristic-baseline",
    modelId: "buildExecutionDecisionInput",
    provider: "baseline",
    slot: "baseline",
    latencyMs: Date.now() - startedAt,
    ok: true,
    schemaValid,
    rawOutput: JSON.stringify(predicted),
    parsedJson: predicted,
    resolvedContract: resolveTaskContract(predicted),
    expected: caseItem.expected,
    expectedResolutionFamily: caseItem.expectedResolutionFamily,
    resolutionFamilyExact:
      resolveTaskContract(predicted).selectedFamily === caseItem.expectedResolutionFamily,
    score
  };
}

function aggregateCapabilitiesMetrics(results: CaseRunResult[]) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const result of results) {
    const expectedSet = new Set(result.expected.requiredCapabilities);
    const predictedSet = new Set(result.parsedJson?.requiredCapabilities ?? []);
    for (const capability of predictedSet) {
      if (expectedSet.has(capability)) {
        tp += 1;
      } else {
        fp += 1;
      }
    }
    for (const capability of expectedSet) {
      if (!predictedSet.has(capability)) {
        fn += 1;
      }
    }
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function buildAggregateMetrics(params: {
  results: CaseRunResult[];
  model: {
    key: string;
    label: string;
    slot: string;
    provider: string;
    modelId: string;
    why: string;
    resolvedFrom: string;
  };
}): AggregateMetrics {
  const scores = params.results.map((result) => result.score.total);
  const latencies = params.results.map((result) => result.latencyMs);
  const capabilities = aggregateCapabilitiesMetrics(params.results);
  return {
    modelKey: params.model.key,
    modelLabel: params.model.label,
    slot: params.model.slot,
    provider: params.model.provider,
    modelId: params.model.modelId,
    why: params.model.why,
    resolvedFrom: params.model.resolvedFrom,
    avgScore: round(average(scores), 2),
    medianScore: round(median(scores), 2),
    avgLatencyMs: round(average(latencies), 1),
    schemaValidRate: average(params.results.map((result) => (result.schemaValid ? 1 : 0))),
    exactPrimaryOutcomeRate: average(
      params.results.map((result) => (result.score.primaryOutcome.exact ? 1 : 0))
    ),
    exactInteractionModeRate: average(
      params.results.map((result) => (result.score.interactionMode.exact ? 1 : 0))
    ),
    resolutionFamilyAccuracy: average(
      params.results.map((result) =>
        result.expectedResolutionFamily
          ? result.resolutionFamilyExact === true
            ? 1
            : 0
          : 1
      )
    ),
    capabilityPrecision: capabilities.precision,
    capabilityRecall: capabilities.recall,
    capabilityF1: capabilities.f1,
    worstCases: [...params.results]
      .sort((left, right) => left.score.total - right.score.total)
      .slice(0, 5)
      .map((result) => ({
        caseId: result.caseId,
        score: result.score.total,
        schemaValid: result.schemaValid,
        rawOutput: result.rawOutput
      }))
  };
}

function countBy<T extends string>(values: T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key}: ${count}`)
    .join(", ");
}

function renderMetricsTable(metrics: AggregateMetrics[]): string {
  const rows = [
    "| Model | Resolved as | Avg score | Schema valid | Avg latency ms | Capability P/R/F1 | Exact outcome | Exact mode | Exact family |",
    "| --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |"
  ];
  for (const metric of metrics) {
    rows.push(
      `| ${metric.modelLabel} | ${metric.provider}/${metric.modelId} | ${metric.avgScore.toFixed(1)} | ${toPercent(metric.schemaValidRate).toFixed(1)}% | ${metric.avgLatencyMs.toFixed(1)} | ${toPercent(metric.capabilityPrecision).toFixed(1)} / ${toPercent(metric.capabilityRecall).toFixed(1)} / ${toPercent(metric.capabilityF1).toFixed(1)} | ${toPercent(metric.exactPrimaryOutcomeRate).toFixed(1)}% | ${toPercent(metric.exactInteractionModeRate).toFixed(1)}% | ${toPercent(metric.resolutionFamilyAccuracy).toFixed(1)}% |`
    );
  }
  return rows.join("\n");
}

function chooseBestShadowModel(metrics: AggregateMetrics[]): AggregateMetrics {
  const remoteCandidates = metrics.filter(
    (metric) => metric.slot === "cheap_remote" || metric.slot === "balanced_remote"
  );
  const sorted = [...remoteCandidates].sort((left, right) => {
    const leftUsable = left.avgScore >= 82 && left.schemaValidRate >= 0.9 ? 1 : 0;
    const rightUsable = right.avgScore >= 82 && right.schemaValidRate >= 0.9 ? 1 : 0;
    if (leftUsable !== rightUsable) {
      return rightUsable - leftUsable;
    }
    if (Math.abs(left.avgScore - right.avgScore) <= 3) {
      return left.avgLatencyMs - right.avgLatencyMs;
    }
    return right.avgScore - left.avgScore;
  });
  return sorted[0] ?? metrics[0];
}

function chooseArbiterModel(metrics: AggregateMetrics[]): AggregateMetrics {
  const arbiter = metrics.find((metric) => metric.slot === "arbiter_remote");
  if (arbiter) {
    return arbiter;
  }
  return [...metrics].sort((left, right) => right.avgScore - left.avgScore)[0] ?? metrics[0];
}

function isShadowReady(metric: AggregateMetrics): boolean {
  return (
    metric.avgScore >= 82 &&
    metric.schemaValidRate >= 0.95 &&
    metric.capabilityF1 >= 0.82 &&
    metric.exactPrimaryOutcomeRate >= 0.9 &&
    metric.exactInteractionModeRate >= 0.85
  );
}

function deriveFailurePatterns(results: CaseRunResult[]): string[] {
  const patterns: string[] = [];
  const schemaInvalid = results.filter((result) => !result.schemaValid).length;
  if (schemaInvalid > 0) {
    patterns.push(`Schema failures: ${schemaInvalid}/${results.length} cases returned invalid or unparseable JSON.`);
  }
  const overCapability = results.filter((result) => result.score.requiredCapabilities.extras.length > 0).length;
  if (overCapability > 0) {
    patterns.push(`Over-predicted capabilities in ${overCapability}/${results.length} cases.`);
  }
  const weakestClasses = countBy(
    [...results]
      .sort((left, right) => left.score.total - right.score.total)
      .slice(0, 8)
      .map((result) => result.caseTaskClass)
  );
  if (Object.keys(weakestClasses).length > 0) {
    patterns.push(`Worst-scoring classes cluster in: ${formatCounts(weakestClasses)}.`);
  }
  return patterns;
}

function buildRecommendation(params: {
  bestShadow: AggregateMetrics;
  arbiter: AggregateMetrics;
  allResults: CaseRunResult[];
}): { recommendation: string[]; nextStep: string[] } {
  const recommendation: string[] = [
    `Shadow classifier candidate: ${params.bestShadow.modelLabel} (${params.bestShadow.provider}/${params.bestShadow.modelId}).`,
    `Control / arbiter model: ${params.arbiter.modelLabel} (${params.arbiter.provider}/${params.arbiter.modelId}).`,
    "Prompt: keep the strict JSON-only classifier prompt stable while iterating only the deterministic resolver layer."
  ];
  if (isShadowReady(params.bestShadow)) {
    recommendation.push("Quality bar: good enough for Phase 1 shadow mode.");
    return {
      recommendation,
      nextStep: [
        "Run the same harness on a larger real-message slice before wiring any routing decisions.",
        "Keep the classifier read-only and compare it against the current heuristic while evaluating the resolver projection separately."
      ]
    };
  }
  recommendation.push("Quality bar: not yet good enough for Phase 1 shadow mode.");
  const schemaInvalid = params.allResults.filter(
    (result) => result.modelKey === params.bestShadow.modelKey && !result.schemaValid
  ).length;
  return {
    recommendation,
    nextStep: [
      schemaInvalid > 0
        ? "Harden the prompt against non-JSON output before the next run."
        : "Tighten the capability vocabulary on mixed browser/code and document/package cases before the next run.",
      "Expand resolver coverage and add more cases around publish/browser ambiguity without changing planner behavior yet."
    ]
  };
}

function renderPromptSection(promptTemplate: PromptTemplate): string {
  return [
    "System prompt:",
    "```text",
    promptTemplate.systemPrompt,
    "```",
    "",
    "User template:",
    "```text",
    promptTemplate.userTemplate,
    "```"
  ].join("\n");
}

function renderSchemaSection(schema: Record<string, unknown>): string {
  return [
    `Schema file: \`scripts/dev/task-contract-eval/schema/task-contract.schema.json\``,
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```"
  ].join("\n");
}

function renderResolutionSchemaSection(schema: Record<string, unknown>): string {
  return [
    `Resolution schema file: \`scripts/dev/task-contract-eval/schema/resolution-contract.schema.json\``,
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```"
  ].join("\n");
}

function renderWorstCases(metrics: AggregateMetrics[]): string {
  const lines: string[] = [];
  for (const metric of metrics) {
    lines.push(`- ${metric.modelLabel}: ${metric.worstCases.map((item) => `${item.caseId} (${item.score})`).join(", ")}`);
  }
  return lines.join("\n");
}

function buildMarkdownReport(params: {
  corpus: CorpusCase[];
  promptTemplate: PromptTemplate;
  schema: Record<string, unknown>;
  resolutionSchema: Record<string, unknown>;
  metrics: AggregateMetrics[];
  bestShadow: AggregateMetrics;
  arbiter: AggregateMetrics;
  recommendation: string[];
  nextStep: string[];
  allResults: CaseRunResult[];
  runScopeLabel: string;
}): string {
  const languageSummary = formatCounts(countBy(params.corpus.map((item) => item.language)));
  const classSummary = formatCounts(countBy(params.corpus.map((item) => item.taskClass)));
  const attachmentCases = params.corpus.filter((item) => item.fileNames.length > 0).length;
  const failurePatterns = deriveFailurePatterns(params.allResults);

  return [
    "# Task Contract Eval Report",
    "",
    "## What was tested",
    "",
    "- Offline/shadow-only task classification harness.",
    "- No recipe execution, no tool runtime integration, no planner mutation.",
    `- Run scope: ${params.runScopeLabel}.`,
    "- Each case was scored against gold contracts and the current heuristic baseline.",
    "",
    "## Models compared",
    "",
    ...params.metrics.map(
      (metric) =>
        `- ${metric.modelLabel}: ${metric.provider}/${metric.modelId} (resolved from ${metric.resolvedFrom}). ${metric.why}`
    ),
    "",
    "## Prompt used",
    "",
    renderPromptSection(params.promptTemplate),
    "",
    "## Schema used",
    "",
    renderSchemaSection(params.schema),
    "",
    "## Resolver schema used",
    "",
    renderResolutionSchemaSection(params.resolutionSchema),
    "",
    "## Dataset summary",
    "",
    `- Total cases: ${params.corpus.length}`,
    `- Cases with attachment file names: ${attachmentCases}`,
    `- Language mix: ${languageSummary}`,
    `- Class coverage: ${classSummary}`,
    "",
    "## Per-model metrics",
    "",
    renderMetricsTable(params.metrics),
    "",
    "## Best model",
    "",
    `- First shadow-classifier candidate: ${params.bestShadow.modelLabel} (${params.bestShadow.provider}/${params.bestShadow.modelId})`,
    `- Control / arbiter: ${params.arbiter.modelLabel} (${params.arbiter.provider}/${params.arbiter.modelId})`,
    `- Phase 1 shadow readiness: ${isShadowReady(params.bestShadow) ? "yes" : "no"}`,
    "",
    "## Failure patterns",
    "",
    ...(failurePatterns.length > 0 ? failurePatterns.map((pattern) => `- ${pattern}`) : ["- No dominant failure pattern detected."]),
    "",
    "Worst cases:",
    renderWorstCases(params.metrics),
    "",
    "## Recommendation",
    "",
    ...params.recommendation.map((line) => `- ${line}`),
    "",
    "## Next step",
    "",
    ...params.nextStep.map((line) => `- ${line}`),
    ""
  ].join("\n");
}

function buildSummary(params: {
  bestShadow: AggregateMetrics;
  arbiter: AggregateMetrics;
  runScopeLabel: string;
}): string {
  return [
    `Run scope: ${params.runScopeLabel}`,
    `Best first shadow classifier: ${params.bestShadow.modelLabel} (${params.bestShadow.provider}/${params.bestShadow.modelId})`,
    `Control / arbiter: ${params.arbiter.modelLabel} (${params.arbiter.provider}/${params.arbiter.modelId})`,
    `Score: ${params.bestShadow.avgScore.toFixed(1)} avg, schema ${toPercent(params.bestShadow.schemaValidRate).toFixed(1)}%, capability F1 ${toPercent(params.bestShadow.capabilityF1).toFixed(1)}%`,
    `Phase 1 shadow ready: ${isShadowReady(params.bestShadow) ? "yes" : "no"}`
  ].join("\n");
}

async function writeOutputs(params: {
  payload: Record<string, unknown>;
  report: string;
  summary: string;
  isSubsetRun: boolean;
}) {
  await ensureDir(OUTPUT_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(OUTPUT_DIR, `task-contract-eval-${stamp}.json`);
  const reportPath = path.join(OUTPUT_DIR, `task-contract-eval-${stamp}.report.md`);
  const summaryPath = path.join(OUTPUT_DIR, `task-contract-eval-${stamp}.summary.md`);
  const latestJsonPath = path.join(
    OUTPUT_DIR,
    params.isSubsetRun ? "latest-targeted-results.json" : "latest-results.json"
  );
  const latestReportPath = path.join(
    OUTPUT_DIR,
    params.isSubsetRun ? "latest-targeted-report.md" : "latest-report.md"
  );
  const latestSummaryPath = path.join(
    OUTPUT_DIR,
    params.isSubsetRun ? "latest-targeted-summary.md" : "latest-summary.md"
  );

  await fs.writeFile(jsonPath, JSON.stringify(params.payload, null, 2));
  await fs.writeFile(reportPath, params.report);
  await fs.writeFile(summaryPath, params.summary);
  await fs.writeFile(latestJsonPath, JSON.stringify(params.payload, null, 2));
  await fs.writeFile(latestReportPath, params.report);
  await fs.writeFile(latestSummaryPath, params.summary);

  return {
    jsonPath,
    reportPath,
    summaryPath,
    latestJsonPath,
    latestReportPath,
    latestSummaryPath
  };
}

async function main() {
  const args = parseArgs();
  const schema = normalizeSchemaForAjv(await readJsonFile<Record<string, unknown>>(SCHEMA_PATH));
  const resolutionSchema = normalizeSchemaForAjv(
    await readJsonFile<Record<string, unknown>>(RESOLUTION_SCHEMA_PATH)
  );
  const promptTemplate = await readJsonFile<PromptTemplate>(PROMPT_TEMPLATE_PATH);
  let corpus = (await readJsonFile<
    Array<{
      id: string;
      language: string;
      taskClass: TaskClass;
      prompt: string;
      fileNames?: string[];
      expected: LegacyTaskContract;
    }>
  >(CORPUS_PATH)).map(normalizeCorpusCase);
  if (args.caseFilter) {
    corpus = corpus.filter((item) => args.caseFilter?.has(item.id));
  }
  if (args.limit > 0) {
    corpus = corpus.slice(0, args.limit);
  }
  if (corpus.length === 0) {
    throw new Error("Corpus is empty after filtering.");
  }
  const isSubsetRun = Boolean(args.caseFilter) || args.limit > 0;
  const runScopeLabel = isSubsetRun ? `subset (${corpus.length} cases)` : `full corpus (${corpus.length} cases)`;

  const resolvedModels = await resolveExperimentModels();
  const filteredModels = args.modelFilter
    ? resolvedModels.filter(
        (model) => args.modelFilter?.has(model.label) || args.modelFilter?.has(model.slot)
      )
    : resolvedModels;
  if (filteredModels.length === 0) {
    throw new Error("No models selected after filtering.");
  }

  const allResults: CaseRunResult[] = [];
  const heuristicResults = corpus.map((caseItem) => runHeuristicBaseline(caseItem, schema));
  allResults.push(...heuristicResults);

  for (const model of filteredModels) {
    for (const caseItem of corpus) {
      const result = await runModelCase({
        caseItem,
        model,
        schema,
        promptTemplate
      });
      allResults.push(result);
      process.stdout.write(
        `${model.label.padEnd(14)} ${caseItem.id.padEnd(34)} score=${result.score.total
          .toFixed(1)
          .padStart(5)} schema=${result.schemaValid ? "ok" : "bad"} latency=${result.latencyMs}ms\n`
      );
    }
  }

  const metricModels: AggregateMetrics[] = [];
  metricModels.push(
    buildAggregateMetrics({
      results: heuristicResults,
      model: {
        key: "baseline:heuristic",
        label: "heuristic-baseline",
        slot: "baseline",
        provider: "baseline",
        modelId: "buildExecutionDecisionInput",
        why: "Current prompt/tools/artifacts heuristic projected into TaskContract.",
        resolvedFrom: "n/a"
      }
    })
  );

  for (const model of filteredModels) {
    const key = `${model.slot}:${model.label}`;
    metricModels.push(
      buildAggregateMetrics({
        results: allResults.filter((result) => result.modelKey === key),
        model: {
          key,
          label: model.label,
          slot: model.slot,
          provider: model.model.provider,
          modelId: model.model.id,
          why: model.why,
          resolvedFrom: `${model.resolvedFrom.provider}/${model.resolvedFrom.modelId}`
        }
      })
    );
  }

  const comparableModels = metricModels.filter((metric) => metric.slot !== "baseline");
  const bestShadow = chooseBestShadowModel(comparableModels);
  const arbiter = chooseArbiterModel(comparableModels);
  const recommendation = buildRecommendation({
    bestShadow,
    arbiter,
    allResults
  });

  const report = buildMarkdownReport({
    corpus,
    promptTemplate,
    schema,
    resolutionSchema,
    metrics: metricModels,
    bestShadow,
    arbiter,
    recommendation: recommendation.recommendation,
    nextStep: recommendation.nextStep,
    allResults,
    runScopeLabel
  });
  const summary = buildSummary({ bestShadow, arbiter, runScopeLabel });

  const payload = {
    generatedAt: new Date().toISOString(),
    runScope: runScopeLabel,
    corpusPath: CORPUS_PATH,
    schemaPath: SCHEMA_PATH,
    resolutionSchemaPath: RESOLUTION_SCHEMA_PATH,
    promptTemplatePath: PROMPT_TEMPLATE_PATH,
    models: metricModels,
    caseResults: allResults
  };

  const outputPaths = await writeOutputs({ payload, report, summary, isSubsetRun });
  process.stdout.write(`\nReport: ${outputPaths.latestReportPath}\n`);
  process.stdout.write(`Summary: ${outputPaths.latestSummaryPath}\n`);
  process.stdout.write(`Raw results: ${outputPaths.latestJsonPath}\n`);
}

await main();
