import { z } from "zod";

import { asIdentityId, isIdentityId, type IdentityId } from "../identity/identity-id.js";

import {
  asMemoryEntryId,
  isMemoryEntryId,
  type MemoryEntryId,
} from "./memory-entry-id.js";

/**
 * Free-form metadata associated with a semantic memory entry. The
 * value space is restricted to JSON-stringifiable scalars because the
 * persistent backend (sqlite-vec, Phase 3) round-trips metadata
 * through a `metadata_json` text column. Arrays and nested objects are
 * intentionally NOT supported in Phase 1 — slices that need richer
 * shapes should serialise their own structure into a string field.
 */
export type SemanticMemoryMetadata = {
  readonly [key: string]: string | number | boolean | null;
};

/**
 * Input shape for `MemoryStore.storeSemantic`. Caller supplies only
 * what is intrinsic to the memory entry (`identityId`, `content`,
 * optional `metadata`); the store assigns the `MemoryEntryId` and any
 * embedding it computes.
 *
 * `content` is the plain-text fact / observation to be stored. Per
 * invariant #5/#6, the caller of `storeSemantic` must be a sanctioned
 * structured-text producer — typically the contractor (slice E
 * Phase 6) or a future LLM-extraction layer (slice E Phase 4) — NOT a
 * raw-input parser.
 */
export type SemanticMemoryWrite = {
  readonly identityId: IdentityId;
  readonly content: string;
  readonly metadata?: SemanticMemoryMetadata;
};

/**
 * Input shape for `MemoryStore.recall`. Fully structured — never a
 * raw user turn. The query is keyed on `identityId` (the operator
 * whose memory is being searched) and carries a `query` string that
 * the store may use for vector / lexical similarity. `limit` caps the
 * number of returned entries; the store is free to return fewer.
 */
export type SemanticMemoryQuery = {
  readonly identityId: IdentityId;
  readonly query: string;
  readonly limit?: number;
};

/**
 * One entry returned by `MemoryStore.recall`. The `score` is
 * implementation-defined but normalised so callers can sort results
 * (higher = more relevant). The Phase 2 in-memory impl uses a simple
 * substring-presence score; the Phase 3 sqlite-vec impl uses cosine
 * similarity over the embedding column.
 */
export type SemanticMemoryEntry = {
  readonly id: MemoryEntryId;
  readonly identityId: IdentityId;
  readonly content: string;
  readonly metadata: SemanticMemoryMetadata;
  readonly score: number;
};

/**
 * Result shape for `MemoryStore.recall`. The `entries` field is
 * always an array — never `undefined` — so callers don't have to
 * guard for null. An empty array means "no recall hits" (NOT an
 * error); per invariant #5/#6 + acceptance criterion #6, downstream
 * sites MUST treat empty as no-op (skip the `<memory>` block) rather
 * than emit whitespace.
 */
export type MemoryRecallResult = {
  readonly entries: readonly SemanticMemoryEntry[];
};

const NonEmptyString = z.string().min(1);

const IdentityIdSchema = z
  .string()
  .refine(isIdentityId, {
    message: "expected an IdentityId of the form `identity:<slug>`",
  })
  .transform((value) => asIdentityId(value));

const MemoryEntryIdSchema = z
  .string()
  .refine(isMemoryEntryId, {
    message: "expected a MemoryEntryId of the form `mem:<slug>`",
  })
  .transform((value) => asMemoryEntryId(value));

/**
 * Zod schema for `SemanticMemoryMetadata`. Restricts values to JSON
 * scalars (string | number | boolean | null) to match the persistent
 * backend's `metadata_json` column shape. Arrays and nested objects
 * are rejected at decode time so a buggy caller can't silently store
 * something the store can't round-trip.
 */
export const SemanticMemoryMetadataSchema: z.ZodType<SemanticMemoryMetadata> =
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

/**
 * Each exported schema is annotated as `z.ZodType<T>` to prevent
 * TS4023 — without the annotation the emitted `.d.ts` tries to inline
 * private brand symbols (`IdentityIdBrand`, `MemoryEntryIdBrand`)
 * that are not exported from their owning modules.
 */
export const SemanticMemoryWriteSchema: z.ZodType<SemanticMemoryWrite> = z.object({
  identityId: IdentityIdSchema,
  content: NonEmptyString,
  metadata: SemanticMemoryMetadataSchema.optional(),
});

export const SemanticMemoryQuerySchema: z.ZodType<SemanticMemoryQuery> = z.object({
  identityId: IdentityIdSchema,
  query: NonEmptyString,
  limit: z.number().int().positive().optional(),
});

export const SemanticMemoryEntrySchema: z.ZodType<SemanticMemoryEntry> = z.object({
  id: MemoryEntryIdSchema,
  identityId: IdentityIdSchema,
  content: NonEmptyString,
  metadata: SemanticMemoryMetadataSchema,
  score: z.number().finite(),
});

export const MemoryRecallResultSchema: z.ZodType<MemoryRecallResult> = z.object({
  entries: z.array(SemanticMemoryEntrySchema).readonly(),
});
