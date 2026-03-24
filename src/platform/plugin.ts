import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildResult,
} from "../plugins/types.js";
import { captureDeveloperArtifactsFromLlmOutput } from "./developer/index.js";
import { captureDocumentArtifactsFromLlmOutput } from "./document/index.js";
import { resolvePlatformRuntimePlan } from "./recipe/runtime-adapter.js";

function buildProfilePromptSection(prompt: string): PluginHookBeforePromptBuildResult | void {
  const resolved = resolvePlatformRuntimePlan({ prompt, baseProfile: "general" });
  return {
    prependSystemContext: [
      `Active specialist profile: ${resolved.profile.selectedProfile.label}.`,
      resolved.profile.effective.taskOverlay?.label
        ? `Task overlay: ${resolved.profile.effective.taskOverlay.label}.`
        : undefined,
      resolved.profile.effective.preferredTools.length > 0
        ? `Preferred tools: ${resolved.profile.effective.preferredTools.join(", ")}.`
        : undefined,
      resolved.runtime.prependSystemContext,
      "Profile selection narrows preferences only; it does not grant hidden permissions.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function buildAgentStartResult(prompt: string): PluginHookBeforeAgentStartResult | void {
  const resolved = resolvePlatformRuntimePlan({ prompt, baseProfile: "general" });
  return {
    prependContext: [
      `Profile hint: ${resolved.profile.selectedProfile.label}. Confidence ${resolved.profile.activeProfile.confidence.toFixed(2)}.`,
      `Recipe hint: ${resolved.recipe.id}.`,
      resolved.runtime.prependContext,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function buildModelResolveResult(prompt: string): PluginHookBeforeModelResolveResult | void {
  const resolved = resolvePlatformRuntimePlan({ prompt, baseProfile: "general" });
  if (!resolved.runtime.modelOverride && !resolved.runtime.providerOverride) {
    return undefined;
  }
  return {
    providerOverride: resolved.runtime.providerOverride,
    modelOverride: resolved.runtime.modelOverride,
  };
}

export function registerPlatformProfilePlugin(api: OpenClawPluginApi): void {
  api.on("before_agent_start", (event) => buildAgentStartResult(event.prompt), { priority: 20 });
  api.on("before_model_resolve", (event) => buildModelResolveResult(event.prompt), {
    priority: 20,
  });
  api.on("before_prompt_build", (event) => buildProfilePromptSection(event.prompt), {
    priority: 20,
  });
  api.on(
    "llm_output",
    (event, ctx) => {
      captureDocumentArtifactsFromLlmOutput({
        sessionId: event.sessionId,
        runId: event.runId,
        recipeId: ctx.platformExecution?.recipeId,
        assistantTexts: event.assistantTexts,
      });
      captureDeveloperArtifactsFromLlmOutput({
        sessionId: event.sessionId,
        runId: event.runId,
        recipeId: ctx.platformExecution?.recipeId,
        assistantTexts: event.assistantTexts,
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
