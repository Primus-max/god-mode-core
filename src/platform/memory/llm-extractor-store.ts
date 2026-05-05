import { randomUUID } from "node:crypto";

import {
  type EpisodicMemoryEvent,
} from "./episodic-memory-event.js";
import { asMemoryEntryId, type MemoryEntryId } from "./memory-entry-id.js";
import type {
  EpisodicMemoryListing,
  MemoryListQuery,
  MemoryListResult,
  MemoryStore,
} from "./memory-store.js";
import {
  SemanticMemoryWriteSchema,
  type MemoryRecallResult,
  type SemanticMemoryEntry,
  type SemanticMemoryMetadata,
  type SemanticMemoryQuery,
  type SemanticMemoryWrite,
} from "./semantic-memory.js";

/**
 * Slice E Phase 4 — LLM-extractor-driven memory store. Wraps a
 * delegate `MemoryStore` (typically `SqliteVecMemoryStore` in
 * production; `InMemoryMemoryStore` in tests) and adds a single LLM
 * call on the SEMANTIC write path that decides:
 *
 * - whether the candidate content is recall-worthy (`keep`);
 * - what the normalized form to actually persist looks like;
 * - which tags to attach to the metadata for downstream filtering.
 *
 * Path B (in-house extractor) was chosen over Path A (mem0 wrapper)
 * at the decision gate because the `mem0ai` Node SDK is alpha-quality
 * (sub-plan §2.2) and a wrapper-pattern adapter would carry more risk
 * than a 150-LOC single-LLM-call surface that the rest of the slice
 * already needs.
 *
 * Per slice-E invariants this module honours:
 * - **#5/#6** — the extractor reads ONLY the structured `content:
 *   string` field of `SemanticMemoryWrite` (already abstracted from
 *   raw user text per Phase-1 design). It does NOT receive
 *   `RawUserTurn` / `UserPrompt` and does NOT do regex/text-rule
 *   matching against operator-side raw input.
 * - **#8** — does NOT import from `src/platform/decision/` or any
 *   commitment-layer module. Imports stay inside `src/platform/memory/`,
 *   `node:crypto`, and Zod (transitively via the prompt module).
 * - **#11** — `MemoryEntryId` brand preserved; the kept entry's id is
 *   minted by the underlying delegate, the dropped entry's id is a
 *   sentinel `mem:dropped-<uuid>` so callers have a stable
 *   observability handle without a persisted row.
 * - **#15** — extraction is OBSERVABILITY, not gating: an extractor
 *   crash degrades to a passthrough write + warning, the underlying
 *   store stays callable. The injection seam (`delegate`) keeps the
 *   wrapper non-load-bearing.
 *
 * Pluggability: implements the Phase-1 `MemoryStore` interface, so
 * callers swap `Mem0MemoryStore` / `SqliteVecMemoryStore` /
 * `InMemoryMemoryStore` / `LlmExtractorMemoryStore` at construction
 * with no callsite change.
 */

/**
 * Input passed to the `LlmExtractor`. Mirrors what gets persisted in a
 * `SemanticMemoryWrite` minus the `identityId` brand — the extractor
 * does NOT need to know whose memory it is filtering, and per
 * invariant #5/#6 we don't pass the brand through to a
 * provider-controlled string anyway.
 */
export type LlmExtractorInput = {
  readonly content: string;
  readonly metadata?: SemanticMemoryMetadata;
};

/**
 * Decision returned by the extractor. Discriminated on `keep`:
 * - `keep:true`  → persist `normalized` (non-empty) with `tags`
 *   merged into metadata as `extractor_tags`;
 * - `keep:false` → drop the entry (no row created); the wrapper
 *   surfaces a sentinel `mem:dropped-<uuid>` id for observability.
 */
export type LlmExtractorDecision =
  | {
      readonly keep: true;
      readonly normalized: string;
      readonly tags: readonly string[];
    }
  | {
      readonly keep: false;
      readonly normalized: string;
      readonly tags: readonly string[];
    };

