import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { parseModelRef } from "../../agents/model-selection.js";
import type { PluginHookPlatformExecutionContext } from "../../plugins/types.js";
import type { BootstrapResolution } from "../bootstrap/contracts.js";
import { TRUSTED_CAPABILITY_CATALOG } from "../bootstrap/defaults.js";
import { resolveBootstrapRequests } from "../bootstrap/resolver.js";
import type {
  PlatformExecutionContextSnapshot,
  PlatformExecutionContextReadinessStatus,
  PlatformExecutionContextUnattendedBoundary,
} from "../decision/contracts.js";
import { inferExecutionContract, inferRequestedEvidence } from "../decision/execution-contract.js";
import { inferOutcomeContract } from "../decision/outcome-contract.js";
import type {
  CandidateExecutionFamily,
  OutcomeContract,
  QualificationConfidence,
  QualificationExecutionContract,
  QualificationLowConfidenceStrategy,
  RequestedEvidenceKind,
} from "../decision/qualification-contract.js";
import type { ResolutionContract } from "../decision/resolution-contract.js";
import { evaluatePolicy } from "../policy/engine.js";
import type { PolicyContext, PolicyDecision } from "../policy/types.js";
import { resolveProducer, type DeliverableSpec } from "../produce/registry.js";
import { getInitialProfile, getTaskOverlay } from "../profile/defaults.js";
import { applyTaskOverlay } from "../profile/overlay.js";
import { createCapabilityRegistry } from "../registry/capability-registry.js";
import type { CapabilityRegistry } from "../registry/types.js";
import {
  PlatformRuntimeExecutionSurfaceSchema,
  type PlatformRuntimeExecutionSurface,
} from "../runtime/index.js";
import type { CapabilityCatalogEntry } from "../schemas/capability.js";
import type { ArtifactKind } from "../schemas/index.js";
import type { ProfileId } from "../schemas/profile.js";
import type {
  ClassifierTelemetry,
  RecipePlannerInput,
  RecipeRoutingHints,
  RoutingOutcome,
} from "./planner.js";
import { planExecutionRecipe, type ExecutionPlan } from "./planner.js";

export type { ClassifierTelemetry, RoutingOutcome } from "./planner.js";

export type RecipeRuntimePlan = {
  selectedRecipeId: string;
  selectedProfileId: ProfileId;
  contractFirst?: boolean;
  taskOverlayId?: string;
  plannerReasoning?: string;
  intent?: RecipePlannerInput["intent"];
  routing?: RecipeRoutingHints;
  providerOverride?: string;
  modelOverride?: string;
  fallbackModels?: string[];
  timeoutSeconds?: number;
  artifactKinds?: ArtifactKind[];
  requestedToolNames?: string[];
  confidence?: QualificationConfidence;
  ambiguityReasons?: string[];
  lowConfidenceStrategy?: QualificationLowConfidenceStrategy;
  candidateFamilies?: CandidateExecutionFamily[];
  resolutionContract?: ResolutionContract;
  outcomeContract?: OutcomeContract;
  executionContract?: QualificationExecutionContract;
  requestedEvidence?: RequestedEvidenceKind[];
  publishTargets?: string[];
  requiredCapabilities?: string[];
  bootstrapRequiredCapabilities?: string[];
  requireExplicitApproval?: boolean;
  policyAutonomy?: PolicyDecision["autonomy"];
  readinessStatus?: PlatformExecutionContextReadinessStatus;
  readinessReasons?: string[];
  unattendedBoundary?: PlatformExecutionContextUnattendedBoundary;
  deliverable?: DeliverableSpec;
  prependSystemContext?: string;
  prependContext?: string;
  classifierTelemetry?: ClassifierTelemetry;
  /**
   * Structured routing status from the planner. Consumers MUST check
   * {@link RoutingOutcome.kind} before claiming successful execution:
   * only `matched` represents a contract that was actually satisfied.
   */
  routingOutcome?: RoutingOutcome;
  /**
   * Heuristic upper-bound estimate of the run's duration in milliseconds.
   * Forwarded from the execution plan so downstream dispatchers can decide
   * whether to issue an immediate ack and defer the actual work.
   * See {@link ExecutionPlan.estimatedDurationMs}.
   */
  estimatedDurationMs?: number;
  /**
   * Deferral decision from the planner (P1.4 D.2 "Ack-then-defer").
   * See {@link ExecutionPlan.ackThenDefer}.
   */
  ackThenDefer?: boolean;
};

export type PlatformCapabilityRequirement = {
  capabilityId: string;
  capabilityLabel?: string;
  status: BootstrapResolution["status"];
  requiresBootstrap: boolean;
  reasons?: string[];
};

export type PlatformCapabilitySummary = {
  requiredCapabilities: string[];
  bootstrapRequiredCapabilities: string[];
  unresolvedCapabilities: string[];
  requirements: PlatformCapabilityRequirement[];
  bootstrapResolutions: BootstrapResolution[];
};

const STRUCTURED_OUTPUT_ARTIFACT_KINDS = new Set<ArtifactKind>([
  "document",
  "estimate",
  "site",
  "release",
  "binary",
  "video",
  "image",
  "audio",
  "archive",
]);

export type ResolvedPlatformExecutionDecision = ExecutionPlan & {
  runtime: RecipeRuntimePlan;
  policyContext: PolicyContext;
  policyPreview: PolicyDecision;
  capabilitySummary: PlatformCapabilitySummary;
};

export type ResolvedPlatformRuntimePlan = ResolvedPlatformExecutionDecision;

export type ResolvePlatformExecutionDecisionOptions = {
  explicitApproval?: boolean;
  capabilityRegistry?: CapabilityRegistry;
  capabilityCatalog?: CapabilityCatalogEntry[];
  policyContextOverrides?: Pick<
    PolicyContext,
    | "explicitApproval"
    | "requestedMachineControl"
    | "machineControlLinked"
    | "machineControlKillSwitchEnabled"
    | "machineControlDeviceId"
    | "touchesSensitiveData"
  >;
};

