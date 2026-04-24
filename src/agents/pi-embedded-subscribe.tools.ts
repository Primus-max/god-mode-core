import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { normalizeTargetForProvider } from "../infra/outbound/target-normalization.js";
import { splitMediaFromOutput } from "../media/parse.js";
import {
  DeliverableKindSchema,
  findProducer,
  type ProducedArtifact,
} from "../platform/produce/registry.js";
import type { PlatformRuntimeExecutionReceipt } from "../platform/runtime/index.js";
import { truncateUtf16Safe } from "../utils.js";
import { collectTextContentBlocks } from "./content-blocks.js";
import { type MessagingToolSend } from "./pi-embedded-messaging.js";
import { normalizeToolName } from "./tool-policy.js";

const TOOL_RESULT_MAX_CHARS = 8000;
const TOOL_ERROR_MAX_CHARS = 400;

function truncateToolText(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) {
    return text;
  }
  return `${truncateUtf16Safe(text, TOOL_RESULT_MAX_CHARS)}\n…(truncated)…`;
}

function normalizeToolErrorText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) {
    return undefined;
  }
  return firstLine.length > TOOL_ERROR_MAX_CHARS
    ? `${truncateUtf16Safe(firstLine, TOOL_ERROR_MAX_CHARS)}…`
    : firstLine;
}

function isErrorLikeStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (
    normalized === "0" ||
    normalized === "ok" ||
    normalized === "success" ||
    normalized === "completed" ||
    normalized === "running"
  ) {
    return false;
  }
  return /error|fail|timeout|timed[_\s-]?out|denied|cancel|invalid|forbidden/.test(normalized);
}

function readErrorCandidate(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeToolErrorText(value);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string") {
    return normalizeToolErrorText(record.message);
  }
  if (typeof record.error === "string") {
    return normalizeToolErrorText(record.error);
  }
  return undefined;
}

function extractErrorField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct =
    readErrorCandidate(record.error) ??
    readErrorCandidate(record.message) ??
    readErrorCandidate(record.reason);
  if (direct) {
    return direct;
  }
  const status = typeof record.status === "string" ? record.status.trim() : "";
  if (!status || !isErrorLikeStatus(status)) {
    return undefined;
  }
  return normalizeToolErrorText(status);
}

export function sanitizeToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : null;
  if (!content) {
    return record;
  }
  const sanitized = content.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const entry = item as Record<string, unknown>;
    const type = typeof entry.type === "string" ? entry.type : undefined;
    if (type === "text" && typeof entry.text === "string") {
      return { ...entry, text: truncateToolText(entry.text) };
    }
    if (type === "image") {
      const data = typeof entry.data === "string" ? entry.data : undefined;
      const bytes = data ? data.length : undefined;
      const cleaned = { ...entry };
      delete cleaned.data;
      return { ...cleaned, bytes, omitted: true };
    }
    return entry;
  });
  return { ...record, content: sanitized };
}

export function extractToolResultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const texts = collectTextContentBlocks(record.content)
    .map((item) => {
      const trimmed = item.trim();
      return trimmed ? trimmed : undefined;
    })
    .filter((value): value is string => Boolean(value));
  if (texts.length === 0) {
    return undefined;
  }
  return texts.join("\n");
}

// Legacy fallback allowlist of core tools that emit local MEDIA paths
// without a structured `details.artifact` contract. The preferred path is
// capability-based trust via the producer registry — see
// `isToolResultMediaTrusted` below. Do NOT add new entries here; instead
// have the tool emit `details.artifact: { kind, format, mimeType, path }`
// matching a producer registry entry.
const TRUSTED_TOOL_RESULT_MEDIA = new Set([
  "agents_list",
  "apply_patch",
  "browser",
  "canvas",
  "cron",
  "edit",
  "exec",
  "gateway",
  "image",
  "image_generate",
  "memory_get",
  "memory_search",
  "message",
  "nodes",
  "pdf",
  "process",
  "read",
  "session_status",
  "sessions_history",
  "sessions_list",
  "sessions_send",
  "sessions_spawn",
  "subagents",
  "tts",
  "web_fetch",
  "web_search",
  "write",
]);
const HTTP_URL_RE = /^https?:\/\//i;

function readToolResultDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  return record.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? (record.details as Record<string, unknown>)
    : undefined;
}

