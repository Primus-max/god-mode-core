// NEW-A Phase 2 — types + derivation helper for modality-aware routing.
// NEW-A Phase 3 — `modelCoversModalityRequirement` capability check helper.
// NEW-A Phase 4 — `filterCandidatesByModality` survivor-set filter with
// fail-open invariant.
// Lives under `src/agents/` (orchestration layer) per master invariant #11 — frozen
// `src/platform/commitment/` is NOT touched. The local `InboundMediaSummaryLike` is
// a structural duck-type, NOT an import from `src/platform/commitment/` (defense-in-depth
// for invariant #8).
//
// Sub-plan: .cursor/plans/commitment_kernel_modality_aware_routing.plan.md (todos
// `ma-phase-2-types-and-derivation`, `ma-phase-3-model-registry-surface-confirmation`,
// `ma-phase-4-candidate-filter`).
// Audit anchor: extensions/AUDIT-modality-aware-routing.md §c, §e, §f, §i (fail-open).

import type { ModelCatalogEntry } from "./model-catalog.js";
import type { ModelCandidate } from "./model-fallback.types.js";
import { modelKey } from "./model-selection.js";

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

/**
 * NEW-A Phase 3 — capability-driven check (NOT provider-name aware).
 *
 * Returns true if the model entry's declared `input` modality list covers the
 * given `requirement`. Driven SOLELY by `ModelCatalogEntry.input` (audit §c) —
 * never branches on `entry.provider` / `entry.id` / `entry.name`. This keeps
 * the slice provider-agnostic per master §0.5.6 NEW-A directive ("per-provider
 * blocklists are EXPLICITLY forbidden").
 *
 * Conservative defaults:
 * - `entry.input === undefined` → treated as `['text']`-only. Many local
 *   providers omit the field; we MUST NOT assume image-capability silently.
 * - `'audio'` / `'video'` requirement → returns `false` against ANY current
 *   catalog entry. The current `ModelInputType` union (`'text' | 'image' |
 *   'document'`) does NOT declare `'audio'` / `'video'`. The reverse-test in
 *   `*.test.ts` is the canary that flags the day a future slice widens
 *   `ModelInputType` and forgets to update this helper. Fail-closed posture.
 *
 * Mapping rules:
 * - `'text'` → always `true` (no model is text-blind; defensive against an
 *   entry mis-omitting `'text'` from a populated `input` list).
 * - `'image'` → `(entry.input ?? ['text']).includes('image')`.
 * - `'audio'` → `false` (typed-but-inert).
 * - `'video'` → `false` (typed-but-inert).
 */
export function modelCoversModalityRequirement(
  entry: ModelCatalogEntry,
  requirement: ModalityRequirement,
): boolean {
  if (requirement === "text") {
    // Every model accepts text. Conservative even if `entry.input` declares no
    // `'text'` member explicitly (e.g. `input: ['image']` — implausible but
    // structurally permitted by `ModelInputType[]`).
    return true;
  }
  if (requirement === "image") {
    const declared = entry.input ?? (["text"] as const);
    return declared.includes("image");
  }
  // 'audio' | 'video' — typed-but-inert. No `ModelInputType` member maps.
  // Fails-closed; reverse-tested.
  return false;
}

// ---------------------------------------------------------------------------
// NEW-A Phase 4 — `filterCandidatesByModality` survivor-set filter.
// ---------------------------------------------------------------------------

/**
 * Per-candidate drop record — enumerates which `ModalityRequirement` values
 * the candidate's catalog entry FAILED to cover. Surfaced for both real drops
 * AND fail-open survivors (telemetry stays accurate even when filtering is
 * suppressed by the survivor-set non-empty invariant).
 */
export type FilterCandidatesByModalityDropped = {
  readonly candidate: ModelCandidate;
  readonly missingModalities: readonly ModalityRequirement[];
};

/**
 * Result shape for `filterCandidatesByModality`. `failedOpen === true` means
 * filtering would have produced ZERO survivors against a non-empty input —
 * the unfiltered candidates were restored, but `dropped` still records every
 * incompatibility for observability (Phase 5 wiring will emit a
 * `modality_filter fail_open` log line).
 */
export type FilterCandidatesByModalityResult = {
  readonly filtered: readonly ModelCandidate[];
  readonly dropped: readonly FilterCandidatesByModalityDropped[];
  readonly failedOpen: boolean;
};

