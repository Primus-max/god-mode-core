import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { resolveAcpAgentPolicyError, resolveAcpDispatchPolicyError } from "../acp/policy.js";
import { toAcpRuntimeError } from "../acp/runtime/errors.js";
import { resolveAcpSessionCwd } from "../acp/runtime/session-identifiers.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/agent-command");
import { normalizeReplyPayload } from "../auto-reply/reply/normalize-reply.js";
import {
  formatThinkingLevels,
  formatXHighModelHint,
  normalizeThinkLevel,
  normalizeVerboseLevel,
  supportsXHighThinking,
  type ThinkLevel,
  type VerboseLevel,
} from "../auto-reply/thinking.js";
import {
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
} from "../auto-reply/tokens.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveCommandSecretRefsViaGateway } from "../cli/command-secret-gateway.js";
import { getAgentRuntimeCommandSecretTargetIds } from "../cli/command-secret-targets.js";
import { type CliDeps, createDefaultDeps } from "../cli/deps.js";
import {
  loadConfig,
  readConfigFileSnapshotForWrite,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import {
  mergeSessionEntry,
  resolveAgentIdFromSessionKey,
  type SessionEntry,
  updateSessionStore,
} from "../config/sessions.js";
import { resolveSessionTranscriptFile } from "../config/sessions/transcript.js";
import {
  clearAgentRunContext,
  emitAgentEvent,
  registerAgentRunContext,
} from "../infra/agent-events.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { getRemoteSkillEligibility } from "../infra/skills-remote.js";
import {
  buildExecutionDecisionInput,
  buildClassifiedExecutionDecisionInput,
  buildSessionBackedExecutionDecisionInput,
  shouldUseLightweightBootstrapContext,
} from "../platform/decision/input.js";
import {
  classifyTaskForDecision,
  type TaskClassifierAdapter,
} from "../platform/decision/task-classifier.js";
import { applySessionSpecialistOverrideToPlannerInput } from "../platform/profile/session-overrides.js";
import {
  resolvePlatformRuntimePlan,
  type ResolvedPlatformRuntimePlan,
  toPluginHookPlatformExecutionContext,
} from "../platform/recipe/runtime-adapter.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { applyVerboseOverride } from "../sessions/level-overrides.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { resolveMessageChannel } from "../utils/message-channel.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveEffectiveModelFallbacks,
  resolveSessionAgentId,
  resolveAgentSkillsFilter,
  resolveAgentWorkspaceDir,
} from "./agent-scope.js";
import { ensureAuthProfileStore } from "./auth-profiles.js";
import { clearSessionAuthProfileOverride } from "./auth-profiles/session-override.js";
import { resolveBootstrapWarningSignaturesSeen } from "./bootstrap-budget.js";
import { runCliAgent } from "./cli-runner.js";
import { getCliSessionId, setCliSessionId } from "./cli-session.js";
import { deliverAgentCommandResult } from "./command/delivery.js";
import { resolveAgentRunContext } from "./command/run-context.js";
import { updateSessionStoreAfterAgentRun } from "./command/session-store.js";
import { resolveSession } from "./command/session.js";
import type { AgentCommandIngressOpts, AgentCommandOpts } from "./command/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { FailoverError } from "./failover-error.js";
import { formatAgentInternalEventsForPrompt } from "./internal-events.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { loadModelCatalog } from "./model-catalog.js";
import { runWithModelFallback } from "./model-fallback.js";
import {
  buildAllowedModelSet,
  isCliProvider,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolveThinkingDefault,
} from "./model-selection.js";
import { prepareSessionManagerForRun } from "./pi-embedded-runner/session-manager-init.js";
import { runEmbeddedPiAgent } from "./pi-embedded.js";
import { resolveRuntimePlanFallbackOverride } from "./runtime-plan-policy.js";
import { buildWorkspaceSkillSnapshot } from "./skills.js";
import { getSkillsSnapshotVersion } from "./skills/refresh.js";
import { normalizeSpawnedRunMetadata } from "./spawned-context.js";
import { resolveAgentTimeoutMs } from "./timeout.js";
import { ensureAgentWorkspace } from "./workspace.js";

type PersistSessionEntryParams = {
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry;
};

type OverrideFieldClearedByDelete =
  | "providerOverride"
  | "modelOverride"
  | "authProfileOverride"
  | "authProfileOverrideSource"
  | "authProfileOverrideCompactionCount"
  | "fallbackNoticeSelectedModel"
  | "fallbackNoticeActiveModel"
  | "fallbackNoticeReason"
  | "claudeCliSessionId";

const OVERRIDE_FIELDS_CLEARED_BY_DELETE: OverrideFieldClearedByDelete[] = [
  "providerOverride",
  "modelOverride",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
  "fallbackNoticeSelectedModel",
  "fallbackNoticeActiveModel",
  "fallbackNoticeReason",
  "claudeCliSessionId",
];

const OVERRIDE_VALUE_MAX_LENGTH = 256;

function containsControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function normalizeExplicitOverrideInput(raw: string, kind: "provider" | "model"): string {
  const trimmed = raw.trim();
  const label = kind === "provider" ? "Provider" : "Model";
  if (!trimmed) {
    throw new Error(`${label} override must be non-empty.`);
  }
  if (trimmed.length > OVERRIDE_VALUE_MAX_LENGTH) {
    throw new Error(`${label} override exceeds ${String(OVERRIDE_VALUE_MAX_LENGTH)} characters.`);
  }
  if (containsControlCharacters(trimmed)) {
    throw new Error(`${label} override contains invalid control characters.`);
  }
  return trimmed;
}

async function persistSessionEntry(params: PersistSessionEntryParams): Promise<void> {
  const persisted = await updateSessionStore(params.storePath, (store) => {
    const merged = mergeSessionEntry(store[params.sessionKey], params.entry);
    // Preserve explicit `delete` clears done by session override helpers.
    for (const field of OVERRIDE_FIELDS_CLEARED_BY_DELETE) {
      if (!Object.hasOwn(params.entry, field)) {
        Reflect.deleteProperty(merged, field);
      }
    }
    store[params.sessionKey] = merged;
    return merged;
  });
  params.sessionStore[params.sessionKey] = persisted;
}

function resolveFallbackRetryPrompt(params: { body: string; isFallbackRetry: boolean }): string {
  if (!params.isFallbackRetry) {
    return params.body;
  }
  return [
    "Continue where you left off.",
    "The previous model attempt failed, timed out, or returned an invalid non-final reply.",
    "Do not restart from scratch, do not ask another clarifying question, and do not answer with a status-only acknowledgement.",
    "If this turn requires a direct artifact, use sensible defaults and call the required tool now.",
  ].join(" ");
}

function prependInternalEventContext(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  if (body.includes("OpenClaw runtime context (internal):")) {
    return body;
  }
  const renderedEvents = formatAgentInternalEventsForPrompt(events);
  if (!renderedEvents) {
    return body;
  }
  return [renderedEvents, body].filter(Boolean).join("\n\n");
}

