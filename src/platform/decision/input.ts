import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { readSessionMessages } from "../../gateway/session-utils.fs.js";
import { defaultRuntime } from "../../runtime.js";
import { getCurrentTurnProgressEmitter } from "../progress/progress-bus.js";
import { applySessionSpecialistOverrideToPlannerInput } from "../profile/session-overrides.js";
import type { RecipePlannerInput } from "../recipe/planner.js";
import { buildIntentLedgerContext, intentLedger } from "../session/intent-ledger.js";
import {
  buildRecipePlannerInputFromRuntimePlan,
  resolvePlatformRuntimePlan,
  type RecipeRuntimePlan,
  type ResolvedPlatformRuntimePlan,
  type ResolvePlatformExecutionDecisionOptions,
} from "../recipe/runtime-adapter.js";
import { inferExecutionContract, inferRequestedEvidence } from "./execution-contract.js";
import { inferCandidateExecutionFamilies } from "./family-candidates.js";
import { inferOutcomeContract, type QualificationBridgePlannerInput } from "./outcome-contract.js";
import { computeQualificationConfidence } from "./qualification-confidence.js";
import {
  inferQualificationAmbiguityReasons,
  resolveLowConfidenceStrategy,
} from "./qualification-confidence.js";
import type { QualificationResult } from "./qualification-contract.js";
import { resolveResolutionContract, toRecipeRoutingHints } from "./resolution-contract.js";
import { classifyTaskForDecision, type TaskClassifierAdapter } from "./task-classifier.js";
import {
  normalizeExecutionTurn,
  resolveKeywordInferencePrompt,
  toUniqueLowercase,
} from "./turn-normalizer.js";

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

function resolveIntentLedgerChannelId(channelHints?: DecisionInputChannelHints): string | undefined {
  const candidate = (
    channelHints?.messageChannel ??
    channelHints?.channel ??
    channelHints?.replyChannel
  )?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
}

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

export function buildExecutionDecisionInput(
  params: BuildExecutionDecisionInputParams,
): RecipePlannerInput {
  const normalizedTurn = normalizeExecutionTurn({
    prompt: params.prompt,
    inferencePrompt: params.inferencePrompt,
    fileNames: params.fileNames,
  });
  const prompt = normalizedTurn.prompt;
  const fileNames = normalizedTurn.fileNames;
  const inferencePrompt = normalizedTurn.inferencePrompt;
  const effectiveIntent = params.intent;
  const channelHints = toUniqueLowercase([
    params.channelHints?.messageChannel,
    params.channelHints?.channel,
    params.channelHints?.replyChannel,
  ]);
  const publishTargets = toUniqueLowercase(params.publishTargets);
  const integrations = toUniqueLowercase([...(params.integrations ?? []), ...channelHints]);
  const artifactKinds = toUniqueLowercase(
    (params.artifactKinds ?? []) as Array<string | undefined>,
  ) as NonNullable<RecipePlannerInput["artifactKinds"]>;
  const requestedTools = toUniqueLowercase(params.requestedTools);
  const qualification = buildQualificationResultFromPlannerInput({
    ...(effectiveIntent ? { intent: effectiveIntent } : {}),
    ...(artifactKinds.length > 0 ? { artifactKinds } : {}),
    ...(requestedTools.length > 0 ? { requestedTools } : {}),
    ...(publishTargets.length > 0 ? { publishTargets } : {}),
  });
  const resolutionContract = resolveResolutionContract({
    ...(effectiveIntent ? { intent: effectiveIntent } : {}),
    ...(fileNames.length > 0 ? { fileNames } : {}),
    ...(artifactKinds.length > 0 ? { artifactKinds } : {}),
    ...(requestedTools.length > 0 ? { requestedTools } : {}),
    ...(publishTargets.length > 0 ? { publishTargets } : {}),
    outcomeContract: qualification.outcomeContract,
    executionContract: qualification.executionContract,
    candidateFamilies: qualification.candidateFamilies,
  });
  return applySessionSpecialistOverrideToPlannerInput(
    {
      prompt,
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
      candidateFamilies: [...resolutionContract.candidateFamilies],
      resolutionContract,
      routing: toRecipeRoutingHints(resolutionContract),
    },
    params.sessionEntry,
  );
}

