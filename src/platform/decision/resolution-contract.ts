import { z } from "zod";
import type { RecipeRoutingHints } from "../recipe/planner.js";
import type { ArtifactKind } from "../schemas/artifact.js";
import type {
  CandidateExecutionFamily,
  OutcomeContract,
  QualificationExecutionContract,
} from "./qualification-contract.js";
import { inferCandidateExecutionFamilies } from "./family-candidates.js";

export const ResolutionToolBundleSchema = z.enum([
  "respond_only",
  "repo_run",
  "repo_mutation",
  "interactive_browser",
  "public_web_lookup",
  "document_extraction",
  "artifact_authoring",
  "external_delivery",
]);
export type ResolutionToolBundle = z.infer<typeof ResolutionToolBundleSchema>;

export const ResolutionRoutingSchema = z
  .object({
    localEligible: z.boolean(),
    remoteProfile: z.enum(["cheap", "code", "strong", "presentation"]),
    preferRemoteFirst: z.boolean(),
    needsVision: z.boolean(),
  })
  .strict();
export type ResolutionRouting = z.infer<typeof ResolutionRoutingSchema>;

export const ResolutionContractSchema = z
  .object({
    // Debug/eval label only — not used for production routing decisions.
    // Source of truth: primaryOutcome + requiredCapabilities + toolBundles + routing.
    selectedFamily: z
      .enum([
        "general_assistant",
        "document_render",
        "media_generation",
        "code_build",
        "analysis_transform",
        "ops_execution",
      ])
      .optional(),
    // Derived from contract — informational only. Production routing uses toolBundles + executionContract.
    candidateFamilies: z.array(
      z.enum([
        "general_assistant",
        "document_render",
        "media_generation",
        "code_build",
        "analysis_transform",
        "ops_execution",
      ]),
    ),
    // Source of truth for production routing.
    toolBundles: z.array(ResolutionToolBundleSchema),
    // Source of truth for execution strategy.
    routing: ResolutionRoutingSchema,
  })
  .strict();
export type ResolutionContract = z.infer<typeof ResolutionContractSchema>;

export type ResolutionBridgePlannerInput = {
  contractFirst?: boolean;
  intent?: "general" | "document" | "code" | "publish" | "compare" | "calculation";
  fileNames?: string[];
  artifactKinds?: ArtifactKind[];
  requestedTools?: string[];
  publishTargets?: string[];
  outcomeContract: OutcomeContract;
  executionContract: QualificationExecutionContract;
  candidateFamilies?: CandidateExecutionFamily[];
};

const HEAVY_TOOL_IDS = new Set(["exec", "apply_patch", "process", "browser", "web_search"]);
const HEAVY_ARTIFACT_KINDS = new Set([
  "image",
  "video",
  "audio",
  "document",
  "site",
  "release",
  "binary",
  "archive",
]);
const TABULAR_ATTACHMENT_EXTENSION = /\.(csv|tsv|xlsx?|ods)$/iu;
const VISION_ATTACHMENT_EXTENSION = /\.(pdf|png|jpe?g|webp|gif|tiff?|bmp|heic)$/iu;

function sortUnique<T extends string>(values: readonly T[]): T[] {
  return Array.from(new Set(values)).toSorted();
}

function fileNamesImplyHeavyLocalRoute(fileNames: string[]): boolean {
  return fileNames.some((name) =>
    /\.(pdf|png|jpe?g|webp|gif|tiff?|bmp|heic|ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|java|kt|cs|cpp|h)$/iu.test(
      name,
    ),
  );
}

function artifactKindsAllowLightTabularOrCalc(kinds: string[]): boolean {
  if (kinds.length === 0) {
    return true;
  }
  if (kinds.some((kind) => HEAVY_ARTIFACT_KINDS.has(kind))) {
    return false;
  }
  const onlyDataReport = kinds.every((kind) => kind === "data" || kind === "report");
  if (!onlyDataReport) {
    return false;
  }
  return true;
}

function inferNeedsVision(params: {
  fileNames: string[];
  requestedTools: string[];
  artifactKinds: string[];
}): boolean {
  return (
    params.requestedTools.includes("browser") ||
    params.fileNames.some((name) => VISION_ATTACHMENT_EXTENSION.test(name)) ||
    params.artifactKinds.some((kind) => kind === "image" || kind === "video")
  );
}

