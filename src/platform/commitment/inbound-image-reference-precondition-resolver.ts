/**
 * Cutover-3 Phase 6 — `INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION`
 * resolver.
 *
 * Sibling of `affordance-registry.ts` (Phase 4 deliverable). The
 * affordance registry stays BYTE-IDENTICAL — this file is a separate
 * module that exports the resolver function consumed downstream by
 * the artifact runtime adapter (Phase 5 → Phase 6) when the
 * `IMAGE_CREATED_AFFORDANCE_ENTRY` is selected and the precondition
 * resolves with non-empty `paths`. The runtime adapter then injects
 * the paths into `image_generate` tool args (`image: paths[0]` for
 * single ref, `images: paths` for multi-ref) BEFORE the model
 * formulates its call — same structural pre-binding pattern Search-
 * Composer 4b used for `<web_evidence>` block injection.
 *
 * Per invariants #5/#6 the resolver reads STRUCTURED inbound-media
 * metadata only (path + MIME + closed `kind` enumeration). It NEVER
 * reads raw user text — the IntentContractor stays the only sanctioned
 * reader of `RawUserTurn`.
 *
 * Boundary discipline:
 * - Lives INSIDE `src/platform/commitment/` so `affordance-registry.ts`
 *   can reference the resolver type without crossing
 *   `src/platform/decision/` (invariant #8). The resolver function is
 *   a pure data transform (filter `kind === "image"` + collect paths)
 *   so the platform-side boundary holds.
 * - Closed return shape `{ paths: readonly string[] }` (no widening
 *   without master-plan amendment).
 * - Filter is closed-loop on `kind === "image"` only (PDF / DOCX /
 *   other are skipped — they map to non-img2img affordance branches).
 */

import type { InboundMediaSummary } from "./intent-contractor-impl.js";

/**
 * Resolved value of the `INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION`.
 * Surfaces the ordered list of inbound image paths to the runtime
 * adapter so it can pre-bind them onto the `image_generate` tool args.
 *
 * Order matters — the adapter reads `paths[0]` for the single-ref
 * `image:` arg when only one path is present.
 */
export type InboundImageReferencePreconditionValue = {
  readonly paths: readonly string[];
};

/**
 * Pure resolver — given a structural inbound-media summary, returns
 * `{ paths }` when at least one `kind="image"` attachment is present,
 * `null` otherwise.
 *
 * `null` is the sentinel for "no img2img precondition this turn"; the
 * runtime adapter then routes through the from-scratch generation path
 * (no `image:` / `images:` injection) — same `IMAGE_CREATED_AFFORDANCE`
 * entry, two execution branches selected by the resolver's value.
 *
 * @param summary - Structural inbound-media summary (or undefined when
 *   no inbound media surfaced this turn).
 * @returns The closed-shape precondition value, or `null` when no
 *   `kind="image"` attachment is present.
 */
export function resolveInboundImageReferencePrecondition(
  summary: InboundMediaSummary | undefined,
): InboundImageReferencePreconditionValue | null {
  if (!summary || summary.attachments.length === 0) {
    return null;
  }
  const paths: string[] = [];
  for (const attachment of summary.attachments) {
    if (attachment.kind === "image" && attachment.path.length > 0) {
      paths.push(attachment.path);
    }
  }
  if (paths.length === 0) {
    return null;
  }
  return { paths: Object.freeze([...paths]) };
}

/**
 * Factory wrapper — given a callable that produces the inbound-media
 * summary for the current turn (the same upstream source the
 * `inboundMediaResolver` constructor dep on `IntentContractor` reads),
 * returns a callable that yields the precondition value.
 *
 * The factory is what the runtime adapter wires into the affordance-
 * gate evaluation. Production callers thread the same `() =>
 * InboundMediaSummary | undefined` resolver into both the contractor
 * (for the `<inbound_attachments>` block injection) AND this resolver
 * (for the structural precondition value) so both surfaces see the
 * same per-turn data.
 *
 * @param resolver - Source of the structural inbound-media summary
 *   for the current turn.
 * @returns Callable producing the precondition value, or `null` when
 *   no image attachment is present.
 */
export function createInboundImageReferencePreconditionResolver(
  resolver: () => InboundMediaSummary | undefined,
): () => InboundImageReferencePreconditionValue | null {
  return () => resolveInboundImageReferencePrecondition(resolver());
}