export function resolveExecutionRuntimePlan(
  params: BuildExecutionDecisionInputParams,
): ResolvedPlatformRuntimePlan {
  return resolvePlatformRuntimePlan({
    ...buildExecutionDecisionInput(params),
    callerTag: "legacy-resolveExecutionRuntimePlan",
  });
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
    {
      ...buildExecutionDecisionInputFromRuntimePlan(params),
      callerTag: "legacy-resolveExecutionRuntimePlanFromExistingRuntime",
    },
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

export async function buildClassifiedExecutionDecisionInput(params: {
  prompt: string;
  fileNames?: string[];
  channelHints?: DecisionInputChannelHints;
  sessionEntry?: Pick<
    SessionEntry,
    | "sessionId"
    | "sessionFile"
    | "specialistOverrideMode"
    | "specialistBaseProfileId"
    | "specialistSessionProfileId"
  > | null;
  storePath?: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  adapterRegistry?: Readonly<Record<string, TaskClassifierAdapter>>;
}): Promise<RecipePlannerInput> {
  const classifierInput = buildSessionBackedExecutionDecisionInput({
    draftPrompt: params.prompt,
    ...(params.fileNames?.length ? { fileNames: params.fileNames } : {}),
    storePath: params.storePath,
    ...(params.channelHints ? { channelHints: params.channelHints } : {}),
    ...(params.sessionEntry ? { sessionEntry: params.sessionEntry } : {}),
  });
  const classifierPrompt = params.prompt.trim() || classifierInput.prompt;
  const ledgerSessionId = params.sessionEntry?.sessionId?.trim();
  const ledgerChannelId = resolveIntentLedgerChannelId(params.channelHints);
  const pendingCommitments =
    ledgerSessionId && ledgerChannelId
      ? intentLedger.peekPending(ledgerSessionId, ledgerChannelId)
      : [];
  const ledgerContext = buildIntentLedgerContext(pendingCommitments);
  defaultRuntime.log(
    `[intent-ledger] peek=${String(pendingCommitments.length)} injected=${ledgerContext ? "1" : "0"}`,
  );
  getCurrentTurnProgressEmitter()?.emit("classifying");
  const classified = await classifyTaskForDecision({
    prompt: classifierPrompt,
    fileNames: classifierInput.fileNames,
    cfg: params.cfg,
    agentDir: params.agentDir,
    input: classifierInput,
    ledgerContext,
    adapterRegistry: params.adapterRegistry,
  });
  return applySessionSpecialistOverrideToPlannerInput(
    {
      ...classified.plannerInput,
      ...(classifierInput.integrations?.length
        ? { integrations: classifierInput.integrations }
        : {}),
    },
    params.sessionEntry,
  );
}

export async function resolveClassifiedSessionBackedExecutionRuntimePlan(params: {
  draftPrompt?: string;
  fileNames?: string[];
  channelHints?: DecisionInputChannelHints;
  sessionEntry?: Pick<
    SessionEntry,
    | "sessionId"
    | "sessionFile"
    | "specialistOverrideMode"
    | "specialistBaseProfileId"
    | "specialistSessionProfileId"
  > | null;
  storePath?: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  adapterRegistry?: Readonly<Record<string, TaskClassifierAdapter>>;
}): Promise<ResolvedPlatformRuntimePlan> {
  const plannerInput = await buildClassifiedExecutionDecisionInput({
    prompt: params.draftPrompt ?? "",
    ...(params.fileNames?.length ? { fileNames: params.fileNames } : {}),
    ...(params.channelHints ? { channelHints: params.channelHints } : {}),
    ...(params.sessionEntry ? { sessionEntry: params.sessionEntry } : {}),
    storePath: params.storePath,
    cfg: params.cfg,
    agentDir: params.agentDir,
    adapterRegistry: params.adapterRegistry,
  });
  return resolvePlatformRuntimePlan({
    ...plannerInput,
    callerTag: "legacy-resolveClassifiedSessionBackedExecutionRuntimePlan",
  });
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
