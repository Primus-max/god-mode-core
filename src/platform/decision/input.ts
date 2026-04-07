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

const DEVELOPER_PUBLISH_TARGET_HINTS = ["github", "npm", "docker", "vercel", "netlify"] as const;
const DEVELOPER_EXECUTION_KEYWORDS =
  /\b(build|test|fix|refactor|repo|repository|compile|ci|code)\b/iu;
const DEVELOPER_PUBLISH_KEYWORDS = /\b(preview|publish|release|deploy|ship|rollout)\b/iu;
const DOCUMENT_ARTIFACT_HINTS = [
  "pdf",
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
  "render",
  "изображени",
  "картин",
  "скриншот",
  "иллюстрац",
  "постер",
  "баннер",
  "иконк",
  "логотип",
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

const COMPARE_INTENT_HINTS = [
  "compare",
  "comparison",
  "comparing",
  "reconcile",
  "reconciliation",
  "side by side",
  "price diff",
  "discrepanc",
  "variance",
  "match up",
  "сравн",
  "сопостав",
  "расхожден",
  "совпаден",
  "сверк",
  "выверк",
  "разница в цен",
] as const;

const CALCULATION_INTENT_HINTS = [
  "ventilation",
  "cfm",
  "airflow",
  "hvac",
  "duct",
  "btu",
  "unit conversion",
  "dimensional analysis",
  "square feet",
  "square foot",
  "cubic meter",
  "cubic metre",
  "ventilation report",
  "вентиляц",
  "кубатур",
  "площад",
  "перевод единиц",
  "единиц измерен",
  "размер помещен",
  "расчёт",
  "расчет",
  "рассчитай",
  "приток",
  "вытяжк",
] as const;
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
  "prompt" | "fileNames"
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

function collectPromptHints(prompt: string, candidates: readonly string[]): string[] {
  const normalized = prompt.toLowerCase();
  return candidates.filter((candidate) => normalized.includes(candidate));
}

function toUniqueLowercase(values: Array<string | undefined> | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim().toLowerCase()),
    ),
  );
}

function promptIncludesAny(prompt: string, hints: readonly string[]): boolean {
  const normalized = prompt.toLowerCase();
  return hints.some((hint) => normalized.includes(hint));
}

function resolveKeywordInferencePrompt(prompt: string): string {
  const segments = prompt
    .split(/\n\s*\n/iu)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.at(-1) ?? prompt;
}

function compareLanguageInPrompt(prompt: string): boolean {
  return (
    promptIncludesAny(prompt, COMPARE_INTENT_HINTS) ||
    /\b(diff|deltas?|delta\b|reconcil\w*)\b/iu.test(prompt) ||
    /\b(два|две|три|оба|обе)\s+(csv|файл|таблиц|экспорт|xlsx)\b/iu.test(prompt)
  );
}

function calculationLanguageInPrompt(prompt: string): boolean {
  return (
    promptIncludesAny(prompt, CALCULATION_INTENT_HINTS) ||
    /\b(dimensions?|measurement|square\s*meter|sq\s*m\b)\b/iu.test(prompt)
  );
}

function generalLanguageInPrompt(prompt: string): boolean {
  return promptIncludesAny(prompt, GENERAL_INTENT_HINTS);
}

function tabularAttachmentCount(fileNames: string[]): number {
  return fileNames.filter((name) => /\.(csv|xlsx|xls|ods)$/iu.test(name)).length;
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
  const documentHint = promptIncludesAny(prompt, DOCUMENT_ARTIFACT_HINTS);
  const developerExecutionHint = DEVELOPER_EXECUTION_KEYWORDS.test(prompt);
  if (documentHint && !developerExecutionHint) {
    return "document";
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
  const hasMediaArtifactHint =
    promptIncludesAny(prompt, MEDIA_IMAGE_HINTS) ||
    promptIncludesAny(prompt, MEDIA_VIDEO_HINTS) ||
    promptIncludesAny(prompt, MEDIA_AUDIO_HINTS);
  return toUniqueLowercase([
    ...(publishTargets.length > 0 || /\bpreview\b/iu.test(prompt) ? ["site"] : []),
    ...(publishTargets.length > 0 || /\brelease\b/iu.test(prompt) ? ["release"] : []),
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

export function buildExecutionDecisionInput(
  params: BuildExecutionDecisionInputParams,
): RecipePlannerInput {
  const fileNames = Array.from(
    new Set(
      (params.fileNames ?? [])
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim()),
    ),
  );
  const inferencePrompt = resolveKeywordInferencePrompt(params.prompt);
  const inferredPublishTargets = collectPromptHints(inferencePrompt, DEVELOPER_PUBLISH_TARGET_HINTS);
  const inferredIntegrations = inferredPublishTargets.filter((target) => target !== "npm");
  const inferredIntent = inferPromptIntent(inferencePrompt, fileNames);
  const effectiveIntent = params.intent ?? inferredIntent;
  const inferredRequestedTools =
    effectiveIntent === "code" || effectiveIntent === "publish"
      ? ["exec", "apply_patch", "process"]
      : [];
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
    ...inferArtifactKinds(inferencePrompt, fileNames),
    ...((params.artifactKinds ?? []) as string[]),
  ]) as NonNullable<RecipePlannerInput["artifactKinds"]>;
  const requestedTools = toUniqueLowercase([
    ...inferredRequestedTools,
    ...(params.requestedTools ?? []),
  ]);

  return applySessionSpecialistOverrideToPlannerInput(
    {
      prompt: params.prompt,
      ...(effectiveIntent ? { intent: effectiveIntent } : {}),
      ...(fileNames.length > 0 ? { fileNames } : {}),
      ...(publishTargets.length > 0 ? { publishTargets } : {}),
      ...(integrations.length > 0 ? { integrations } : {}),
      ...(requestedTools.length > 0 ? { requestedTools } : {}),
      ...(artifactKinds.length > 0 ? { artifactKinds } : {}),
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
  return {
    prompt,
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
