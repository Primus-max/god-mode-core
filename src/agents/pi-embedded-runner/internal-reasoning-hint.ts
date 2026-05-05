import { isExternalDeliverySurface } from "../../infra/outbound/outbound-sanitizer.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";

/**
 * Slice I Phase 4 — advisory `internalReasoningHint` for Anthropic + external
 * delivery channels.
 *
 * Distinct from the STRICT `<think>+<final>` block enforced via
 * `reasoningTagHint` for google/minimax (`isReasoningTagProvider`). This
 * advisory hint asks the model to wrap any English meta-thinking in
 * `<thinking>...</thinking>` blocks so:
 *   - the existing `stripThinkingTagsFromText` helper removes them on the
 *     extraction path (`pi-embedded-utils.ts:280`), AND
 *   - the new Phase 3 `english_meta_*` post-filter family in
 *     `outbound-sanitizer.ts` is the safety net when the model ignores the
 *     hint.
 *
 * It does NOT gate output via a `<final>` requirement — the strict path
 * stays reserved for google/minimax, which truly need it.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_reply_sanitizer.plan.md` §6.4.
 *
 * Hard invariants kept:
 *  - #5/#6 — operates on system-prompt parameters, not on UserPrompt /
 *    RawUserTurn (no string match on raw user text).
 *  - #8 — does not import from `src/platform/commitment/**`.
 *  - #11 — 5 frozen contracts untouched.
 */
export const INTERNAL_REASONING_HINT_TEXT = [
  "If you have any internal reasoning, planning, or English meta-thinking like",
  '"Let me check…" / "I\'ll search…" / "First, I\'ll…", wrap it in',
  "<thinking>...</thinking> blocks. ONLY user-facing reply text in the user's",
  "language goes outside <thinking> blocks. The user will not see anything",
  "inside <thinking>.",
].join("\n");

/**
 * Returns true when the advisory hint should be emitted for this
 * (provider, runtimeChannel) combination.
 *
 * Conditions (BOTH required):
 *  (a) `runtimeChannel` is in `EXTERNAL_DELIVERY_SURFACES` — the channel
 *      strips reasoning at delivery, so the model must not emit it as
 *      plain text.
 *  (b) `isReasoningTagProvider(provider) === false` — google/minimax
 *      already get the stricter `<think>+<final>` block, so the advisory
 *      hint would be redundant for them.
 *
 * Note: `runtimeChannel` of `undefined` or empty-string disables the hint
 * — without channel context we can't be sure delivery will strip
 * reasoning, so we err on the side of NOT instructing the model.
 */
export function isInternalReasoningHintApplicable(
  provider: string | undefined | null,
  runtimeChannel: string | undefined | null,
): boolean {
  if (!runtimeChannel) {
    return false;
  }
  if (!isExternalDeliverySurface(runtimeChannel)) {
    return false;
  }
  if (isReasoningTagProvider(provider)) {
    return false;
  }
  return true;
}
