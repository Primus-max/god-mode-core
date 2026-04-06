import type { ArtifactKind, Profile, TaskOverlay } from "../schemas/index.js";
import { getTaskOverlay } from "./defaults.js";
import { normalizeProfileHintList } from "./hints.js";
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
  const normalizedPrompt = (input.prompt ?? "").toLowerCase();

  if (
    normalizedTargets.length > 0 &&
    (getTaskOverlay(profile, "publish_release") ||
      getTaskOverlay(profile, "publish_brief") ||
      getTaskOverlay(profile, "media_publish"))
  ) {
    return (
      getTaskOverlay(profile, "publish_release") ??
      getTaskOverlay(profile, "publish_brief") ??
      getTaskOverlay(profile, "media_publish")
    );
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
    (promptIncludes(input.prompt, [
      "integration",
      "webhook",
      "connector",
      "sync",
      "oauth",
      "pipeline",
    ]) ||
      (input.integrations?.length ?? 0) > 0) &&
    getTaskOverlay(profile, "integration_first")
  ) {
    return getTaskOverlay(profile, "integration_first");
  }

  if (
    promptIncludes(input.prompt, ["bootstrap", "install capability", "capability bootstrap"]) &&
    getTaskOverlay(profile, "bootstrap_capability")
  ) {
    return getTaskOverlay(profile, "bootstrap_capability");
  }

  if (
    promptIncludes(input.prompt, [
      "machine control",
      "linked machine",
      "kill switch",
      "run on node",
    ]) &&
    getTaskOverlay(profile, "machine_control")
  ) {
    return getTaskOverlay(profile, "machine_control");
  }

  if (
    promptIncludes(input.prompt, [
      "infra",
      "infrastructure",
      "server",
      "ssh",
      "machine",
      "kubernetes",
      "logs",
      "restart",
    ]) &&
    getTaskOverlay(profile, "ops_first")
  ) {
    return getTaskOverlay(profile, "ops_first");
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

  if (
    (promptIncludes(input.prompt, [
      "image",
      "video",
      "audio",
      "thumbnail",
      "render",
      "caption",
      "transcribe",
      "storyboard",
      "figma",
      "design",
    ]) ||
      normalizedFiles.some((file) =>
        [".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mp3", ".wav"].some((ext) =>
          file.endsWith(ext),
        ),
      ) ||
      hasArtifactKinds(input, ["image", "video", "audio"])) &&
    getTaskOverlay(profile, "media_first")
  ) {
    return getTaskOverlay(profile, "media_first");
  }

  if (normalizedPrompt.includes("publish") && getTaskOverlay(profile, "media_publish")) {
    return getTaskOverlay(profile, "media_publish");
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
    preferredTools: normalizeProfileHintList([
      ...(profile.preferredTools ?? []),
      ...(taskOverlay?.toolHints ?? []),
    ]),
    preferredPublishTargets: normalizeProfileHintList([
      ...(profile.preferredPublishTargets ?? []),
      ...(taskOverlay?.publishTargets ?? []),
    ]),
    modelHints: normalizeProfileHintList(taskOverlay?.modelHints ?? []),
    timeoutSeconds: taskOverlay?.timeoutSeconds,
  };
}
