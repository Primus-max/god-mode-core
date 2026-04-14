import path from "node:path";
import type { SessionEntry } from "../../config/sessions.js";
import { readSessionMessages } from "../../gateway/session-utils.fs.js";
import { applySessionSpecialistOverrideToPlannerInput } from "../profile/session-overrides.js";
import type { RecipePlannerInput } from "../recipe/planner.js";
import {
  buildRecipePlannerInputFromRuntimePlan,
  resolvePlatformRuntimePlan,
  type RecipeRuntimePlan,
  type ResolvedPlatformRuntimePlan,
  type ResolvePlatformExecutionDecisionOptions,
} from "../recipe/runtime-adapter.js";
import { inferCandidateExecutionFamilies } from "./family-candidates.js";
import {
  countTabularFiles,
  promptSuggestsCalculationIntent,
  promptSuggestsCompareIntent,
  promptSuggestsWebsiteFrontendWork,
} from "./intent-signals.js";
import { computeQualificationConfidence } from "./qualification-confidence.js";
import {
  inferQualificationAmbiguityReasons,
  resolveLowConfidenceStrategy,
} from "./qualification-confidence.js";
import type { QualificationResult } from "./qualification-contract.js";
import { inferExecutionContract, inferRequestedEvidence } from "./execution-contract.js";
import {
  inferOutcomeContract,
  type QualificationBridgePlannerInput,
} from "./outcome-contract.js";
import {
  collectPromptHints,
  normalizeExecutionTurn,
  promptIncludesAny,
  resolveKeywordInferencePrompt,
  toUniqueLowercase,
} from "./turn-normalizer.js";

const DEVELOPER_PUBLISH_TARGET_HINTS = ["github", "npm", "docker", "vercel", "netlify"] as const;
const DEVELOPER_EXECUTION_KEYWORDS =
  /\b(build|test|fix|refactor|repo|repository|compile|ci|code|e2e|bug|tests?|тест|тесты|исправ|почин|баг|код|сборк|проверк|рефактор)\b/iu;
const DEVELOPER_PUBLISH_KEYWORDS = /\b(preview|publish|release|deploy|ship|rollout)\b/iu;
const DOCUMENT_ARTIFACT_HINTS = [
  "pdf",
  "пдф",
  "document",
  "doc",
  "docx",
  "report",
  "invoice",
  "estimate",
  "spec",
  "proposal",
  "документ",
  "отчет",
  "отчёт",
  "смет",
  "спецификац",
  "предложени",
] as const;
const MEDIA_IMAGE_HINTS = [
  "image",
  "picture",
  "screenshot",
  "illustration",
  "poster",
  "thumbnail",
  "banner",
  "icon",
  "logo",
  "infographic",
  "render",
  "изображени",
  "картин",
  "скриншот",
  "иллюстрац",
  "постер",
  "баннер",
  "иконк",
  "логотип",
  "инфограф",
  "рендер",
] as const;
const MEDIA_VIDEO_HINTS = [
  "video",
  "clip",
  "animation",
  "gif",
  "reel",
  "trailer",
  "видео",
  "ролик",
  "анимац",
  "гиф",
] as const;
const MEDIA_AUDIO_HINTS = [
  "audio",
  "voice",
  "speech",
  "podcast",
  "soundtrack",
  "music",
  "аудио",
  "голос",
  "речь",
  "подкаст",
  "саундтрек",
  "музык",
] as const;
const BROWSER_TOOL_HINTS = [
  "browser",
  "browse",
  "website",
  "web page",
  "webpage",
  "page title",
  "navigate",
  "open tab",
  "открой в браузере",
  "в браузере",
  "сайт",
  "страниц",
  "заголовок страницы",
] as const;
const WEB_SEARCH_TOOL_HINTS = [
  "web search",
  "search the web",
  "search online",
  "find online",
  "internet",
  "latest public",
  "найди в интернете",
  "поищи в интернете",
  "поиск в интернете",
  "в интернете",
] as const;
const PRESENTATION_ARTIFACT_HINTS = [
  "presentation",
  "slides",
  "slide deck",
  "deck",
  "infographic",
  "презентац",
  "слайд",
  "инфограф",
] as const;
const IMAGE_GENERATION_VERB_RE =
  /generate|create|make|draw|render|paint|сгенерируй|создай|сделай|нарисуй|отрендери/iu;
