// NEW-A Phase 2 — types + derivation helper for modality-aware routing.
// Lives under `src/agents/` (orchestration layer) per master invariant #11 — frozen
// `src/platform/commitment/` is NOT touched. The local `InboundMediaSummaryLike` is
// a structural duck-type, NOT an import from `src/platform/commitment/` (defense-in-depth
// for invariant #8).
//
// Sub-plan: .cursor/plans/commitment_kernel_modality_aware_routing.plan.md (todo
// `ma-phase-2-types-and-derivation`).
// Audit anchor: extensions/AUDIT-modality-aware-routing.md §c, §e, §f.

/**
 * Closed union of modality requirements a turn may impose on the candidate
 * model set. `'audio'` and `'video'` are typed-but-inert in this slice —
 * no derivation path produces them yet (see reverse-test in `*.test.ts`).
 * They will be wired when corresponding inbound `InboundMediaAttachmentKind`
 * values land in a follow-up sub-plan.
 */
export type ModalityRequirement = "text" | "image" | "audio" | "video";

/**
 * Structural duck-type mirroring the closed `InboundMediaSummary` shape from
 * `src/platform/commitment/intent-contractor-impl.ts` (Cutover-3 P6). Declared
 * locally so this module does NOT import from `src/platform/commitment/`
 * (invariant #8 defense-in-depth). Byte-compatible with the frozen-layer type.
 */
type InboundMediaAttachmentLike = {
  readonly kind: "image" | "pdf" | "docx" | "other";
  readonly path?: string;
};

type InboundMediaSummaryLike = {
  readonly attachments: readonly InboundMediaAttachmentLike[];
};

/**
 * Derive the set of `ModalityRequirement` values a turn imposes on its
 * candidate model selection. Pure structural reads — never `RawUserTurn` /
 * `UserPrompt` (invariant #5).
 *
 * Mapping rules (per sub-plan §2.3 / audit §f Phase 2 derivation rules):
 * - `'text'` is ALWAYS in the requirement set (no model is text-blind).
 * - `attachment.kind === 'image'` → adds `'image'`.
 * - `attachment.kind ∈ {'pdf','docx','other'}` → does NOT add `'image'`
 *   (document-mode handled by `'text'` + downstream document tooling).
 * - `desiredEffectFamily.startsWith('image_generation')` → adds `'image'` ONLY
 *   IF the turn ALSO references an inbound image (img2img path). Pure
 *   text-to-image generation is text-only on the planner side — the prompt is
 *   text and image-output is the EFFECT not the model INPUT requirement.
 * - `needsVision === true` → adds `'image'` (defense-in-depth secondary
 *   signal; see audit §e — `RecipeRoutingHints.needsVision` is derived from
 *   filename-extension regex + tools, NOT from `inboundMediaResolver`).
 *
 * Output is a frozen, sorted, deterministic readonly tuple — caller cannot
 * mutate, downstream comparisons are stable.
 */
export function deriveTurnModalityRequirements(input: {
  readonly inboundMediaSummary?: InboundMediaSummaryLike;
  readonly desiredEffectFamily?: string;
  readonly needsVision?: boolean;
}): readonly ModalityRequirement[] {
  const requirements = new Set<ModalityRequirement>();
  // Invariant: every model the system selects must minimally accept text input.
  requirements.add("text");

  const hasInboundImage =
    input.inboundMediaSummary?.attachments.some(
      (attachment) => attachment.kind === "image",
    ) ?? false;

  if (hasInboundImage) {
    requirements.add("image");
  }

  if (
    input.desiredEffectFamily !== undefined &&
    input.desiredEffectFamily.startsWith("image_generation") &&
    hasInboundImage
  ) {
    // img2img path — generation effect that also consumes an inbound image.
    requirements.add("image");
  }

  if (input.needsVision === true) {
    requirements.add("image");
  }

  // Stable sorted output (deterministic for downstream comparison) and frozen
  // so callers cannot mutate the requirement set in-place.
  const sorted = Array.from(requirements).sort();
  return Object.freeze(sorted) as readonly ModalityRequirement[];
}
