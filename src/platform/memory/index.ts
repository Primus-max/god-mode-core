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

export { asMemoryEntryId, isMemoryEntryId, type MemoryEntryId } from "./memory-entry-id.js";

export {
  ArtifactCreatedPayloadSchema,
  EpisodicMemoryEventSchema,
  PersistentSessionCreatedPayloadSchema,
  PolicyApprovalPayloadSchema,
  PolicyBudgetPayloadSchema,
  PolicyEscalationPayloadSchema,
  PolicyRetryPayloadSchema,
  PolicyRolePayloadSchema,
  ReminderSetPayloadSchema,
  RepoOperationCompletedPayloadSchema,
  SubagentCreatedPayloadSchema,
  TaskCancelledPayloadSchema,
  TaskCompletedPayloadSchema,
  TaskCreatedPayloadSchema,
  TaskFailedPayloadSchema,
  TaskLifecyclePayloadSchema,
  assertNeverEpisodic,
  type ArtifactCreatedPayload,
  type EpisodicEffectFamily,
  type EpisodicMemoryEvent,
  type PersistentSessionCreatedPayload,
  type PolicyApprovalPayload,
  type PolicyBudgetPayload,
  type PolicyEscalationPayload,
  type PolicyRetryPayload,
  type PolicyRolePayload,
  type ReminderSetPayload,
  type RepoOperationCompletedPayload,
  type SubagentCreatedPayload,
  type TaskCancelledPayload,
  type TaskCompletedPayload,
  type TaskCreatedPayload,
  type TaskFailedPayload,
  type TaskLifecyclePayload,
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

export { InMemoryMemoryStore, type InMemoryListPaginatedQuery } from "./in-memory-store.js";

export {
  SqliteVecMemoryStore,
  SQLITE_VEC_MEMORY_STORE_SCHEMA_VERSION,
  defaultSqliteVecMemoryStorePath,
  type LoadSqliteVecExtensionFn,
  type MemoryEmbedder,
  type SqliteVecMemoryStoreLogger,
  type SqliteVecMemoryStoreOpenOptions,
} from "./sqlite-vec-store.js";

export {
  EXTRACTOR_TAGS_METADATA_KEY,
  LlmExtractorMemoryStore,
  type LlmExtractor,
  type LlmExtractorDecision,
  type LlmExtractorInput,
  type LlmExtractorMemoryStoreLogger,
  type LlmExtractorMemoryStoreOptions,
} from "./llm-extractor-store.js";

export {
  LLM_EXTRACTOR_PROMPT,
  LlmExtractorDecisionSchema,
  parseLlmExtractorDecision,
} from "./llm-extractor-prompt.js";