function createAcpVisibleTextAccumulator() {
  let pendingSilentPrefix = "";
  let visibleText = "";
  const startsWithWordChar = (chunk: string): boolean => /^[\p{L}\p{N}]/u.test(chunk);

  const resolveNextCandidate = (base: string, chunk: string): string => {
    if (!base) {
      return chunk;
    }
    if (
      isSilentReplyText(base, SILENT_REPLY_TOKEN) &&
      !chunk.startsWith(base) &&
      startsWithWordChar(chunk)
    ) {
      return chunk;
    }
    // Some ACP backends emit cumulative snapshots even on text_delta-style hooks.
    // Accept those only when they strictly extend the buffered text.
    if (chunk.startsWith(base) && chunk.length > base.length) {
      return chunk;
    }
    return `${base}${chunk}`;
  };

  const mergeVisibleChunk = (base: string, chunk: string): { text: string; delta: string } => {
    if (!base) {
      return { text: chunk, delta: chunk };
    }
    if (chunk.startsWith(base) && chunk.length > base.length) {
      const delta = chunk.slice(base.length);
      return { text: chunk, delta };
    }
    return {
      text: `${base}${chunk}`,
      delta: chunk,
    };
  };

  return {
    consume(chunk: string): { text: string; delta: string } | null {
      if (!chunk) {
        return null;
      }

      if (!visibleText) {
        const leadCandidate = resolveNextCandidate(pendingSilentPrefix, chunk);
        const trimmedLeadCandidate = leadCandidate.trim();
        if (
          isSilentReplyText(trimmedLeadCandidate, SILENT_REPLY_TOKEN) ||
          isSilentReplyPrefixText(trimmedLeadCandidate, SILENT_REPLY_TOKEN)
        ) {
          pendingSilentPrefix = leadCandidate;
          return null;
        }
        if (pendingSilentPrefix) {
          pendingSilentPrefix = "";
          visibleText = leadCandidate;
          return {
            text: visibleText,
            delta: leadCandidate,
          };
        }
      }

      const nextVisible = mergeVisibleChunk(visibleText, chunk);
      visibleText = nextVisible.text;
      return nextVisible.delta ? nextVisible : null;
    },
    finalize(): string {
      return visibleText.trim();
    },
    finalizeRaw(): string {
      return visibleText;
    },
  };
}

const ACP_TRANSCRIPT_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
} as const;

async function persistAcpTurnTranscript(params: {
  body: string;
  finalText: string;
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  sessionAgentId: string;
  threadId?: string | number;
  sessionCwd: string;
}): Promise<SessionEntry | undefined> {
  const promptText = params.body;
  const replyText = params.finalText;
  if (!promptText && !replyText) {
    return params.sessionEntry;
  }

  const { sessionFile, sessionEntry } = await resolveSessionTranscriptFile({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
    agentId: params.sessionAgentId,
    threadId: params.threadId,
  });
  const hadSessionFile = await fs
    .access(sessionFile)
    .then(() => true)
    .catch(() => false);
  const sessionManager = SessionManager.open(sessionFile);
  await prepareSessionManagerForRun({
    sessionManager,
    sessionFile,
    hadSessionFile,
    sessionId: params.sessionId,
    cwd: params.sessionCwd,
  });

  if (promptText) {
    sessionManager.appendMessage({
      role: "user",
      content: promptText,
      timestamp: Date.now(),
    });
  }

  if (replyText) {
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: replyText }],
      api: "openai-responses",
      provider: "openclaw",
      model: "acp-runtime",
      usage: ACP_TRANSCRIPT_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    });
  }

  emitSessionTranscriptUpdate(sessionFile);
  return sessionEntry;
}

type RunAgentAttemptParams = {
  providerOverride: string;
  modelOverride: string;
  cfg: ReturnType<typeof loadConfig>;
  sessionEntry: SessionEntry | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  sessionAgentId: string;
  sessionFile: string;
  workspaceDir: string;
  body: string;
  isFallbackRetry: boolean;
  resolvedThinkLevel: ThinkLevel;
  timeoutMs: number;
  runId: string;
  opts: AgentCommandOpts & { senderIsOwner: boolean };
  runContext: ReturnType<typeof resolveAgentRunContext>;
  spawnedBy: string | undefined;
  messageChannel: ReturnType<typeof resolveMessageChannel>;
  skillsSnapshot: ReturnType<typeof buildWorkspaceSkillSnapshot> | undefined;
  resolvedVerboseLevel: VerboseLevel | undefined;
  agentDir: string;
  onAgentEvent: (evt: { stream: string; data?: Record<string, unknown> }) => void;
  authProfileProvider: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  allowTransientCooldownProbe?: boolean;
  platformRuntimePlan: ResolvedPlatformRuntimePlan;
  bootstrapContextMode?: "full" | "lightweight";
};

type BuildEmbeddedAgentRunParams = Pick<
  RunAgentAttemptParams,
  | "sessionId"
  | "sessionKey"
  | "sessionAgentId"
  | "messageChannel"
  | "runContext"
  | "spawnedBy"
  | "opts"
  | "sessionFile"
  | "workspaceDir"
  | "cfg"
  | "skillsSnapshot"
  | "providerOverride"
  | "modelOverride"
  | "sessionEntry"
  | "resolvedThinkLevel"
  | "resolvedVerboseLevel"
  | "timeoutMs"
  | "runId"
  | "agentDir"
  | "allowTransientCooldownProbe"
  | "onAgentEvent"
  | "platformRuntimePlan"
  | "bootstrapContextMode"
> & {
  effectivePrompt: string;
  images?: AgentCommandOpts["images"];
  authProfileId?: string;
  bootstrapPromptWarningSignaturesSeen?: string[];
  bootstrapPromptWarningSignature?: string;
};

/**
 * Sanitizes an inbound attachment file name for workspace staging.
 *
 * @param {string} fileName - Original attachment file name from the caller.
 * @param {number} index - Stable attachment index for fallback naming.
 * @returns {string} Safe file name for `media/inbound`.
 */
function sanitizeInboundAttachmentFileName(fileName: string, index: number): string {
  const baseName = path.basename(fileName.trim());
  const cleaned = baseName.replace(/[^\w.-]+/g, "_");
  return cleaned || `attachment-${String(index + 1)}.bin`;
}

/**
 * Appends a compact note so the agent can discover staged inbound files via tools.
 *
 * @param {string} message - Original user-visible prompt text.
 * @param {string[]} relativePaths - Workspace-relative staged file paths.
 * @param {string[]} inlinePreviews - Optional inline text previews for small inbound files.
 * @returns {string} Prompt text with a short attached-files note.
 */
export function appendInboundFilesContext(
  message: string,
  relativePaths: string[],
  inlinePreviews: string[] = [],
): string {
  if (relativePaths.length === 0) {
    return message;
  }
  const attachmentBlock = [
    "Attached files available in workspace:",
    ...relativePaths.map((relativePath) => `- ${relativePath}`),
  ].join("\n");
  const previewBlock =
    inlinePreviews.length > 0
      ? `\n\nInline file previews for immediate reasoning:\n\n${inlinePreviews.join("\n\n")}`
      : "";
  const previewInstruction =
    inlinePreviews.length > 0
      ? "\n\nUse the inline file previews below as the primary source for this turn. Return the final answer directly and do not emit raw tool-call JSON, placeholder tool payloads, or memory search requests."
      : "";
  return `${message}\n\n${attachmentBlock}${previewInstruction}${previewBlock}`;
}

/**
 * Builds a compact CSV preview so smaller tabular attachments can be reasoned
 * about directly even when the selected model does not reliably trigger tools.
 *
 * @param {string} fileName - Sanitized staged file name.
 * @param {string} relativePath - Workspace-relative file path.
 * @param {Buffer} bytes - Raw decoded attachment bytes.
 * @returns {string | undefined} Markdown preview block when the file is eligible.
 */
