import type { SessionEntry } from "../../config/sessions.js";
import type { RecipePlannerInput } from "../recipe/planner.js";
import type { SpecialistOverrideMode } from "./contracts.js";

export type ResolvedSessionSpecialistOverride = {
  mode: SpecialistOverrideMode;
  baseProfileId?: SessionEntry["specialistBaseProfileId"];
  sessionProfileId?: SessionEntry["specialistSessionProfileId"];
};

export function resolveSessionSpecialistOverride(
  entry?: Pick<
    SessionEntry,
    "specialistOverrideMode" | "specialistBaseProfileId" | "specialistSessionProfileId"
  > | null,
): ResolvedSessionSpecialistOverride {
  const mode = entry?.specialistOverrideMode ?? "auto";
  if (mode === "base" && entry?.specialistBaseProfileId) {
    return {
      mode,
      baseProfileId: entry.specialistBaseProfileId,
    };
  }
  if (mode === "session" && entry?.specialistSessionProfileId) {
    return {
      mode,
      sessionProfileId: entry.specialistSessionProfileId,
    };
  }
  return { mode: "auto" };
}

export function applySessionSpecialistOverrideToPlannerInput(
  input: RecipePlannerInput,
  entry?: Pick<
    SessionEntry,
    "specialistOverrideMode" | "specialistBaseProfileId" | "specialistSessionProfileId"
  > | null,
): RecipePlannerInput {
  const override = resolveSessionSpecialistOverride(entry);
  if (override.mode === "base" && override.baseProfileId) {
    return {
      ...input,
      baseProfile: override.baseProfileId,
      sessionProfile: undefined,
    };
  }
  if (override.mode === "session" && override.sessionProfileId) {
    return {
      ...input,
      sessionProfile: override.sessionProfileId,
    };
  }
  return input;
}
