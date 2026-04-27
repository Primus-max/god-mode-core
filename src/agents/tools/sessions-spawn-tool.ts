import { Type } from "@sinclair/typebox";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { ACP_SPAWN_STREAM_TARGETS, type SpawnAcpResult, spawnAcpDirect } from "../acp-spawn.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { type SpawnSubagentResult, spawnSubagentDirect } from "../subagent-spawn.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

// Cherry-pick fields that are safe to surface to the LLM/user.
// On error/forbidden we deliberately drop childSessionKey, runId, agentId,
// parentSessionKey and any other internal hint added by upstream branches;
// verbose details belong in logs.
//
// `parentSessionKey: null` is meaningful (top-level spawn, no caller session)
// and is preserved on accepted; `undefined` means "not applicable" and is
// dropped. This split keeps the LLM payload truthful about lineage while
// staying consistent with the runtime result schema.
export function buildSubagentSpawnLlmResult(result: SpawnSubagentResult): Record<string, unknown> {
  if (result.status === "accepted") {
    const out: Record<string, unknown> = { status: result.status };
    if (result.childSessionKey) {
      out.childSessionKey = result.childSessionKey;
    }
    if (result.runId) {
      out.runId = result.runId;
    }
    if (result.mode) {
      out.mode = result.mode;
    }
    if (result.note) {
      out.note = result.note;
    }
    if (result.modelApplied !== undefined) {
      out.modelApplied = result.modelApplied;
    }
    if (result.agentId) {
      out.agentId = result.agentId;
    }
    if (result.parentSessionKey !== undefined) {
      out.parentSessionKey = result.parentSessionKey;
    }
    if (result.attachments) {
      out.attachments = result.attachments;
    }
    return out;
  }
  const out: Record<string, unknown> = { status: result.status };
  if (result.error) {
    out.error = result.error;
  }
  return out;
}

export function buildAcpSpawnLlmResult(result: SpawnAcpResult): Record<string, unknown> {
  if (result.status === "accepted") {
    const out: Record<string, unknown> = { status: result.status };
    if (result.childSessionKey) {
      out.childSessionKey = result.childSessionKey;
    }
    if (result.runId) {
      out.runId = result.runId;
    }
    if (result.mode) {
      out.mode = result.mode;
    }
    if (result.streamLogPath) {
      out.streamLogPath = result.streamLogPath;
    }
    if (result.note) {
      out.note = result.note;
    }
    if (result.agentId) {
      out.agentId = result.agentId;
    }
    if (result.parentSessionKey !== undefined) {
      out.parentSessionKey = result.parentSessionKey;
    }
    return out;
  }
  const out: Record<string, unknown> = { status: result.status };
  if (result.error) {
    out.error = result.error;
  }
  return out;
}

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
const SESSIONS_SPAWN_CONTINUATIONS = ["one_shot", "followup"] as const;
type SessionsSpawnContinuation = (typeof SESSIONS_SPAWN_CONTINUATIONS)[number];
const UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS = [
  "target",
  "transport",
  "channel",
  "to",
  "threadId",
  "thread_id",
  "replyTo",
  "reply_to",
] as const;
// Legacy implementation-leaking keys we used to expose. Reject them with a
// clear schema-style error so the LLM is forced to switch to `continuation`.
const REJECTED_LEGACY_SPAWN_PARAM_KEYS = ["thread", "mode"] as const;
const FOLLOWUP_FALLBACK_NOTE =
  "Follow-up unavailable in this channel; ran one-shot instead.";

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  runtime: optionalStringEnum(SESSIONS_SPAWN_RUNTIMES),
  agentId: Type.Optional(Type.String()),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        'Resume an existing agent session by its ID (e.g. a Codex session UUID from ~/.codex/sessions/). Requires runtime="acp". The agent replays conversation history via session/load instead of starting fresh.',
    }),
  ),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat: older callers used timeoutSeconds for this tool.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  continuation: Type.Optional(
    stringEnum(SESSIONS_SPAWN_CONTINUATIONS, {
      default: "one_shot",
      description:
        "Pick `followup` if you will need to send more messages to this subagent later (persistent session). Pick `one_shot` for a single fire-and-collect task.",
    }),
  ),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
  streamTo: optionalStringEnum(ACP_SPAWN_STREAM_TARGETS),

  // Inline attachments (snapshot-by-value).
  // NOTE: Attachment contents are redacted from transcript persistence by sanitizeToolCallInputs.
  attachments: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        content: Type.String(),
        encoding: Type.Optional(optionalStringEnum(["utf8", "base64"] as const)),
        mimeType: Type.Optional(Type.String()),
      }),
      { maxItems: 50 },
    ),
  ),
  attachAs: Type.Optional(
    Type.Object({
      // Where the spawned agent should look for attachments.
      // Kept as a hint; implementation materializes into the child workspace.
      mountPath: Type.Optional(Type.String()),
    }),
  ),
});

