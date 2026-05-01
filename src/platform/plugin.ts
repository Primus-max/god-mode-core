import { resolveStateDir } from "../config/paths.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  PluginHookAgentContext,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildResult,
  PluginHookPlatformExecutionContext,
} from "../plugins/types.js";
import {
  createArtifactGetGatewayMethod,
  createArtifactHttpHandler,
  createArtifactListGatewayMethod,
  createArtifactTransitionGatewayMethod,
  getPlatformArtifactService,
} from "./artifacts/index.js";
import {
  createBootstrapGetGatewayMethod,
  createBootstrapListGatewayMethod,
  createBootstrapResolveGatewayMethod,
  createBootstrapRunGatewayMethod,
  getPlatformBootstrapService,
  TRUSTED_CAPABILITY_CATALOG,
} from "./bootstrap/index.js";
import {
  createCapabilityCatalogGetGatewayMethod,
  createCapabilityCatalogListGatewayMethod,
  createRecipeCatalogGetGatewayMethod,
  createRecipeCatalogListGatewayMethod,
} from "./catalog/index.js";
import {
  createDefaultExpectedDeltaResolver,
  createDefaultMonitoredRuntime,
} from "./commitment/index.js";
import { runTurnDecision } from "./decision/run-turn-decision.js";
import { captureDeveloperArtifactsFromLlmOutput } from "./developer/index.js";
import { captureDocumentArtifactsFromLlmOutput } from "./document/index.js";
import {
  createMachineKillSwitchGatewayMethod,
  createMachineLinkGatewayMethod,
  createMachineStatusGatewayMethod,
  createMachineUnlinkGatewayMethod,
  getPlatformMachineControlService,
} from "./machine/index.js";
import { evaluatePolicy } from "./policy/engine.js";
import { getInitialProfile, getTaskOverlay } from "./profile/defaults.js";
import { createProfileResolveGatewayMethod } from "./profile/index.js";
import {
  buildPolicyContextFromExecutionContext,
  resolvePlatformRuntimePlan,
  toPluginHookPlatformExecutionContext,
} from "./recipe/runtime-adapter.js";
import { createCapabilityRegistry } from "./registry/index.js";
import {
  createRuntimeActionGetGatewayMethod,
  createRuntimeActionListGatewayMethod,
  createRuntimeCheckpointDispatchGatewayMethod,
  createRuntimeCheckpointGetGatewayMethod,
  createRuntimeCheckpointListGatewayMethod,
  createRuntimeClosureGetGatewayMethod,
  createRuntimeClosureListGatewayMethod,
  getPlatformRuntimeCheckpointService,
} from "./runtime/index.js";

const apiConfigRef: { current: OpenClawPluginApi["config"] | undefined } = {
  current: undefined,
};

export async function resolveHookExecution(
  prompt: string,
  ctx?: Pick<PluginHookAgentContext, "platformExecution" | "workspaceDir" | "agentId">,
): Promise<PluginHookPlatformExecutionContext> {
  if (ctx?.platformExecution) {
    return ctx.platformExecution;
  }
  if (!apiConfigRef.current) {
    throw new Error("Plugin API config not initialized");
  }
  const { productionDecision: classified } = await runTurnDecision({
    prompt,
    cfg: apiConfigRef.current,
    agentDir: ctx?.workspaceDir,
    monitoredRuntime: createDefaultMonitoredRuntime(),
    expectedDeltaResolver: createDefaultExpectedDeltaResolver(
      ctx?.agentId ? { targetAgentId: ctx.agentId } : {},
    ),
  });
  return toPluginHookPlatformExecutionContext(
    resolvePlatformRuntimePlan({
      ...classified.plannerInput,
      callerTag: "plugin-platformContext",
    }).runtime,
  );
}

function resolveExecutionLabels(execution: PluginHookPlatformExecutionContext): {
  profileLabel: string;
  overlayLabel?: string;
} {
  const profile = getInitialProfile(execution.profileId as Parameters<typeof getInitialProfile>[0]);
  const overlayLabel =
    profile && execution.taskOverlayId
      ? (getTaskOverlay(profile, execution.taskOverlayId)?.label ?? execution.taskOverlayId)
      : execution.taskOverlayId;
  return {
    profileLabel: profile?.label ?? execution.profileId,
    ...(overlayLabel ? { overlayLabel } : {}),
  };
}

