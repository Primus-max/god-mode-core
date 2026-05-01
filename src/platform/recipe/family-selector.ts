import type { CandidateExecutionFamily, OutcomeContract } from "../decision/qualification-contract.js";
import type { ArtifactKind } from "../schemas/index.js";

// Simplicity order: prefer the family with the smallest execution surface and
// clearest evidence contract. Lower index = preferred when multiple families
// are valid for the same input.
export const FAMILY_SIMPLICITY_ORDER: readonly CandidateExecutionFamily[] = [
  "general_assistant",
  "analysis_transform",
  "document_render",
  "media_generation",
  "code_build",
  "ops_execution",
];

// Minimal context needed for family validity and selection.
// Structurally compatible with RecipePlannerInput — planner can pass input directly.
export type FamilySelectionContext = {
  outcomeContract?: OutcomeContract;
  intent?: string;
  artifactKinds?: ArtifactKind[];
};

// Artifact kind helpers — shared between family validation and recipe scoring.
// Kept here so both layers use the same definitions without coupling.

export function hasDocumentArtifact(artifactKinds: ArtifactKind[]): boolean {
  return artifactKinds.some(
    (kind) => kind === "document" || kind === "estimate" || kind === "report" || kind === "data",
  );
}

export function hasCodeArtifact(artifactKinds: ArtifactKind[]): boolean {
  return artifactKinds.some(
    (kind) => kind === "site" || kind === "release" || kind === "binary" || kind === "archive",
  );
}

export function hasMediaArtifact(artifactKinds: ArtifactKind[]): boolean {
  return artifactKinds.some((kind) => kind === "image" || kind === "video" || kind === "audio");
}

export function hasReportOrDataArtifact(artifactKinds: ArtifactKind[]): boolean {
  return artifactKinds.some((kind) => kind === "report" || kind === "data");
}

// Determines whether a given family is valid for the current execution context.
//
// outcomeContract is the primary signal. intent fields are legacy bridges kept for
// backward compatibility with inputs that supply intent without outcomeContract.
export function familyIsValidForInput(
  family: CandidateExecutionFamily,
  ctx: FamilySelectionContext,
): boolean {
  const artifactKinds = ctx.artifactKinds ?? [];
  const hasMedia = hasMediaArtifact(artifactKinds);
  const hasCode = hasCodeArtifact(artifactKinds);
  const hasDocument = hasDocumentArtifact(artifactKinds);
  const hasReportOrData = hasReportOrDataArtifact(artifactKinds);

  switch (family) {
    case "general_assistant":
      return ctx.outcomeContract === "text_response" || ctx.intent === "general";
    case "analysis_transform":
      return (
        ctx.intent === "compare" ||
        ctx.intent === "calculation" ||
        (ctx.outcomeContract === "structured_artifact" &&
          hasReportOrData &&
          !hasDocument &&
          !hasMedia &&
          !hasCode)
      );
    case "document_render":
      return (
        ctx.intent === "document" ||
        (ctx.outcomeContract === "structured_artifact" && !hasMedia && !hasCode)
      );
    case "media_generation":
      return ctx.outcomeContract === "structured_artifact" && hasMedia;
    case "code_build":
      return (
        ctx.outcomeContract === "workspace_change" ||
        ctx.outcomeContract === "interactive_local_result" ||
        ctx.intent === "code"
      );
    case "ops_execution":
      return ctx.outcomeContract === "external_operation" || ctx.intent === "publish";
    default:
      return false;
  }
}

// Derives a broad set of candidate families from an outcome contract.
//
// Used as a contract-first fallback when candidateFamilies are not explicitly
// provided by the qualification layer. Returns families ordered broad-to-specific
// so pickSimplestValidFamily can apply FAMILY_SIMPLICITY_ORDER on top.
export function deriveFamiliesFromOutcomeContract(
  outcomeContract: OutcomeContract,
): CandidateExecutionFamily[] {
  switch (outcomeContract) {
    case "text_response":
      return ["general_assistant", "analysis_transform"];
    case "structured_artifact":
      return ["document_render", "media_generation", "analysis_transform", "code_build"];
    case "workspace_change":
    case "interactive_local_result":
      return ["code_build", "ops_execution"];
    case "external_operation":
      return ["ops_execution", "code_build"];
    default:
      return [];
  }
}

// Picks the simplest valid family from a pre-filtered list.
//
// "availableFamilies" must already be intersected with the recipe pool by the caller
// (only families that have at least one recipe in the candidate set).
// "Valid" is per familyIsValidForInput. "Simplest" follows FAMILY_SIMPLICITY_ORDER.
export function pickSimplestValidFamily(
  availableFamilies: CandidateExecutionFamily[],
  ctx: FamilySelectionContext,
): CandidateExecutionFamily | undefined {
  return availableFamilies
    .filter((family) => familyIsValidForInput(family, ctx))
    .toSorted(
      (left, right) =>
        FAMILY_SIMPLICITY_ORDER.indexOf(left) - FAMILY_SIMPLICITY_ORDER.indexOf(right),
    )[0];
}

// Selects the winning execution family from requested and available families.
//
// requestedFamilies: what qualification layer (or contract derivation) asks for.
// availableFamilies: intersection of requestedFamilies with recipe pool — families
//   that actually have recipes for this profile.
// ctx: used for familyIsValidForInput checks.
//
// Returns undefined when the intersection is empty, allowing the caller to fall
// back to full-pool scoring (legacy path).
export function selectExecutionFamily(
  requestedFamilies: CandidateExecutionFamily[],
  availableFamilies: CandidateExecutionFamily[],
  ctx: FamilySelectionContext,
): CandidateExecutionFamily | undefined {
  if (requestedFamilies.length === 0) return undefined;
  // Only consider families that are both requested AND available in the recipe pool.
  const intersected = requestedFamilies.filter((f) => availableFamilies.includes(f));
  return pickSimplestValidFamily(intersected, ctx);
}