export function buildInlineCsvPreview(
  fileName: string,
  relativePath: string,
  bytes: Buffer,
): string | undefined {
  if (!fileName.toLowerCase().endsWith(".csv") || bytes.byteLength > 16_000) {
    return undefined;
  }
  const rawText = bytes.toString("utf8").replace(/\r\n/g, "\n").trim();
  if (!rawText) {
    return undefined;
  }
  const lines = rawText.split("\n");
  const previewLines = lines.slice(0, 40);
  const previewText = previewLines.join("\n").slice(0, 3_500);
  const truncated = previewLines.length < lines.length || previewText.length < rawText.length;
  return [
    `File preview: ${fileName} (${relativePath})`,
    "```csv",
    previewText,
    "```",
    truncated ? "Preview truncated; open the staged file if more rows are needed." : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Stages caller-provided document attachments into the agent workspace so the
 * planner/runtime can reason about file names and the model can inspect files.
 *
 * @param {{ workspaceDir: string; documents: NonNullable<AgentCommandOpts["documents"]> }} params - Workspace and raw document attachments.
 * @returns {Promise<{ fileNames: string[]; relativePaths: string[]; inlinePreviews: string[] }>} Staged file names, workspace-relative paths, and inline prompt previews.
 */
async function stageInboundDocuments(params: {
  workspaceDir: string;
  documents: NonNullable<AgentCommandOpts["documents"]>;
}): Promise<{
  fileNames: string[];
  relativePaths: string[];
  inlinePreviews: string[];
}> {
  if (params.documents.length === 0) {
    return { fileNames: [], relativePaths: [], inlinePreviews: [] };
  }
  const inboundDir = path.join(params.workspaceDir, "media", "inbound");
  await fs.mkdir(inboundDir, { recursive: true });
  const fileNames: string[] = [];
  const relativePaths: string[] = [];
  const inlinePreviews: string[] = [];
  for (const [index, document] of params.documents.entries()) {
    const safeFileName = sanitizeInboundAttachmentFileName(document.fileName, index);
    const uniqueFileName = `${path.parse(safeFileName).name}---${Date.now()}-${String(index)}${path.extname(safeFileName)}`;
    const absolutePath = path.join(inboundDir, uniqueFileName);
    const bytes = Buffer.from(document.data, "base64");
    await fs.writeFile(absolutePath, bytes);
    fileNames.push(safeFileName);
    const relativePath = path.posix.join("media", "inbound", uniqueFileName);
    relativePaths.push(relativePath);
    const inlinePreview = buildInlineCsvPreview(safeFileName, relativePath, bytes);
    if (inlinePreview) {
      inlinePreviews.push(inlinePreview);
    }
  }
  return { fileNames, relativePaths, inlinePreviews };
}

export function resolveAgentCommandFallbackOverride(params: {
  platformRuntimePlan: ResolvedPlatformRuntimePlan;
  configuredFallbacks?: string[];
}): string[] | undefined {
  return resolveRuntimePlanFallbackOverride({
    runtimePlan: params.platformRuntimePlan.runtime,
    configuredFallbacks: params.configuredFallbacks,
  });
}

export function buildEmbeddedAgentRunParams(
  params: BuildEmbeddedAgentRunParams,
): Parameters<typeof runEmbeddedPiAgent>[0] {
  const deliveryManagedArtifactHint =
    params.opts.deliver === true
      ? [
          "Final reply delivery is handled by the command pipeline for this run.",
          "Do not call the message tool to send the final answer or attachment yourself.",
          "Do not read or verify a generated artifact by guessing a file path or filename alone.",
          "Generate the artifact with the appropriate tool and then return a normal assistant reply describing the completed result.",
        ].join(" ")
      : undefined;
  const extraSystemPrompt = [params.opts.extraSystemPrompt, deliveryManagedArtifactHint]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.sessionAgentId,
    trigger: "user",
    messageChannel: params.messageChannel,
    agentAccountId: params.runContext.accountId,
    messageTo: params.opts.replyTo ?? params.opts.to,
    messageThreadId: params.opts.threadId,
    groupId: params.runContext.groupId,
    groupChannel: params.runContext.groupChannel,
    groupSpace: params.runContext.groupSpace,
    spawnedBy: params.spawnedBy,
    currentChannelId: params.runContext.currentChannelId,
    currentThreadTs: params.runContext.currentThreadTs,
    replyToMode: params.runContext.replyToMode,
    hasRepliedRef: params.runContext.hasRepliedRef,
    senderIsOwner: params.opts.senderIsOwner,
    disableMessageTool: params.opts.deliver === true,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.cfg,
    skillsSnapshot: params.skillsSnapshot,
    prompt: params.effectivePrompt,
    images: params.images,
    clientTools: params.opts.clientTools,
    provider: params.providerOverride,
    model: params.modelOverride,
    authProfileId: params.authProfileId,
    authProfileIdSource: params.authProfileId
      ? params.sessionEntry?.authProfileOverrideSource
      : undefined,
    thinkLevel: params.resolvedThinkLevel,
    verboseLevel: params.resolvedVerboseLevel,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    lane: params.opts.lane,
    abortSignal: params.opts.abortSignal,
    extraSystemPrompt: extraSystemPrompt || undefined,
    inputProvenance: params.opts.inputProvenance,
    streamParams: params.opts.streamParams,
    agentDir: params.agentDir,
    platformExecutionContext: params.platformRuntimePlan.runtime,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
    bootstrapContextMode: params.bootstrapContextMode,
    onAgentEvent: params.onAgentEvent,
    bootstrapPromptWarningSignaturesSeen: params.bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature: params.bootstrapPromptWarningSignature,
  };
}

export function buildPlatformPlannerInput(params: {
  prompt: string;
  fileNames?: string[];
  opts: Pick<AgentCommandOpts, "messageChannel" | "channel" | "replyChannel">;
  sessionEntry?: Pick<
    SessionEntry,
    | "sessionId"
    | "sessionFile"
    | "specialistOverrideMode"
    | "specialistBaseProfileId"
    | "specialistSessionProfileId"
  > | null;
  storePath?: string;
}): Parameters<typeof resolvePlatformRuntimePlan>[0] {
  if (params.storePath && params.sessionEntry?.sessionId) {
    return buildExecutionDecisionInput(
      buildSessionBackedExecutionDecisionInput({
        draftPrompt: params.prompt,
        ...(params.fileNames?.length ? { fileNames: params.fileNames } : {}),
        storePath: params.storePath,
        channelHints: params.opts,
        sessionEntry: params.sessionEntry,
      }),
    );
  }
  return buildExecutionDecisionInput({
    prompt: params.prompt,
    ...(params.fileNames?.length ? { fileNames: params.fileNames } : {}),
    channelHints: params.opts,
    sessionEntry: params.sessionEntry,
  });
}

export async function buildClassifiedPlatformPlannerInput(params: {
  prompt: string;
  fileNames?: string[];
  opts: Pick<AgentCommandOpts, "messageChannel" | "channel" | "replyChannel">;
  sessionEntry?: Pick<
    SessionEntry,
    | "sessionId"
    | "sessionFile"
    | "specialistOverrideMode"
    | "specialistBaseProfileId"
    | "specialistSessionProfileId"
  > | null;
  storePath?: string;
  cfg: ReturnType<typeof loadConfig>;
  agentDir?: string;
  adapterRegistry?: Readonly<Record<string, TaskClassifierAdapter>>;
}): Promise<Parameters<typeof resolvePlatformRuntimePlan>[0]> {
  return buildClassifiedExecutionDecisionInput({
    prompt: params.prompt,
    ...(params.fileNames?.length ? { fileNames: params.fileNames } : {}),
    channelHints: params.opts,
    sessionEntry: params.sessionEntry,
    storePath: params.storePath,
    cfg: params.cfg,
    agentDir: params.agentDir,
    adapterRegistry: params.adapterRegistry,
  });
}

export function shouldFailoverEmptySemanticRetryResult(
  result: Awaited<ReturnType<typeof runEmbeddedPiAgent>>,
): boolean {
  const payloads = result.payloads ?? [];
  const verdict = result.meta.supervisorVerdict;
  const executionIntent = result.meta.executionIntent;
  const CONTINUATION_REFUSAL_RE =
    /\b(?:can(?:not|'t)\s+continue|unable\s+to\s+continue|can(?:not|'t)\s+proceed|unable\s+to\s+proceed)\b/i;
  const ACK_ONLY_TEXTS = new Set([
    "got it",
    "sure",
    "will do",
    "sounds good",
    "understood",
    "i ll do it",
    "i will do it",
    "i ll handle it",
    "i will handle it",
    "i ll make it",
    "i will make it",
    "понял",
    "хорошо",
    "сделаю",
    "сейчас сделаю",
    "отлично",
    "отлично сделаю",
    "ага",
  ]);
  const TOOL_NAME_FIELD_RE = /"(?:name|function|function_name|tool|tool_name)"\s*:\s*"[^"\r\n]+"/;
  const ARGUMENTS_FIELD_RE = /"arguments"\s*:\s*\{/;
  const extractLeadText = (text: string): string => {
    return (
      text
        .split(/\n\s*\n>\s*📊\s*\[DEBUG ROUTING\]/u, 1)[0]
        ?.split(/\n\s*\n---\s*$/u, 1)[0]
        ?.trim() ?? ""
    );
  };
  const normalizeAckText = (text: string): string =>
    extractLeadText(text)
      .replace(/\p{Extended_Pictographic}/gu, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const hasVisibleProviderErrorShape = (text: string): boolean => {
    const lead = extractLeadText(text);
    if (!lead) {
      return false;
    }
    return (
      /^(?:http\s*\d{3}\b|(?:[a-z][\w-]*\s+)?(?:api\s+)?error\b|request failed\b|llm request failed\b)/iu.test(
        lead,
      ) ||
      /\b(?:cannot be processed|unsupported data|invalid request|request is invalid|bad request)\b/iu.test(
        lead,
      )
    );
  };
  const unwrapStandaloneToolCallEnvelope = (text: string): string | null => {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenced?.[1]?.trim() || trimmed;
  };
  const isStandaloneToolCallEnvelope = (text: string | undefined): boolean => {
    if (typeof text !== "string") {
      return false;
    }
    const candidate = unwrapStandaloneToolCallEnvelope(text);
    if (!candidate) {
      return false;
    }
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const parsedObject = parsed as Record<string, unknown>;
      const hasToolName =
        typeof (parsed as { name?: unknown }).name === "string" ||
        typeof (parsed as { function?: unknown }).function === "string" ||
        typeof (parsed as { function_name?: unknown }).function_name === "string" ||
        typeof (parsed as { tool?: unknown }).tool === "string" ||
        typeof (parsed as { tool_name?: unknown }).tool_name === "string";
      return Boolean(
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        hasToolName &&
        "arguments" in parsedObject &&
        Object.keys(parsedObject).every(
          (key) =>
            key === "name" ||
            key === "function" ||
            key === "function_name" ||
            key === "tool" ||
            key === "tool_name" ||
            key === "arguments" ||
            key === "id",
        ),
      );
    } catch {
      // Some weaker fallback models emit tool-call envelopes that look correct
      // to users but are not strict JSON (for example raw Windows paths with
      // unescaped backslashes). Keep the failover heuristic tolerant so these
      // still trigger a semantic retry instead of leaking pseudo-tool text.
      const trimmedCandidate = candidate.trim();
      return (
        trimmedCandidate.startsWith("{") &&
        trimmedCandidate.endsWith("}") &&
        TOOL_NAME_FIELD_RE.test(trimmedCandidate) &&
        ARGUMENTS_FIELD_RE.test(trimmedCandidate)
      );
    }
  };
  const isSemanticRetryAcknowledgementOnly = (): boolean => {
    if (
      verdict?.action !== "retry" ||
      verdict.remediation !== "semantic_retry" ||
      payloads.length === 0
    ) {
      return false;
    }
    return payloads.every((payload) => {
      const hasMedia =
        typeof payload.mediaUrl === "string" ||
        (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0);
      if (hasMedia || typeof payload.text !== "string") {
        return false;
      }
      const normalized = normalizeAckText(payload.text);
      return normalized.length > 0 && normalized.length <= 80 && ACK_ONLY_TEXTS.has(normalized);
    });
  };
  const isArtifactTurnAcknowledgementOnly = (): boolean => {
    if (payloads.length === 0) {
      return false;
    }
    const artifactKinds = executionIntent?.artifactKinds ?? [];
    const requestedToolNames = executionIntent?.requestedToolNames ?? [];
    const expectsArtifactOutput =
      executionIntent?.outcomeContract === "structured_artifact" ||
      artifactKinds.length > 0 ||
      requestedToolNames.some((tool) => {
        const normalizedTool = tool.trim().toLowerCase();
        return (
          normalizedTool === "pdf" ||
          normalizedTool === "image_generate" ||
          normalizedTool === "video_generate" ||
          normalizedTool === "audio_generate"
        );
      });
    if (!expectsArtifactOutput) {
      return false;
    }
    return payloads.every((payload) => {
      const hasMedia =
        typeof payload.mediaUrl === "string" ||
        (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0);
      if (hasMedia || typeof payload.text !== "string") {
        return false;
      }
      const normalized = normalizeAckText(payload.text);
      if (normalized.length === 0 || normalized.length > 160) {
        return false;
      }
      if (ACK_ONLY_TEXTS.has(normalized)) {
        return true;
      }
      const startsLikePromise =
        normalized.startsWith("сделаю ") ||
        normalized.startsWith("сейчас сделаю ") ||
        normalized.startsWith("i will ") ||
        normalized.startsWith("i ll ") ||
        normalized.startsWith("will do ");
      const soundsCompleted =
        normalized.includes("готово") ||
        normalized.includes("done") ||
        normalized.includes("saved") ||
        normalized.includes("создал") ||
        normalized.includes("сохранил") ||
        normalized.includes("file ") ||
        normalized.includes("файл ");
      return startsLikePromise && !soundsCompleted;
    });
  };
  const isArtifactTurnProviderErrorOnly = (): boolean => {
    const artifactKinds = executionIntent?.artifactKinds ?? [];
    const requestedToolNames = executionIntent?.requestedToolNames ?? [];
    const expectsArtifactOutput =
      executionIntent?.outcomeContract === "structured_artifact" ||
      artifactKinds.length > 0 ||
      requestedToolNames.some((tool) => {
        const normalizedTool = tool.trim().toLowerCase();
        return (
          normalizedTool === "pdf" ||
          normalizedTool === "image_generate" ||
          normalizedTool === "video_generate" ||
          normalizedTool === "audio_generate"
        );
      });
    if (!expectsArtifactOutput || payloads.length === 0) {
      return false;
    }
    const metaError = result.meta.error;
    return payloads.every((payload) => {
      const hasMedia =
        typeof payload.mediaUrl === "string" ||
        (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0);
      if (hasMedia || typeof payload.text !== "string") {
        return false;
      }
      return hasVisibleProviderErrorShape(payload.text) || Boolean(metaError);
    });
  };
  const isArtifactTurnClarificationOnly = (): boolean => {
    const artifactKinds = executionIntent?.artifactKinds ?? [];
    const requestedToolNames = executionIntent?.requestedToolNames ?? [];
    const expectsArtifactOutput =
      executionIntent?.outcomeContract === "structured_artifact" ||
      artifactKinds.length > 0 ||
      requestedToolNames.some((tool) => {
        const normalizedTool = tool.trim().toLowerCase();
        return (
          normalizedTool === "pdf" ||
          normalizedTool === "image_generate" ||
          normalizedTool === "video_generate" ||
          normalizedTool === "audio_generate"
        );
      });
    if (!expectsArtifactOutput || payloads.length === 0) {
      return false;
    }
    const ARTIFACT_CLARIFICATION_HINTS = [
      "уточняющ",
      "вопрос",
      "каком стиле",
      "какой стиль",
      "какой формат",
      "какой шаблон",
      "какой размер",
      "какое соотношение сторон",
      "сколько страниц",
      "прозрачный фон",
      "avoid incorrect expectations",
      "clarifying question",
      "question",
      "what style",
      "which style",
      "what format",
      "which format",
      "what size",
      "which size",
      "aspect ratio",
      "transparent background",
      "how many pages",
    ];
    return payloads.every((payload) => {
      const hasMedia =
        typeof payload.mediaUrl === "string" ||
        (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0);
      if (hasMedia || typeof payload.text !== "string") {
        return false;
      }
      const lead = extractLeadText(payload.text).trim();
      if (!lead || lead.length > 500 || !lead.includes("?")) {
        return false;
      }
      const normalizedLead = lead.toLowerCase();
      const questionCount = (lead.match(/\?/g) ?? []).length;
      const completionHints = [
        "готово",
        "done",
        "created",
        "saved",
        "создал",
        "сгенерировал",
        "прикрепил",
        "attached",
        "вот",
        "here is",
      ];
      if (completionHints.some((hint) => normalizedLead.includes(hint))) {
        return false;
      }
      if (ARTIFACT_CLARIFICATION_HINTS.some((hint) => normalizedLead.includes(hint))) {
        return true;
      }
      return questionCount > 0;
    });
  };
  if (payloads.length > 0) {
    if (
      isSemanticRetryAcknowledgementOnly() ||
      isArtifactTurnAcknowledgementOnly() ||
      isArtifactTurnProviderErrorOnly() ||
      isArtifactTurnClarificationOnly()
    ) {
      return true;
    }
    const firstVisibleTextPayload = payloads.find((payload) => {
      const hasMedia =
        typeof payload.mediaUrl === "string" ||
        (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0);
      return !hasMedia && typeof payload.text === "string" && payload.text.trim().length > 0;
    });
    if (isStandaloneToolCallEnvelope(firstVisibleTextPayload?.text)) {
      return true;
    }
    const onlyContinuationRefusals = payloads.every((payload) => {
      const hasMedia =
        typeof payload.mediaUrl === "string" ||
        (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0);
      return (
        !hasMedia && typeof payload.text === "string" && CONTINUATION_REFUSAL_RE.test(payload.text)
      );
    });
    if (onlyContinuationRefusals) {
      return true;
    }
    const onlyPseudoToolPayloads = payloads.every((payload) => {
      const hasMedia =
        typeof payload.mediaUrl === "string" ||
        (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0);
      return !hasMedia && isStandaloneToolCallEnvelope(payload.text);
    });
    if (onlyPseudoToolPayloads) {
      return true;
    }
    return false;
  }
  return verdict?.action === "retry" && verdict.remediation === "semantic_retry";
}

export function shouldGrantPlatformExplicitApprovalForAgentTurn(params: {
  senderIsOwner: boolean;
}): boolean {
  return params.senderIsOwner === true;
}

function runAgentAttempt(params: RunAgentAttemptParams) {
  const effectivePrompt = resolveFallbackRetryPrompt({
    body: params.body,
    isFallbackRetry: params.isFallbackRetry,
  });
  const bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    params.sessionEntry?.systemPromptReport,
  );
  const bootstrapPromptWarningSignature =
    bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1];
  if (isCliProvider(params.providerOverride, params.cfg)) {
    const cliSessionId = getCliSessionId(params.sessionEntry, params.providerOverride);
    const runCliWithSession = (nextCliSessionId: string | undefined) =>
      runCliAgent({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.sessionAgentId,
        sessionFile: params.sessionFile,
        workspaceDir: params.workspaceDir,
        config: params.cfg,
        prompt: effectivePrompt,
        provider: params.providerOverride,
        model: params.modelOverride,
        thinkLevel: params.resolvedThinkLevel,
        timeoutMs: params.timeoutMs,
        runId: params.runId,
        extraSystemPrompt: params.opts.extraSystemPrompt,
        platformExecutionContext: params.platformRuntimePlan.runtime,
        cliSessionId: nextCliSessionId,
        bootstrapPromptWarningSignaturesSeen,
        bootstrapPromptWarningSignature,
        images: params.isFallbackRetry ? undefined : params.opts.images,
        streamParams: params.opts.streamParams,
      });
    return runCliWithSession(cliSessionId).catch(async (err) => {
      // Handle CLI session expired error
      if (
        err instanceof FailoverError &&
        err.reason === "session_expired" &&
        cliSessionId &&
        params.sessionKey &&
        params.sessionStore &&
        params.storePath
      ) {
        log.warn(
          `CLI session expired, clearing from session store: provider=${sanitizeForLog(params.providerOverride)} sessionKey=${params.sessionKey}`,
        );

        // Clear the expired session ID from the session store
        const entry = params.sessionStore[params.sessionKey];
        if (entry) {
          const updatedEntry = { ...entry };
          if (params.providerOverride === "claude-cli") {
            delete updatedEntry.claudeCliSessionId;
          }
          if (updatedEntry.cliSessionIds) {
            const normalizedProvider = normalizeProviderId(params.providerOverride);
            const newCliSessionIds = { ...updatedEntry.cliSessionIds };
            delete newCliSessionIds[normalizedProvider];
            updatedEntry.cliSessionIds = newCliSessionIds;
          }
          updatedEntry.updatedAt = Date.now();

          await persistSessionEntry({
            sessionStore: params.sessionStore,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
            entry: updatedEntry,
          });

          // Update the session entry reference
          params.sessionEntry = updatedEntry;
        }

        // Retry with no session ID (will create a new session)
        return runCliWithSession(undefined).then(async (result) => {
          // Update session store with new CLI session ID if available
          if (
            result.meta.agentMeta?.sessionId &&
            params.sessionKey &&
            params.sessionStore &&
            params.storePath
          ) {
            const entry = params.sessionStore[params.sessionKey];
            if (entry) {
              const updatedEntry = { ...entry };
              setCliSessionId(
                updatedEntry,
                params.providerOverride,
                result.meta.agentMeta.sessionId,
              );
              updatedEntry.updatedAt = Date.now();

              await persistSessionEntry({
                sessionStore: params.sessionStore,
                sessionKey: params.sessionKey,
                storePath: params.storePath,
                entry: updatedEntry,
              });
            }
          }
          return result;
        });
      }
      throw err;
    });
  }

  const authProfileId =
    params.providerOverride === params.authProfileProvider
      ? params.sessionEntry?.authProfileOverride
      : undefined;
  return runEmbeddedPiAgent(
    buildEmbeddedAgentRunParams({
      ...params,
      effectivePrompt,
      images: params.isFallbackRetry ? undefined : params.opts.images,
      authProfileId,
      bootstrapPromptWarningSignaturesSeen,
      bootstrapPromptWarningSignature,
    }),
  );
}