function joinPromptContextSegments(...segments: Array<string | undefined>): string | undefined {
  const parts = segments.map((segment) => segment?.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function buildProfilePromptSection(
  prompt: string,
  ctx?: Pick<PluginHookAgentContext, "platformExecution" | "workspaceDir" | "agentId">,
): Promise<PluginHookBeforePromptBuildResult | void> {
  return resolveHookExecution(prompt, ctx).then((execution) => {
    const labels = resolveExecutionLabels(execution);
    return {
      prependSystemContext: joinPromptContextSegments(
        execution.prependSystemContext,
        [
          `Active specialist profile: ${labels.profileLabel}.`,
          labels.overlayLabel ? `Task overlay: ${labels.overlayLabel}.` : undefined,
          execution.requestedToolNames?.length
            ? `Planned tools: ${execution.requestedToolNames.join(", ")}.`
            : undefined,
          "Profile selection narrows preferences only; it does not grant hidden permissions.",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    };
  });
}

function buildAgentStartResult(
  prompt: string,
  ctx?: Pick<PluginHookAgentContext, "platformExecution" | "workspaceDir" | "agentId">,
): Promise<PluginHookBeforeAgentStartResult | void> {
  return resolveHookExecution(prompt, ctx).then((execution) => ({
    prependContext: execution.prependContext,
  }));
}

function buildModelResolveResult(
  prompt: string,
  ctx?: Pick<PluginHookAgentContext, "platformExecution" | "workspaceDir" | "agentId">,
): Promise<PluginHookBeforeModelResolveResult | void> {
  return resolveHookExecution(prompt, ctx).then((execution) => {
    if (!execution.modelOverride && !execution.providerOverride) {
      return undefined;
    }
    return {
      providerOverride: execution.providerOverride,
      modelOverride: execution.modelOverride,
    };
  });
}

function isMachineControlToolCall(toolName: string, params: Record<string, unknown>): boolean {
  if (toolName !== "exec") {
    return false;
  }
  return params.host === "node";
}

export function registerPlatformProfilePlugin(api: OpenClawPluginApi): void {
  apiConfigRef.current = api.config;
  const artifactService = getPlatformArtifactService({
    config: api.config,
  });
  const capabilityRegistry = createCapabilityRegistry([], TRUSTED_CAPABILITY_CATALOG);
  const bootstrapService = getPlatformBootstrapService({
    stateDir: resolveStateDir(process.env),
    registry: capabilityRegistry,
  });
  const runtimeCheckpointService = getPlatformRuntimeCheckpointService({
    stateDir: resolveStateDir(process.env),
  });
  const machineControlService = getPlatformMachineControlService();
  artifactService.rehydrate();
  bootstrapService.rehydrate();
  runtimeCheckpointService.rehydrate();

  api.registerHttpRoute({
    path: "/platform/artifacts",
    auth: "plugin",
    match: "prefix",
    handler: createArtifactHttpHandler({
      service: artifactService,
      logger: api.logger,
    }),
  });
  api.registerGatewayMethod(
    "platform.artifacts.list",
    createArtifactListGatewayMethod(artifactService),
  );
  api.registerGatewayMethod(
    "platform.artifacts.get",
    createArtifactGetGatewayMethod(artifactService),
  );
  api.registerGatewayMethod(
    "platform.artifacts.transition",
    createArtifactTransitionGatewayMethod(artifactService),
  );
  api.registerGatewayMethod(
    "platform.bootstrap.list",
    createBootstrapListGatewayMethod(bootstrapService),
  );
  api.registerGatewayMethod(
    "platform.bootstrap.get",
    createBootstrapGetGatewayMethod(bootstrapService),
  );
  api.registerGatewayMethod(
    "platform.bootstrap.resolve",
    createBootstrapResolveGatewayMethod(bootstrapService),
  );
  api.registerGatewayMethod(
    "platform.bootstrap.run",
    createBootstrapRunGatewayMethod(bootstrapService),
  );
  api.registerGatewayMethod("platform.recipes.list", createRecipeCatalogListGatewayMethod());
  api.registerGatewayMethod("platform.recipes.get", createRecipeCatalogGetGatewayMethod());
  api.registerGatewayMethod(
    "platform.capabilities.list",
    createCapabilityCatalogListGatewayMethod(capabilityRegistry),
  );
  api.registerGatewayMethod(
    "platform.capabilities.get",
    createCapabilityCatalogGetGatewayMethod(capabilityRegistry),
  );
  api.registerGatewayMethod(
    "platform.runtime.actions.list",
    createRuntimeActionListGatewayMethod(runtimeCheckpointService),
  );
  api.registerGatewayMethod(
    "platform.runtime.actions.get",
    createRuntimeActionGetGatewayMethod(runtimeCheckpointService),
  );
  api.registerGatewayMethod(
    "platform.runtime.checkpoints.list",
    createRuntimeCheckpointListGatewayMethod(runtimeCheckpointService),
  );
  api.registerGatewayMethod(
    "platform.runtime.checkpoints.get",
    createRuntimeCheckpointGetGatewayMethod(runtimeCheckpointService),
  );
  api.registerGatewayMethod(
    "platform.runtime.checkpoints.dispatch",
    createRuntimeCheckpointDispatchGatewayMethod(runtimeCheckpointService),
  );
  api.registerGatewayMethod(
    "platform.runtime.closures.list",
    createRuntimeClosureListGatewayMethod(runtimeCheckpointService),
  );
  api.registerGatewayMethod(
    "platform.runtime.closures.get",
    createRuntimeClosureGetGatewayMethod(runtimeCheckpointService),
  );
  api.registerGatewayMethod(
    "platform.machine.status",
    createMachineStatusGatewayMethod(machineControlService),
  );
  api.registerGatewayMethod(
    "platform.machine.link",
    createMachineLinkGatewayMethod(machineControlService),
  );
  api.registerGatewayMethod(
    "platform.machine.unlink",
    createMachineUnlinkGatewayMethod(machineControlService),
  );
  api.registerGatewayMethod(
    "platform.machine.setKillSwitch",
    createMachineKillSwitchGatewayMethod(machineControlService),
  );
  api.registerGatewayMethod("platform.profile.resolve", createProfileResolveGatewayMethod());
  api.on("before_agent_start", (event, ctx) => buildAgentStartResult(event.prompt, ctx), {
    priority: 20,
  });
  api.on("before_model_resolve", (event, ctx) => buildModelResolveResult(event.prompt, ctx), {
    priority: 20,
  });
  api.on("before_prompt_build", (event, ctx) => buildProfilePromptSection(event.prompt, ctx), {
    priority: 20,
  });
  api.on(
    "gateway_start",
    (event) => {
      artifactService.configure({
        config: api.config,
        gatewayPort: event.port,
      });
    },
    { priority: 20 },
  );
  api.on(
    "llm_input",
    async (event, ctx) => {
      const execution = ctx.platformExecution ?? (await resolveHookExecution(event.prompt, ctx));
      machineControlService.recordRunSnapshot({
        runId: event.runId,
        sessionId: event.sessionId,
        prompt: event.prompt,
        profileId: execution.profileId,
        recipeId: execution.recipeId,
        platformExecution: execution,
        recordedAtMs: Date.now(),
      });
    },
    { priority: 20 },
  );
  api.on(
    "before_tool_call",
    async (event, ctx) => {
      const params =
        event.params && typeof event.params === "object" && !Array.isArray(event.params)
          ? event.params
          : {};
      if (!isMachineControlToolCall(event.toolName, params)) {
        return undefined;
      }
      const runSnapshot = ctx.runId ? machineControlService.getRunSnapshot(ctx.runId) : undefined;
      const policyContext = runSnapshot?.platformExecution
        ? buildPolicyContextFromExecutionContext(runSnapshot.platformExecution, {
            requestedMachineControl: true,
            machineControlLinked: true,
            machineControlKillSwitchEnabled: machineControlService.getSnapshot().killSwitch.enabled,
            explicitApproval: false,
          })
        : undefined;
      const fallbackDecision = !policyContext
        ? apiConfigRef.current
          ? resolvePlatformRuntimePlan({
              ...(
                await runTurnDecision({
                  prompt: runSnapshot?.prompt ?? "",
                  cfg: apiConfigRef.current,
                  monitoredRuntime: createDefaultMonitoredRuntime(),
                  expectedDeltaResolver: createDefaultExpectedDeltaResolver(
                    ctx.agentId ? { targetAgentId: ctx.agentId } : {},
                  ),
                })
              ).productionDecision.plannerInput,
              callerTag: "plugin-fallback-decision",
            })
          : undefined
        : undefined;
      const policy = evaluatePolicy(
        policyContext ?? {
          ...fallbackDecision!.policyContext,
          requestedToolNames: [event.toolName],
          requestedMachineControl: true,
          machineControlLinked: true,
          machineControlKillSwitchEnabled: machineControlService.getSnapshot().killSwitch.enabled,
          explicitApproval: false,
        },
      );
      if (!policy.allowMachineControl && policy.deniedReasons.length > 0) {
        const blockingReason = policy.deniedReasons.find((reason) =>
          reason.includes("kill switch"),
        );
        if (blockingReason) {
          return {
            block: true,
            blockReason: blockingReason,
          };
        }
      }
      return undefined;
    },
    { priority: 20 },
  );
  api.on(
    "llm_output",
    (event, ctx) => {
      captureDocumentArtifactsFromLlmOutput({
        sessionId: event.sessionId,
        runId: event.runId,
        recipeId: ctx.platformExecution?.recipeId,
        executionContext: ctx.platformExecution,
        assistantTexts: event.assistantTexts,
        artifactService,
      });
      captureDeveloperArtifactsFromLlmOutput({
        sessionId: event.sessionId,
        runId: event.runId,
        recipeId: ctx.platformExecution?.recipeId,
        executionContext: ctx.platformExecution,
        assistantTexts: event.assistantTexts,
        artifactService,
      });
      return undefined;
    },
    { priority: 20 },
  );
}

const platformProfilePlugin: OpenClawPluginDefinition = {
  id: "platform-profile-foundation",
  name: "Platform Profile Foundation",
  description: "Stage 1 profile resolver and policy foundation hooks.",
  register: registerPlatformProfilePlugin,
};

export default platformProfilePlugin;