export function createSessionsSpawnTool(
  opts?: {
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    sandboxed?: boolean;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
  } & SpawnedToolContext,
): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    description:
      "Spawn a subagent. Use continuation='followup' if you will need to send more messages to this subagent later (persistent session). Use continuation='one_shot' for a single fire-and-collect task. Default: one_shot.",
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const unsupportedParam = UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS.find((key) =>
        Object.hasOwn(params, key),
      );
      if (unsupportedParam) {
        throw new ToolInputError(
          `sessions_spawn does not support "${unsupportedParam}". Use "message" or "sessions_send" for channel delivery.`,
        );
      }
      const legacyParam = REJECTED_LEGACY_SPAWN_PARAM_KEYS.find((key) =>
        Object.hasOwn(params, key),
      );
      if (legacyParam) {
        throw new ToolInputError(
          `sessions_spawn no longer accepts "${legacyParam}". Use "continuation": "one_shot" | "followup" instead.`,
        );
      }
      const task = readStringParam(params, "task", { required: true });
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      const requestedAgentId = readStringParam(params, "agentId");
      const resumeSessionId = readStringParam(params, "resumeSessionId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cwd = readStringParam(params, "cwd");
      const continuation: SessionsSpawnContinuation =
        params.continuation === "followup" ? "followup" : "one_shot";
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const sandbox = params.sandbox === "require" ? "require" : "inherit";
      const streamTo = params.streamTo === "parent" ? "parent" : undefined;
      // Back-compat: older callers used timeoutSeconds for this tool.
      const timeoutSecondsCandidate =
        typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : typeof params.timeoutSeconds === "number"
            ? params.timeoutSeconds
            : undefined;
      const runTimeoutSeconds =
        typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate)
          ? Math.max(0, Math.floor(timeoutSecondsCandidate))
          : undefined;
      const attachments = Array.isArray(params.attachments)
        ? (params.attachments as Array<{
            name: string;
            content: string;
            encoding?: "utf8" | "base64";
            mimeType?: string;
          }>)
        : undefined;

      if (streamTo && runtime !== "acp") {
        return jsonResult({
          status: "error",
          error: `streamTo is only supported for runtime=acp; got runtime=${runtime}`,
        });
      }

      if (resumeSessionId && runtime !== "acp") {
        return jsonResult({
          status: "error",
          error: `resumeSessionId is only supported for runtime=acp; got runtime=${runtime}`,
        });
      }

      // Tool-boundary mapping: intent (`continuation`) -> internal
      // (`thread`, `mode`). The internal API is intentionally untouched.
      const toInternal = (
        c: SessionsSpawnContinuation,
      ): { thread: boolean; mode: "run" | "session" } =>
        c === "followup"
          ? { thread: true, mode: "session" }
          : { thread: false, mode: "run" };

      if (runtime === "acp") {
        if (Array.isArray(attachments) && attachments.length > 0) {
          return jsonResult({
            status: "error",
            error:
              "attachments are currently unsupported for runtime=acp; use runtime=subagent or remove attachments",
          });
        }
        const internal = toInternal(continuation);
        const result = await spawnAcpDirect(
          {
            task,
            label: label || undefined,
            agentId: requestedAgentId,
            resumeSessionId,
            cwd,
            mode: internal.mode,
            thread: internal.thread,
            sandbox,
            streamTo,
          },
          {
            agentSessionKey: opts?.agentSessionKey,
            agentChannel: opts?.agentChannel,
            agentAccountId: opts?.agentAccountId,
            agentTo: opts?.agentTo,
            agentThreadId: opts?.agentThreadId,
            sandboxed: opts?.sandboxed,
          },
        );
        return jsonResult(buildAcpSpawnLlmResult(result));
      }

      const subagentContext = {
        agentSessionKey: opts?.agentSessionKey,
        agentChannel: opts?.agentChannel,
        agentAccountId: opts?.agentAccountId,
        agentTo: opts?.agentTo,
        agentThreadId: opts?.agentThreadId,
        agentGroupId: opts?.agentGroupId,
        agentGroupChannel: opts?.agentGroupChannel,
        agentGroupSpace: opts?.agentGroupSpace,
        requesterAgentIdOverride: opts?.requesterAgentIdOverride,
        workspaceDir: opts?.workspaceDir,
      };
      const attachMountPath =
        params.attachAs && typeof params.attachAs === "object"
          ? readStringParam(params.attachAs as Record<string, unknown>, "mountPath")
          : undefined;
      const baseSubagentParams = {
        task,
        label: label || undefined,
        agentId: requestedAgentId,
        model: modelOverride,
        thinking: thinkingOverrideRaw,
        runTimeoutSeconds,
        cleanup,
        sandbox,
        expectsCompletionMessage: true,
        attachments,
        attachMountPath,
      } as const;

      const internal = toInternal(continuation);
      let result = await spawnSubagentDirect(
        { ...baseSubagentParams, thread: internal.thread, mode: internal.mode },
        subagentContext,
      );

      // Graceful fallback: if the orchestrator asked for a follow-up session but
      // this delivery channel cannot bind a thread, transparently retry as a
      // one-shot run. We branch on the structured discriminator (NOT the error
      // string) so the contract stays stable across error wording changes.
      let effectiveContinuation: SessionsSpawnContinuation = continuation;
      let fallbackNote: string | undefined;
      if (
        continuation === "followup" &&
        result.status === "error" &&
        result.errorReason === "thread_binding_unsupported"
      ) {
        const fallback = toInternal("one_shot");
        result = await spawnSubagentDirect(
          { ...baseSubagentParams, thread: fallback.thread, mode: fallback.mode },
          subagentContext,
        );
        if (result.status === "accepted") {
          effectiveContinuation = "one_shot";
          fallbackNote = FOLLOWUP_FALLBACK_NOTE;
        }
      }

      const llmResult = buildSubagentSpawnLlmResult(result);
      if (result.status === "accepted") {
        llmResult.effectiveContinuation = effectiveContinuation;
        if (fallbackNote) {
          // Prefer the fallback note over any pre-existing accepted-note so the
          // LLM sees the most actionable hint first.
          llmResult.note = fallbackNote;
        }
      }
      return jsonResult(llmResult);
    },
  };
}
