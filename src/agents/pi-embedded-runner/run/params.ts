import type { ImageContent } from "@mariozechner/pi-ai";
import type { ReasoningLevel, ThinkLevel, VerboseLevel } from "../../../auto-reply/thinking.js";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RecipeRuntimePlan } from "../../../platform/recipe/runtime-adapter.js";
import type { ensureOpenClawModelsJson } from "../../models-config.js";
import type { prepareProviderRuntimeAuth } from "../../../plugins/provider-runtime.js";
import type { enqueueCommand } from "../../../process/command-queue.js";
import type { runEmbeddedAttempt } from "../run/attempt.js";
import type { resolveModelAsync } from "../model.js";
import type { computeBackoff, sleepWithAbort } from "../../../infra/backoff.js";
import type { ensureRuntimePluginsLoaded } from "../../runtime-plugins.js";
import type { InputProvenance } from "../../../sessions/input-provenance.js";
import type { ExecElevatedDefaults, ExecToolDefaults } from "../../bash-tools.js";
import type { AgentStreamParams } from "../../command/types.js";
import type { BlockReplyPayload } from "../../pi-embedded-payloads.js";
import type { BlockReplyChunking, ToolResultFormat } from "../../pi-embedded-subscribe.js";
import type { SkillSnapshot } from "../../skills.js";

// Simplified tool definition for client-provided tools (OpenResponses hosted tools)
export type ClientToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type RunEmbeddedPiAgentParams = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  /** What initiated this agent run: "user", "heartbeat", "cron", or "memory". */
  trigger?: string;
  /** Relative workspace path that memory-triggered writes are allowed to append to. */
  memoryFlushWritePath?: string;
  /** Delivery target (e.g. telegram:group:123:topic:456) for topic/thread routing. */
  messageTo?: string;
  /** Thread/topic identifier for routing replies to the originating thread. */
  messageThreadId?: string | number;
  /** Group id for channel-level tool policy resolution. */
  groupId?: string | null;
  /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null;
  /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null;
  /** Parent session key for subagent policy inheritance. */
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  /** Whether the sender is an owner (required for owner-only tools). */
  senderIsOwner?: boolean;
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Current inbound message id for action fallbacks (e.g. Telegram react). */
  currentMessageId?: string | number;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** Require explicit message tool targets (no implicit last-route sends). */
  requireExplicitMessageTarget?: boolean;
  /** If true, omit the message tool from the tool list. */
  disableMessageTool?: boolean;
  /** Allow runtime plugins for this run to late-bind the gateway subagent. */
  allowGatewaySubagentBinding?: boolean;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  prompt: string;
  images?: ImageContent[];
  /** Optional client-provided tools (OpenResponses hosted tools). */
  clientTools?: ClientToolDefinition[];
  /** Disable built-in tools for this run (LLM-only mode). */
  disableTools?: boolean;
  provider?: string;
  model?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  thinkLevel?: ThinkLevel;
  fastMode?: boolean;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  toolResultFormat?: ToolResultFormat;
  /** If true, suppress tool error warning payloads for this run (including mutating tools). */
  suppressToolErrorWarnings?: boolean;
  /** Bootstrap context mode for workspace file injection. */
  bootstrapContextMode?: "full" | "lightweight";
  /** Run kind hint for context mode behavior. */
  bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  /** Seen bootstrap truncation warning signatures for this session (once mode dedupe). */
  bootstrapPromptWarningSignaturesSeen?: string[];
  /** Last shown bootstrap truncation warning signature for this session. */
  bootstrapPromptWarningSignature?: string;
  execOverrides?: Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;
  bashElevated?: ExecElevatedDefaults;
  timeoutMs: number;
  runId: string;
  /** Stable request/idempotency anchor that may span continuation runs. */
  requestRunId?: string;
  /** Immediate predecessor runId when this execution continues a prior run. */
  parentRunId?: string;
  abortSignal?: AbortSignal;
  shouldEmitToolResult?: () => boolean;
  shouldEmitToolOutput?: () => boolean;
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onBlockReply?: (payload: BlockReplyPayload) => void | Promise<void>;
  onBlockReplyFlush?: () => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  blockReplyChunking?: BlockReplyChunking;
  onReasoningStream?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onReasoningEnd?: () => void | Promise<void>;
  onToolResult?: (payload: ReplyPayload) => void | Promise<void>;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
  lane?: string;
  enqueue?: typeof enqueueCommand;
  /** Injectable override for ensureOpenClawModelsJson — used in tests to bypass the real
   *  implementation which triggers expensive Jiti plugin compilation. */
  ensureModelsJson?: typeof ensureOpenClawModelsJson;
  /** Injectable override for ensureRuntimePluginsLoaded — used in tests to bypass Jiti
   *  plugin compilation that happens on the first call per worker process. */
  ensureRuntimePluginsLoaded?: typeof ensureRuntimePluginsLoaded;
  /** Injectable override for prepareProviderRuntimeAuth — used in tests to bypass the real
   *  implementation which triggers Jiti plugin loading. */
  prepareRuntimeAuth?: typeof prepareProviderRuntimeAuth;
  /** Injectable override for runEmbeddedAttempt — used in tests to bypass the real
   *  implementation which makes actual LLM API calls. */
  runAttempt?: typeof runEmbeddedAttempt;
  /** Injectable override for resolveModelAsync — used in tests to bypass the real
   *  implementation which triggers Jiti plugin compilation via DEFAULT_PROVIDER_RUNTIME_HOOKS. */
  resolveModelAsync?: typeof resolveModelAsync;
  /** Injectable override for computeBackoff — used in tests to bypass the vi.mock interception
   *  failure caused by test/setup.ts pre-loading backoff.js via context.ts before vi.mock applies. */
  computeBackoff?: typeof computeBackoff;
  /** Injectable override for sleepWithAbort — used in tests alongside computeBackoff injection. */
  sleepWithAbort?: typeof sleepWithAbort;
  extraSystemPrompt?: string;
  inputProvenance?: InputProvenance;
  streamParams?: AgentStreamParams;
  ownerNumbers?: string[];
  enforceFinalTag?: boolean;
  /**
   * Structured platform orchestration hints selected before entering the runner.
   * When refreshing policy or rebuilding planner input for the same turn, prefer
   * `buildExecutionDecisionInputFromRuntimePlan` / `resolveExecutionRuntimePlanFromExistingRuntime`
   * (`src/platform/decision/input.ts`) so intent and artifact signals stay tied to this snapshot
   * instead of being re-inferred from raw prompt text.
   */
  platformExecutionContext?: RecipeRuntimePlan;
  /**
   * Allow a single run attempt even when all auth profiles are in cooldown,
   * but only for inferred transient cooldowns like `rate_limit` or `overloaded`.
   *
   * This is used by model fallback when trying sibling models on providers
   * where transient service pressure is often model-scoped.
   */
  allowTransientCooldownProbe?: boolean;
};
