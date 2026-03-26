import path from "node:path";
import { z } from "zod";
import { loadSessionEntry, readSessionMessages } from "../../gateway/session-utils.js";
import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { resolvePlatformRuntimePlan } from "../recipe/runtime-adapter.js";
import { getInitialProfile, getTaskOverlay } from "./defaults.js";
import { SpecialistRuntimeSnapshotSchema } from "./contracts.js";

const SpecialistResolveParamsSchema = z.object({
  sessionKey: z.string().min(1),
  draft: z.string().optional(),
});

function extractTranscriptUserText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textBlocks = content
    .map((block) =>
      block && typeof block === "object" && "text" in block ? (block as { text?: unknown }).text : undefined,
    )
    .filter((text): text is string => typeof text === "string");
  return textBlocks.length > 0 ? textBlocks.join("") : undefined;
}

function pushMediaPath(value: unknown, into: Set<string>) {
  if (typeof value !== "string" || !value.trim()) {
    return;
  }
  into.add(path.basename(value.trim()));
}

function resolveSessionPromptContext(messages: unknown[]): { prompt: string; fileNames: string[] } {
  const recentTexts: string[] = [];
  const fileNames = new Set<string>();
  for (const raw of messages.slice(-24)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const message = raw as {
      role?: unknown;
      content?: unknown;
      MediaPath?: unknown;
      MediaPaths?: unknown;
    };
    if (message.role !== "user") {
      continue;
    }
    const text = extractTranscriptUserText(message.content)?.trim();
    if (text) {
      recentTexts.push(text);
    }
    pushMediaPath(message.MediaPath, fileNames);
    if (Array.isArray(message.MediaPaths)) {
      for (const entry of message.MediaPaths) {
        pushMediaPath(entry, fileNames);
      }
    }
  }
  return {
    prompt: recentTexts.slice(-6).join("\n\n"),
    fileNames: Array.from(fileNames).slice(-8),
  };
}

export function createProfileResolveGatewayMethod(): GatewayRequestHandler {
  return ({ params, respond }) => {
    const parsed = SpecialistResolveParamsSchema.safeParse(params);
    if (!parsed.success) {
      respond(false, { error: "invalid platform.profile.resolve params" });
      return;
    }

    const sessionKey = parsed.data.sessionKey.trim();
    const draft = parsed.data.draft?.trim() ?? "";
    const { entry, storePath } = loadSessionEntry(sessionKey);
    const messages =
      entry?.sessionId && storePath ? readSessionMessages(entry.sessionId, storePath, entry.sessionFile) : [];
    const sessionContext = resolveSessionPromptContext(messages);
    const prompt = [sessionContext.prompt, draft].filter(Boolean).join("\n\n");
    const resolved = resolvePlatformRuntimePlan({
      prompt,
      baseProfile: "general",
      fileNames: sessionContext.fileNames,
    });
    const selectedProfile = resolved.profile.selectedProfile;
    const activeProfileId = resolved.profile.activeProfile.sessionProfile ?? selectedProfile.id;
    const activeProfile = getInitialProfile(activeProfileId) ?? selectedProfile;
    const taskOverlay =
      getTaskOverlay(selectedProfile, resolved.profile.activeProfile.taskOverlay) ??
      resolved.profile.effective.taskOverlay;

    respond(
      true,
      SpecialistRuntimeSnapshotSchema.parse({
        sessionKey,
        selectedProfileId: selectedProfile.id,
        selectedProfileLabel: selectedProfile.label,
        activeProfileId,
        activeProfileLabel: activeProfile.label,
        ...(activeProfile.description ? { activeProfileDescription: activeProfile.description } : {}),
        baseProfileId: resolved.profile.activeProfile.baseProfile,
        ...(resolved.profile.activeProfile.sessionProfile
          ? { sessionProfileId: resolved.profile.activeProfile.sessionProfile }
          : {}),
        ...(taskOverlay?.id ? { taskOverlayId: taskOverlay.id } : {}),
        ...(taskOverlay?.label ? { taskOverlayLabel: taskOverlay.label } : {}),
        recipeId: resolved.recipe.id,
        recipePurpose: resolved.recipe.purpose,
        ...(resolved.recipe.summary ? { recipeSummary: resolved.recipe.summary } : {}),
        reasoningSummary:
          resolved.runtime.plannerReasoning ??
          `Recipe ${resolved.recipe.id} selected for profile ${selectedProfile.id}.`,
        confidence: resolved.profile.activeProfile.confidence,
        preferredTools: resolved.profile.effective.preferredTools,
        publishTargets: resolved.profile.effective.preferredPublishTargets,
        ...(resolved.runtime.providerOverride ? { providerOverride: resolved.runtime.providerOverride } : {}),
        ...(resolved.runtime.modelOverride ? { modelOverride: resolved.runtime.modelOverride } : {}),
        ...(resolved.runtime.timeoutSeconds ? { timeoutSeconds: resolved.runtime.timeoutSeconds } : {}),
        draftApplied: draft.length > 0,
        signals: resolved.profile.signals.map((signal) => ({
          source: signal.source,
          profileId: signal.profileId,
          profileLabel: getInitialProfile(signal.profileId)?.label ?? signal.profileId,
          weight: signal.weight,
          ...(signal.reason ? { reason: signal.reason } : {}),
        })),
        override: {
          supported: false,
          mode: "auto",
          baseProfileId: resolved.profile.activeProfile.baseProfile,
          ...(resolved.profile.activeProfile.sessionProfile
            ? { sessionProfileId: resolved.profile.activeProfile.sessionProfile }
            : {}),
          note:
            "Manual profile override is not wired into this control surface yet. Selection remains automatic and policy-safe.",
        },
      }),
    );
  };
}
