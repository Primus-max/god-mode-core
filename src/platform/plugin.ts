import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforePromptBuildResult,
} from "../plugins/types.js";
import { getInitialProfile } from "./profile/defaults.js";
import { resolveProfile } from "./profile/resolver.js";

function buildProfilePromptSection(prompt: string): PluginHookBeforePromptBuildResult | void {
  const resolved = resolveProfile({ prompt, baseProfile: "general" });
  const overlayLabel = resolved.effective.taskOverlay?.label;
  const profileLabel = resolved.selectedProfile.label;
  return {
    prependSystemContext: [
      `Active specialist profile: ${profileLabel}.`,
      overlayLabel ? `Task overlay: ${overlayLabel}.` : undefined,
      resolved.effective.preferredTools.length > 0
        ? `Preferred tools: ${resolved.effective.preferredTools.join(", ")}.`
        : undefined,
      "Profile selection narrows preferences only; it does not grant hidden permissions.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function buildAgentStartResult(prompt: string): PluginHookBeforeAgentStartResult | void {
  const resolved = resolveProfile({ prompt, baseProfile: "general" });
  const profile = getInitialProfile(resolved.selectedProfile.id);
  if (!profile) {
    return undefined;
  }
  return {
    prependContext: `Profile hint: ${profile.label}. Confidence ${resolved.activeProfile.confidence.toFixed(2)}.`,
  };
}

export function registerPlatformProfilePlugin(api: OpenClawPluginApi): void {
  api.on("before_agent_start", (event) => buildAgentStartResult(event.prompt), { priority: 20 });
  api.on("before_model_resolve", () => undefined, { priority: 20 });
  api.on("before_prompt_build", (event) => buildProfilePromptSection(event.prompt), {
    priority: 20,
  });
  api.on("llm_output", () => undefined, { priority: 20 });
}

const platformProfilePlugin: OpenClawPluginDefinition = {
  id: "platform-profile-foundation",
  name: "Platform Profile Foundation",
  description: "Stage 1 profile resolver and policy foundation hooks.",
  register: registerPlatformProfilePlugin,
};

export default platformProfilePlugin;