/**
 * Pure capability-driven filter. Does NOT branch on provider/id — only on
 * catalog-declared `ModelInputType[]` capabilities (per master §0.5.6 NEW-A
 * "per-provider blocklists are EXPLICITLY forbidden").
 *
 * Behaviour rules (sub-plan §Phase 4 / audit §i):
 * 1. Empty `requirements` → structural identity: `{ filtered: candidates,
 *    dropped: [], failedOpen: false }`. No filtering performed.
 * 2. Empty `candidates` → empty result. No filtering performed.
 * 3. Per-candidate, the catalog is consulted by `modelKey(provider, model)`
 *    case-INSENSITIVE lookup. Catalogs in the wild use mixed casing
 *    (`Hydra/Claude-Opus-4.6` vs `hydra/claude-opus-4.6`); we normalise
 *    aggressively rather than lose a match.
 * 4. Catalog miss → KEEP candidate (conservative — unknown !== incompatible).
 *    No drop record emitted.
 * 5. Catalog hit + ALL requirements covered (Phase 3 helper) → KEEP.
 * 6. Catalog hit + SOME requirement uncovered → DROP, with the missing
 *    requirements enumerated.
 * 7. **Survivor-set non-empty invariant (CRITICAL — slice-implementer MUST
 *    NOT remove)**: if rule (6) would empty the survivor set against a
 *    non-empty input, return the UNFILTERED `candidates` and set
 *    `failedOpen: true`. The `dropped` list is still populated so the Phase
 *    5 log line surfaces every incompatibility — observability is preserved
 *    even though routing carries on. Rationale: silently routing to zero
 *    candidates would surface as `lastError: "no candidates"` downstream
 *    (audit §i) which is strictly worse than letting the incompatible
 *    candidate try and fail loudly.
 *
 * Returned arrays are NOT frozen — caller in Phase 5 may concat / reorder.
 */
export function filterCandidatesByModality(params: {
  readonly candidates: readonly ModelCandidate[];
  readonly requirements: readonly ModalityRequirement[];
  readonly catalog: readonly ModelCatalogEntry[];
}): FilterCandidatesByModalityResult {
  const { candidates, requirements, catalog } = params;

  // Rule (1) — structural identity for zero-requirement turns. The Phase 5
  // wiring emits no log line in this branch (deriveTurnModalityRequirements
  // always returns at least `['text']`, so this branch is mostly defensive
  // for direct callers passing `[]`).
  if (requirements.length === 0) {
    return { filtered: candidates, dropped: [], failedOpen: false };
  }

  // Rule (2) — empty input.
  if (candidates.length === 0) {
    return { filtered: [], dropped: [], failedOpen: false };
  }

  // Rule (3) — case-insensitive catalog index. `modelKey()` canonicalises the
  // `provider/model` form but does NOT lowercase the result; we lowercase the
  // key on insert AND lookup to absorb upstream casing drift.
  const catalogIndex = new Map<string, ModelCatalogEntry>();
  for (const entry of catalog) {
    const key = modelKey(entry.provider, entry.id).toLowerCase();
    // First write wins — duplicate-id catalogs are upstream's bug; do not
    // mask by overwriting silently here.
    if (!catalogIndex.has(key)) {
      catalogIndex.set(key, entry);
    }
  }

  const filtered: ModelCandidate[] = [];
  const dropped: FilterCandidatesByModalityDropped[] = [];

  for (const candidate of candidates) {
    const key = modelKey(candidate.provider, candidate.model).toLowerCase();
    const entry = catalogIndex.get(key);
    if (entry === undefined) {
      // Rule (4) — unknown candidate retained.
      filtered.push(candidate);
      continue;
    }
    const missing: ModalityRequirement[] = [];
    for (const requirement of requirements) {
      if (!modelCoversModalityRequirement(entry, requirement)) {
        missing.push(requirement);
      }
    }
    if (missing.length === 0) {
      // Rule (5) — fully covered.
      filtered.push(candidate);
    } else {
      // Rule (6) — incompatible; record drop.
      dropped.push({ candidate, missingModalities: missing });
    }
  }

  // Rule (7) — fail-open. `candidates.length > 0` is implied by rule (2)
  // having short-circuited the empty-input case earlier.
  if (filtered.length === 0) {
    return {
      filtered: candidates,
      dropped,
      failedOpen: true,
    };
  }

  return { filtered, dropped, failedOpen: false };
}
