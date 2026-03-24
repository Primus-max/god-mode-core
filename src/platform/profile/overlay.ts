import type { ArtifactKind, Profile, TaskOverlay } from "../schemas/index.js";
import { getTaskOverlay } from "./defaults.js";
import type { ProfileSignalInput } from "./signals.js";

export type EffectiveProfilePreference = {
  profile: Profile;
  activeProfileId: Profile["id"];
  taskOverlay?: TaskOverlay;
  preferredTools: string[];
  preferredPublishTargets: string[];
  modelHints: string[];
  timeoutSeconds?: number;
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function promptIncludes(prompt: string | undefined, values: string[]): boolean {
  const normalized = (prompt ?? "").toLowerCase();
  return values.some((value) => normalized.includes(value));
}

function hasArtifactKinds(input: ProfileSignalInput, kinds: ArtifactKind[]): boolean {
  return (input.artifactKinds ?? []).some((kind) => kinds.includes(kind));
}

export function resolveTaskOverlay(
  profile: Profile,
  input: ProfileSignalInput,
): TaskOverlay | undefined {
  const normalizedTargets = (input.publishTargets ?? []).map((value) => value.toLowerCase());
  const normalizedFiles = (input.fileNames ?? []).map((value) => value.toLowerCase());

  if (
    normalizedTargets.length > 0 &&
    (getTaskOverlay(profile, "publish_release") || getTaskOverlay(profile, "publish_brief"))
  ) {
    return getTaskOverlay(profile, "publish_release") ?? getTaskOverlay(profile, "publish_brief");
  }

  if (
    promptIncludes(input.prompt, ["joke", "fun", "story", "hello", "brainstorm"]) &&
    getTaskOverlay(profile, "general_chat")
  ) {
    return getTaskOverlay(profile, "general_chat");
  }

  if (
    promptIncludes(input.prompt, ["code", "build", "deploy", "fix", "test", "refactor"]) ||
    normalizedFiles.some((file) =>
      [".ts", ".tsx", ".js", ".jsx", ".json", ".py"].some((ext) => file.endsWith(ext)),
    )
  ) {
    return getTaskOverlay(profile, "code_first");
  }

  if (
    promptIncludes(input.prompt, ["pdf", "document", "estimate", "extract", "ocr", "report"]) ||
    normalizedFiles.some((file) =>
      [".pdf", ".docx", ".xlsx", ".csv"].some((ext) => file.endsWith(ext)),
    ) ||
    hasArtifactKinds(input, ["document", "estimate", "report", "data"])
  ) {
    return getTaskOverlay(profile, "document_first");
  }

  return undefined;
}

export function applyTaskOverlay(
  profile: Profile,
  taskOverlay: TaskOverlay | undefined,
): EffectiveProfilePreference {
  return {
    profile,
    activeProfileId: profile.id,
    taskOverlay,
    preferredTools: unique([...(profile.preferredTools ?? []), ...(taskOverlay?.toolHints ?? [])]),
    preferredPublishTargets: unique([
      ...(profile.preferredPublishTargets ?? []),
      ...(taskOverlay?.publishTargets ?? []),
    ]),
    modelHints: unique(taskOverlay?.modelHints ?? []),
    timeoutSeconds: taskOverlay?.timeoutSeconds,
  };
}