function isExternalToolResult(result: unknown): boolean {
  const details = readToolResultDetails(result);
  if (!details) {
    return false;
  }
  return typeof details.mcpServer === "string" || typeof details.mcpTool === "string";
}

/**
 * Trust check for local media paths emitted by tool results.
 *
 * Two-layer policy:
 *  1. Capability-based trust (preferred): a tool result is trusted when it
 *     declares `details.artifact: { kind, format, mimeType, ... }` that maps
 *     to a registered producer in `src/platform/produce/registry.ts`. This
 *     keeps the path open for any artifact-producing tool (pdf, docx, xlsx,
 *     csv, site, ...) without hardcoding tool names elsewhere.
 *  2. Legacy fallback: a small static allowlist of core tools that haven't
 *     migrated to the structured artifact contract yet (kept until every
 *     such tool emits `details.artifact`).
 *
 * MCP / external-provenance results are always rejected — the trust is
 * about *who produced the file*, not about how it was transported.
 */
export function isToolResultMediaTrusted(toolName?: string, result?: unknown): boolean {
  if (isExternalToolResult(result)) {
    return false;
  }
  const artifact = extractProducedArtifactFromToolResult(result);
  if (artifact && findProducer(artifact.kind, artifact.format)) {
    return true;
  }
  if (!toolName) {
    return false;
  }
  const normalized = normalizeToolName(toolName);
  return TRUSTED_TOOL_RESULT_MEDIA.has(normalized);
}

export function filterToolResultMediaUrls(
  toolName: string | undefined,
  mediaUrls: string[],
  result?: unknown,
): string[] {
  if (mediaUrls.length === 0) {
    return mediaUrls;
  }
  if (isToolResultMediaTrusted(toolName, result)) {
    return mediaUrls;
  }
  return mediaUrls.filter((url) => HTTP_URL_RE.test(url.trim()));
}

/**
 * Extract media file paths from a tool result.
 *
 * Strategy (first match wins):
 * 1. Read structured `details.media` attachments from tool details.
 * 2. Parse legacy `MEDIA:` tokens from text content blocks.
 * 3. Fall back to `details.path` when image content exists (legacy imageResult).
 *
 * Returns an empty array when no media is found (e.g. Pi SDK `read` tool
 * returns base64 image data but no file path; those need a different delivery
 * path like saving to a temp file).
 */
export type ToolResultMediaArtifact = {
  mediaUrls: string[];
  audioAsVoice?: boolean;
};

function readToolResultDetailsMedia(
  result: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const details = readToolResultDetails(result);
  const media =
    details?.media && typeof details.media === "object" && !Array.isArray(details.media)
      ? (details.media as Record<string, unknown>)
      : undefined;
  return media;
}

function collectStructuredMediaUrls(media: Record<string, unknown>): string[] {
  const urls: string[] = [];
  if (typeof media.mediaUrl === "string" && media.mediaUrl.trim()) {
    urls.push(media.mediaUrl.trim());
  }
  if (Array.isArray(media.mediaUrls)) {
    urls.push(
      ...media.mediaUrls
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }
  return Array.from(new Set(urls));
}

export function extractToolResultMediaArtifact(
  result: unknown,
): ToolResultMediaArtifact | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const detailsMedia = readToolResultDetailsMedia(record);
  if (detailsMedia) {
    const mediaUrls = collectStructuredMediaUrls(detailsMedia);
    if (mediaUrls.length > 0) {
      return {
        mediaUrls,
        ...(detailsMedia.audioAsVoice === true ? { audioAsVoice: true } : {}),
      };
    }
  }

  const artifactDescriptor = extractProducedArtifactFromToolResult(record);
  if (artifactDescriptor) {
    const url = artifactDescriptor.url?.trim();
    const path = artifactDescriptor.path?.trim();
    const mediaUrls = [url, path].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (mediaUrls.length > 0) {
      return { mediaUrls: Array.from(new Set(mediaUrls)) };
    }
  }

  const content = Array.isArray(record.content) ? record.content : null;
  if (!content) {
    return undefined;
  }

  // Extract legacy MEDIA: paths from text content blocks using the shared
  // parser so directive matching and validation stay in sync with outbound
  // reply parsing.
  const paths: string[] = [];
  let hasImageContent = false;
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (entry.type === "image") {
      hasImageContent = true;
      continue;
    }
    if (entry.type === "text" && typeof entry.text === "string") {
      const parsed = splitMediaFromOutput(entry.text);
      if (parsed.mediaUrls?.length) {
        paths.push(...parsed.mediaUrls);
      }
    }
  }

  if (paths.length > 0) {
    return { mediaUrls: paths };
  }

  // Fall back to legacy details.path when image content exists but no
  // structured media details or MEDIA: text.
  if (hasImageContent) {
    const details = record.details as Record<string, unknown> | undefined;
    const p = typeof details?.path === "string" ? details.path.trim() : "";
    if (p) {
      return { mediaUrls: [p] };
    }
  }

  return undefined;
}