/**
 * Injection seam for the LLM call. A test stub returns deterministic
 * decisions keyed off input content; production wires this to the
 * existing memory-config LLM provider (default OpenAI per
 * `src/memory/embeddings*.ts` / sub-plan §6 — concrete provider
 * binding is wired by the slice-E Phase-5 commitment-runtime hook
 * call site, NOT by this module).
 *
 * The contract: `extract` either returns a validated
 * `LlmExtractorDecision` or throws. A throw is treated as an
 * observability event — the wrapper catches it and falls back to a
 * passthrough write with a `extractor_error` warning surfaced via the
 * injected logger.
 */
export type LlmExtractor = {
  extract(input: LlmExtractorInput): Promise<LlmExtractorDecision>;
};

/**
 * Logger seam. Decoupled from the project logger so tests can inject
 * a capturing stub without pulling logging infrastructure in. The
 * Phase-3 `SqliteVecMemoryStoreLogger` shape is intentionally
 * mirrored.
 */
export type LlmExtractorMemoryStoreLogger = {
  warn(message: string): void;
};

/**
 * Construction options. `delegate` and `extractor` are required;
 * `logger` defaults to a no-op so production callers can wire the
 * project logger explicitly.
 */
export type LlmExtractorMemoryStoreOptions = {
  readonly delegate: MemoryStore;
  readonly extractor: LlmExtractor;
  readonly logger?: LlmExtractorMemoryStoreLogger;
};

const NO_OP_LOGGER: LlmExtractorMemoryStoreLogger = {
  warn() {
    /* swallow — production callers should inject a real logger */
  },
};

/**
 * Sentinel-id prefix for entries the extractor decided to drop. Kept
 * separate from the `mem:` prefix so a quick string-prefix check at
 * `forget` time avoids hitting the delegate for a row that was never
 * persisted.
 */
const DROPPED_PREFIX = "mem:dropped-";

/**
 * `LlmExtractorMemoryStore` — the Phase-4 wrapper. Constructor takes
 * `{ delegate, extractor, logger }`. Every method either:
 * - delegates verbatim (`storeEpisodic`, `recall`, `list`, `forget`
 *   on a real id);
 * - or runs the extractor on the SEMANTIC write path and forwards to
 *   the delegate only when `keep:true`.
 *
 * Stateless apart from the dropped-id marker check in `forget`.
 */
export class LlmExtractorMemoryStore implements MemoryStore {
  private readonly delegate: MemoryStore;
  private readonly extractor: LlmExtractor;
  private readonly logger: LlmExtractorMemoryStoreLogger;

  constructor(opts: LlmExtractorMemoryStoreOptions) {
    this.delegate = opts.delegate;
    this.extractor = opts.extractor;
    this.logger = opts.logger ?? NO_OP_LOGGER;
  }

  /**
   * Episodic events are already structured (typed payload, sub-plan
   * §6) and bypass the extractor — there is no semantic content to
   * filter. Direct passthrough to the delegate.
   */
  storeEpisodic(event: EpisodicMemoryEvent): Promise<MemoryEntryId> {
    return this.delegate.storeEpisodic(event);
  }

