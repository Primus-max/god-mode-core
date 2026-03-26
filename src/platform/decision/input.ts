import path from "node:path";
import { readSessionMessages } from "../../gateway/session-utils.fs.js";
import type { SessionEntry } from "../../config/sessions.js";
import { applySessionSpecialistOverrideToPlannerInput } from "../profile/session-overrides.js";
import type { RecipePlannerInput } from "../recipe/planner.js";
import { resolvePlatformRuntimePlan, type ResolvedPlatformRuntimePlan } from "../recipe/runtime-adapter.js";

const DEVELOPER_PUBLISH_TARGET_HINTS = ["github", "npm", "docker", "vercel", "netlify"] as const;
const DEVELOPER_EXECUTION_KEYWORDS =
  /\b(build|test|fix|refactor|repo|repository|compile|ci|code)\b/iu;
const DEVELOPER_PUBLISH_KEYWORDS = /\b(preview|publish|release|deploy|ship|rollout)\b/iu;

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

function inferPromptIntent(prompt: string): RecipePlannerInput["intent"] {
  if (DEVELOPER_PUBLISH_KEYWORDS.test(prompt)) {
    return "publish";
  }
  if (DEVELOPER_EXECUTION_KEYWORDS.test(prompt)) {
    return "code";
  }
  return undefined;
}

function inferArtifactKinds(prompt: string): NonNullable<RecipePlannerInput["artifactKinds"]> {
  const publishTargets = collectPromptHints(prompt, DEVELOPER_PUBLISH_TARGET_HINTS);
  return toUniqueLowercase([
    ...(publishTargets.length > 0 || /\bpreview\b/iu.test(prompt) ? ["site"] : []),
    ...(publishTargets.length > 0 || /\brelease\b/iu.test(prompt) ? ["release"] : []),
    ...(DEVELOPER_EXECUTION_KEYWORDS.test(prompt) ? ["binary"] : []),
  ]) as NonNullable<RecipePlannerInput["artifactKinds"]>;
}

export function buildExecutionDecisionInput(
  params: BuildExecutionDecisionInputParams,
): RecipePlannerInput {
  const inferredPublishTargets = collectPromptHints(params.prompt, DEVELOPER_PUBLISH_TARGET_HINTS);
  const inferredIntegrations = inferredPublishTargets.filter((target) => target !== "npm");
  const inferredIntent = inferPromptIntent(params.prompt);
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
  const fileNames = Array.from(
    new Set(
      (params.fileNames ?? [])
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim()),
    ),
  );
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
    ...inferArtifactKinds(params.prompt),
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
      block && typeof block === "object" && "text" in block ? (block as { text?: unknown }).text : undefined,
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

export function resolveSessionDecisionInputContext(
  messages: unknown[],
): { prompt: string; fileNames: string[] } {
  const recentTexts: string[] = [];
  const fileNames = new Set<string>();
  for (const raw of messages.slice(-24)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const message = raw as {
      role?: unknown;
      content?: unknown;
      MediaPath?: unknown;
      MediaPaths?: unknown;
    };
    if (message.role !== "user") {
      continue;
    }
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
    prompt: recentTexts.slice(-6).join("\n\n"),
    fileNames: Array.from(fileNames).slice(-8),
  };
}