export function extractToolResultMediaPaths(result: unknown): string[] {
  return extractToolResultMediaArtifact(result)?.mediaUrls ?? [];
}

export function isToolResultError(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  const record = result as { details?: unknown };
  const details = record.details;
  if (!details || typeof details !== "object") {
    return false;
  }
  const status = (details as { status?: unknown }).status;
  if (typeof status !== "string") {
    return false;
  }
  const normalized = status.trim().toLowerCase();
  return normalized === "error" || normalized === "timeout";
}

export function extractToolErrorMessage(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const fromDetails = extractErrorField(record.details);
  if (fromDetails) {
    return fromDetails;
  }
  const fromRoot = extractErrorField(record);
  if (fromRoot) {
    return fromRoot;
  }
  const text = extractToolResultText(result);
  if (!text) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const fromJson = extractErrorField(parsed);
    if (fromJson) {
      return fromJson;
    }
  } catch {
    // Fall through to first-line text fallback.
  }
  return normalizeToolErrorText(text);
}

function readToolResultStatus(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const details =
    record.details && typeof record.details === "object" && !Array.isArray(record.details)
      ? (record.details as Record<string, unknown>)
      : record;
  return typeof details.status === "string" ? details.status.trim().toLowerCase() : undefined;
}

export function isToolResultNoProgress(toolName: string, result: unknown): boolean {
  const normalizedToolName = normalizeToolName(toolName);
  if (normalizedToolName !== "process" && normalizedToolName !== "command_status") {
    return false;
  }
  if (!result || typeof result !== "object") {
    return false;
  }
  const record = result as Record<string, unknown>;
  const details =
    record.details && typeof record.details === "object" && !Array.isArray(record.details)
      ? (record.details as Record<string, unknown>)
      : record;
  const status = readToolResultStatus(result);
  const aggregated =
    typeof details.aggregated === "string" ? details.aggregated.trim().toLowerCase() : undefined;
  const text = (extractToolResultText(result) ?? "").trim().toLowerCase();
  return (
    status === "running" &&
    (aggregated === "steady" || /no new output|still running|no progress/.test(text))
  );
}

/**
 * Extract a ProducedArtifact descriptor from a tool result's `details.artifact` payload.
 * Producer tools (pdf/docx/xlsx/csv/site/image) emit `{ details: { artifact: {...} } }`;
 * this helper converts that into the canonical ProducedArtifact shape the runtime uses
 * for deliverable acceptance — no tool-name heuristics here.
 */
export function extractProducedArtifactFromToolResult(
  result: unknown,
): ProducedArtifact | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const details =
    record.details && typeof record.details === "object" && !Array.isArray(record.details)
      ? (record.details as Record<string, unknown>)
      : undefined;
  const rawArtifact = details?.artifact;
  if (!rawArtifact || typeof rawArtifact !== "object" || Array.isArray(rawArtifact)) {
    return undefined;
  }
  const artifact = rawArtifact as Record<string, unknown>;
  const parsedKind = DeliverableKindSchema.safeParse(artifact.kind);
  if (!parsedKind.success) {
    return undefined;
  }
  const format = typeof artifact.format === "string" ? artifact.format.trim() : "";
  const mimeType = typeof artifact.mimeType === "string" ? artifact.mimeType.trim() : "";
  if (!format || !mimeType) {
    return undefined;
  }
  const normalized: ProducedArtifact = {
    kind: parsedKind.data,
    format,
    mimeType,
  };
  if (typeof artifact.path === "string" && artifact.path.trim()) {
    normalized.path = artifact.path.trim();
  }
  if (typeof artifact.url === "string" && artifact.url.trim()) {
    normalized.url = artifact.url.trim();
  }
  if (typeof artifact.sizeBytes === "number" && Number.isFinite(artifact.sizeBytes) && artifact.sizeBytes >= 0) {
    normalized.sizeBytes = Math.floor(artifact.sizeBytes);
  }
  if (typeof artifact.bootstrapRequestId === "string" && artifact.bootstrapRequestId.trim()) {
    normalized.bootstrapRequestId = artifact.bootstrapRequestId.trim();
  }
  if (
    artifact.metadata &&
    typeof artifact.metadata === "object" &&
    !Array.isArray(artifact.metadata)
  ) {
    normalized.metadata = { ...(artifact.metadata as Record<string, unknown>) };
  }
  return normalized;
}

