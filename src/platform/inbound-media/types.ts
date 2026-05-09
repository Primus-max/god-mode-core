/**
 * S11b prep — inbound-media pure-data type home.
 *
 * Relocated from `src/platform/commitment/intent-contractor-impl.ts`
 * (Cutover-3 Phase 6 origin) to a non-kernel module so V1-CUTOVER S11b
 * can delete `src/platform/commitment/` without dragging type-only
 * importers with it. Mirrors S11a's branded-id relocation pattern
 * (commit `29eac8c5ab`).
 *
 * INVARIANTS (sub-plan §HARD-INVARIANTS):
 *   #2 no kernel revival — these are pure structural data types, no
 *      runtime semantics, no functions live here.
 *   #3 no regex parsing of user input — types describe attachment
 *      metadata only (path / MIME / closed `kind` enum).
 *   #5/#6 the contractor stays the only sanctioned reader of raw user
 *      text; this surface is structural metadata only.
 */

/**
 * Closed-shape attachment kind enumeration. Widening this union
 * requires explicit master-plan amendment so the contractor never
 * grows a textual classification surface.
 */
export type InboundMediaAttachmentKind = "image" | "pdf" | "docx" | "other";

/**
 * Single inbound attachment descriptor. STRUCTURAL metadata only
 * (path + MIME type + closed `kind` enumeration).
 *
 * `sourceTurnId` is optional and propagates the upstream turn id when
 * the producer (gateway / agent-command) tracks it; predicates and
 * downstream observers can JOIN on this id without re-reading the
 * raw text.
 */
export type InboundMediaAttachment = {
  readonly path: string;
  readonly mimeType: string;
  readonly kind: InboundMediaAttachmentKind;
  readonly sourceTurnId?: string;
};

/**
 * Closed-shape summary of inbound media for the current turn. When
 * the producer is absent OR returns `undefined` OR returns an empty
 * `attachments` array, downstream consumers elide their corresponding
 * blocks (zero whitespace pollution).
 */
export type InboundMediaSummary = {
  readonly attachments: readonly InboundMediaAttachment[];
};