export type PlatformExecutionReadiness = {
  status: PlatformExecutionContextReadinessStatus;
  reasons: string[];
  unattendedBoundary?: PlatformExecutionContextUnattendedBoundary;
};

function normalizePlannerIntentForPolicy(
  intent: RecipePlannerInput["intent"] | undefined,
): PolicyContext["intent"] | undefined {
  if (intent === "compare" || intent === "calculation") {
    return "document";
  }
  return intent;
}

function normalizePlannerIntentForBootstrapSourceDomain(
  intent: RecipePlannerInput["intent"] | undefined,
): PolicyContext["intent"] | undefined {
  return normalizePlannerIntentForPolicy(intent);
}

export function buildExecutionSurfaceSnapshot(params: {
  readiness: PlatformExecutionReadiness;
  capabilitySummary: PlatformCapabilitySummary;
  checkedAtMs?: number;
  cacheTtlMs?: number;
  modelFallbackActive?: boolean;
}): PlatformRuntimeExecutionSurface {
  const status =
    params.readiness.status === "ready"
      ? "ready"
      : params.readiness.status === "bootstrap_required"
        ? "bootstrap_required"
        : params.readiness.status === "approval_required"
          ? "approval_required"
          : "degraded";
  return PlatformRuntimeExecutionSurfaceSchema.parse({
    status,
    ready: status === "ready",
    checkedAtMs: params.checkedAtMs ?? Date.now(),
    cacheTtlMs: params.cacheTtlMs,
    reasons: params.readiness.reasons,
    bootstrapRequiredCapabilities: params.capabilitySummary.bootstrapRequiredCapabilities,
    unresolvedCapabilities: params.capabilitySummary.unresolvedCapabilities,
    modelFallbackActive: params.modelFallbackActive,
    approvalRequired: status === "approval_required",
  });
}

/**
 * Returns execution-time guardrails for artifact requests that must not degrade
 * into a plain status message.
 *
 * Fires when artifact kinds include a structured kind OR when the qualification
 * contract explicitly declares a structured artifact outcome / evidence requirement.
 * This ensures runs qualified as structured_artifact get the guardrail even when
 * artifact kinds are absent or underspecified.
 *
 * @param {ArtifactKind[] | undefined} artifactKinds - Requested artifact kinds from planner input.
 * @param {OutcomeContract | undefined} outcomeContract - Explicit outcome contract from qualification.
 * @param {QualificationExecutionContract | undefined} executionContract - Explicit execution contract.
 * @returns {string | undefined} Extra system guidance when the run must emit a tangible artifact.
 */
function buildArtifactOutputGuardrails(
  artifactKinds?: ArtifactKind[],
  outcomeContract?: OutcomeContract,
  executionContract?: QualificationExecutionContract,
): string | undefined {
  const hasStructuredArtifactKind = artifactKinds?.some((kind) =>
    STRUCTURED_OUTPUT_ARTIFACT_KINDS.has(kind),
  );
  const contractRequiresArtifact =
    outcomeContract === "structured_artifact" ||
    executionContract?.requiresArtifactEvidence === true;
  if (!hasStructuredArtifactKind && !contractRequiresArtifact) {
    return undefined;
  }
  const lines = [
    "Artifact contract: do not claim completion without producing a real artifact or attachment.",
    "When a file-like deliverable is requested, use the appropriate tool and return the actual deliverable instead of a text-only status update.",
  ];
  if (artifactKinds?.includes("site")) {
    lines.push(
      "Site / web UI contract: when the user asks for a website, SPA, or local preview, you must call `write` and/or `exec` (install, build, or dev server as needed) before your final reply. Do not answer with only a plan, apology, or a localhost URL unless tools ran and project files were updated in this turn.",
    );
  }
  return lines.join(" ");
}

