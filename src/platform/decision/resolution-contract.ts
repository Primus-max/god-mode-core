import { z } from "zod";
import type { RecipeRoutingHints } from "../recipe/planner.js";
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
    toolBundles: z.array(ResolutionToolBundleSchema),
    routing: ResolutionRoutingSchema,
  })
  .strict();
export type ResolutionContract = z.infer<typeof ResolutionContractSchema>;

export type ResolutionBridgePlannerInput = {
  prompt?: string;
  intent?: "general" | "document" | "code" | "publish" | "compare" | "calculation";
  fileNames?: string[];
  artifactKinds?: string[];
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

function sortUnique<T extends string>(values: readonly T[]): T[] {
  return Array.from(new Set(values)).sort() as T[];
}

function promptSuggestsHeavyDocumentWork(prompt: string): boolean {
  return (
    /\b(pdf|png|jpe?g|webp|gif|scan|scanned|screenshot|ocr|invoice|diagram)\b/iu.test(prompt) ||
    /\b(pdf|пдф|png|скан|скриншот|чертеж)\b/iu.test(prompt)
  );
}

function promptSuggestsLightGeneralTask(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (
    /\b(rewrite|rephrase|shorten|paraphrase|translate)\b/iu.test(prompt) ||
    ["перепиши", "перефраз", "сократи", "переведи"].some((hint) => normalized.includes(hint))
  ) {
    return true;
  }
  const asksForShortList =
    /\b(name|list|give|share)\s+(?:one|two|three|1|2|3)\b/iu.test(prompt) ||
    /\b(назови|перечисли|дай)\s+(?:один|одну|два|две|три|1|2|3)\b/iu.test(prompt) ||
    ["назови 1", "назови 2", "назови 3", "перечисли 1", "перечисли 2", "перечисли 3", "дай 1", "дай 2", "дай 3"].some(
      (hint) => normalized.includes(hint),
    );
  const requestsBriefness = ["short", "brief", "quick", "коротк", "кратк"].some((hint) =>
    normalized.includes(hint),
  );
  return asksForShortList && requestsBriefness;
}

function promptSuggestsComplexReasoning(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized || promptSuggestsLightGeneralTask(prompt)) {
    return false;
  }
  let score = 0;
  if (normalized.length >= 120) {
    score += 1;
  }
  if (
    /\b(analy[sz]e|analysis|deep dive|detailed|trade[- ]?offs?|framework|metrics?|kpis?|examples?|rationale|prioriti[sz]e|step[- ]by[- ]step)\b/iu.test(
      prompt,
    ) ||
    [
      "анализ",
      "подробн",
      "развернут",
      "развёрнут",
      "почему",
      "пример",
      "метрик",
      "пошагов",
      "приорит",
      "обоснован",
    ].some((hint) => normalized.includes(hint))
  ) {
    score += 2;
  }
  if (
    /\b(three|four|five|six|seven|eight|nine|ten|3|4|5|6|7|8|9|10)\b/iu.test(prompt) ||
    ["три", "четыре", "пять", "шесть", "семь", "восемь", "девять", "десять"].some((hint) =>
      normalized.includes(hint),
    )
  ) {
    score += 1;
  }
  if (
    /[:;]/.test(prompt) &&
    (/\b(why|because|with examples?)\b/iu.test(prompt) ||
      normalized.includes("с примерами") ||
      normalized.includes("почему") ||
      normalized.includes("например"))
  ) {
    score += 1;
  }
  return score >= 2;
}

function fileNamesImplyHeavyLocalRoute(fileNames: string[]): boolean {
  return fileNames.some((name) =>
    /\.(pdf|png|jpe?g|webp|gif|tiff?|bmp|heic|ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|java|kt|cs|cpp|h)$/iu.test(
      name,
    ),
  );
}

function artifactKindsAllowLightTabularOrCalc(
  kinds: string[],
  intent: ResolutionBridgePlannerInput["intent"],
): boolean {
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
  return intent === "compare" || intent === "calculation";
}

function inferNeedsVision(params: { prompt: string; fileNames: string[] }): boolean {
  if (promptSuggestsHeavyDocumentWork(params.prompt)) {
    return true;
  }
  return params.fileNames.some((name) => /\.(pdf|png|jpe?g|webp|gif|tiff?|bmp|heic)$/iu.test(name));
}

function inferLocalRoutingEligible(params: {
  prompt: string;
  intent: ResolutionBridgePlannerInput["intent"];
  requestedTools: string[];
  fileNames: string[];
  artifactKinds: string[];
}): boolean {
  if (params.intent === "code" || params.intent === "publish") {
    return false;
  }
  if (params.requestedTools.some((tool) => HEAVY_TOOL_IDS.has(tool))) {
    return false;
  }
  if (promptSuggestsHeavyDocumentWork(params.prompt) || promptSuggestsComplexReasoning(params.prompt)) {
    return false;
  }
  if (params.fileNames.length > 0) {
    if (fileNamesImplyHeavyLocalRoute(params.fileNames)) {
      return false;
    }
    if (
      params.intent === "compare" &&
      params.fileNames.every((name) => TABULAR_ATTACHMENT_EXTENSION.test(name))
    ) {
      return false;
    }
    return false;
  }
  if (params.artifactKinds.length > 0) {
    return artifactKindsAllowLightTabularOrCalc(params.artifactKinds, params.intent);
  }
  return true;
}

