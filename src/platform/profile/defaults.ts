import { createProfileRegistry } from "../registry/index.js";
import type { Profile, ProfileId, TaskOverlay } from "../schemas/profile.js";

export const INITIAL_PROFILES: Profile[] = [
  {
    id: "general",
    label: "General",
    description: "General-purpose assistant for chat, brainstorming, and lightweight tasks.",
    riskCeiling: "low",
    priority: 10,
    taskOverlays: [
      {
        id: "general_chat",
        label: "General Chat",
        parentProfile: "general",
        toolHints: ["read"],
        timeoutSeconds: 60,
      },
    ],
  },
  {
    id: "builder",
    label: "Builder",
    description:
      "Project-designer and document-first specialist: calculations and spreadsheet modeling, supplier comparison, ventilation and air-balance reasoning, plus estimates, extraction, reporting, and structured outputs.",
    preferredTools: ["read", "write", "edit"],
    preferredPublishTargets: ["pdf", "email"],
    riskCeiling: "medium",
    priority: 30,
    taskOverlays: [
      {
        id: "document_first",
        label: "Document First",
        parentProfile: "builder",
        toolHints: ["read", "edit"],
        modelHints: ["structured-output"],
        timeoutSeconds: 180,
      },
      {
        id: "project_designer",
        label: "Project Designer",
        parentProfile: "builder",
        toolHints: ["read", "edit"],
        modelHints: ["structured-output"],
        timeoutSeconds: 240,
      },
      {
        id: "publish_brief",
        label: "Publish Brief",
        parentProfile: "builder",
        publishTargets: ["pdf", "email"],
        timeoutSeconds: 240,
      },
      {
        id: "general_chat",
        label: "General Chat",
        parentProfile: "builder",
        toolHints: ["read"],
        timeoutSeconds: 60,
      },
    ],
  },
  {
    id: "developer",
    label: "Developer",
    description:
      "Code-first specialist for repositories, testing, build, deploy, and release workflows.",
    preferredTools: ["read", "write", "edit", "exec", "process"],
    preferredPublishTargets: ["github", "npm"],
    riskCeiling: "high",
    priority: 40,
    taskOverlays: [
      {
        id: "code_first",
        label: "Code First",
        parentProfile: "developer",
        toolHints: ["read", "write", "edit", "exec"],
        modelHints: ["tool-use", "repo-aware"],
        timeoutSeconds: 300,
      },
      {
        id: "publish_release",
        label: "Publish Release",
        parentProfile: "developer",
        publishTargets: ["github", "npm"],
        timeoutSeconds: 420,
      },
      {
        id: "general_chat",
        label: "General Chat",
        parentProfile: "developer",
        toolHints: ["read"],
        timeoutSeconds: 60,
      },
    ],
  },
  {
    id: "integrator",
    label: "Integrator",
    description:
      "API, webhook, rollout, and cross-system integration specialist for connected workflows.",
    preferredTools: ["read", "write", "edit", "exec"],
    preferredPublishTargets: ["github", "docker", "vercel", "netlify", "webhook"],
    riskCeiling: "high",
    priority: 35,
    taskOverlays: [
      {
        id: "integration_first",
        label: "Integration First",
        parentProfile: "integrator",
        toolHints: ["read", "write", "edit", "exec"],
        modelHints: ["tool-use", "structured-output"],
        timeoutSeconds: 240,
      },
      {
        id: "publish_release",
        label: "Publish Release",
        parentProfile: "integrator",
        publishTargets: ["github", "docker", "vercel", "netlify", "webhook"],
        timeoutSeconds: 360,
      },
      {
        id: "general_chat",
        label: "General Chat",
        parentProfile: "integrator",
        toolHints: ["read"],
        timeoutSeconds: 60,
      },
    ],
  },
  {
    id: "operator",
    label: "Operator",
    description:
      "Infrastructure, machine-control, and capability-operations specialist for guarded runtime work.",
    preferredTools: ["read", "exec", "process"],
    riskCeiling: "high",
    priority: 45,
    taskOverlays: [
      {
        id: "ops_first",
        label: "Ops First",
        parentProfile: "operator",
        toolHints: ["read", "exec", "process"],
        modelHints: ["tool-use", "ops-aware"],
        timeoutSeconds: 300,
      },
      {
        id: "machine_control",
        label: "Machine Control",
        parentProfile: "operator",
        toolHints: ["exec", "process"],
        timeoutSeconds: 300,
      },
      {
        id: "bootstrap_capability",
        label: "Bootstrap Capability",
        parentProfile: "operator",
        toolHints: ["read", "exec"],
        timeoutSeconds: 240,
      },
      {
        id: "general_chat",
        label: "General Chat",
        parentProfile: "operator",
        toolHints: ["read"],
        timeoutSeconds: 60,
      },
    ],
  },
  {
    id: "media_creator",
    label: "Media Creator",
    description: "Image, video, audio, and multimodal content production specialist.",
    preferredTools: ["read", "write", "browser", "canvas"],
    preferredPublishTargets: ["site"],
    riskCeiling: "medium",
    priority: 25,
    taskOverlays: [
      {
        id: "media_first",
        label: "Media First",
        parentProfile: "media_creator",
        toolHints: ["read", "write", "browser", "canvas"],
        modelHints: ["multimodal", "visual"],
        timeoutSeconds: 240,
      },
      {
        id: "media_publish",
        label: "Media Publish",
        parentProfile: "media_creator",
        publishTargets: ["site"],
        timeoutSeconds: 180,
      },
      {
        id: "general_chat",
        label: "General Chat",
        parentProfile: "media_creator",
        toolHints: ["read"],
        timeoutSeconds: 60,
      },
    ],
  },
];

export const INITIAL_PROFILE_IDS = INITIAL_PROFILES.map((profile) => profile.id);
export const initialProfileRegistry = createProfileRegistry(INITIAL_PROFILES);

export function getInitialProfile(id: ProfileId): Profile | undefined {
  return initialProfileRegistry.get(id);
}

export function getTaskOverlay(
  profile: Profile,
  overlayId: string | undefined,
): TaskOverlay | undefined {
  if (!overlayId) {
    return undefined;
  }
  return profile.taskOverlays?.find((overlay) => overlay.id === overlayId);
}