function buildRequestedToolGuardrails(requestedToolNames?: string[]): string | undefined {
  if (!requestedToolNames?.length) {
    return undefined;
  }
  const toolSet = new Set(requestedToolNames.map((tool) => tool.trim().toLowerCase()));
  const guardrails: string[] = [];
  if (toolSet.has("image_generate")) {
    guardrails.push(
      "Image artifact contract: when the user asks you to generate or edit an image, you must call image_generate before your first final answer and return the actual generated image instead of a text-only description, acknowledgement, or brainstorm.",
    );
  }
  if (toolSet.has("pdf")) {
    guardrails.push(
      "PDF artifact contract: when the user asks for a PDF or slide-style document from prompt text, you must use the pdf tool before your first final answer to create the deliverable instead of replying with instructions, an acknowledgement, or a plan. For prompt-only PDF generation, pass the requested document content in the pdf tool's `prompt` argument and include `filename` when the user implies a saved file. Do not call `pdf` with an empty object for a prompt-only PDF task. Do not fake PDF output, manually write PDF bytes, or bypass the pdf tool with write/exec when the task requires a real PDF deliverable.",
    );
  }
  if (toolSet.has("image_generate") && toolSet.has("pdf")) {
    guardrails.push(
      "Multi-step artifact contract: when supporting images feed a final PDF deliverable, treat image_generate as an intermediate step only. After the required images succeed, you must continue in the same turn and call pdf to assemble the final document artifact before any text-only reply. Reuse successful generated image outputs from the current session instead of stopping, restarting from scratch, or asking for extra style confirmation unless the user explicitly requested a choice.",
    );
  }
  if (toolSet.has("docx_write")) {
    guardrails.push(
      "DOCX artifact contract: when the deliverable is a Word (docx) document, you must call the docx_write tool in this turn. Pass the full document content in the tool arguments (the classifier already resolved title/sections/language). Do not reply with only a plan, acknowledgement, or clarifying question.",
    );
  }
  if (toolSet.has("xlsx_write")) {
    guardrails.push(
      "XLSX artifact contract: when the deliverable is an Excel (xlsx) document, you must call the xlsx_write tool in this turn with the sheet structure and rows you invent if the user left them unspecified. Do not ask for exact columns/rows — pick reasonable defaults and include them in the tool arguments.",
    );
  }
  if (toolSet.has("csv_write")) {
    guardrails.push(
      "CSV artifact contract: when the deliverable is a CSV document, you must call the csv_write tool in this turn. Invent reasonable columns/rows if the user left them unspecified and include them in the tool arguments. Do not reply with a plan or question instead.",
    );
  }
  if (toolSet.has("site_pack")) {
    guardrails.push(
      "Site artifact contract: when the deliverable is a packaged website (zip/html), you must call the site_pack tool in this turn with the complete file set (index.html plus any assets). Invent reasonable default copy if not provided. Do not reply with only a plan, a URL, or a clarifying question.",
    );
  }
  if (toolSet.has("capability_install")) {
    guardrails.push(
      "Capability install contract: when the user requests installation of a library/capability, you must call capability_install with the packageRef and optional version/integrity in this turn. Do not reply with only an acknowledgement or a plan.",
    );
  }
  if (toolSet.has("apply_patch")) {
    guardrails.push(
      "Code-change contract: when the deliverable is a workspace mutation (add/update/delete files), you must call apply_patch in this turn with a structured patch input (*** Begin Patch / *** Add File: <path> / *** Update File: <path> / *** End Patch). Pass the exact target path(s) and the full new or updated file contents through the patch body. Do not paste the patch into chat text instead of invoking the tool. Do not reply with a plan, acknowledgement, or diff preview without calling apply_patch first.",
    );
  }
  if (toolSet.has("write") && !toolSet.has("apply_patch") && !toolSet.has("image_generate")) {
    guardrails.push(
      "Workspace-file contract: when the deliverable is a brand-new file under the workspace, you may call write with the exact path and full file contents in this turn. Do not only describe the file; emit the tool call that actually creates it.",
    );
  }
  if (toolSet.has("exec")) {
    guardrails.push(
      "Repo-execution contract: when the deliverable is a command/script/test-report invocation, you must call exec in this turn with the literal command the user requested (or the closest safe equivalent for running the test suite). Pass args and cwd that reflect the request. Do not substitute exec with chat text describing what the command would print.",
    );
  }
  if (toolSet.has("sessions_spawn")) {
    guardrails.push(
      "Session orchestration contract: when the user asks for a persistent worker, named subagent, or follow-up/background session, you must call sessions_spawn in this turn. Use continuation=\"followup\" unless the deliverable contract explicitly says otherwise. Do not use cron, publish, repo execution, or a text-only plan as a substitute.",
    );
  }
  return guardrails.length > 0 ? guardrails.join(" ") : undefined;
}

function buildClarificationGuardrails(params: {
  lowConfidenceStrategy?: QualificationLowConfidenceStrategy;
  ambiguityReasons?: string[];
}): string | undefined {
  if (params.lowConfidenceStrategy !== "clarify") {
    return undefined;
  }
  return [
    "Clarification path: preserve the original qualified task semantics, but do not execute tools, mutate the workspace, or claim completion on this turn.",
    params.ambiguityReasons?.length
      ? `Ask one concise clarifying question that resolves the blocking ambiguity: ${params.ambiguityReasons.join("; ")}.`
      : "Ask one concise clarifying question that resolves the blocking ambiguity before execution continues.",
  ].join(" ");
}

/**
 * Keeps reply language aligned with the user's latest turn so lightweight local
 * models do not drift into an unrelated language on simple chat requests.
 *
 * @returns {string} Stable language-continuity instruction for the system prompt.
 */
function buildReplyLanguageGuardrail(): string {
  return "Reply in the same language as the user's latest message unless they explicitly ask for another language.";
}

/**
 * Serializes the deliverable contract into an instruction block so the
 * downstream LLM agent knows exactly which artifact kind/format/constraints the
 * user expects and can pass matching parameters into the chosen tool (e.g.
 * pdf/image/csv). This removes the need for tools to parse user prompts.
 */
