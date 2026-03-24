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
      "Document-first specialist for estimates, extraction, reporting, and structured outputs.",
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