async function prepareAgentCommandExecution(
  opts: AgentCommandOpts & { senderIsOwner: boolean },
  runtime: RuntimeEnv,
) {
  const message = opts.message ?? "";
  if (!message.trim()) {
    throw new Error("Message (--message) is required");
  }
  let body = prependInternalEventContext(message, opts.internalEvents);
  if (!opts.to && !opts.sessionId && !opts.sessionKey && !opts.agentId) {
    throw new Error("Pass --to <E.164>, --session-id, or --agent to choose a session");
  }

  const loadedRaw = loadConfig();
  const sourceConfig = await (async () => {
    try {
      const { snapshot } = await readConfigFileSnapshotForWrite();
      if (snapshot.valid) {
        return snapshot.resolved;
      }
    } catch {
      // Fall back to runtime-loaded config when source snapshot is unavailable.
    }
    return loadedRaw;
  })();
  const { resolvedConfig: cfg, diagnostics } = await resolveCommandSecretRefsViaGateway({
    config: loadedRaw,
    commandName: "agent",
    targetIds: getAgentRuntimeCommandSecretTargetIds(),
  });
  setRuntimeConfigSnapshot(cfg, sourceConfig);
  const normalizedSpawned = normalizeSpawnedRunMetadata({
    spawnedBy: opts.spawnedBy,
    groupId: opts.groupId,
    groupChannel: opts.groupChannel,
    groupSpace: opts.groupSpace,
    workspaceDir: opts.workspaceDir,
  });
  for (const entry of diagnostics) {
    runtime.log(`[secrets] ${entry}`);
  }
  const agentIdOverrideRaw = opts.agentId?.trim();
  const agentIdOverride = agentIdOverrideRaw ? normalizeAgentId(agentIdOverrideRaw) : undefined;
  if (agentIdOverride) {
    const knownAgents = listAgentIds(cfg);
    if (!knownAgents.includes(agentIdOverride)) {
      throw new Error(
        `Unknown agent id "${agentIdOverrideRaw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
      );
    }
  }
  if (agentIdOverride && opts.sessionKey) {
    const sessionAgentId = resolveAgentIdFromSessionKey(opts.sessionKey);
    if (sessionAgentId !== agentIdOverride) {
      throw new Error(
        `Agent id "${agentIdOverrideRaw}" does not match session key agent "${sessionAgentId}".`,
      );
    }
  }
  const agentCfg = cfg.agents?.defaults;
  const configuredModel = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const thinkingLevelsHint = formatThinkingLevels(configuredModel.provider, configuredModel.model);

  const thinkOverride = normalizeThinkLevel(opts.thinking);
  const thinkOnce = normalizeThinkLevel(opts.thinkingOnce);
  if (opts.thinking && !thinkOverride) {
    throw new Error(`Invalid thinking level. Use one of: ${thinkingLevelsHint}.`);
  }
  if (opts.thinkingOnce && !thinkOnce) {
    throw new Error(`Invalid one-shot thinking level. Use one of: ${thinkingLevelsHint}.`);
  }

  const verboseOverride = normalizeVerboseLevel(opts.verbose);
  if (opts.verbose && !verboseOverride) {
    throw new Error('Invalid verbose level. Use "on", "full", or "off".');
  }

  const sessionResolution = resolveSession({
    cfg,
    to: opts.to,
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    agentId: agentIdOverride,
  });

  const {
    sessionId,
    sessionKey,
    sessionEntry: sessionEntryRaw,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
  } = sessionResolution;
  const platformPlannerInput = await buildClassifiedPlatformPlannerInput({
    prompt: body,
    fileNames: opts.documents?.map((document) => document.fileName),
    opts,
    sessionEntry: sessionEntryRaw,
    storePath,
    cfg,
  });
  const platformRuntimePlan = resolvePlatformRuntimePlan(
    { ...platformPlannerInput, callerTag: "agent-command-main" },
    {
      explicitApproval: shouldGrantPlatformExplicitApprovalForAgentTurn({
        senderIsOwner: opts.senderIsOwner,
      }),
    },
  );
  const laneRaw = typeof opts.lane === "string" ? opts.lane.trim() : "";
  const isSubagentLane = laneRaw === String(AGENT_LANE_SUBAGENT);
  const timeoutSecondsRaw =
    opts.timeout !== undefined
      ? Number.parseInt(String(opts.timeout), 10)
      : isSubagentLane
        ? 0
        : platformRuntimePlan.runtime.timeoutSeconds;
  if (
    timeoutSecondsRaw !== undefined &&
    (Number.isNaN(timeoutSecondsRaw) || timeoutSecondsRaw < 0)
  ) {
    throw new Error("--timeout must be a non-negative integer (seconds; 0 means no timeout)");
  }
  const timeoutMs = resolveAgentTimeoutMs({
    cfg,
    overrideSeconds: timeoutSecondsRaw,
  });
  const sessionAgentId =
    agentIdOverride ??
    resolveSessionAgentId({
      sessionKey: sessionKey ?? opts.sessionKey?.trim(),
      config: cfg,
    });
  const outboundSession = buildOutboundSessionContext({
    cfg,
    agentId: sessionAgentId,
    sessionKey,
  });
  // Internal callers (for example subagent spawns) may pin workspace inheritance.
  const workspaceDirRaw =
    normalizedSpawned.workspaceDir ?? resolveAgentWorkspaceDir(cfg, sessionAgentId);
  const agentDir = resolveAgentDir(cfg, sessionAgentId);
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap,
  });
  const workspaceDir = workspace.dir;
  const stagedDocuments = await stageInboundDocuments({
    workspaceDir,
    documents: opts.documents ?? [],
  });
  body = appendInboundFilesContext(
    body,
    stagedDocuments.relativePaths,
    stagedDocuments.inlinePreviews,
  );
  const runId = opts.runId?.trim() || sessionId;
  const acpManager = getAcpSessionManager();
  const acpResolution = sessionKey
    ? acpManager.resolveSession({
        cfg,
        sessionKey,
      })
    : null;

  return {
    body,
    platformPlannerInput,
    platformRuntimePlan,
    cfg,
    normalizedSpawned,
    agentCfg,
    thinkOverride,
    thinkOnce,
    verboseOverride,
    timeoutMs,
    sessionId,
    sessionKey,
    sessionEntry: sessionEntryRaw,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
    sessionAgentId,
    outboundSession,
    workspaceDir,
    agentDir,
    runId,
    acpManager,
    acpResolution,
  };
}

async function agentCommandInternal(
  opts: AgentCommandOpts & { senderIsOwner: boolean },
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  const prepared = await prepareAgentCommandExecution(opts, runtime);
  const {
    body,
    platformPlannerInput,
    platformRuntimePlan,
    cfg,
    normalizedSpawned,
    agentCfg,
    thinkOverride,
    thinkOnce,
    verboseOverride,
    timeoutMs,
    sessionId,
    sessionKey,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
    sessionAgentId,
    outboundSession,
    workspaceDir,
    agentDir,
    runId,
    acpManager,
    acpResolution,
  } = prepared;
  let sessionEntry = prepared.sessionEntry;

  try {
    if (opts.deliver === true) {
      const sendPolicy = resolveSendPolicy({
        cfg,
        entry: sessionEntry,
        sessionKey,
        channel: sessionEntry?.channel,
        chatType: sessionEntry?.chatType,
      });
      if (sendPolicy === "deny") {
        throw new Error("send blocked by session policy");
      }
    }

    if (acpResolution?.kind === "stale") {
      throw acpResolution.error;
    }

    if (acpResolution?.kind === "ready" && sessionKey) {
      const startedAt = Date.now();
      registerAgentRunContext(runId, {
        ...(sessionKey ? { sessionKey } : {}),
        platformExecution: toPluginHookPlatformExecutionContext(platformRuntimePlan.runtime),
      });
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: {
          phase: "start",
          startedAt,
        },
      });

      const visibleTextAccumulator = createAcpVisibleTextAccumulator();
      let stopReason: string | undefined;
      try {
        const dispatchPolicyError = resolveAcpDispatchPolicyError(cfg);
        if (dispatchPolicyError) {
          throw dispatchPolicyError;
        }
        const acpAgent = normalizeAgentId(
          acpResolution.meta.agent || resolveAgentIdFromSessionKey(sessionKey),
        );
        const agentPolicyError = resolveAcpAgentPolicyError(cfg, acpAgent);
        if (agentPolicyError) {
          throw agentPolicyError;
        }

        await acpManager.runTurn({
          cfg,
          sessionKey,
          text: body,
          mode: "prompt",
          requestId: runId,
          signal: opts.abortSignal,
          onEvent: (event) => {
            if (event.type === "done") {
              stopReason = event.stopReason;
              return;
            }
            if (event.type !== "text_delta") {
              return;
            }
            if (event.stream && event.stream !== "output") {
              return;
            }
            if (!event.text) {
              return;
            }
            const visibleUpdate = visibleTextAccumulator.consume(event.text);
            if (!visibleUpdate) {
              return;
            }
            emitAgentEvent({
              runId,
              stream: "assistant",
              data: {
                text: visibleUpdate.text,
                delta: visibleUpdate.delta,
              },
            });
          },
        });
      } catch (error) {
        const acpError = toAcpRuntimeError({
          error,
          fallbackCode: "ACP_TURN_FAILED",
          fallbackMessage: "ACP turn failed before completion.",
        });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: {
            phase: "error",
            error: acpError.message,
            endedAt: Date.now(),
          },
        });
        throw acpError;
      }

      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: Date.now(),
        },
      });

      const finalTextRaw = visibleTextAccumulator.finalizeRaw();
      const finalText = visibleTextAccumulator.finalize();
      try {
        sessionEntry = await persistAcpTurnTranscript({
          body,
          finalText: finalTextRaw,
          sessionId,
          sessionKey,
          sessionEntry,
          sessionStore,
          storePath,
          sessionAgentId,
          threadId: opts.threadId,
          sessionCwd: resolveAcpSessionCwd(acpResolution.meta) ?? workspaceDir,
        });
      } catch (error) {
        log.warn(
          `ACP transcript persistence failed for ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const normalizedFinalPayload = normalizeReplyPayload({
        text: finalText,
      });
      const payloads = normalizedFinalPayload ? [normalizedFinalPayload] : [];
      const result = {
        payloads,
        meta: {
          durationMs: Date.now() - startedAt,
          aborted: opts.abortSignal?.aborted === true,
          stopReason,
        },
      };

      return await deliverAgentCommandResult({
        cfg,
        deps,
        runtime,
        opts,
        outboundSession,
        sessionEntry,
        result,
        payloads,
      });
    }

    let resolvedThinkLevel = thinkOnce ?? thinkOverride ?? persistedThinking;
    const resolvedVerboseLevel =
      verboseOverride ?? persistedVerbose ?? (agentCfg?.verboseDefault as VerboseLevel | undefined);

    registerAgentRunContext(runId, {
      ...(sessionKey ? { sessionKey } : {}),
      ...(resolvedVerboseLevel ? { verboseLevel: resolvedVerboseLevel } : {}),
      platformExecution: toPluginHookPlatformExecutionContext(platformRuntimePlan.runtime),
      awaitingRunClosure: true,
    });

    const needsSkillsSnapshot = isNewSession || !sessionEntry?.skillsSnapshot;
    const skillsSnapshotVersion = getSkillsSnapshotVersion(workspaceDir);
    const skillFilter = resolveAgentSkillsFilter(cfg, sessionAgentId);
    const skillsSnapshot = needsSkillsSnapshot
      ? buildWorkspaceSkillSnapshot(workspaceDir, {
          config: cfg,
          eligibility: { remote: getRemoteSkillEligibility() },
          snapshotVersion: skillsSnapshotVersion,
          skillFilter,
        })
      : sessionEntry?.skillsSnapshot;

    if (skillsSnapshot && sessionStore && sessionKey && needsSkillsSnapshot) {
      const current = sessionEntry ?? {
        sessionId,
        updatedAt: Date.now(),
      };
      const next: SessionEntry = {
        ...current,
        sessionId,
        updatedAt: Date.now(),
        skillsSnapshot,
      };
      await persistSessionEntry({
        sessionStore,
        sessionKey,
        storePath,
        entry: next,
      });
      sessionEntry = next;
    }

    // Persist explicit /command overrides to the session store when we have a key.
    if (sessionStore && sessionKey) {
      const entry = sessionStore[sessionKey] ??
        sessionEntry ?? { sessionId, updatedAt: Date.now() };
      const next: SessionEntry = { ...entry, sessionId, updatedAt: Date.now() };
      if (thinkOverride) {
        next.thinkingLevel = thinkOverride;
      }
      applyVerboseOverride(next, verboseOverride);
      await persistSessionEntry({
        sessionStore,
        sessionKey,
        storePath,
        entry: next,
      });
      sessionEntry = next;
    }

    const configuredDefaultRef = resolveDefaultModelForAgent({
      cfg,
      agentId: sessionAgentId,
    });
    const { provider: defaultProvider, model: defaultModel } = normalizeModelRef(
      configuredDefaultRef.provider,
      configuredDefaultRef.model,
    );
    let provider = platformRuntimePlan.runtime.providerOverride ?? defaultProvider;
    let model = platformRuntimePlan.runtime.modelOverride ?? defaultModel;
    const hasAllowlist = agentCfg?.models && Object.keys(agentCfg.models).length > 0;
    const hasStoredOverride = Boolean(
      sessionEntry?.modelOverride || sessionEntry?.providerOverride,
    );
    const explicitProviderOverride =
      typeof opts.provider === "string"
        ? normalizeExplicitOverrideInput(opts.provider, "provider")
        : undefined;
    const explicitModelOverride =
      typeof opts.model === "string"
        ? normalizeExplicitOverrideInput(opts.model, "model")
        : undefined;
    const hasExplicitRunOverride = Boolean(explicitProviderOverride || explicitModelOverride);
    if (hasExplicitRunOverride && opts.allowModelOverride !== true) {
      throw new Error("Model override is not authorized for this caller.");
    }
    const needsModelCatalog = hasAllowlist || hasStoredOverride || hasExplicitRunOverride;
    let allowedModelKeys = new Set<string>();
    let allowedModelCatalog: Awaited<ReturnType<typeof loadModelCatalog>> = [];
    let modelCatalog: Awaited<ReturnType<typeof loadModelCatalog>> | null = null;
    let allowAnyModel = false;

    if (needsModelCatalog) {
      modelCatalog = await loadModelCatalog({ config: cfg });
      const allowed = buildAllowedModelSet({
        cfg,
        catalog: modelCatalog,
        defaultProvider,
        defaultModel,
        agentId: sessionAgentId,
      });
      allowedModelKeys = allowed.allowedKeys;
      allowedModelCatalog = allowed.allowedCatalog;
      allowAnyModel = allowed.allowAny ?? false;
    }

    if (sessionEntry && sessionStore && sessionKey && hasStoredOverride) {
      const entry = sessionEntry;
      const overrideProvider = sessionEntry.providerOverride?.trim() || defaultProvider;
      const overrideModel = sessionEntry.modelOverride?.trim();
      if (overrideModel) {
        const normalizedOverride = normalizeModelRef(overrideProvider, overrideModel);
        const key = modelKey(normalizedOverride.provider, normalizedOverride.model);
        if (
          !isCliProvider(normalizedOverride.provider, cfg) &&
          !allowAnyModel &&
          !allowedModelKeys.has(key)
        ) {
          const { updated } = applyModelOverrideToSessionEntry({
            entry,
            selection: { provider: defaultProvider, model: defaultModel, isDefault: true },
          });
          if (updated) {
            await persistSessionEntry({
              sessionStore,
              sessionKey,
              storePath,
              entry,
            });
          }
        }
      }
    }

    const storedProviderOverride = sessionEntry?.providerOverride?.trim();
    const storedModelOverride = sessionEntry?.modelOverride?.trim();
    if (storedModelOverride) {
      const candidateProvider = storedProviderOverride || defaultProvider;
      const normalizedStored = normalizeModelRef(candidateProvider, storedModelOverride);
      const key = modelKey(normalizedStored.provider, normalizedStored.model);
      if (
        isCliProvider(normalizedStored.provider, cfg) ||
        allowAnyModel ||
        allowedModelKeys.has(key)
      ) {
        provider = normalizedStored.provider;
        model = normalizedStored.model;
      }
    }
    const providerForAuthProfileValidation = provider;
    if (hasExplicitRunOverride) {
      const explicitRef = explicitModelOverride
        ? explicitProviderOverride
          ? normalizeModelRef(explicitProviderOverride, explicitModelOverride)
          : parseModelRef(explicitModelOverride, provider)
        : explicitProviderOverride
          ? normalizeModelRef(explicitProviderOverride, model)
          : null;
      if (!explicitRef) {
        throw new Error("Invalid model override.");
      }
      const explicitKey = modelKey(explicitRef.provider, explicitRef.model);
      if (
        !isCliProvider(explicitRef.provider, cfg) &&
        !allowAnyModel &&
        !allowedModelKeys.has(explicitKey)
      ) {
        throw new Error(
          `Model override "${sanitizeForLog(explicitRef.provider)}/${sanitizeForLog(explicitRef.model)}" is not allowed for agent "${sessionAgentId}".`,
        );
      }
      provider = explicitRef.provider;
      model = explicitRef.model;
    }
    if (sessionEntry) {
      const authProfileId = sessionEntry.authProfileOverride;
      if (authProfileId) {
        const entry = sessionEntry;
        const store = ensureAuthProfileStore();
        const profile = store.profiles[authProfileId];
        if (!profile || profile.provider !== providerForAuthProfileValidation) {
          if (sessionStore && sessionKey) {
            await clearSessionAuthProfileOverride({
              sessionEntry: entry,
              sessionStore,
              sessionKey,
              storePath,
            });
          }
        }
      }
    }

    if (!resolvedThinkLevel) {
      let catalogForThinking = modelCatalog ?? allowedModelCatalog;
      if (!catalogForThinking || catalogForThinking.length === 0) {
        modelCatalog = await loadModelCatalog({ config: cfg });
        catalogForThinking = modelCatalog;
      }
      resolvedThinkLevel = resolveThinkingDefault({
        cfg,
        provider,
        model,
        catalog: catalogForThinking,
      });
    }
    if (resolvedThinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
      const explicitThink = Boolean(thinkOnce || thinkOverride);
      if (explicitThink) {
        throw new Error(`Thinking level "xhigh" is only supported for ${formatXHighModelHint()}.`);
      }
      resolvedThinkLevel = "high";
      if (sessionEntry && sessionStore && sessionKey && sessionEntry.thinkingLevel === "xhigh") {
        const entry = sessionEntry;
        entry.thinkingLevel = "high";
        entry.updatedAt = Date.now();
        await persistSessionEntry({
          sessionStore,
          sessionKey,
          storePath,
          entry,
        });
      }
    }
    let sessionFile: string | undefined;
    if (sessionStore && sessionKey) {
      const resolvedSessionFile = await resolveSessionTranscriptFile({
        sessionId,
        sessionKey,
        sessionStore,
        storePath,
        sessionEntry,
        agentId: sessionAgentId,
        threadId: opts.threadId,
      });
      sessionFile = resolvedSessionFile.sessionFile;
      sessionEntry = resolvedSessionFile.sessionEntry;
    }
    if (!sessionFile) {
      const resolvedSessionFile = await resolveSessionTranscriptFile({
        sessionId,
        sessionKey: sessionKey ?? sessionId,
        storePath,
        sessionEntry,
        agentId: sessionAgentId,
        threadId: opts.threadId,
      });
      sessionFile = resolvedSessionFile.sessionFile;
      sessionEntry = resolvedSessionFile.sessionEntry;
    }

    const startedAt = Date.now();
    let lifecycleEnded = false;

    let result: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
    let fallbackProvider = provider;
    let fallbackModel = model;
    try {
      const runContext = resolveAgentRunContext(opts);
      const messageChannel = resolveMessageChannel(
        runContext.messageChannel,
        opts.replyChannel ?? opts.channel,
      );
      const spawnedBy = normalizedSpawned.spawnedBy ?? sessionEntry?.spawnedBy;
      // Keep fallback candidate resolution centralized so session model overrides,
      // per-agent overrides, and default fallbacks stay consistent across callers.
      const effectiveFallbacksOverride = resolveEffectiveModelFallbacks({
        cfg,
        agentId: sessionAgentId,
        hasSessionModelOverride: Boolean(storedModelOverride),
      });
      const fallbackOverride = resolveAgentCommandFallbackOverride({
        platformRuntimePlan,
        configuredFallbacks: effectiveFallbacksOverride,
      });
      const bootstrapContextMode = shouldUseLightweightBootstrapContext(platformPlannerInput)
        ? "lightweight"
        : undefined;

      // Track model fallback attempts so retries on an existing session don't
      // re-inject the original prompt as a duplicate user message.
      let fallbackAttemptIndex = 0;
      const fallbackResult = await runWithModelFallback({
        cfg,
        provider,
        model,
        runId,
        agentDir,
        fallbacksOverride: fallbackOverride,
        preflightPrompt: body,
        preflightPlannerInput: platformPlannerInput,
        ...(Boolean(sessionEntry?.providerOverride?.trim()) ||
        Boolean(sessionEntry?.modelOverride?.trim()) ||
        process.env.OPENCLAW_SKIP_MODEL_ROUTE_PREFLIGHT === "1"
          ? { skipRoutePreflight: true as const }
          : {}),
        run: (providerOverride, modelOverride, runOptions) => {
          const isFallbackRetry = fallbackAttemptIndex > 0;
          fallbackAttemptIndex += 1;
          return runAgentAttempt({
            providerOverride,
            modelOverride,
            cfg,
            sessionEntry,
            sessionId,
            sessionKey,
            sessionAgentId,
            sessionFile,
            workspaceDir,
            body,
            isFallbackRetry,
            resolvedThinkLevel,
            timeoutMs: runOptions?.timeoutMsOverride ?? timeoutMs,
            runId,
            opts,
            runContext,
            spawnedBy,
            messageChannel,
            skillsSnapshot,
            resolvedVerboseLevel,
            agentDir,
            authProfileProvider: providerForAuthProfileValidation,
            sessionStore,
            storePath,
            allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
            platformRuntimePlan,
            bootstrapContextMode,
            onAgentEvent: (evt) => {
              // Track lifecycle end for fallback emission below.
              if (
                evt.stream === "lifecycle" &&
                typeof evt.data?.phase === "string" &&
                (evt.data.phase === "end" || evt.data.phase === "error")
              ) {
                lifecycleEnded = true;
              }
            },
          }).then((attemptResult) => {
            if (shouldFailoverEmptySemanticRetryResult(attemptResult)) {
              throw new FailoverError(
                "Model returned no user-visible output and requested a semantic retry.",
                {
                  reason: "format",
                  provider: providerOverride,
                  model: modelOverride,
                },
              );
            }
            return attemptResult;
          });
        },
      });
      result = fallbackResult.result;
      fallbackProvider = fallbackResult.provider;
      fallbackModel = fallbackResult.model;
      if (!lifecycleEnded) {
        const stopReason = result.meta.stopReason;
        if (stopReason && stopReason !== "end_turn") {
          console.error(`[agent] run ${runId} ended with stopReason=${stopReason}`);
        }
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: {
            phase: "end",
            startedAt,
            endedAt: Date.now(),
            aborted: result.meta.aborted ?? false,
            stopReason,
          },
        });
      }
    } catch (err) {
      if (!lifecycleEnded) {
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: {
            phase: "error",
            startedAt,
            endedAt: Date.now(),
            error: String(err),
          },
        });
      }
      throw err;
    }

    // Update token+model fields in the session store.
    if (sessionStore && sessionKey) {
      await updateSessionStoreAfterAgentRun({
        cfg,
        contextTokensOverride: agentCfg?.contextTokens,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: provider,
        defaultModel: model,
        fallbackProvider,
        fallbackModel,
        result,
      });
    }

    const payloads = result.payloads ?? [];
    return await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts,
      outboundSession,
      sessionEntry,
      result,
      payloads,
    });
  } finally {
    clearAgentRunContext(runId);
  }
}

export async function agentCommand(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  return await agentCommandInternal(
    {
      ...opts,
      // agentCommand is the trusted-operator entrypoint used by CLI/local flows.
      // Ingress callers must opt into owner semantics explicitly via
      // agentCommandFromIngress so network-facing paths cannot inherit this default by accident.
      senderIsOwner: opts.senderIsOwner ?? true,
      // Local/CLI callers are trusted by default for per-run model overrides.
      allowModelOverride: opts.allowModelOverride ?? true,
    },
    runtime,
    deps,
  );
}

export async function agentCommandFromIngress(
  opts: AgentCommandIngressOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  if (typeof opts.senderIsOwner !== "boolean") {
    // HTTP/WS ingress must declare the trust level explicitly at the boundary.
    // This keeps network-facing callers from silently picking up the local trusted default.
    throw new Error("senderIsOwner must be explicitly set for ingress agent runs.");
  }
  if (typeof opts.allowModelOverride !== "boolean") {
    throw new Error("allowModelOverride must be explicitly set for ingress agent runs.");
  }
  return await agentCommandInternal(
    {
      ...opts,
      senderIsOwner: opts.senderIsOwner,
      allowModelOverride: opts.allowModelOverride,
    },
    runtime,
    deps,
  );
}