const PDF_GENERATION_VERB_RE =
  /generate|create|make|export|render|assemble|сгенерируй|создай|сделай|экспортируй|собери/iu;
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

const GENERAL_INTENT_HINTS = [
  "hello",
  "hi",
  "how are you",
  "joke",
  "fun",
  "story",
  "chat",
  "translate",
  "explain",
  "brainstorm",
  "привет",
  "здравств",
  "как дела",
  "пошут",
  "шутк",
  "истори",
  "поболта",
  "перевед",
  "объясн",
] as const;
type DecisionInputChannelHints = {
  messageChannel?: string;
  channel?: string;
  replyChannel?: string;
};

export type BuildExecutionDecisionInputParams = {
  prompt: string;
  inferencePrompt?: string;
  fileNames?: string[];
  artifactKinds?: RecipePlannerInput["artifactKinds"];
  intent?: RecipePlannerInput["intent"];
  publishTargets?: string[];
  integrations?: string[];
  requestedTools?: string[];
  channelHints?: DecisionInputChannelHints;
  sessionEntry?: Pick<
    SessionEntry,
    "specialistOverrideMode" | "specialistBaseProfileId" | "specialistSessionProfileId"
  > | null;
};

export type BuildSessionBackedExecutionDecisionInputParams = Omit<
  BuildExecutionDecisionInputParams,
  "prompt" | "fileNames" | "inferencePrompt"
> & {
  draftPrompt?: string;
  fileNames?: string[];
  storePath?: string;
  sessionEntry?: Pick<
    SessionEntry,
    | "sessionId"
    | "sessionFile"
    | "specialistOverrideMode"
    | "specialistBaseProfileId"
    | "specialistSessionProfileId"
  > | null;
};

export function shouldUseLightweightBootstrapContext(
  plannerInput: Pick<
    RecipePlannerInput,
    "intent" | "requestedTools" | "artifactKinds" | "fileNames" | "publishTargets"
  >,
): boolean {
  if ((plannerInput.fileNames?.length ?? 0) > 0) {
    return false;
  }
  if ((plannerInput.requestedTools?.length ?? 0) > 0) {
    return false;
  }
  if ((plannerInput.artifactKinds?.length ?? 0) > 0) {
    return false;
  }
  if ((plannerInput.publishTargets?.length ?? 0) > 0) {
    return false;
  }
  return plannerInput.intent === "general" || plannerInput.intent === undefined;
}

function compareLanguageInPrompt(prompt: string): boolean {
  return promptSuggestsCompareIntent(prompt);
}

function calculationLanguageInPrompt(prompt: string): boolean {
  return promptSuggestsCalculationIntent(prompt);
}

function generalLanguageInPrompt(prompt: string): boolean {
  return promptIncludesAny(prompt, GENERAL_INTENT_HINTS);
}

function tabularAttachmentCount(fileNames: string[]): number {
  return countTabularFiles(fileNames);
}

function inferCompareIntentFromAttachments(prompt: string, fileNames: string[]): boolean {
  if (tabularAttachmentCount(fileNames) < 2) {
    return false;
  }
  if (/\b(merge|concat|append|stack|объедин)\w*\b/iu.test(prompt)) {
    return false;
  }
  return true;
}

function inferPromptIntent(prompt: string, fileNames: string[]): RecipePlannerInput["intent"] {
  if (compareLanguageInPrompt(prompt) || inferCompareIntentFromAttachments(prompt, fileNames)) {
    return "compare";
  }
  if (calculationLanguageInPrompt(prompt)) {
    return "calculation";
  }
  if (promptSuggestsWebsiteFrontendWork(prompt)) {
    return "code";
  }
  const imageGenerationHint = promptNeedsImageGenerationTool(prompt);
  const documentHint = promptIncludesAny(prompt, DOCUMENT_ARTIFACT_HINTS);
  const developerExecutionHint = DEVELOPER_EXECUTION_KEYWORDS.test(prompt);
  if (documentHint && !developerExecutionHint) {
    return "document";
  }
  if (imageGenerationHint) {
    return undefined;
  }
  if (DEVELOPER_PUBLISH_KEYWORDS.test(prompt)) {
    return "publish";
  }
  if (documentHint) {
    return "document";
  }
  if (DEVELOPER_EXECUTION_KEYWORDS.test(prompt)) {
    return "code";
  }
  if (generalLanguageInPrompt(prompt) && fileNames.length === 0) {
    return "general";
  }
  return undefined;
}

