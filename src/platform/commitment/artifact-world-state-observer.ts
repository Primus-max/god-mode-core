import type { SessionId } from "./ids.js";
import {
  artifactRecordSchema,
  type ArtifactRecord,
  type ArtifactWorldState,
} from "./world-state.js";

export type ArtifactTurnKey = {
  readonly sessionId: SessionId;
  readonly turnId: string;
};

const DEFAULT_PER_TURN_LIMIT = 8;

export interface ArtifactWorldStateCollector {
  /**
   * Appends an artifact record to the bucket for `(sessionId, turnId)`.
   * Records with the same `artifactId` for the same key dedupe last-writer-
   * wins (the previous entry is removed before the new one is appended).
   * Malformed records (missing fields, unknown kind, malformed timestamp)
   * throw — invalid data is never persisted into the WorldState.
   *
   * @param record - Artifact record produced by the Phase 5 runtime adapter.
   * @param key - Turn-scoped bucket key.
   */
  record(record: ArtifactRecord, key: ArtifactTurnKey): void;

  /**
   * Drops every record bucketed under `(sessionId, turnId)`. Called by the
   * runtime adapter at turn-start to enforce per-turn isolation.
   *
   * @param key - Turn-scoped bucket key to clear.
   */
  resetForTurn(key: ArtifactTurnKey): void;

  /**
   * Marks the bucket the observer should expose via `observe()`. Production
   * callers (Phase 5 runtime adapter) set this once per turn; tests pin a
   * fixture key explicitly. `undefined` clears the active pointer so
   * `observe()` returns `undefined` (the WorldState slice is absent — the
   * default state when no artifact-producing tool has run on this turn).
   *
   * @param key - Turn key to expose, or `undefined` to clear.
   */
  setActiveTurn(key: ArtifactTurnKey | undefined): void;

  /**
   * Returns the records bucketed under the currently-active turn, oldest
   * first. Returns `undefined` when no active turn is set or when the active
   * turn's bucket has never been written.
   *
   * @returns Frozen list of records for the active turn, or `undefined`.
   */
  getActiveSlice(): readonly ArtifactRecord[] | undefined;
}

export interface ArtifactWorldStateObserver {
  /**
   * Reads a deterministic `ArtifactWorldState` snapshot for the currently-
   * active turn. Returns `undefined` when the kernel runs through a turn
   * that produced no artifacts — the predicate sees `artifacts.slice_absent`
   * rather than an empty `records` list (slice E precedent).
   *
   * @returns Frozen `ArtifactWorldState` derived from the collector, or
   *   `undefined` when no active turn is set.
   */
  observe(): ArtifactWorldState | undefined;
}

export type CreateArtifactWorldStateCollectorOptions = {
  /**
   * Soft cap on the number of records retained per `(sessionId, turnId)`.
   * Older records are dropped from the head when exceeded. Defaults to 8
   * (cutover-3 sub-plan §1 todo Phase 3).
   */
  readonly perTurnLimit?: number;
};

function bucketKey(key: ArtifactTurnKey): string {
  return `${key.sessionId} ${key.turnId}`;
}

class InMemoryArtifactWorldStateCollector implements ArtifactWorldStateCollector {
  readonly #buckets = new Map<string, ArtifactRecord[]>();
  readonly #perTurnLimit: number;
  #activeKey: string | undefined;

  constructor(options: CreateArtifactWorldStateCollectorOptions) {
    this.#perTurnLimit = Math.max(1, options.perTurnLimit ?? DEFAULT_PER_TURN_LIMIT);
  }

  record(record: ArtifactRecord, key: ArtifactTurnKey): void {
    // Validate via Zod; throws on missing fields / unknown kind / malformed
    // timestamp. The runtime adapter (Phase 5) is the only writer in
    // production; tests exercise the rejection path explicitly.
    const parsed = artifactRecordSchema.parse(record) as ArtifactRecord;
    const bk = bucketKey(key);
    const bucket = this.#buckets.get(bk) ?? [];
    const filtered = bucket.filter((entry) => entry.artifactId !== parsed.artifactId);
    filtered.push(Object.freeze({ ...parsed }));
    while (filtered.length > this.#perTurnLimit) {
      filtered.shift();
    }
    this.#buckets.set(bk, filtered);
  }

  resetForTurn(key: ArtifactTurnKey): void {
    this.#buckets.delete(bucketKey(key));
  }

  setActiveTurn(key: ArtifactTurnKey | undefined): void {
    this.#activeKey = key === undefined ? undefined : bucketKey(key);
  }

  getActiveSlice(): readonly ArtifactRecord[] | undefined {
    if (this.#activeKey === undefined) {
      return undefined;
    }
    const bucket = this.#buckets.get(this.#activeKey);
    return bucket ? Object.freeze([...bucket]) : undefined;
  }
}

/**
 * Creates an in-memory `ArtifactWorldStateCollector` used by the artifact
 * runtime adapter (Phase 5) and the kernel's `ArtifactWorldStateObserver`.
 *
 * @param options - Optional capacity tuning.
 * @returns Frozen collector handle.
 */
export function createArtifactWorldStateCollector(
  options: CreateArtifactWorldStateCollectorOptions = {},
): ArtifactWorldStateCollector {
  return new InMemoryArtifactWorldStateCollector(options);
}

/**
 * Creates a read-only observer over an injected collector. The observer
 * reads `getActiveSlice()` and wraps it as a frozen `ArtifactWorldState`.
 * When no active turn is set, returns `undefined` (the kernel's per-family
 * artifact predicates then report `artifacts.slice_absent`).
 *
 * @param collector - Append-only collector written by the runtime adapter.
 * @returns Observer that maps the collector into `ArtifactWorldState`.
 */
export function createArtifactWorldStateObserver(
  collector: ArtifactWorldStateCollector,
): ArtifactWorldStateObserver {
  return Object.freeze({
    observe(): ArtifactWorldState | undefined {
      const records = collector.getActiveSlice();
      return records === undefined ? undefined : Object.freeze({ records });
    },
  });
}

let processCollector: ArtifactWorldStateCollector | undefined;

/**
 * Returns the lazily-initialized process-scoped
 * `ArtifactWorldStateCollector`. The Phase 5 runtime adapter writes to this
 * collector; the kernel observer reads from it. Tests can inject a fixture
 * instance via `setProcessArtifactWorldStateCollectorForTests`.
 *
 * @returns Singleton collector shared across the running process.
 */
export function getProcessArtifactWorldStateCollector(): ArtifactWorldStateCollector {
  if (!processCollector) {
    processCollector = createArtifactWorldStateCollector();
  }
  return processCollector;
}

/**
 * Replaces the process collector; intended for tests that need a
 * deterministic instance distinct from the singleton lifecycle.
 *
 * @param collector - Replacement collector, or `undefined` to reset.
 */
export function setProcessArtifactWorldStateCollectorForTests(
  collector: ArtifactWorldStateCollector | undefined,
): void {
  processCollector = collector;
}