function inferLocalRoutingEligible(params: {
  requestedTools: string[];
  fileNames: string[];
  artifactKinds: string[];
  outcomeContract: OutcomeContract;
  executionContract: QualificationExecutionContract;
}): boolean {
  if (
    params.outcomeContract === "workspace_change" ||
    params.outcomeContract === "interactive_local_result" ||
    params.outcomeContract === "external_operation"
  ) {
    return false;
  }
  if (params.requestedTools.some((tool) => HEAVY_TOOL_IDS.has(tool))) {
    return false;
  }
  if (
    params.executionContract.requiresWorkspaceMutation ||
    params.executionContract.requiresLocalProcess ||
    params.executionContract.requiresDeliveryEvidence
  ) {
    return false;
  }
  if (params.fileNames.length > 0) {
    if (fileNamesImplyHeavyLocalRoute(params.fileNames)) {
      return false;
    }
    if (
      params.fileNames.every((name) => TABULAR_ATTACHMENT_EXTENSION.test(name))
    ) {
      return false;
    }
    return false;
  }
  if (params.artifactKinds.length > 0) {
    return artifactKindsAllowLightTabularOrCalc(params.artifactKinds);
  }
  return true;
}

function inferRemoteRoutingProfile(params: {
  requestedTools: string[];
  artifactKinds: string[];
  localEligible: boolean;
  needsVision: boolean;
  outcomeContract: OutcomeContract;
  executionContract: QualificationExecutionContract;
}): ResolutionRouting["remoteProfile"] {
  const wantsPresentationQuality =
    params.outcomeContract === "structured_artifact" &&
    params.artifactKinds.includes("document") &&
    params.requestedTools.includes("pdf") &&
    (params.requestedTools.includes("image_generate") ||
      params.artifactKinds.includes("image") ||
      params.needsVision);
  if (wantsPresentationQuality) {
    return "presentation";
  }
  if (
    params.executionContract.requiresWorkspaceMutation ||
    params.executionContract.requiresLocalProcess ||
    params.requestedTools.includes("apply_patch") ||
    params.requestedTools.includes("exec") ||
    params.requestedTools.includes("process")
  ) {
    return "code";
  }
  if (
    params.outcomeContract === "external_operation" ||
    params.requestedTools.includes("browser") ||
    params.requestedTools.includes("web_search") ||
    !params.localEligible ||
    params.artifactKinds.some((kind) => HEAVY_ARTIFACT_KINDS.has(kind)) ||
    params.needsVision
  ) {
    return "strong";
  }
  return "cheap";
}

function inferPreferRemoteFirst(params: {
  requestedTools: string[];
  artifactKinds: string[];
  outcomeContract: OutcomeContract;
  remoteProfile: ResolutionRouting["remoteProfile"];
}): boolean {
  if (
    params.remoteProfile === "presentation" ||
    params.remoteProfile === "strong" ||
    params.outcomeContract === "external_operation"
  ) {
    return true;
  }
  if (params.requestedTools.includes("browser") || params.requestedTools.includes("web_search")) {
    return true;
  }
  if (
    params.artifactKinds.some((kind) =>
      kind === "image" || kind === "video" || kind === "audio" || kind === "site" || kind === "release",
    )
  ) {
    return true;
  }
  return false;
}

function deriveToolBundles(params: {
  fileNames: string[];
  candidateFamilies: CandidateExecutionFamily[];
  requestedTools: string[];
  artifactKinds: string[];
  publishTargets: string[];
  outcomeContract: OutcomeContract;
  executionContract: QualificationExecutionContract;
}): ResolutionToolBundle[] {
  const bundles = new Set<ResolutionToolBundle>();
  const tools = new Set(params.requestedTools);
  const hasMediaArtifact = params.artifactKinds.some((kind) =>
    ["image", "video", "audio"].includes(kind),
  );
  const hasArtifactAttachments = params.fileNames.length > 0;
  const explicitAuthoring =
    tools.has("pdf") ||
    tools.has("image_generate") ||
    hasMediaArtifact ||
    params.candidateFamilies.includes("media_generation");
  if (!params.executionContract.requiresTools && tools.size === 0) {
    bundles.add("respond_only");
  }
  if (tools.has("exec") || tools.has("process") || params.executionContract.requiresLocalProcess) {
    bundles.add("repo_run");
  }
  if (tools.has("apply_patch") || params.executionContract.requiresWorkspaceMutation) {
    bundles.add("repo_mutation");
  }
  if (tools.has("browser")) {
    bundles.add("interactive_browser");
  }
  if (tools.has("web_search")) {
    bundles.add("public_web_lookup");
  }
  if (
    hasArtifactAttachments &&
    params.outcomeContract === "structured_artifact" &&
    params.executionContract.requiresArtifactEvidence &&
    !explicitAuthoring
  ) {
    bundles.add("document_extraction");
  }
  if (
    explicitAuthoring ||
    (params.outcomeContract === "structured_artifact" && !bundles.has("document_extraction"))
  ) {
    bundles.add("artifact_authoring");
  }
  if (params.publishTargets.length > 0 || params.outcomeContract === "external_operation") {
    bundles.add("external_delivery");
  }
  return sortUnique(Array.from(bundles));
}

