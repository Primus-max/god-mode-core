import { z } from "zod";
import { loadSessionEntry } from "../../gateway/session-entry.js";
import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import {
  buildSessionBackedExecutionDecisionInput,
} from "../decision/input.js";
import { resolvePlatformRuntimePlan } from "../recipe/runtime-adapter.js";
import { getInitialProfile, getTaskOverlay, INITIAL_PROFILES } from "./defaults.js";
import { SpecialistRuntimeSnapshotSchema } from "./contracts.js";
import { resolveSessionSpecialistOverride } from "./session-overrides.js";

const SpecialistResolveParamsSchema = z.object({
  sessionKey: z.string().min(1),
  draft: z.string().optional(),
});

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
    const override = resolveSessionSpecialistOverride(entry);
    const resolved = resolvePlatformRuntimePlan(
      buildSessionBackedExecutionDecisionInput({
        draftPrompt: draft,
        storePath,
        sessionEntry: entry,
      }),
    );
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
        availableProfiles: INITIAL_PROFILES.map((profile) => ({
          id: profile.id,
          label: profile.label,
        })),
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
        requiredCapabilities: resolved.capabilitySummary.requiredCapabilities,
        bootstrapRequiredCapabilities: resolved.capabilitySummary.bootstrapRequiredCapabilities,
        capabilityRequirements: resolved.capabilitySummary.requirements.map((requirement) => ({
          id: requirement.capabilityId,
          label: requirement.capabilityLabel ?? requirement.capabilityId,
          status: requirement.status,
          requiresBootstrap: requirement.requiresBootstrap,
          ...(requirement.reasons?.length ? { reasons: requirement.reasons } : {}),
        })),
        policyAutonomy: resolved.policyPreview.autonomy,
        requiresExplicitApproval: resolved.policyPreview.requireExplicitApproval,
        allowArtifactPersistence: resolved.policyPreview.allowArtifactPersistence,
        allowPublish: resolved.policyPreview.allowPublish,
        allowCapabilityBootstrap: resolved.policyPreview.allowCapabilityBootstrap,
        allowPrivilegedTools: resolved.policyPreview.allowPrivilegedTools,
        policyReasons: resolved.policyPreview.reasons,
        policyDeniedReasons: resolved.policyPreview.deniedReasons,
        ...(resolved.capabilitySummary.bootstrapRequiredCapabilities.length > 0
          ? {
              bootstrapContinuationMode: resolved.capabilitySummary.bootstrapResolutions.some(
                (resolution) => Boolean(resolution.request?.executionContext),
              )
                ? "frozen"
                : "fallback",
            }
          : {}),
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
          supported: true,
          mode: override.mode,
          ...(override.baseProfileId ? { baseProfileId: override.baseProfileId } : {}),
          ...(override.sessionProfileId ? { sessionProfileId: override.sessionProfileId } : {}),
          note:
            override.mode === "auto"
              ? "Automatic specialist selection stays policy-safe and can still react to task signals."
              : undefined,
        },
      }),
    );
  };
}
