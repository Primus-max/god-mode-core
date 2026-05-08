// V1-CLOSE T6 — schema for the in-repo canonical model defaults file
// (`config/models.default.json`). Charter row §4 T6.
//
// This is NOT the user's `~/.openclaw/agents/main/agent/models.json` (that file
// follows the broader `ModelDefinitionSchema` / `ModelProviderSchema` shape in
// `zod-schema.core.ts`). The repo defaults are intentionally narrower: they
// only declare modality capabilities for the canonical v1 fleet so that the
// loader can fill `input` / `output` gaps on resolved provider model entries
// without inventing a new field that downstream tooling would have to learn.
//
// Stricter than `ModelDefinitionSchema` on purpose:
// - `input` / `output` are REQUIRED (per charter "no defaulting unknown
//   modalities to permissive — reject unknown").
// - `output` enum is restricted to the v1 fleet's known output kinds (`text`,
//   `image`). Adding a new kind requires touching this schema deliberately.
// - Unknown top-level keys are rejected; the only allowed extra key is
//   `$comment`, the conventional JSON-comment placeholder used in the default
//   file (see `config/models.default.json`).
//
// Per AGENTS.md "Tests must catch real bugs": the companion test
// `models.config.test.ts` feeds malformed JSON literals at this schema and
// asserts rejection, NOT a mocked validator return value.

import { z } from "zod";

/**
 * Modality value the canonical-default fleet may declare on `input`. Mirrors
 * the closed `ModelInputType` union in `src/agents/model-catalog.ts` minus
 * `'document'` — none of the v1 fleet entries declare native document input
 * so admitting it here would expand the unaudited surface (per charter §3.3
 * "no refactors outside T1–T7").
 */
const CanonicalInputModalitySchema = z.union([z.literal("text"), z.literal("image")]);

/**
 * Modality value the canonical-default fleet may declare on `output`. The
 * v1 fleet is text-only on the output side; `'image'` is reserved for a
 * future generation-effect model (none of the 7 canonical entries today).
 */
const CanonicalOutputModalitySchema = z.union([z.literal("text"), z.literal("image")]);

const NonEmptyModelId = z
  .string()
  .min(1, "models[].id must be a non-empty string")
  .refine(
    (value) => value.trim() === value,
    "models[].id must not have leading/trailing whitespace",
  );

export const CanonicalModelDefaultSchema = z
  .object({
    id: NonEmptyModelId,
    input: z
      .array(CanonicalInputModalitySchema)
      .min(1, "models[].input must declare at least one modality")
      .refine(
        (value) => new Set(value).size === value.length,
        "models[].input must not contain duplicates",
      ),
    output: z
      .array(CanonicalOutputModalitySchema)
      .min(1, "models[].output must declare at least one modality")
      .refine(
        (value) => new Set(value).size === value.length,
        "models[].output must not contain duplicates",
      ),
  })
  .strict();

export const CanonicalModelDefaultsFileSchema = z
  .object({
    // Optional `$comment` is the standard JSON-comment escape hatch we use in
    // the default file to document provenance (pi-ai upstream id, etc.). It
    // is intentionally string-only and ignored at runtime.
    $comment: z.string().optional(),
    models: z
      .array(CanonicalModelDefaultSchema)
      .min(1, "models[] must declare at least one canonical entry"),
  })
  .strict();

export type CanonicalModelDefault = z.infer<typeof CanonicalModelDefaultSchema>;
export type CanonicalModelDefaultsFile = z.infer<typeof CanonicalModelDefaultsFileSchema>;

/**
 * Strict parse — throws `ZodError` with field-level paths on any malformed
 * input. Callers pass parsed JSON; this function does NOT itself read files.
 * (Keeping I/O out of the schema layer simplifies the boot-time loader path
 * in `src/agents/models-config.canonical-modalities.ts`.)
 */
export function parseCanonicalModelDefaults(input: unknown): CanonicalModelDefaultsFile {
  return CanonicalModelDefaultsFileSchema.parse(input);
}

/**
 * In-repo canonical defaults for the v1 fleet. Mirrored verbatim from
 * `config/models.default.json` — the JSON file is the human-reviewable source
 * of truth, and `models.config.test.ts` runs a guardrail assertion that the
 * two stay byte-equal. Embedding here lets the boot path apply the defaults
 * without fs I/O or build-step coupling on the JSON copy step.
 *
 * If you change one, change the other. If the guardrail test fails, do NOT
 * silently update either side — re-run the audit (charter §4 T6 row, pi-ai
 * upstream catalog `node_modules/@mariozechner/pi-ai/dist/models.generated.js`)
 * and update both deliberately.
 */
export const CANONICAL_MODEL_DEFAULTS: CanonicalModelDefaultsFile = parseCanonicalModelDefaults({
  models: [
    { id: "gpt-5.4", input: ["text", "image"], output: ["text"] },
    { id: "gpt-4o", input: ["text", "image"], output: ["text"] },
    { id: "gpt-5-mini", input: ["text", "image"], output: ["text"] },
    { id: "gemini-2.5-pro", input: ["text", "image"], output: ["text"] },
    { id: "claude-sonnet-4.6", input: ["text", "image"], output: ["text"] },
    { id: "claude-opus-4.6", input: ["text", "image"], output: ["text"] },
    { id: "grok-4", input: ["text"], output: ["text"] },
  ],
});
