import { z } from "zod";

/**
 * Slice E Phase 4 — frozen LLM-extraction prompt + structured-output
 * schema for the in-house extractor (Path B).
 *
 * Path A (mem0 wrapper) was rejected at the decision gate because the
 * `mem0ai` Node SDK is alpha-quality and the wrapper-pattern audit
 * (sub-plan §2.2) explicitly authorised the in-house fallback under
 * those conditions. Surfaced as a §6 amendment proposal in the slice
 * sub-plan handoff log.
 *
 * The prompt is a SINGLE LLM CALL per write, deliberately
 * stateless / orchestration-free. The model is asked to emit a JSON
 * object with three fields:
 * - `keep`     — boolean. When false, the caller MUST NOT persist the
 *                content. This is the noise-filter the extraction
 *                layer exists to provide.
 * - `normalized` — the same fact rewritten as a concise, third-person,
 *                  context-free statement suitable for later recall.
 *                  Must be non-empty when `keep:true`.
 * - `tags`     — short topical tags (string[]). Persisted as a CSV
 *                string under `metadata.extractor_tags` because the
 *                Phase-1 `SemanticMemoryMetadata` schema forbids
 *                non-scalar values (no arrays / nested objects).
 *
 * Per invariant #5/#6: the extractor reads ONLY the structured
 * `content: string` field of `SemanticMemoryWrite`. That string is
 * already an abstraction from `RawUserTurn`/`UserPrompt` — produced by
 * the contractor (Phase 6) or by the commitment-runtime hook (Phase 5).
 * The extractor does NOT read raw user input.
 */
export const LLM_EXTRACTOR_PROMPT = [
  "You filter and normalize candidate memory entries for an operator.",
  "",
  "For each candidate `content`, decide:",
  "1. `keep` (boolean): true if the content is a durable, recall-worthy",
  '   fact about the operator (preference, identity, ongoing context,',
  "   plan, decision); false if it is noise (filler, acknowledgements,",
  "   one-off chatter, transient state).",
  "2. `normalized` (string, non-empty when keep=true): the same fact",
  "   rewritten as a concise, third-person, context-free statement",
  "   suitable for later semantic recall.",
  "3. `tags` (string[]): a short list of topical tags (e.g.",
  '   "preference", "schedule", "identity"). Empty array is allowed.',
  "",
  "Respond with a single JSON object: { keep, normalized, tags }.",
  "Do not wrap the JSON in prose, code fences, or commentary.",
].join("\n");

/**
 * Strict schema for the structured-output decision. The discriminated
 * union enforces that `normalized` is non-empty when `keep:true` (an
 * empty normalized would be a model-side bug — there is nothing to
 * persist), but allows any string (including the original input) when
 * `keep:false`.
 *
 * Tags are validated as `string[]`; each entry is non-empty so the CSV
 * encoding in `metadata.extractor_tags` does not produce empty slots.
 */
export const LlmExtractorDecisionSchema: z.ZodType<LlmExtractorDecisionInput> =
  z.discriminatedUnion("keep", [
    z.object({
      keep: z.literal(true),
      normalized: z.string().min(1, {
        message: "normalized must be non-empty when keep:true",
      }),
      tags: z.array(z.string().min(1)),
    }),
    z.object({
      keep: z.literal(false),
      normalized: z.string(),
      tags: z.array(z.string().min(1)),
    }),
  ]);

/**
 * Input shape (pre-parse) for the decision schema. The runtime type
 * exported by the `llm-extractor-store.ts` module (`LlmExtractorDecision`)
 * is structurally identical; this type exists so the schema annotation
 * does not depend on the cross-module re-export.
 */
type LlmExtractorDecisionInput =
  | { readonly keep: true; readonly normalized: string; readonly tags: readonly string[] }
  | { readonly keep: false; readonly normalized: string; readonly tags: readonly string[] };

/**
 * Code-fence stripper. Some LLM providers wrap structured output in a
 * ```json ... ``` block even when asked not to; treat that as benign
 * and recover the inner JSON. NOT a parser — just a pre-trim — so a
 * malformed fence (no closing block) falls through to `JSON.parse`,
 * which then surfaces a clear error.
 */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  // Strip the opening fence (```json\n or ```\n) and the closing ```.
  const firstLineEnd = trimmed.indexOf("\n");
  if (firstLineEnd < 0) {
    return trimmed;
  }
  const body = trimmed.slice(firstLineEnd + 1);
  const closingIdx = body.lastIndexOf("```");
  if (closingIdx < 0) {
    return body.trim();
  }
  return body.slice(0, closingIdx).trim();
}

/**
 * Parse a raw string from an LLM into a validated decision. Strips a
 * surrounding ```json``` fence if present, then `JSON.parse` + Zod
 * validation. Throws on malformed JSON or schema violation — callers
 * are expected to surface the rejection as an extractor error and the
 * Phase-4 store falls back to passthrough write per invariant #15.
 */
export function parseLlmExtractorDecision(raw: string): LlmExtractorDecisionInput {
  const stripped = stripCodeFence(raw);
  const parsedJson: unknown = JSON.parse(stripped);
  return LlmExtractorDecisionSchema.parse(parsedJson);
}