export function buildToolExecutionReceipt(params: {
  toolName: string;
  toolCallId: string;
  meta?: string;
  isToolError: boolean;
  result?: unknown;
}): PlatformRuntimeExecutionReceipt {
  const reasons: string[] = [];
  const normalizedToolName = normalizeToolName(params.toolName) || "unknown_tool";
  const statusText = readToolResultStatus(params.result);
  const errorMessage = params.isToolError ? extractToolErrorMessage(params.result) : undefined;
  let status: PlatformRuntimeExecutionReceipt["status"] = "success";
  if (params.isToolError) {
    status = "failed";
    if (errorMessage) {
      reasons.push(errorMessage);
    }
  } else if (isToolResultNoProgress(normalizedToolName, params.result)) {
    status = "blocked";
    reasons.push("tool reported no progress on a repeated poll path");
  } else if (statusText === "approval-pending") {
    status = "blocked";
    reasons.push("tool is waiting on approval before it can continue");
  } else if (statusText === "approval-unavailable" || statusText === "degraded") {
    status = "degraded";
    reasons.push(statusText.replaceAll("-", " "));
  } else if (statusText === "warning") {
    status = "warning";
    reasons.push("tool completed with a warning status");
  } else if (statusText === "partial") {
    status = "partial";
    reasons.push("tool completed with a partial result");
  }
  const producedArtifact = !params.isToolError
    ? extractProducedArtifactFromToolResult(params.result)
    : undefined;
  return {
    kind: "tool",
    name: normalizedToolName,
    status,
    proof: "reported",
    ...(params.meta ? { summary: params.meta } : {}),
    ...(reasons.length > 0 ? { reasons } : {}),
    metadata: {
      toolCallId: params.toolCallId,
      ...(status === "blocked"
        ? { noProgress: isToolResultNoProgress(normalizedToolName, params.result) }
        : {}),
      ...(statusText ? { toolStatus: statusText } : {}),
    },
    ...(producedArtifact ? { producedArtifacts: [producedArtifact] } : {}),
  };
}

function resolveMessageToolTarget(args: Record<string, unknown>): string | undefined {
  const toRaw = typeof args.to === "string" ? args.to : undefined;
  if (toRaw) {
    return toRaw;
  }
  return typeof args.target === "string" ? args.target : undefined;
}

export function extractMessagingToolSend(
  toolName: string,
  args: Record<string, unknown>,
): MessagingToolSend | undefined {
  // Provider docking: new provider tools must implement plugin.actions.extractToolSend.
  const action = typeof args.action === "string" ? args.action.trim() : "";
  const accountIdRaw = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
  const accountId = accountIdRaw ? accountIdRaw : undefined;
  if (toolName === "message") {
    if (action !== "send" && action !== "thread-reply") {
      return undefined;
    }
    const toRaw = resolveMessageToolTarget(args);
    if (!toRaw) {
      return undefined;
    }
    const providerRaw = typeof args.provider === "string" ? args.provider.trim() : "";
    const channelRaw = typeof args.channel === "string" ? args.channel.trim() : "";
    const providerHint = providerRaw || channelRaw;
    const providerId = providerHint ? normalizeChannelId(providerHint) : null;
    const provider = providerId ?? (providerHint ? providerHint.toLowerCase() : "message");
    const to = normalizeTargetForProvider(provider, toRaw);
    return to ? { tool: toolName, provider, accountId, to } : undefined;
  }
  const providerId = normalizeChannelId(toolName);
  if (!providerId) {
    return undefined;
  }
  const plugin = getChannelPlugin(providerId);
  const extracted = plugin?.actions?.extractToolSend?.({ args });
  if (!extracted?.to) {
    return undefined;
  }
  const to = normalizeTargetForProvider(providerId, extracted.to);
  return to
    ? {
        tool: toolName,
        provider: providerId,
        accountId: extracted.accountId ?? accountId,
        to,
      }
    : undefined;
}