  /**
   * Semantic write — the extraction surface. Steps:
   * 1. Validate the input via the Phase-1 Zod schema. A malformed
   *    write rejects synchronously BEFORE the LLM call (saves a
   *    pointless API round-trip and keeps the failure mode identical
   *    to the in-memory + sqlite-vec impls).
   * 2. Call the extractor. On crash, fall back to passthrough write
   *    + `extractor_error` warning (invariant #15 — observability,
   *    not gating).
   * 3. On `keep:false`, mint a `mem:dropped-<uuid>` sentinel id and
   *    return without touching the delegate.
   * 4. On `keep:true`, write the normalized content to the delegate
   *    with tags merged into metadata as `extractor_tags`.
   */
  async storeSemantic(write: SemanticMemoryWrite): Promise<MemoryEntryId> {
    // Validate at the boundary — same guard as the in-memory + vec
    // impls. Rejection here precedes the LLM call by design.
    const parsed = SemanticMemoryWriteSchema.parse(write);

    let decision: LlmExtractorDecision;
    try {
      decision = await this.extractor.extract({
        content: parsed.content,
        metadata: parsed.metadata,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `LlmExtractorMemoryStore: extractor_error — falling back to passthrough write: ${message}`,
      );
      // Defense-in-depth: a crashing extractor MUST NOT lose the
      // candidate write. Persist verbatim with no extractor tags.
      return this.delegate.storeSemantic({
        identityId: parsed.identityId,
        content: parsed.content,
        metadata: parsed.metadata,
      });
    }

    if (!decision.keep) {
      // No row in the delegate — observability handle only. The id is
      // brand-validated through `asMemoryEntryId` so callers can pass
      // it back to `forget` without a runtime error.
      return mintDroppedId();
    }

    const mergedMetadata = mergeMetadata(parsed.metadata, decision.tags);
    return this.delegate.storeSemantic({
      identityId: parsed.identityId,
      content: decision.normalized,
      metadata: mergedMetadata,
    });
  }

  /**
   * Recall delegates verbatim. The wrapper does NOT re-rank or
   * post-filter results — the delegate (sqlite-vec or in-memory) is
   * the sole source of truth for what was persisted.
   */
  recall(query: SemanticMemoryQuery): Promise<MemoryRecallResult> {
    return this.delegate.recall(query);
  }

  /**
   * `list` delegates verbatim. Both arrays mirror the delegate's
   * snapshot — no extractor introspection at read time.
   */
  list(query: MemoryListQuery): Promise<MemoryListResult> {
    return this.delegate.list(query);
  }

  /**
   * `forget` short-circuits on a sentinel `mem:dropped-...` id (no
   * delegate row exists) and otherwise delegates verbatim. Idempotent
   * per Phase-1 contract.
   */
  forget(id: MemoryEntryId): Promise<void> {
    if (id.startsWith(DROPPED_PREFIX)) {
      // Nothing was persisted — silent no-op, same shape as
      // `InMemoryMemoryStore.forget` on an unknown id.
      return Promise.resolve();
    }
    return this.delegate.forget(id);
  }
}

/**
 * Mint a sentinel id for a dropped (extractor `keep:false`) entry.
 * Format `mem:dropped-<uuid>` — a real `MemoryEntryId` (passes the
 * brand validator's `mem:` prefix + slug rule) so callers can roundtrip
 * it through the typed surface.
 */
function mintDroppedId(): MemoryEntryId {
  return asMemoryEntryId(`${DROPPED_PREFIX}${randomUUID()}`);
}

/**
 * Merge extractor `tags` into the original metadata under the
 * `extractor_tags` key. The Phase-1 `SemanticMemoryMetadata` schema
 * forbids non-scalar values (no arrays, no nested objects) so we
 * encode the tag list as a CSV string. Empty tag list → no key added,
 * keeping the metadata shape minimal for downstream readers.
 *
 * Existing metadata keys are preserved verbatim; the extractor tags
 * never overwrite caller-supplied keys (the wrapper's contract is
 * additive).
 */
function mergeMetadata(
  base: SemanticMemoryMetadata | undefined,
  tags: readonly string[],
): SemanticMemoryMetadata | undefined {
  if (tags.length === 0) {
    return base;
  }
  const csv = tags.join(",");
  return {
    ...(base ?? {}),
    extractor_tags: csv,
  };
}

/**
 * Re-export for downstream slices that want to read a stored entry's
 * tags without re-importing the schema. Lives next to the merge fn
 * so the encoding contract is in one place.
 */
export const EXTRACTOR_TAGS_METADATA_KEY = "extractor_tags";

// Type re-exports kept beside the impl so a single import covers the
// public surface of this module.
export type { EpisodicMemoryListing };
