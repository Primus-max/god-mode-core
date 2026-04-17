import type { OpenClawConfig } from "../config/config.js";
import { Type } from "@sinclair/typebox";
import { getInitialProfile } from "../platform/profile/defaults.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { SpawnedToolContext } from "./spawned-context.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import { createCapabilityInstallTool } from "./tools/capability-install-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createCsvTool } from "./tools/csv-tool.js";
import { createDocxTool } from "./tools/docx-tool.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createImageGenerateTool } from "./tools/image-generate-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createPdfTool } from "./tools/pdf-tool.js";
import { createSiteTool } from "./tools/site-tool.js";
import { createXlsxTool } from "./tools/xlsx-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";
import { createTtsTool } from "./tools/tts-tool.js";
import { applyImageGenerationModelConfigDefaults } from "./tools/media-tool-shared.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

/**
 * Hides runtime web_search from agent tool lists when the active runtime secret
 * snapshot already knows there is no usable provider key. This prevents models
 * from spending turns on a tool that can only come back with a setup hint.
 *
 * @param {ReturnType<typeof getActiveRuntimeWebToolsMetadata>} runtimeWebTools - Active runtime web tool metadata snapshot.
 * @returns {boolean} True when web_search should be exposed to the agent.
 */
function shouldExposeRuntimeWebSearchTool(
  runtimeWebTools: ReturnType<typeof getActiveRuntimeWebToolsMetadata> | undefined,
): boolean {
  if (!runtimeWebTools) {
    return true;
  }
  if (runtimeWebTools.search.selectedProviderKeySource === "missing") {
    return false;
  }
  return !runtimeWebTools.search.diagnostics.some(
    (diagnostic) => diagnostic.code === "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
  );
}

function applyProfileImageGenerationDefaults(params: {
  cfg: OpenClawConfig | undefined;
  selectedProfileId: string | undefined;
}): OpenClawConfig | undefined {
  const profileId = params.selectedProfileId?.trim();
  if (!profileId) {
    return params.cfg;
  }
  const profile = getInitialProfile(profileId as Parameters<typeof getInitialProfile>[0]);
  const profileModel = profile?.defaultImageGenerationModel?.trim();
  if (!profileModel) {
    return params.cfg;
  }
  const existing = params.cfg?.agents?.defaults?.imageGenerationModel;
  const existingPrimary =
    typeof existing === "string"
      ? existing.trim()
      : typeof existing?.primary === "string"
        ? existing.primary.trim()
        : "";
  const existingFallbacks =
    typeof existing === "object" && Array.isArray(existing?.fallbacks)
      ? existing.fallbacks
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
  const fallbacks = Array.from(
    new Set(
      [
        ...(existingPrimary && existingPrimary !== profileModel ? [existingPrimary] : []),
        ...existingFallbacks,
      ].filter((value) => value !== profileModel),
    ),
  );
  return applyImageGenerationModelConfigDefaults(params.cfg, {
    primary: profileModel,
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  });
}