// Derives a debug/eval label from contract — not used for production routing.
// Source of truth: toolBundles + executionContract + routing.
function deriveDebugFamilyLabel(params: {
  outcomeContract: OutcomeContract;
  candidateFamilies: CandidateExecutionFamily[];
  artifactKinds: string[];
  requestedTools: string[];
  fileNames: string[];
}): CandidateExecutionFamily | undefined {
  const families = params.candidateFamilies;
  if (families.length === 0) {
    return undefined;
  }
  if (params.outcomeContract === "workspace_change" || params.outcomeContract === "interactive_local_result") {
    return families.find((family) => family === "code_build") ?? families[0];
  }
  if (params.outcomeContract === "external_operation") {
    return families.find((family) => family === "ops_execution") ?? families[0];
  }
  if (params.outcomeContract === "text_response") {
    if (
      params.artifactKinds.every((kind) => kind === "data" || kind === "report") &&
      (params.artifactKinds.length > 0 || params.fileNames.some((name) => TABULAR_ATTACHMENT_EXTENSION.test(name)))
    ) {
      return families.find((family) => family === "analysis_transform") ?? families[0];
      }
    return families.find((family) => family === "general_assistant") ?? families[0];
  }
  if (
    params.artifactKinds.includes("document") &&
    families.includes("document_render")
  ) {
    return "document_render";
  }
  if (params.artifactKinds.some((kind) => kind === "image" || kind === "video" || kind === "audio")) {
    return families.find((family) => family === "media_generation") ?? families[0];
  }
  if (
    params.requestedTools.includes("web_search") &&
    params.artifactKinds.every((kind) => kind === "data" || kind === "report")
  ) {
    return families.find((family) => family === "analysis_transform") ?? families[0];
  }
  return families.find((family) => family === "document_render") ?? families[0];
}

export function resolveResolutionContract(input: ResolutionBridgePlannerInput): ResolutionContract {
  const fileNames = input.fileNames ?? [];
  const artifactKinds = sortUnique(input.artifactKinds ?? []);
  const requestedTools = sortUnique(input.requestedTools ?? []);
  const publishTargets = sortUnique(input.publishTargets ?? []);
  const candidateFamilies = sortUnique(
    input.candidateFamilies?.length
      ? input.candidateFamilies
      : inferCandidateExecutionFamilies(input.outcomeContract, {
          artifactKinds,
          requestedTools,
          publishTargets,
        }),
  );
  const needsVision = inferNeedsVision({ fileNames, requestedTools, artifactKinds });
  const localEligible = inferLocalRoutingEligible({
    requestedTools,
    fileNames,
    artifactKinds,
    outcomeContract: input.outcomeContract,
    executionContract: input.executionContract,
  });
  const remoteProfile = inferRemoteRoutingProfile({
    requestedTools,
    artifactKinds,
    localEligible,
    needsVision,
    outcomeContract: input.outcomeContract,
    executionContract: input.executionContract,
  });
  const routing: ResolutionRouting = {
    localEligible,
    remoteProfile,
    preferRemoteFirst: inferPreferRemoteFirst({
      requestedTools,
      artifactKinds,
      outcomeContract: input.outcomeContract,
      remoteProfile,
    }),
    needsVision,
  };
  return ResolutionContractSchema.parse({
    // Debug/eval label only — informational, not routing truth
    selectedFamily: deriveDebugFamilyLabel({
      outcomeContract: input.outcomeContract,
      candidateFamilies,
      artifactKinds,
      requestedTools,
      fileNames,
    }),
    // Derived from contract — informational only
    candidateFamilies,
    // Source of truth for production routing
    toolBundles: deriveToolBundles({
      fileNames,
      candidateFamilies,
      requestedTools,
      artifactKinds,
      publishTargets,
      outcomeContract: input.outcomeContract,
      executionContract: input.executionContract,
    }),
    // Source of truth for execution strategy
    routing,
  });
}

export function toRecipeRoutingHints(resolution: ResolutionContract): RecipeRoutingHints {
  return {
    localEligible: resolution.routing.localEligible,
    remoteProfile: resolution.routing.remoteProfile,
    ...(resolution.routing.preferRemoteFirst ? { preferRemoteFirst: true } : {}),
    ...(resolution.routing.needsVision ? { needsVision: true } : {}),
  };
}