function buildDeliverableContractGuidance(deliverable?: DeliverableSpec): string | undefined {
  if (!deliverable) {
    return undefined;
  }
  const parts: string[] = [];
  parts.push(`kind=${deliverable.kind}`);
  if (deliverable.acceptedFormats?.length) {
    parts.push(`acceptedFormats=[${deliverable.acceptedFormats.join(", ")}]`);
  }
  if (deliverable.preferredFormat) {
    parts.push(`preferredFormat=${deliverable.preferredFormat}`);
  }
  const constraintEntries = deliverable.constraints
    ? Object.entries(deliverable.constraints).filter(
        ([, value]) => value !== undefined && value !== null,
      )
    : [];
  if (constraintEntries.length > 0) {
    const rendered = constraintEntries
      .map(([key, value]) => {
        if (Array.isArray(value)) {
          return `${key}=[${value.map((v) => String(v)).join(", ")}]`;
        }
        if (typeof value === "object") {
          return `${key}=${JSON.stringify(value)}`;
        }
        return `${key}=${String(value)}`;
      })
      .join(", ");
    parts.push(`constraints={${rendered}}`);
  }
  const acceptedFormats = deliverable.acceptedFormats ?? [];
  const preferredFormat = deliverable.preferredFormat ?? acceptedFormats[0];
  const fallbackFormats = acceptedFormats.filter((format) => format !== preferredFormat);
  const lines = [
    `Deliverable contract (resolved upstream): ${parts.join(", ")}.`,
    "This contract was resolved by the upstream classifier from the user request. Treat it as authoritative: you must produce an artifact matching kind and one of acceptedFormats in THIS turn via the appropriate tool call.",
    "Do not ask the user clarifying questions about the deliverable kind, format, style, page count, language, or any other already-resolved constraint. If something in the contract is genuinely impossible, produce the closest acceptable deliverable and note the deviation in your final reply.",
    "When you call a tool to produce this deliverable, pass the matching parameters from the contract directly (do not re-derive them from the user text).",
    "Do not invent additional constraints the user did not request; do not drop constraints that were set.",
    "A text-only reply (acknowledgement, plan, question, or apology) before the artifact is produced does NOT satisfy this contract and will be rejected as incomplete.",
  ];
  if (preferredFormat && fallbackFormats.length > 0) {
    lines.push(
      `Format priority: attempt preferredFormat=${preferredFormat} first. If the producer for it fails (capability install error, runtime error, or unsupported constraint), fall back to the next format from acceptedFormats in order: [${fallbackFormats.join(", ")}]. Any acceptedFormat satisfies the contract.`,
    );
  } else if (acceptedFormats.length > 1) {
    lines.push(
      `Any of acceptedFormats=[${acceptedFormats.join(", ")}] satisfies the contract. Pick one and, on failure, retry with another from the list.`,
    );
  }
  if (deliverable.kind === "capability_install") {
    lines.push(
      "Capability install contract: you must call capability_install with a packageRef (and optional version/integrity) matching the user's request before your final reply. Do not answer with only a plan or an acknowledgement that installation is possible.",
    );
  }
  return lines.join(" ");
}

/**
 * Builds the system-context prefix for the selected execution recipe.
 *
 * @param {ExecutionPlan} plan - Planned execution route chosen by the planner.
 * @param {PlatformCapabilitySummary | undefined} capabilitySummary - Capability readiness summary for the route.
 * @param {ArtifactKind[] | undefined} artifactKinds - Requested artifact kinds inferred for the run.
 * @param {string[] | undefined} requestedToolNames - Tool names requested for this run.
 * @param {QualificationLowConfidenceStrategy | undefined} lowConfidenceStrategy - Strategy for ambiguous turns.
 * @param {string[] | undefined} ambiguityReasons - Reasons for ambiguity, used in clarification path.
 * @param {OutcomeContract | undefined} outcomeContract - Explicit outcome contract; triggers artifact guardrail.
 * @param {QualificationExecutionContract | undefined} executionContract - Explicit execution contract.
 * @returns {string} Joined system-context instructions for the embedded agent.
 */