export function createOpenClawTools(
  options?: {
    sandboxBrowserBridgeUrl?: string;
    allowHostBrowserControl?: boolean;
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    /** Delivery target (e.g. telegram:group:123:topic:456) for topic/thread routing. */
    agentTo?: string;
    /** Thread/topic identifier for routing replies to the originating thread. */
    agentThreadId?: string | number;
    agentDir?: string;
    sandboxRoot?: string;
    sandboxFsBridge?: SandboxFsBridge;
    fsPolicy?: ToolFsPolicy;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    pluginToolAllowlist?: string[];
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
    /** If true, the model has native vision capability */
    modelHasVision?: boolean;
    /** If true, nodes action="invoke" can call media-returning commands directly. */
    allowMediaInvokeCommands?: boolean;
    /** Explicit agent ID override for cron/hook sessions. */
    requesterAgentIdOverride?: string;
    /** Require explicit message targets (no implicit last-route sends). */
    requireExplicitMessageTarget?: boolean;
    /** If true, omit the message tool from the tool list. */
    disableMessageTool?: boolean;
    /** Trusted sender id from inbound context (not tool args). */
    requesterSenderId?: string | null;
    /** Whether the requesting sender is an owner. */
    senderIsOwner?: boolean;
    /** Ephemeral session UUID — regenerated on /new and /reset. */
    sessionId?: string;
    /** Stable run identifier for this agent invocation. */
    runId?: string;
    /** Active platform-selected specialist profile for profile-aware tool defaults. */
    selectedProfileId?: string;
    /**
     * Workspace directory to pass to spawned subagents for inheritance.
     * Defaults to workspaceDir. Use this to pass the actual agent workspace when the
     * session itself is running in a copied-workspace sandbox (`ro` or `none`) so
     * subagents inherit the real workspace path instead of the sandbox copy.
     */
    spawnWorkspaceDir?: string;
    /** Callback invoked when sessions_yield-compatible tools pause the turn. */
    onYield?: (message: string) => Promise<void> | void;
    /** Allow plugin tools for this tool set to late-bind the gateway subagent. */
    allowGatewaySubagentBinding?: boolean;
  } & SpawnedToolContext,
): AnyAgentTool[] {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  const spawnWorkspaceDir = resolveWorkspaceRoot(
    options?.spawnWorkspaceDir ?? options?.workspaceDir,
  );
  const effectiveConfig = applyProfileImageGenerationDefaults({
    cfg: options?.config,
    selectedProfileId: options?.selectedProfileId,
  });
  const runtimeWebTools = getActiveRuntimeWebToolsMetadata();
  const sandbox =
    options?.sandboxRoot && options?.sandboxFsBridge
      ? { root: options.sandboxRoot, bridge: options.sandboxFsBridge }
      : undefined;
  const imageTool = options?.agentDir?.trim()
    ? createImageTool({
        config: effectiveConfig,
        agentDir: options.agentDir,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
        modelHasVision: options?.modelHasVision,
      })
    : null;
  const imageGenerateTool = createImageGenerateTool({
    config: effectiveConfig,
    agentDir: options?.agentDir,
    workspaceDir,
    sandbox,
    fsPolicy: options?.fsPolicy,
  });
  const pdfTool = (() => {
    try {
      return createPdfTool({
        config: effectiveConfig,
        agentDir: options?.agentDir,
        runId: options?.runId,
        onYield: options?.onYield,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/requires agentDir/i.test(message)) {
        return {
          label: "PDF",
          name: "pdf",
          description:
            "PDF generation and analysis tool. Fails closed when runtime agentDir is unavailable.",
          parameters: Type.Object({}, { additionalProperties: true }),
          execute: async () => {
            throw new Error(
              "PDF tool unavailable: runtime agentDir is missing, so the requested PDF capability cannot execute in this turn.",
            );
          },
        } satisfies AnyAgentTool;
      }
      throw error;
    }
  })();
  const webSearchTool = createWebSearchTool({
    config: effectiveConfig,
    sandboxed: options?.sandboxed,
    runtimeWebSearch: runtimeWebTools?.search,
  });
  const effectiveWebSearchTool = shouldExposeRuntimeWebSearchTool(runtimeWebTools)
    ? webSearchTool
    : null;
  const webFetchTool = createWebFetchTool({
    config: effectiveConfig,
    sandboxed: options?.sandboxed,
    runtimeFirecrawl: runtimeWebTools?.fetch.firecrawl,
  });
  const messageTool = options?.disableMessageTool
    ? null
    : createMessageTool({
        agentAccountId: options?.agentAccountId,
        agentSessionKey: options?.agentSessionKey,
        sessionId: options?.sessionId,
        config: effectiveConfig,
        currentChannelId: options?.currentChannelId,
        currentChannelProvider: options?.agentChannel,
        currentThreadTs: options?.currentThreadTs,
        currentMessageId: options?.currentMessageId,
        replyToMode: options?.replyToMode,
        hasRepliedRef: options?.hasRepliedRef,
        sandboxRoot: options?.sandboxRoot,
        requireExplicitTarget: options?.requireExplicitMessageTarget,
        requesterSenderId: options?.requesterSenderId ?? undefined,
      });
  const tools: AnyAgentTool[] = [
    createBrowserTool({
      sandboxBridgeUrl: options?.sandboxBrowserBridgeUrl,
      allowHostControl: options?.allowHostBrowserControl,
      agentSessionKey: options?.agentSessionKey,
    }),
    createCanvasTool({ config: effectiveConfig }),
    createNodesTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      currentChannelId: options?.currentChannelId,
      currentThreadTs: options?.currentThreadTs,
      config: effectiveConfig,
      modelHasVision: options?.modelHasVision,
      allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
    }),
    createCronTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    ...(messageTool ? [messageTool] : []),
    createTtsTool({
      agentChannel: options?.agentChannel,
      config: effectiveConfig,
    }),
    ...(imageGenerateTool ? [imageGenerateTool] : []),
    createGatewayTool({
      agentSessionKey: options?.agentSessionKey,
      config: effectiveConfig,
    }),
    createAgentsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config: effectiveConfig,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config: effectiveConfig,
    }),
    createSessionsSendTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      sandboxed: options?.sandboxed,
      config: effectiveConfig,
    }),
    createSessionsYieldTool({
      sessionId: options?.sessionId,
      onYield: options?.onYield,
    }),
    createSessionsSpawnTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      agentTo: options?.agentTo,
      agentThreadId: options?.agentThreadId,
      agentGroupId: options?.agentGroupId,
      agentGroupChannel: options?.agentGroupChannel,
      agentGroupSpace: options?.agentGroupSpace,
      sandboxed: options?.sandboxed,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
      workspaceDir: spawnWorkspaceDir,
    }),
    createSubagentsTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      config: effectiveConfig,
      sandboxed: options?.sandboxed,
    }),
    ...(effectiveWebSearchTool ? [effectiveWebSearchTool] : []),
    ...(webFetchTool ? [webFetchTool] : []),
    ...(imageTool ? [imageTool] : []),
    ...(pdfTool ? [pdfTool] : []),
    createCsvTool(),
    createDocxTool(),
    createXlsxTool(),
    createSiteTool(),
    createCapabilityInstallTool(),
  ];

  const pluginTools = resolvePluginTools({
    context: {
      config: effectiveConfig,
      workspaceDir,
      agentDir: options?.agentDir,
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: effectiveConfig,
      }),
      sessionKey: options?.agentSessionKey,
      sessionId: options?.sessionId,
      messageChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      requesterSenderId: options?.requesterSenderId ?? undefined,
      senderIsOwner: options?.senderIsOwner ?? undefined,
      sandboxed: options?.sandboxed,
    },
    existingToolNames: new Set(tools.map((tool) => tool.name)),
    toolAllowlist: options?.pluginToolAllowlist,
    allowGatewaySubagentBinding: options?.allowGatewaySubagentBinding,
  });

  return [...tools, ...pluginTools];
}