function inferRemoteRoutingProfile(params: {
  prompt: string;
  intent: ResolutionBridgePlannerInput["intent"];
  requestedTools: string[];
  artifactKinds: string[];
  localEligible: boolean;
  needsVision: boolean;
  outcomeContract: OutcomeContract;
  executionContract: QualificationExecutionContract;
}): ResolutionRouting["remoteProfile"] {
  const wantsPresentationQuality =
    params.intent === "document" &&
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
    params.intent === "code" ||
    params.intent === "publish"
  ) {
    return "code";
  }
  if (
    params.outcomeContract === "external_operation" ||
    params.requestedTools.includes("browser") ||
    params.requestedTools.includes("web_search") ||
    !params.localEligible ||
    params.artifactKinds.some((kind) => HEAVY_ARTIFACT_KINDS.has(kind)) ||
    promptSuggestsHeavyDocumentWork(params.prompt) ||
    promptSuggestsComplexReasoning(params.prompt)
  ) {
    return "strong";
  }
  return "cheap";
}

function inferPreferRemoteFirst(params: {
  prompt: string;
  intent: ResolutionBridgePlannerInput["intent"];
  requestedTools: string[];
  artifactKinds: string[];
  outcomeContract: OutcomeContract;
  remoteProfile: ResolutionRouting["remoteProfile"];
}): boolean {
  if (
    params.remoteProfile === "presentation" ||
    params.remoteProfile === "strong" ||
    params.outcomeContract === "external_operation" ||
    params.intent === "publish"
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
  return (
    params.artifactKinds.includes("document") &&
    [
      "pdf",
      "presentation",
      "slides",
      "infographic",
      "layout",
      "презентац",
      "инфограф",
      "слайд",
      "плакат",
      "баннер",
    ].some((hint) => params.prompt.toLowerCase().includes(hint))
  );
}

function deriveToolBundles(params: {
  requestedTools: string[];
  artifactKinds: string[];
  publishTargets: string[];
  outcomeContract: OutcomeContract;
  executionContract: QualificationExecutionContract;
}): ResolutionToolBundle[] {
  const bundles = new Set<ResolutionToolBundle>();
  const tools = new Set(params.requestedTools);
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
    tools.has("pdf") ||
    tools.has("image_generate") ||
    params.artifactKinds.some((kind) => ["document", "estimate", "image", "video", "audio", "archive"].includes(kind)) ||
    params.outcomeContract === "structured_artifact"
  ) {
    bundles.add("artifact_authoring");
  }
  if (params.publishTargets.length > 0 || params.outcomeContract === "external_operation") {
    bundles.add("external_delivery");
  }
  return sortUnique(Array.from(bundles));
}

function selectResolutionFamily(params: {
  outcomeContract: OutcomeContract;
  candidateFamilies: CandidateExecutionFamily[];
  artifactKinds: string[];
  intent: ResolutionBridgePlannerInput["intent"];
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
    if (params.intent === "compare" || params.intent === "calculation") {
      return families.find((family) => family === "analysis_transform") ?? families[0];
    }
    return families.find((family) => family === "general_assistant") ?? families[0];
  }
  if (
    params.intent === "document" &&
    params.artifactKinds.includes("document") &&
    families.includes("document_render")
  ) {
    return "document_render";
  }
  if (params.artifactKinds.some((kind) => kind === "image" || kind === "video" || kind === "audio")) {
    return families.find((family) => family === "media_generation") ?? families[0];
  }
  if (params.intent === "compare" || params.intent === "calculation") {
    return families.find((family) => family === "analysis_transform") ?? families[0];
  }
  return families.find((family) => family === "document_render") ?? families[0];
}

export function resolveResolutionContract(input: ResolutionBridgePlannerInput): ResolutionContract {
  const prompt = input.prompt ?? "";
  const fileNames = input.fileNames ?? [];
  const artifactKinds = sortUnique(input.artifactKinds ?? []);
  const requestedTools = sortUnique(input.requestedTools ?? []);
  const publishTargets = sortUnique(input.publishTargets ?? []);
  const candidateFamilies = sortUnique(
    input.candidateFamilies?.length
      ? input.candidateFamilies
      : inferCandidateExecutionFamilies(input.outcomeContract, {
          intent: input.intent,
          artifactKinds,
          requestedTools,
          publishTargets,
        }),
  );
  const needsVision = inferNeedsVision({ prompt, fileNames });
  const localEligible = inferLocalRoutingEligible({
    prompt,
    intent: input.intent,
    requestedTools,
    fileNames,
    artifactKinds,
  });
  const remoteProfile = inferRemoteRoutingProfile({
    prompt,
    intent: input.intent,
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
      prompt,
      intent: input.intent,
      requestedTools,
      artifactKinds,
      outcomeContract: input.outcomeContract,
      remoteProfile,
    }),
    needsVision,
  };
  return ResolutionContractSchema.parse({
    selectedFamily: selectResolutionFamily({
      outcomeContract: input.outcomeContract,
      candidateFamilies,
      artifactKinds,
      intent: input.intent,
    }),
    candidateFamilies,
    toolBundles: deriveToolBundles({
      requestedTools,
      artifactKinds,
      publishTargets,
      outcomeContract: input.outcomeContract,
      executionContract: input.executionContract,
    }),
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
