import type { ExecToolDefaults } from "../../../agents/bash-tools.js";
import type { SkillSnapshot } from "../../../agents/skills.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { SessionEntry } from "../../../config/sessions.js";
import type { InputProvenance } from "../../../sessions/input-provenance.js";
import type { OriginatingChannelType } from "../../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../directives.js";

export type QueueMode =
  | "steer"
  | "followup"
  | "collect"
  | "steer-backlog"
  | "interrupt"
  | "queue"
  | "deferred_job";

export type QueueDropPolicy = "old" | "new" | "summarize";

export type QueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
};

export type QueueDedupeMode = "message-id" | "prompt" | "none";

export type FollowupAutomationMetadata = {
  source: "acceptance_retry" | "closure_recovery";
  retryCount: number;
  persisted?: boolean;
  runtimeCheckpointId?: string;
  reasonCode?: string;
  reasonSummary?: string;
};

export type FollowupRun = {
  prompt: string;
  /** Provider message ID, when available (for deduplication). */
  messageId?: string;
  summaryLine?: string;
  enqueuedAt: number;
  /** Stable request/idempotency anchor that started the continuation chain. */
  requestRunId?: string;
  /** Immediate predecessor runtime runId when this run is a continuation. */
  parentRunId?: string;
  automation?: FollowupAutomationMetadata;
  /**
   * Originating channel for reply routing.
   * When set, replies should be routed back to this provider
   * instead of using the session's lastChannel.
   */
  originatingChannel?: OriginatingChannelType;
  /**
   * Originating destination for reply routing.
   * The chat/channel/user ID where the reply should be sent.
   */
  originatingTo?: string;
  /** Provider account id (multi-account). */
  originatingAccountId?: string;
  /** Thread id for reply routing (Telegram topic id or Matrix thread event id). */
  originatingThreadId?: string | number;
  /** Chat type for context-aware threading (e.g., DM vs channel). */
  originatingChatType?: string;
  run: {
    agentId: string;
    agentDir: string;
    sessionId: string;
    sessionKey?: string;
    messageProvider?: string;
    agentAccountId?: string;
    groupId?: string;
    groupChannel?: string;
    groupSpace?: string;
    senderId?: string;
    senderName?: string;
    senderUsername?: string;
    senderE164?: string;
    senderIsOwner?: boolean;
    sessionFile: string;
    workspaceDir: string;
    config: OpenClawConfig;
    skillsSnapshot?: SkillSnapshot;
    provider: string;
    model: string;
    authProfileId?: string;
    authProfileIdSource?: "auto" | "user";
    thinkLevel?: ThinkLevel;
    verboseLevel?: VerboseLevel;
    reasoningLevel?: ReasoningLevel;
    elevatedLevel?: ElevatedLevel;
    execOverrides?: Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;
    bashElevated?: {
      enabled: boolean;
      allowed: boolean;
      defaultLevel: ElevatedLevel;
    };
    timeoutMs: number;
    blockReplyBreak: "text_end" | "message_end";
    ownerNumbers?: string[];
    inputProvenance?: InputProvenance;
    extraSystemPrompt?: string;
    enforceFinalTag?: boolean;
    /**
     * When true, skip automatic route preflight reordering (cheap-remote-first, promote Hydra, etc.)
     * and use the configured candidate order with the session primary first. Set when the session
     * has an explicit model override, or via OPENCLAW_SKIP_MODEL_ROUTE_PREFLIGHT=1 at runtime.
     */
    modelRoutePreflightDisabled?: boolean;
  };
};

export type ResolveQueueSettingsParams = {
  cfg: OpenClawConfig;
  channel?: string;
  sessionEntry?: SessionEntry;
  inlineMode?: QueueMode;
  inlineOptions?: Partial<QueueSettings>;
};
