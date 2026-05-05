/**
 * Public surface of the platform memory module — slice E Phase 1.
 *
 * Phase 1 ships ONLY types + Zod schemas + the `MemoryStore`
 * interface. No implementation is exported here yet; Phase 2 will add
 * `InMemoryMemoryStore`, Phase 3 will add `SqliteVecMemoryStore`.
 *
 * Per invariant #8, this module imports ONLY from
 * `src/platform/identity/`, the standard library, and Zod. It does
 * NOT import from `src/platform/decision/` or any decision-layer
 * adapter, and it does NOT touch `src/platform/commitment/` (the
 * frozen 5-contract layer).
 */

export {
  asMemoryEntryId,
  isMemoryEntryId,
  type MemoryEntryId,
} from "./memory-entry-id.js";

export {
  ArtifactCreatedPayloadSchema,
  EpisodicMemoryEventSchema,
  PersistentSessionCreatedPayloadSchema,
  ReminderSetPayloadSchema,
  SubagentCreatedPayloadSchema,
  assertNeverEpisodic,
  type ArtifactCreatedPayload,
  type EpisodicEffectFamily,
  type EpisodicMemoryEvent,
  type PersistentSessionCreatedPayload,
  type ReminderSetPayload,
  type SubagentCreatedPayload,
} from "./episodic-memory-event.js";

export {
  MemoryRecallResultSchema,
  SemanticMemoryEntrySchema,
  SemanticMemoryMetadataSchema,
  SemanticMemoryQuerySchema,
  SemanticMemoryWriteSchema,
  type MemoryRecallResult,
  type SemanticMemoryEntry,
  type SemanticMemoryMetadata,
  type SemanticMemoryQuery,
  type SemanticMemoryWrite,
} from "./semantic-memory.js";

export type {
  EpisodicMemoryListing,
  MemoryListQuery,
  MemoryListResult,
  MemoryStore,
} from "./memory-store.js";