function promptNeedsBrowserTool(prompt: string): boolean {
  return /https?:\/\//iu.test(prompt) || promptIncludesAny(prompt, BROWSER_TOOL_HINTS);
}

function promptNeedsWebSearchTool(prompt: string): boolean {
  return promptIncludesAny(prompt, WEB_SEARCH_TOOL_HINTS);
}

function promptNeedsImageGenerationTool(prompt: string): boolean {
  return IMAGE_GENERATION_VERB_RE.test(prompt) && promptIncludesAny(prompt, MEDIA_IMAGE_HINTS);
}

function promptNeedsPdfTool(prompt: string): boolean {
  return (
    PDF_GENERATION_VERB_RE.test(prompt) &&
    (promptIncludesAny(prompt, ["pdf", "пдф"]) ||
      promptIncludesAny(prompt, PRESENTATION_ARTIFACT_HINTS))
  );
}

function promptTargetsPdfArtifact(prompt: string, fileNames: string[]): boolean {
  return (
    promptIncludesAny(prompt, ["pdf", "пдф"]) ||
    promptIncludesAny(prompt, PRESENTATION_ARTIFACT_HINTS) ||
    fileNames.some((name) => /\.pdf$/iu.test(name))
  );
}

type ArtifactDrivenToolRule = {
  toolName: string;
  matches: (params: {
    prompt: string;
    fileNames: string[];
    artifactKinds: NonNullable<RecipePlannerInput["artifactKinds"]>;
    pdfTarget: boolean;
  }) => boolean;
};

const ARTIFACT_DRIVEN_TOOL_RULES: readonly ArtifactDrivenToolRule[] = [
  {
    toolName: "pdf",
    matches: ({ artifactKinds, pdfTarget }) => artifactKinds.includes("document") && pdfTarget,
  },
  {
    toolName: "image_generate",
    matches: ({ artifactKinds, pdfTarget }) =>
      artifactKinds.includes("image") && artifactKinds.includes("document") && pdfTarget,
  },
] as const;

function inferArtifactDrivenTools(params: {
  prompt: string;
  fileNames: string[];
  artifactKinds: NonNullable<RecipePlannerInput["artifactKinds"]>;
}): string[] {
  const pdfTarget = promptTargetsPdfArtifact(params.prompt, params.fileNames);
  return ARTIFACT_DRIVEN_TOOL_RULES.filter((rule) =>
    rule.matches({
      prompt: params.prompt,
      fileNames: params.fileNames,
      artifactKinds: params.artifactKinds,
      pdfTarget,
    }),
  ).map((rule) => rule.toolName);
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
    [
      "назови 1",
      "назови 2",
      "назови 3",
      "перечисли 1",
      "перечисли 2",
      "перечисли 3",
      "дай 1",
      "дай 2",
      "дай 3",
    ].some((hint) => normalized.includes(hint));
  const requestsBriefness = ["short", "brief", "quick", "коротк", "кратк"].some((hint) =>
    normalized.includes(hint),
  );
  return asksForShortList && requestsBriefness;
}

