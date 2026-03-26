import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  PluginHookAgentContext,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildResult,
  PluginHookPlatformExecutionContext,
} from "../plugins/types.js";
import { resolveStateDir } from "../config/paths.js";
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
} from "./bootstrap/index.js";
import {
  createMachineKillSwitchGatewayMethod,
  createMachineLinkGatewayMethod,
  createMachineStatusGatewayMethod,
  createMachineUnlinkGatewayMethod,
  getPlatformMachineControlService,
} from "./machine/index.js";
import { buildExecutionDecisionInput } from "./decision/input.js";
import { createProfileResolveGatewayMethod } from "./profile/index.js";
import { getInitialProfile, getTaskOverlay } from "./profile/defaults.js";
import { evaluatePolicy } from "./policy/engine.js";
import { captureDeveloperArtifactsFromLlmOutput } from "./developer/index.js";
import { captureDocumentArtifactsFromLlmOutput } from "./document/index.js";
import {
  buildPolicyContextFromExecutionContext,
  resolvePlatformRuntimePlan,
  toPluginHookPlatformExecutionContext,
} from "./recipe/runtime-adapter.js";
import { getInitialRecipe } from "./recipe/defaults.js";

function resolveHookExecution(
  prompt: string,
  ctx?: Pick<PluginHookAgentContext, "platformExecution">,
): PluginHookPlatformExecutionContext {
  if (ctx?.platformExecution) {
    return ctx.platformExecution;
  }
  return toPluginHookPlatformExecutionContext(
    resolvePlatformRuntimePlan(buildExecutionDecisionInput({ prompt })).runtime,
  );
}

function resolveExecutionLabels(execution: PluginHookPlatformExecutionContext): {
  profileLabel: string;
  overlayLabel?: string;
} {
  const profile = getInitialProfile(execution.profileId as Parameters<typeof getInitialProfile>[0]);
  const overlayLabel =
    profile && execution.taskOverlayId
      ? getTaskOverlay(profile, execution.taskOverlayId)?.label ?? execution.taskOverlayId
      : execution.taskOverlayId;
  return {
    profileLabel: profile?.label ?? execution.profileId,
    ...(overlayLabel ? { overlayLabel } : {}),
  };
}

function buildProfilePromptSection(
  prompt: string,
  ctx?: Pick<PluginHookAgentContext, "platformExecution">,
): PluginHookBeforePromptBuildResult | void {
  const execution = resolveHookExecution(prompt, ctx);
  const labels = resolveExecutionLabels(execution);
  const recipe = getInitialRecipe(execution.recipeId);
  return {
    prependSystemContext: [
      `Active specialist profile: ${labels.profileLabel}.`,
      labels.overlayLabel ? `Task overlay: ${labels.overlayLabel}.` : undefined,
      execution.requestedToolNames?.length
        ? `Planned tools: ${execution.requestedToolNames.join(", ")}.`
        : undefined,
      `Execution recipe: ${execution.recipeId}.`,
      recipe?.summary ? `Recipe summary: ${recipe.summary}` : undefined,
      recipe?.systemPrompt,
      execution.requiredCapabilities?.length
        ? `Required capabilities: ${execution.requiredCapabilities.join(", ")}.`
        : undefined,
      execution.bootstrapRequiredCapabilities?.length
        ? `Bootstrap required: ${execution.bootstrapRequiredCapabilities.join(", ")}.`
        : undefined,
      "Profile selection narrows preferences only; it does not grant hidden permissions.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function buildAgentStartResult(
  prompt: string,
  ctx?: Pick<PluginHookAgentContext, "platformExecution">,
): PluginHookBeforeAgentStartResult | void {
  const execution = resolveHookExecution(prompt, ctx);
  const labels = resolveExecutionLabels(execution);
  return {
    prependContext: [
      `Profile hint: ${labels.profileLabel}.`,
      `Recipe hint: ${execution.recipeId}.`,
      execution.plannerReasoning ? `Planner reasoning: ${execution.plannerReasoning}` : undefined,
      execution.bootstrapRequiredCapabilities?.length
        ? `Pending bootstrap: ${execution.bootstrapRequiredCapabilities.join(", ")}.`
        : undefined,
      execution.requireExplicitApproval
        ? `Policy posture: explicit approval required (${execution.policyAutonomy ?? "guarded"}).`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function buildModelResolveResult(
  prompt: string,
  ctx?: Pick<PluginHookAgentContext, "platformExecution">,
): PluginHookBeforeModelResolveResult | void {
  const execution = resolveHookExecution(prompt, ctx);
  if (!execution.modelOverride && !execution.providerOverride) {
    return undefined;
  }
  return {
    providerOverride: execution.providerOverride,
    modelOverride: execution.modelOverride,
  };
}

function isMachineControlToolCall(toolName: string, params: Record<string, unknown>): boolean {
  if (toolName !== "exec") {
    return false;
  }
  return params.host === "node";
}

export function registerPlatformProfilePlugin(api: OpenClawPluginApi): void {
  const artifactService = getPlatformArtifactService({
    config: api.config,
  });
  const bootstrapService = getPlatformBootstrapService({
    stateDir: resolveStateDir(process.env),
  });
  const machineControlService = getPlatformMachineControlService();
  artifactService.rehydrate();
  bootstrapService.rehydrate();

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
  api.on("before_agent_start", (event, ctx) => buildAgentStartResult(event.prompt, ctx), { priority: 20 });
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
    (event, ctx) => {
      const fallbackExecution = toPluginHookPlatformExecutionContext(
        resolvePlatformRuntimePlan(buildExecutionDecisionInput({ prompt: event.prompt })).runtime,
      );
      const execution = ctx.platformExecution ?? fallbackExecution;
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
    (event, ctx) => {
      const params =
        event.params && typeof event.params === "object" && !Array.isArray(event.params)
          ? (event.params as Record<string, unknown>)
          : {};
      if (!isMachineControlToolCall(event.toolName, params)) {
        return undefined;
      }
      const runSnapshot = ctx.runId ? machineControlService.getRunSnapshot(ctx.runId) : undefined;
      const policyContext =
        runSnapshot?.platformExecution
          ? buildPolicyContextFromExecutionContext(
              runSnapshot.platformExecution,
              {
                requestedMachineControl: true,
                machineControlLinked: true,
                machineControlKillSwitchEnabled: machineControlService.getSnapshot().killSwitch.enabled,
                explicitApproval: false,
              },
            )
          : undefined;
      const fallbackDecision = !policyContext
        ? resolvePlatformRuntimePlan(buildExecutionDecisionInput({ prompt: runSnapshot?.prompt ?? "" }))
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
        const blockingReason = policy.deniedReasons.find((reason) => reason.includes("kill switch"));
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