function buildSystemContext(
  plan: ExecutionPlan,
  capabilitySummary?: PlatformCapabilitySummary,
  artifactKinds?: ArtifactKind[],
  requestedToolNames?: string[],
  lowConfidenceStrategy?: QualificationLowConfidenceStrategy,
  ambiguityReasons?: string[],
  outcomeContract?: OutcomeContract,
  executionContract?: QualificationExecutionContract,
  deliverable?: DeliverableSpec,
): string {
  const clarificationGuardrails = buildClarificationGuardrails({
    lowConfidenceStrategy,
    ambiguityReasons,
  });
  return [
    `Execution recipe: ${plan.recipe.id}.`,
    plan.recipe.summary ? `Recipe summary: ${plan.recipe.summary}` : undefined,
    capabilitySummary?.requiredCapabilities.length
      ? `Required capabilities: ${capabilitySummary.requiredCapabilities.join(", ")}.`
      : undefined,
    buildReplyLanguageGuardrail(),
    clarificationGuardrails,
    clarificationGuardrails ? undefined : buildDeliverableContractGuidance(deliverable),
    clarificationGuardrails
      ? undefined
      : buildArtifactOutputGuardrails(artifactKinds, outcomeContract, executionContract),
    clarificationGuardrails ? undefined : buildRequestedToolGuardrails(requestedToolNames),
    plan.recipe.systemPrompt,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Compact domain guidance for builder / project-designer runs (not a capability; injected as context only).
 */
function buildBuilderDomainContextSegment(): string {
  return [
    "Builder domain context:",
    "use consistent units (state SI vs other and conversions);",
    "label explicit assumptions (loads, losses, price basis);",
    "show formulas and calculation steps when deriving quantities, costs, or spreadsheet totals;",
    "for ventilation/air exchange cite applicable SNiP/SP/GOST-class norm references as bibliographic pointers only, not legal advice;",
    "for office ventilation baseline, assume 60 m3/h per person unless the user or source documents provide a different project-specific norm;",
    "for supplier comparison align scope, units, incoterms or delivery terms, lead times, and warranty.",
  ].join(" ");
}

function buildPrependContext(
  plan: ExecutionPlan,
  params?: {
    capabilitySummary?: PlatformCapabilitySummary;
    policyPreview?: PolicyDecision;
    readiness?: PlatformExecutionReadiness;
    artifactKinds?: ArtifactKind[];
    requestedToolNames?: string[];
    lowConfidenceStrategy?: QualificationLowConfidenceStrategy;
    ambiguityReasons?: string[];
    outcomeContract?: OutcomeContract;
    executionContract?: QualificationExecutionContract;
    deliverable?: DeliverableSpec;
  },
): string {
  return [
    `Profile: ${plan.profile.selectedProfile.label}.`,
    `Language continuity: ${buildReplyLanguageGuardrail()}`,
    plan.profile.selectedProfile.id === "builder" ? buildBuilderDomainContextSegment() : undefined,
    plan.profile.effective.taskOverlay?.label
      ? `Task overlay: ${plan.profile.effective.taskOverlay.label}.`
      : undefined,
    plan.plannerOutput.reasoning ? `Planner reasoning: ${plan.plannerOutput.reasoning}` : undefined,
    params?.capabilitySummary?.bootstrapRequiredCapabilities.length
      ? `Bootstrap required: ${params.capabilitySummary.bootstrapRequiredCapabilities.join(", ")}.`
      : undefined,
    params?.policyPreview?.requireExplicitApproval
      ? `Policy posture: explicit approval required (${params.policyPreview.autonomy}).`
      : undefined,
    params?.readiness && params.readiness.status !== "ready"
      ? `Preflight readiness: ${params.readiness.status.replaceAll("_", " ")}. ${params.readiness.reasons.join(" ")}`
      : undefined,
    buildDeliverableContractGuidance(params?.deliverable),
    buildArtifactOutputGuardrails(
      params?.artifactKinds,
      params?.outcomeContract,
      params?.executionContract,
    ),
    buildRequestedToolGuardrails(params?.requestedToolNames),
    buildClarificationGuardrails({
      lowConfidenceStrategy: params?.lowConfidenceStrategy,
      ambiguityReasons: params?.ambiguityReasons,
    }),
  ]
    .filter(Boolean)
    .join("\n");
}

function buildExecutionReadiness(params: {
  input: RecipePlannerInput;
  capabilitySummary: PlatformCapabilitySummary;
  policyPreview: PolicyDecision;
}): PlatformExecutionReadiness {
  const reasons: string[] = [];
  if (params.capabilitySummary.bootstrapRequiredCapabilities.length > 0) {
    reasons.push(
      `Bootstrap required for capabilities: ${params.capabilitySummary.bootstrapRequiredCapabilities.join(", ")}.`,
    );
    const canAutoContinueBootstrap =
      params.policyPreview.autonomy === "assist" &&
      (params.input.outcomeContract === "structured_artifact" ||
        params.input.outcomeContract === "workspace_change" ||
        params.input.executionContract?.requiresArtifactEvidence === true ||
        params.input.intent === "document" ||
        params.input.intent === "code" ||
        params.input.intent === "compare" ||
        params.input.intent === "calculation");
    return {
      status: "bootstrap_required",
      reasons,
      ...(canAutoContinueBootstrap ? { unattendedBoundary: "bootstrap" } : {}),
    };
  }
  const requestsPrivilegedAction =
    (params.input.requestedTools?.some((tool) => tool === "exec" || tool === "process") ?? false) ||
    (params.input.publishTargets?.length ?? 0) > 0;
  if (params.policyPreview.requireExplicitApproval && requestsPrivilegedAction) {
    reasons.push("Explicit approval is required before privileged execution can continue.");
    return {
      status: "approval_required",
      reasons,
    };
  }
  return {
    status: "ready",
    reasons: [],
  };
}

function resolveBootstrapSourceDomain(
  intent: PolicyContext["intent"],
): "document" | "developer" | "platform" {
  if (intent === "document") {
    return "document";
  }
  if (intent === "code" || intent === "publish") {
    return "developer";
  }
  return "platform";
}

/**
 * Plain CSV files can be handled directly from the staged workspace without
 * forcing a table-parser bootstrap. Spreadsheet binaries still require the
 * dedicated capability path.
 */
function allTabularFilesAreCsv(fileNames: string[] | undefined): boolean {
  const normalized = (fileNames ?? [])
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  return normalized.length > 0 && normalized.every((name) => name.endsWith(".csv"));
}

function buildCapabilitySummary(params: {
  plan: ExecutionPlan;
  input: RecipePlannerInput;
  capabilityRegistry?: CapabilityRegistry;
  capabilityCatalog?: CapabilityCatalogEntry[];
}): PlatformCapabilitySummary {
  const recipeCapabilities =
    params.plan.recipe.id === "doc_ingest" &&
    (params.input.fileNames?.length ?? 0) === 0 &&
    params.input.intent === "document"
      ? []
      : (params.plan.recipe.id === "table_extract" || params.plan.recipe.id === "table_compare") &&
          allTabularFilesAreCsv(params.input.fileNames)
        ? []
        : (params.plan.recipe.requiredCapabilities ?? []);
  // Universal degrade: when a deliverable is declared, include capabilities for EVERY
  // accepted format (not just the preferred). This way if the primary producer's
  // capability fails to bootstrap, the runtime already has the fallback path ready.
  const deliverable = params.input.deliverable;
  const producerCapabilities = deliverable ? resolveProducer(deliverable).capabilityIds : [];
  const requiredCapabilities = Array.from(
    new Set([...recipeCapabilities, ...producerCapabilities]),
  );
  if (requiredCapabilities.length === 0) {
    return {
      requiredCapabilities: [],
      bootstrapRequiredCapabilities: [],
      unresolvedCapabilities: [],
      requirements: [],
      bootstrapResolutions: [],
    };
  }
  const registry =
    params.capabilityRegistry ??
    createCapabilityRegistry([], params.capabilityCatalog ?? TRUSTED_CAPABILITY_CATALOG);
  const bootstrapResolutions = resolveBootstrapRequests({
    capabilityIds: requiredCapabilities,
    registry,
    catalog: params.capabilityCatalog ?? TRUSTED_CAPABILITY_CATALOG,
    reason: "recipe_requirement",
    sourceDomain: resolveBootstrapSourceDomain(
      normalizePlannerIntentForBootstrapSourceDomain(params.input.intent),
    ),
    sourceRecipeId: params.plan.recipe.id,
  });
  const requirements = bootstrapResolutions.map((resolution, index) => {
    const capabilityId =
      resolution.request?.capabilityId ??
      resolution.capability?.id ??
      requiredCapabilities[index] ??
      "unknown-capability";
    return {
      capabilityId,
      capabilityLabel:
        resolution.request?.catalogEntry.capability.label ?? resolution.capability?.label,
      status: resolution.status,
      requiresBootstrap: resolution.status === "request",
      ...(resolution.reasons?.length ? { reasons: resolution.reasons } : {}),
    } satisfies PlatformCapabilityRequirement;
  });
  return {
    requiredCapabilities,
    bootstrapRequiredCapabilities: requirements
      .filter((requirement) => requirement.requiresBootstrap)
      .map((requirement) => requirement.capabilityId),
    unresolvedCapabilities: requirements
      .filter((requirement) => requirement.status !== "available")
      .map((requirement) => requirement.capabilityId),
    requirements,
    bootstrapResolutions,
  };
}

function attachExecutionContextToCapabilitySummary(
  summary: PlatformCapabilitySummary,
  executionContext: PluginHookPlatformExecutionContext,
): PlatformCapabilitySummary {
  return {
    ...summary,
    bootstrapResolutions: summary.bootstrapResolutions.map((resolution) =>
      resolution.request
        ? {
            ...resolution,
            request: {
              ...resolution.request,
              executionContext,
            },
          }
        : resolution,
    ),
  };
}

export function buildPolicyContextFromRuntimePlan(
  runtimePlan: Pick<
    RecipeRuntimePlan,
    | "selectedProfileId"
    | "taskOverlayId"
    | "intent"
    | "requestedToolNames"
    | "publishTargets"
    | "bootstrapRequiredCapabilities"
  >,
  overrides: Pick<
    PolicyContext,
    | "explicitApproval"
    | "requestedMachineControl"
    | "machineControlLinked"
    | "machineControlKillSwitchEnabled"
    | "machineControlDeviceId"
    | "touchesSensitiveData"
  > = {},
): PolicyContext | undefined {
  const profile = getInitialProfile(runtimePlan.selectedProfileId);
  if (!profile) {
    return undefined;
  }
  const overlay =
    runtimePlan.taskOverlayId && profile
      ? (getTaskOverlay(profile, runtimePlan.taskOverlayId) ?? undefined)
      : undefined;
  return {
    activeProfileId: profile.id,
    activeProfile: profile,
    activeStateTaskOverlay: overlay?.id,
    effective: applyTaskOverlay(profile, overlay),
    ...(normalizePlannerIntentForPolicy(runtimePlan.intent)
      ? { intent: normalizePlannerIntentForPolicy(runtimePlan.intent) }
      : {}),
    ...(runtimePlan.requestedToolNames?.length
      ? { requestedToolNames: runtimePlan.requestedToolNames }
      : {}),
    ...(runtimePlan.publishTargets?.length ? { publishTargets: runtimePlan.publishTargets } : {}),
    ...(runtimePlan.bootstrapRequiredCapabilities?.length
      ? { requestedCapabilities: runtimePlan.bootstrapRequiredCapabilities }
      : {}),
    ...overrides,
  };
}

export function buildPolicyContextFromExecutionContext(
  execution: Pick<
    PlatformExecutionContextSnapshot,
    | "profileId"
    | "taskOverlayId"
    | "intent"
    | "requestedToolNames"
    | "publishTargets"
    | "requiredCapabilities"
    | "bootstrapRequiredCapabilities"
  >,
  overrides: Pick<
    PolicyContext,
    | "explicitApproval"
    | "requestedMachineControl"
    | "machineControlLinked"
    | "machineControlKillSwitchEnabled"
    | "machineControlDeviceId"
    | "touchesSensitiveData"
    | "artifactKinds"
  > = {},
): PolicyContext | undefined {
  return buildPolicyContextFromRuntimePlan(
    {
      selectedProfileId: execution.profileId as ProfileId,
      taskOverlayId: execution.taskOverlayId,
      intent: execution.intent,
      requestedToolNames: execution.requestedToolNames,
      publishTargets: execution.publishTargets,
      bootstrapRequiredCapabilities:
        execution.bootstrapRequiredCapabilities ?? execution.requiredCapabilities,
    },
    overrides,
  );
}

export function toPluginHookPlatformExecutionContext(
  runtimePlan: RecipeRuntimePlan,
): PluginHookPlatformExecutionContext {
  return {
    profileId: runtimePlan.selectedProfileId,
    recipeId: runtimePlan.selectedRecipeId,
    ...(runtimePlan.taskOverlayId ? { taskOverlayId: runtimePlan.taskOverlayId } : {}),
    ...(runtimePlan.plannerReasoning ? { plannerReasoning: runtimePlan.plannerReasoning } : {}),
    ...(runtimePlan.intent ? { intent: runtimePlan.intent } : {}),
    ...(runtimePlan.providerOverride ? { providerOverride: runtimePlan.providerOverride } : {}),
    ...(runtimePlan.modelOverride ? { modelOverride: runtimePlan.modelOverride } : {}),
    ...(runtimePlan.timeoutSeconds ? { timeoutSeconds: runtimePlan.timeoutSeconds } : {}),
    ...(runtimePlan.fallbackModels?.length ? { fallbackModels: runtimePlan.fallbackModels } : {}),
    ...(runtimePlan.requestedToolNames?.length
      ? { requestedToolNames: runtimePlan.requestedToolNames }
      : {}),
    ...(runtimePlan.artifactKinds?.length ? { artifactKinds: runtimePlan.artifactKinds } : {}),
    ...(runtimePlan.publishTargets?.length ? { publishTargets: runtimePlan.publishTargets } : {}),
    ...(runtimePlan.requiredCapabilities?.length
      ? { requiredCapabilities: runtimePlan.requiredCapabilities }
      : {}),
    ...(runtimePlan.bootstrapRequiredCapabilities?.length
      ? { bootstrapRequiredCapabilities: runtimePlan.bootstrapRequiredCapabilities }
      : {}),
    ...(runtimePlan.requireExplicitApproval !== undefined
      ? { requireExplicitApproval: runtimePlan.requireExplicitApproval }
      : {}),
    ...(runtimePlan.policyAutonomy ? { policyAutonomy: runtimePlan.policyAutonomy } : {}),
    ...(runtimePlan.readinessStatus ? { readinessStatus: runtimePlan.readinessStatus } : {}),
    ...(runtimePlan.readinessReasons?.length
      ? { readinessReasons: runtimePlan.readinessReasons }
      : {}),
    ...(runtimePlan.unattendedBoundary
      ? { unattendedBoundary: runtimePlan.unattendedBoundary }
      : {}),
    ...(runtimePlan.prependContext ? { prependContext: runtimePlan.prependContext } : {}),
    ...(runtimePlan.prependSystemContext
      ? { prependSystemContext: runtimePlan.prependSystemContext }
      : {}),
  };
}

export function adaptExecutionPlanToRuntime(
  plan: ExecutionPlan,
  params?: {
    input?: RecipePlannerInput;
    capabilitySummary?: PlatformCapabilitySummary;
    policyPreview?: PolicyDecision;
    readiness?: PlatformExecutionReadiness;
  },
): RecipeRuntimePlan {
  const overrideModel = plan.plannerOutput.overrides?.model;
  const parsedModel = overrideModel ? parseModelRef(overrideModel, DEFAULT_PROVIDER) : null;
  const outcomeContract =
    params?.input?.outcomeContract ??
    inferOutcomeContract({
      ...(params?.input?.intent ? { intent: params.input.intent } : {}),
      ...(params?.input?.artifactKinds?.length
        ? { artifactKinds: params.input.artifactKinds }
        : {}),
      ...(params?.input?.requestedTools?.length
        ? { requestedTools: params.input.requestedTools }
        : {}),
      ...(params?.input?.publishTargets?.length
        ? { publishTargets: params.input.publishTargets }
        : {}),
    });
  const executionContract =
    params?.input?.executionContract ??
    inferExecutionContract(outcomeContract, {
      ...(params?.input?.intent ? { intent: params.input.intent } : {}),
      ...(params?.input?.artifactKinds?.length
        ? { artifactKinds: params.input.artifactKinds }
        : {}),
      ...(params?.input?.requestedTools?.length
        ? { requestedTools: params.input.requestedTools }
        : {}),
      ...(params?.input?.publishTargets?.length
        ? { publishTargets: params.input.publishTargets }
        : {}),
    });
  const requestedEvidence =
    params?.input?.requestedEvidence ?? inferRequestedEvidence(outcomeContract, executionContract);
  const deliverable = params?.input?.deliverable;
  const prependSystemContext = buildSystemContext(
    plan,
    params?.capabilitySummary,
    params?.input?.artifactKinds,
    params?.input?.requestedTools,
    params?.input?.lowConfidenceStrategy,
    params?.input?.ambiguityReasons,
    outcomeContract,
    executionContract,
    deliverable,
  );
  const prependContext = buildPrependContext(plan, {
    capabilitySummary: params?.capabilitySummary,
    policyPreview: params?.policyPreview,
    readiness: params?.readiness,
    artifactKinds: params?.input?.artifactKinds,
    requestedToolNames: params?.input?.requestedTools,
    lowConfidenceStrategy: params?.input?.lowConfidenceStrategy,
    ambiguityReasons: params?.input?.ambiguityReasons,
    outcomeContract,
    executionContract,
    ...(deliverable ? { deliverable } : {}),
  });

  return {
    selectedRecipeId: plan.recipe.id,
    selectedProfileId: plan.profile.selectedProfile.id,
    ...(plan.profile.activeProfile.taskOverlay
      ? { taskOverlayId: plan.profile.activeProfile.taskOverlay }
      : {}),
    ...(plan.plannerOutput.reasoning ? { plannerReasoning: plan.plannerOutput.reasoning } : {}),
    ...(params?.input?.contractFirst ? { contractFirst: true } : {}),
    ...(params?.input?.intent ? { intent: params.input.intent } : {}),
    ...(params?.input?.routing ? { routing: params.input.routing } : {}),
    ...(parsedModel?.provider ? { providerOverride: parsedModel.provider } : {}),
    ...(parsedModel?.model ? { modelOverride: parsedModel.model } : {}),
    ...(plan.recipe.fallbackModels?.length ? { fallbackModels: plan.recipe.fallbackModels } : {}),
    ...(plan.plannerOutput.overrides?.timeoutSeconds
      ? { timeoutSeconds: plan.plannerOutput.overrides.timeoutSeconds }
      : {}),
    ...(params?.input?.artifactKinds?.length ? { artifactKinds: params.input.artifactKinds } : {}),
    ...(params?.input?.requestedTools?.length
      ? { requestedToolNames: params.input.requestedTools }
      : {}),
    ...(params?.input?.confidence ? { confidence: params.input.confidence } : {}),
    ...(params?.input?.ambiguityReasons?.length
      ? { ambiguityReasons: params.input.ambiguityReasons }
      : {}),
    ...(params?.input?.lowConfidenceStrategy
      ? { lowConfidenceStrategy: params.input.lowConfidenceStrategy }
      : {}),
    ...(params?.input?.candidateFamilies?.length
      ? { candidateFamilies: params.input.candidateFamilies }
      : {}),
    ...(params?.input?.resolutionContract
      ? { resolutionContract: params.input.resolutionContract }
      : {}),
    ...(outcomeContract ? { outcomeContract } : {}),
    ...(executionContract ? { executionContract } : {}),
    ...(requestedEvidence.length ? { requestedEvidence } : {}),
    ...(deliverable ? { deliverable } : {}),
    ...(params?.input?.publishTargets?.length
      ? { publishTargets: params.input.publishTargets }
      : {}),
    ...(params?.capabilitySummary?.requiredCapabilities.length
      ? { requiredCapabilities: params.capabilitySummary.requiredCapabilities }
      : {}),
    ...(params?.capabilitySummary?.bootstrapRequiredCapabilities.length
      ? { bootstrapRequiredCapabilities: params.capabilitySummary.bootstrapRequiredCapabilities }
      : {}),
    ...(params?.policyPreview
      ? {
          requireExplicitApproval: params.policyPreview.requireExplicitApproval,
          policyAutonomy: params.policyPreview.autonomy,
        }
      : {}),
    ...(params?.readiness
      ? {
          readinessStatus: params.readiness.status,
          ...(params.readiness.reasons.length
            ? { readinessReasons: params.readiness.reasons }
            : {}),
          ...(params.readiness.unattendedBoundary
            ? { unattendedBoundary: params.readiness.unattendedBoundary }
            : {}),
        }
      : {}),
    ...(prependSystemContext ? { prependSystemContext } : {}),
    ...(prependContext ? { prependContext } : {}),
    ...(params?.input?.classifierTelemetry
      ? { classifierTelemetry: params.input.classifierTelemetry }
      : {}),
    ...(plan.routingOutcome ? { routingOutcome: plan.routingOutcome } : {}),
    ...(typeof plan.estimatedDurationMs === "number"
      ? { estimatedDurationMs: plan.estimatedDurationMs }
      : {}),
    ...(plan.ackThenDefer ? { ackThenDefer: true } : {}),
  };
}

export function resolvePlatformExecutionDecision(
  input: RecipePlannerInput,
  options: ResolvePlatformExecutionDecisionOptions = {},
): ResolvedPlatformExecutionDecision {
  const plan = planExecutionRecipe(input);
  const baseCapabilitySummary = buildCapabilitySummary({
    plan,
    input,
    capabilityRegistry: options.capabilityRegistry,
    capabilityCatalog: options.capabilityCatalog,
  });
  const policyContext = {
    ...(buildPolicyContextFromRuntimePlan(
      {
        selectedProfileId: plan.profile.selectedProfile.id,
        taskOverlayId: plan.profile.activeProfile.taskOverlay,
        intent: input.intent,
        requestedToolNames: input.requestedTools,
        publishTargets: input.publishTargets,
        bootstrapRequiredCapabilities: baseCapabilitySummary.bootstrapRequiredCapabilities,
      },
      {
        explicitApproval: options.explicitApproval,
        ...options.policyContextOverrides,
      },
    ) ?? {
      activeProfileId: plan.profile.selectedProfile.id,
      activeProfile: plan.profile.selectedProfile,
      effective: plan.profile.effective,
    }),
  } satisfies PolicyContext;
  const policyPreview = evaluatePolicy(policyContext);
  const readiness = buildExecutionReadiness({
    input,
    capabilitySummary: baseCapabilitySummary,
    policyPreview,
  });
  const runtime = adaptExecutionPlanToRuntime(plan, {
    input,
    capabilitySummary: baseCapabilitySummary,
    policyPreview,
    readiness,
  });
  const executionContext = toPluginHookPlatformExecutionContext(runtime);
  const capabilitySummary = attachExecutionContextToCapabilitySummary(
    baseCapabilitySummary,
    executionContext,
  );
  return {
    ...plan,
    capabilitySummary,
    policyContext,
    policyPreview,
    runtime,
  };
}

export function resolvePlatformRuntimePlan(
  input: RecipePlannerInput,
  options: ResolvePlatformExecutionDecisionOptions = {},
): ResolvedPlatformRuntimePlan {
  return resolvePlatformExecutionDecision(input, options);
}

/**
 * Rehydrates planner input from an existing {@link RecipeRuntimePlan} plus the current user prompt.
 * Use this when the platform already resolved profile/recipe/intent so downstream code does not
 * re-derive those fields from prompt heuristics in `buildExecutionDecisionInput`.
 */
export function buildRecipePlannerInputFromRuntimePlan(
  runtime: RecipeRuntimePlan,
  prompt: string,
  extras?: { fileNames?: string[] },
): RecipePlannerInput {
  const fileNames = Array.from(
    new Set(
      (extras?.fileNames ?? [])
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim()),
    ),
  );
  return {
    prompt,
    ...(runtime.contractFirst ? { contractFirst: true } : {}),
    ...(fileNames.length > 0 ? { fileNames } : {}),
    ...(runtime.intent ? { intent: runtime.intent } : {}),
    ...(runtime.routing ? { routing: runtime.routing } : {}),
    ...(runtime.artifactKinds?.length
      ? { artifactKinds: runtime.artifactKinds as ArtifactKind[] }
      : {}),
    ...(runtime.confidence ? { confidence: runtime.confidence } : {}),
    ...(runtime.ambiguityReasons?.length ? { ambiguityReasons: runtime.ambiguityReasons } : {}),
    ...(runtime.lowConfidenceStrategy
      ? { lowConfidenceStrategy: runtime.lowConfidenceStrategy }
      : {}),
    ...(runtime.candidateFamilies?.length ? { candidateFamilies: runtime.candidateFamilies } : {}),
    ...(runtime.resolutionContract ? { resolutionContract: runtime.resolutionContract } : {}),
    ...(runtime.outcomeContract ? { outcomeContract: runtime.outcomeContract } : {}),
    ...(runtime.executionContract ? { executionContract: runtime.executionContract } : {}),
    ...(runtime.requestedEvidence?.length ? { requestedEvidence: runtime.requestedEvidence } : {}),
    ...(runtime.publishTargets?.length ? { publishTargets: runtime.publishTargets } : {}),
    ...(runtime.requestedToolNames?.length ? { requestedTools: runtime.requestedToolNames } : {}),
    ...(runtime.deliverable ? { deliverable: runtime.deliverable } : {}),
    ...(runtime.classifierTelemetry ? { classifierTelemetry: runtime.classifierTelemetry } : {}),
  };
}