function promptSuggestsComplexReasoning(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (promptSuggestsLightGeneralTask(prompt)) {
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

function inferArtifactKinds(
  prompt: string,
  fileNames: string[],
): NonNullable<RecipePlannerInput["artifactKinds"]> {
  const publishTargets = collectPromptHints(prompt, DEVELOPER_PUBLISH_TARGET_HINTS);
  const compareIntentish =
    compareLanguageInPrompt(prompt) || inferCompareIntentFromAttachments(prompt, fileNames);
  const calculationIntentish = calculationLanguageInPrompt(prompt);
  const hasDocumentArtifactHintRaw = promptIncludesAny(prompt, DOCUMENT_ARTIFACT_HINTS);
  const hasDocumentArtifactHint =
    hasDocumentArtifactHintRaw && !calculationIntentish && !compareIntentish;
  const imageGenerationHint = promptNeedsImageGenerationTool(prompt);
  const hasMediaArtifactHint =
    promptIncludesAny(prompt, MEDIA_IMAGE_HINTS) ||
    promptIncludesAny(prompt, MEDIA_VIDEO_HINTS) ||
    promptIncludesAny(prompt, MEDIA_AUDIO_HINTS);
  const canInferPublishArtifacts =
    !imageGenerationHint && !hasDocumentArtifactHint && !compareIntentish && !calculationIntentish;
  return toUniqueLowercase([
    ...(promptSuggestsWebsiteFrontendWork(prompt) ? ["site"] : []),
    ...(canInferPublishArtifacts && (publishTargets.length > 0 || /\bpreview\b/iu.test(prompt))
      ? ["site"]
      : []),
    ...(canInferPublishArtifacts && (publishTargets.length > 0 || /\brelease\b/iu.test(prompt))
      ? ["release"]
      : []),
    ...(DEVELOPER_EXECUTION_KEYWORDS.test(prompt) &&
    !hasDocumentArtifactHint &&
    !hasMediaArtifactHint
      ? ["binary"]
      : []),
    ...(hasDocumentArtifactHint ? ["document"] : []),
    ...(compareIntentish ? (["data", "report"] as const) : []),
    ...(calculationIntentish ? (["report", "data"] as const) : []),
    ...(/\breport\b/iu.test(prompt) ? ["report"] : []),
    ...(/\b(отчет|отчёт)\b/iu.test(prompt) ? ["report"] : []),
    ...(promptIncludesAny(prompt, MEDIA_IMAGE_HINTS) ? ["image"] : []),
    ...(promptIncludesAny(prompt, MEDIA_VIDEO_HINTS) ? ["video"] : []),
    ...(promptIncludesAny(prompt, MEDIA_AUDIO_HINTS) ? ["audio"] : []),
  ]) as NonNullable<RecipePlannerInput["artifactKinds"]>;
}

function fileNamesImplyHeavyLocalRoute(fileNames: string[]): boolean {
  return fileNames.some((name) =>
    /\.(pdf|png|jpe?g|webp|gif|tiff?|bmp|heic|ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|java|kt|cs|cpp|h)$/iu.test(
      name,
    ),
  );
}

function artifactKindsAllowLightTabularOrCalc(
  kinds: NonNullable<RecipePlannerInput["artifactKinds"]>,
  intent: RecipePlannerInput["intent"],
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

function inferLocalRoutingEligible(params: {
  prompt: string;
  intent: RecipePlannerInput["intent"];
  requestedTools: string[];
  fileNames: string[];
  artifactKinds: NonNullable<RecipePlannerInput["artifactKinds"]>;
}): boolean {
  if (params.intent === "code" || params.intent === "publish") {
    return false;
  }
  if (params.requestedTools.some((tool) => HEAVY_TOOL_IDS.has(tool))) {
    return false;
  }
  if (promptSuggestsHeavyDocumentWork(params.prompt)) {
    return false;
  }
  if (promptSuggestsComplexReasoning(params.prompt)) {
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
  intent: RecipePlannerInput["intent"];
  requestedTools: string[];
  artifactKinds: NonNullable<RecipePlannerInput["artifactKinds"]>;
  localEligible: boolean;
}): NonNullable<NonNullable<RecipePlannerInput["routing"]>["remoteProfile"]> {
  const wantsPresentationQuality =
    params.intent === "document" &&
    params.artifactKinds.includes("document") &&
    params.requestedTools.includes("pdf") &&
    (params.requestedTools.includes("image_generate") ||
      params.artifactKinds.includes("image") ||
      inferNeedsVision({ prompt: params.prompt, fileNames: [] }));
  if (wantsPresentationQuality) {
    return "presentation";
  }
  if (
    params.intent === "code" ||
    params.intent === "publish" ||
    params.requestedTools.some((tool) => HEAVY_TOOL_IDS.has(tool))
  ) {
    return "code";
  }
  if (
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
  intent: RecipePlannerInput["intent"];
  requestedTools: string[];
  artifactKinds: NonNullable<RecipePlannerInput["artifactKinds"]>;
}): boolean {
  if (params.intent === "publish") {
    return true;
  }
  if (params.requestedTools.includes("browser") || params.requestedTools.includes("web_search")) {
    return true;
  }
  if (
    params.artifactKinds.some(
      (kind) =>
        kind === "image" ||
        kind === "video" ||
        kind === "audio" ||
        kind === "site" ||
        kind === "release",
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

function inferNeedsVision(params: { prompt: string; fileNames: string[] }): boolean {
  if (promptSuggestsHeavyDocumentWork(params.prompt)) {
    return true;
  }
  return params.fileNames.some((name) => /\.(pdf|png|jpe?g|webp|gif|tiff?|bmp|heic)$/iu.test(name));
}

export function buildExecutionDecisionInput(
  params: BuildExecutionDecisionInputParams,
): RecipePlannerInput {
  const normalizedTurn = normalizeExecutionTurn({
    prompt: params.prompt,
    inferencePrompt: params.inferencePrompt,
    fileNames: params.fileNames,
  });
  const fileNames = normalizedTurn.fileNames;
  const inferencePromptCandidate = normalizedTurn.inferencePrompt;
  const candidatePublishTargets = collectPromptHints(
    inferencePromptCandidate,
    DEVELOPER_PUBLISH_TARGET_HINTS,
  );
  const candidateIntent = inferPromptIntent(inferencePromptCandidate, fileNames);
  const candidateArtifactKinds = inferArtifactKinds(inferencePromptCandidate, fileNames);
  const inferencePrompt =
    !params.inferencePrompt &&
    inferencePromptCandidate !== params.prompt &&
    !candidateIntent &&
    candidatePublishTargets.length === 0 &&
    candidateArtifactKinds.length === 0
      ? params.prompt
      : inferencePromptCandidate;
  const inferredPublishTargets = collectPromptHints(
    inferencePrompt,
    DEVELOPER_PUBLISH_TARGET_HINTS,
  );
  const inferredIntegrations = inferredPublishTargets.filter((target) => target !== "npm");
  const inferredIntent = inferPromptIntent(inferencePrompt, fileNames);
  const effectiveIntent = params.intent ?? inferredIntent;
  const inferredRequestedTools = toUniqueLowercase([
    ...(effectiveIntent === "code" || effectiveIntent === "publish"
      ? ["exec", "apply_patch", "process"]
      : []),
    ...(promptNeedsBrowserTool(inferencePrompt) ? ["browser"] : []),
    ...(promptNeedsWebSearchTool(inferencePrompt) ? ["web_search"] : []),
    ...(promptNeedsImageGenerationTool(inferencePrompt) ? ["image_generate"] : []),
    ...(promptNeedsPdfTool(inferencePrompt) ? ["pdf"] : []),
  ]);
  const channelHints = toUniqueLowercase([
    params.channelHints?.messageChannel,
    params.channelHints?.channel,
    params.channelHints?.replyChannel,
  ]);
  const publishTargets = toUniqueLowercase([
    ...inferredPublishTargets,
    ...(params.publishTargets ?? []),
  ]);
  const integrations = toUniqueLowercase([
    ...inferredIntegrations,
    ...(params.integrations ?? []),
    ...channelHints,
  ]);
  const artifactKinds = toUniqueLowercase([
    ...(inferencePrompt === inferencePromptCandidate
      ? candidateArtifactKinds
      : inferArtifactKinds(inferencePrompt, fileNames)),
    ...((params.artifactKinds ?? []) as string[]),
  ]) as NonNullable<RecipePlannerInput["artifactKinds"]>;
  const requestedTools = toUniqueLowercase([
    ...inferredRequestedTools,
    ...inferArtifactDrivenTools({
      prompt: inferencePrompt,
      fileNames,
      artifactKinds,
    }),
    ...(params.requestedTools ?? []),
  ]);
  const localRoutingEligible = inferLocalRoutingEligible({
    prompt: inferencePrompt,
    intent: effectiveIntent,
    requestedTools,
    fileNames,
    artifactKinds,
  });
  const remoteProfile = inferRemoteRoutingProfile({
    prompt: inferencePrompt,
    intent: effectiveIntent,
    requestedTools,
    artifactKinds,
    localEligible: localRoutingEligible,
  });
  const preferRemoteFirst = inferPreferRemoteFirst({
    prompt: inferencePrompt,
    intent: effectiveIntent,
    requestedTools,
    artifactKinds,
  });
  const needsVision = inferNeedsVision({ prompt: inferencePrompt, fileNames });
  const qualification = buildQualificationResultFromPlannerInput({
    ...(effectiveIntent ? { intent: effectiveIntent } : {}),
    ...(artifactKinds.length > 0 ? { artifactKinds } : {}),
    ...(requestedTools.length > 0 ? { requestedTools } : {}),
    ...(publishTargets.length > 0 ? { publishTargets } : {}),
  });
  return applySessionSpecialistOverrideToPlannerInput(
    {
      prompt: params.prompt,
      ...(effectiveIntent ? { intent: effectiveIntent } : {}),
      ...(fileNames.length > 0 ? { fileNames } : {}),
      ...(publishTargets.length > 0 ? { publishTargets } : {}),
      ...(integrations.length > 0 ? { integrations } : {}),
      ...(requestedTools.length > 0 ? { requestedTools } : {}),
      ...(artifactKinds.length > 0 ? { artifactKinds } : {}),
      outcomeContract: qualification.outcomeContract,
      executionContract: qualification.executionContract,
      requestedEvidence: [...qualification.requestedEvidence],
      confidence: qualification.confidence,
      ambiguityReasons: qualification.ambiguityReasons,
      lowConfidenceStrategy: qualification.lowConfidenceStrategy,
      candidateFamilies: [...qualification.candidateFamilies],
      routing: {
        localEligible: localRoutingEligible,
        remoteProfile,
        ...(preferRemoteFirst ? { preferRemoteFirst: true } : {}),
        ...(needsVision ? { needsVision: true } : {}),
      },
    },
    params.sessionEntry,
  );
}

export function resolveExecutionRuntimePlan(
  params: BuildExecutionDecisionInputParams,
): ResolvedPlatformRuntimePlan {
  return resolvePlatformRuntimePlan(buildExecutionDecisionInput(params));
}

/**
 * Builds planner input from a persisted `RecipeRuntimePlan` so intent, tools, artifacts,
 * and publish targets stay aligned with the prior platform resolution instead of being re-inferred
 * from raw prompt text.
 */
export function buildExecutionDecisionInputFromRuntimePlan(params: {
  runtime: RecipeRuntimePlan;
  prompt: string;
  fileNames?: string[];
  sessionEntry?: BuildExecutionDecisionInputParams["sessionEntry"];
}): RecipePlannerInput {
  const base = buildRecipePlannerInputFromRuntimePlan(params.runtime, params.prompt, {
    fileNames: params.fileNames,
  });
  return applySessionSpecialistOverrideToPlannerInput(base, params.sessionEntry ?? null);
}

/** Re-runs platform resolution using structured fields carried by an existing runtime plan. */
export function resolveExecutionRuntimePlanFromExistingRuntime(params: {
  runtime: RecipeRuntimePlan;
  prompt: string;
  fileNames?: string[];
  sessionEntry?: BuildExecutionDecisionInputParams["sessionEntry"];
  options?: ResolvePlatformExecutionDecisionOptions;
}): ResolvedPlatformRuntimePlan {
  return resolvePlatformRuntimePlan(
    buildExecutionDecisionInputFromRuntimePlan(params),
    params.options ?? {},
  );
}

export function buildSessionBackedExecutionDecisionInput(
  params: BuildSessionBackedExecutionDecisionInputParams,
): BuildExecutionDecisionInputParams {
  const messages =
    params.sessionEntry?.sessionId && params.storePath
      ? readSessionMessages(
          params.sessionEntry.sessionId,
          params.storePath,
          params.sessionEntry.sessionFile,
        )
      : [];
  const sessionContext = resolveSessionDecisionInputContext(messages);
  const prompt = [sessionContext.prompt, params.draftPrompt?.trim()].filter(Boolean).join("\n\n");
  const fileNames = Array.from(new Set([...sessionContext.fileNames, ...(params.fileNames ?? [])]));
  const inferencePrompt =
    typeof params.draftPrompt === "string" && params.draftPrompt.trim().length > 0
      ? resolveKeywordInferencePrompt(params.draftPrompt)
      : undefined;
  return {
    prompt,
    ...(inferencePrompt ? { inferencePrompt } : {}),
    ...(fileNames.length > 0 ? { fileNames } : {}),
    ...(params.artifactKinds?.length ? { artifactKinds: params.artifactKinds } : {}),
    ...(params.intent ? { intent: params.intent } : {}),
    ...(params.publishTargets?.length ? { publishTargets: params.publishTargets } : {}),
    ...(params.integrations?.length ? { integrations: params.integrations } : {}),
    ...(params.requestedTools?.length ? { requestedTools: params.requestedTools } : {}),
    ...(params.channelHints ? { channelHints: params.channelHints } : {}),
    ...(params.sessionEntry ? { sessionEntry: params.sessionEntry } : {}),
  };
}

export function resolveSessionBackedExecutionRuntimePlan(
  params: BuildSessionBackedExecutionDecisionInputParams,
): ResolvedPlatformRuntimePlan {
  return resolveExecutionRuntimePlan(buildSessionBackedExecutionDecisionInput(params));
}

function extractTranscriptUserText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textBlocks = content
    .map((block) =>
      block && typeof block === "object" && "text" in block
        ? (block as { text?: unknown }).text
        : undefined,
    )
    .filter((text): text is string => typeof text === "string");
  return textBlocks.length > 0 ? textBlocks.join("") : undefined;
}

function pushMediaPath(value: unknown, into: Set<string>) {
  if (typeof value !== "string" || !value.trim()) {
    return;
  }
  into.add(path.basename(value.trim()));
}

/**
 * Builds a compact planner context from the latest user turns in a session transcript.
 *
 * The same recent user-message window is used for both prompt text and attachment-derived
 * file names so older spreadsheet uploads do not leak into a new unrelated turn.
 *
 * @param {unknown[]} messages - Raw transcript messages for the current session.
 * @returns {{ prompt: string; fileNames: string[] }} Prompt text and attachment file names.
 */
export function resolveSessionDecisionInputContext(messages: unknown[]): {
  prompt: string;
  fileNames: string[];
} {
  const recentUserMessages = messages
    .slice(-24)
    .filter(
      (
        raw,
      ): raw is {
        role?: unknown;
        content?: unknown;
        MediaPath?: unknown;
        MediaPaths?: unknown;
      } => Boolean(raw) && typeof raw === "object" && (raw as { role?: unknown }).role === "user",
    )
    .slice(-6);
  const recentTexts: string[] = [];
  const fileNames = new Set<string>();
  for (const message of recentUserMessages) {
    const text = extractTranscriptUserText(message.content)?.trim();
    if (text) {
      recentTexts.push(text);
    }
    pushMediaPath(message.MediaPath, fileNames);
    if (Array.isArray(message.MediaPaths)) {
      for (const entry of message.MediaPaths) {
        pushMediaPath(entry, fileNames);
      }
    }
  }
  return {
    prompt: recentTexts.join("\n\n"),
    fileNames: Array.from(fileNames).slice(-8),
  };
}

export function buildQualificationResultFromPlannerInput(
  input: QualificationBridgePlannerInput,
): QualificationResult {
  const outcomeContract = inferOutcomeContract(input);
  const executionContract = inferExecutionContract(outcomeContract, input);
  const candidateFamilies = inferCandidateExecutionFamilies(outcomeContract, input);
  const ambiguityReasons = inferQualificationAmbiguityReasons({
    outcomeContract,
    executionContract,
    candidateFamilies,
    intent: input.intent,
    artifactKinds: input.artifactKinds,
    requestedTools: input.requestedTools,
    publishTargets: input.publishTargets,
  });
  const confidence = computeQualificationConfidence({
    outcomeContract,
    executionContract,
    candidateFamilies,
    ambiguityReasons,
    intent: input.intent,
    artifactKinds: input.artifactKinds,
    requestedTools: input.requestedTools,
    publishTargets: input.publishTargets,
  });
  return {
    outcomeContract,
    executionContract,
    requestedEvidence: inferRequestedEvidence(outcomeContract, executionContract),
    confidence,
    ambiguityReasons,
    lowConfidenceStrategy: resolveLowConfidenceStrategy({
      outcomeContract,
      executionContract,
      candidateFamilies,
      confidence,
      ambiguityReasons,
      intent: input.intent,
      artifactKinds: input.artifactKinds,
      requestedTools: input.requestedTools,
      publishTargets: input.publishTargets,
    }),
    candidateFamilies,
  };
}
