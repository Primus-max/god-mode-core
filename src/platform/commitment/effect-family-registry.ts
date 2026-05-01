import type { EffectFamilyId } from "./ids.js";
import type { OperationHint } from "./semantic-intent.js";

export type OperationHintKind = OperationHint["kind"];

export type EffectFamilyDefinition = {
  readonly id: EffectFamilyId;
  readonly displayName: string;
  readonly allowedOperationKinds: readonly OperationHintKind[];
};

export const PERSISTENT_SESSION_EFFECT_FAMILY = "persistent_session" as EffectFamilyId;
export const COMMUNICATION_EFFECT_FAMILY = "communication" as EffectFamilyId;
export const UNKNOWN_EFFECT_FAMILY = "unknown" as EffectFamilyId;

export const EFFECT_FAMILY_REGISTRY = Object.freeze([
  Object.freeze({
    id: PERSISTENT_SESSION_EFFECT_FAMILY,
    displayName: "Persistent session",
    allowedOperationKinds: Object.freeze(["create", "observe", "cancel"] satisfies OperationHintKind[]),
  }),
  Object.freeze({
    id: COMMUNICATION_EFFECT_FAMILY,
    displayName: "Communication",
    allowedOperationKinds: Object.freeze(["create", "observe"] satisfies OperationHintKind[]),
  }),
  Object.freeze({
    id: UNKNOWN_EFFECT_FAMILY,
    displayName: "Unknown intent",
    allowedOperationKinds: Object.freeze([] satisfies OperationHintKind[]),
  }),
] satisfies EffectFamilyDefinition[]);

const definitionsById = new Map<string, EffectFamilyDefinition>(
  EFFECT_FAMILY_REGISTRY.map((definition) => [definition.id, definition]),
);

/**
 * Checks whether a raw string belongs to the closed PR-2 effect-family registry.
 *
 * @param value - Raw candidate returned by an adapter or fixture.
 * @returns True when the candidate is a registered `EffectFamilyId`.
 */
export function isKnownEffectFamilyId(value: string): value is EffectFamilyId {
  return definitionsById.has(value);
}

/**
 * Resolves a raw family id to the branded registry value, falling back to
 * `unknown` instead of constructing an unregistered brand.
 *
 * @param value - Raw candidate returned by an adapter or fixture.
 * @returns A registered `EffectFamilyId`, or `unknown` for out-of-registry values.
 */
export function resolveEffectFamilyId(value: string): EffectFamilyId {
  return isKnownEffectFamilyId(value) ? value : UNKNOWN_EFFECT_FAMILY;
}

/**
 * Reads metadata for a registered effect family.
 *
 * @param familyId - Branded effect-family id.
 * @returns Registry definition when present; otherwise `undefined`.
 */
export function getEffectFamilyDefinition(
  familyId: EffectFamilyId,
): EffectFamilyDefinition | undefined {
  return definitionsById.get(familyId);
}

/**
 * Lists registered effect-family ids for structured-output schema prompts.
 *
 * @returns Closed PR-2 list of known effect-family ids.
 */
export function listEffectFamilyIds(): readonly EffectFamilyId[] {
  return EFFECT_FAMILY_REGISTRY.map((definition) => definition.id);
}
