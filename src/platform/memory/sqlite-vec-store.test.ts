import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asIdentityId } from "../identity/identity-id.js";

import { type EpisodicMemoryEvent } from "./episodic-memory-event.js";
import { isMemoryEntryId } from "./memory-entry-id.js";
import type { MemoryStore } from "./memory-store.js";
import {
  SqliteVecMemoryStore,
  type MemoryEmbedder,
  type SqliteVecMemoryStoreLogger,
} from "./sqlite-vec-store.js";

/**
 * Slice E Phase 3 — `SqliteVecMemoryStore` acceptance tests. Per
 * sub-plan §5 these tests:
 * - exercise a REAL sqlite file in a tmp dir (no mocking the store under
 *   test);
 * - inject the embedder + the `loadSqliteVecExtension` callable + the
 *   logger (the only `vi.spyOn`-style points are these *injected
 *   dependencies* — the store's own methods are never spied);
 * - cover the negative paths: malformed input rejected, vector
 *   extension load failure falls back gracefully + emits a
 *   `vector_unavailable` warning, schema migration is idempotent on
 *   re-open;
 * - assert identity isolation across two operators on the same file.
 *
 * The test file lands FIRST as a failing commit (the impl module does
 * not yet exist on this branch) — see the Phase-3 spec.
 */

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");

const VALID_ISO = "2026-05-05T12:34:56.000Z";

const VECTOR_DIMS = 32;

/**
 * Deterministic stub embedder: SHA-1 of the input text seeded into a
 * `VECTOR_DIMS`-long Float32Array. Same text always yields the same
 * vector, so recall ranking is reproducible across runs.
 *
 * NOTE: this is the ONLY place we spy on the embedder — per sub-plan
 * the embedder is an INJECTED dep, not the function under test.
 */
function createStubEmbedder(): MemoryEmbedder {
  return {
    embed(text: string): Promise<Float32Array> {
      const digest = createHash("sha1").update(text).digest();
      const out = new Float32Array(VECTOR_DIMS);
      for (let i = 0; i < VECTOR_DIMS; i += 1) {
        // Map byte 0..255 to a roughly-zero-centred float so cosine
        // similarity has both positive and negative components.
        const byte = digest[i % digest.length] ?? 0;
        out[i] = (byte - 128) / 128;
      }
      return Promise.resolve(out);
    },
  };
}

function buildSessionEvent(
  identity = VLADIMIR,
  messageId = "msg-1",
  messageText = `text for ${messageId}`,
): EpisodicMemoryEvent {
  return {
    identityId: identity,
    effectFamily: "persistent_session",
    effectId: `effect-${messageId}`,
    payload: {
      messageRole: "user",
      messageText,
      messageId,
      occurredAt: VALID_ISO,
    },
  };
}

type CapturingLogger = SqliteVecMemoryStoreLogger & {
  readonly warnings: readonly string[];
};

function createCapturingLogger(): CapturingLogger {
  const warnings: string[] = [];
  return {
    warn(message: string) {
      warnings.push(message);
    },
    get warnings() {
      return warnings;
    },
  };
}

describe("SqliteVecMemoryStore — Phase 3 acceptance", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "openclaw-sqlite-vec-store-"));
    dbPath = path.join(tmpDir, "identity-memory.sqlite");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — Windows sometimes holds an open DB
      // handle for a beat after `close()`. The test runner does not
      // care if the dir lingers; CI's tmpdir is wiped between jobs.
    }
  });

  it("a freshly-opened SqliteVecMemoryStore is assignable to the MemoryStore interface", async () => {
    const store: MemoryStore = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
    });
    expect(store).toBeInstanceOf(SqliteVecMemoryStore);
    await (store as SqliteVecMemoryStore).close();
  });

  it("schema_version row is present and equals 1 after open", async () => {
    const store = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
    });
    expect(store.getSchemaVersion()).toBe(1);
    await store.close();
  });

  it("episodic round-trip persists across close + reopen on the same file", async () => {
    const embedder = createStubEmbedder();
    const first = await SqliteVecMemoryStore.open({
      dbPath,
      embedder,
      vectorDims: VECTOR_DIMS,
    });
    const id = await first.storeEpisodic(buildSessionEvent(VLADIMIR, "m-1"));
    expect(isMemoryEntryId(id)).toBe(true);
    await first.close();

    // Re-open on the same file — schema migration must be idempotent.
    const second = await SqliteVecMemoryStore.open({
      dbPath,
      embedder,
      vectorDims: VECTOR_DIMS,
    });
    const list = await second.list({ identityId: VLADIMIR });
    expect(list.episodic).toHaveLength(1);
    expect(list.episodic[0]?.id).toBe(id);
    expect(list.episodic[0]?.event).toEqual(buildSessionEvent(VLADIMIR, "m-1"));
    await second.close();
  });

  it("semantic round-trip — storeSemantic + recall returns the entry by content match", async () => {
    const store = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
    });
    const id = await store.storeSemantic({
      identityId: VLADIMIR,
      content: "favourite colour is teal",
      metadata: { source: "operator" },
    });
    expect(isMemoryEntryId(id)).toBe(true);

    const result = await store.recall({
      identityId: VLADIMIR,
      query: "favourite colour is teal",
    });

    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    expect(entry?.id).toBe(id);
    expect(entry?.identityId).toBe(VLADIMIR);
    expect(entry?.content).toBe("favourite colour is teal");
    expect(entry?.metadata).toEqual({ source: "operator" });
    expect(Number.isFinite(entry?.score ?? Number.NaN)).toBe(true);

    await store.close();
  });

  it("identity isolation — entries under VLADIMIR are not visible from ALICE", async () => {
    const store = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
    });

    await store.storeEpisodic(buildSessionEvent(VLADIMIR, "v-1"));
    await store.storeSemantic({
      identityId: VLADIMIR,
      content: "vladimir's secret",
    });

    // List under the OTHER identity → empty
    const aliceList = await store.list({ identityId: ALICE });
    expect(aliceList.episodic).toEqual([]);
    expect(aliceList.semantic).toEqual([]);

    // Recall under the OTHER identity → empty (vector path scoped by id)
    const aliceRecall = await store.recall({
      identityId: ALICE,
      query: "vladimir's secret",
    });
    expect(aliceRecall.entries).toEqual([]);

    // Sanity — under VLADIMIR the entries ARE visible
    const vladimirList = await store.list({ identityId: VLADIMIR });
    expect(vladimirList.episodic).toHaveLength(1);
    expect(vladimirList.semantic).toHaveLength(1);

    await store.close();
  });

  it("schema migration is idempotent — re-opening on the same file does not throw", async () => {
    const embedder = createStubEmbedder();
    const first = await SqliteVecMemoryStore.open({
      dbPath,
      embedder,
      vectorDims: VECTOR_DIMS,
    });
    expect(first.getSchemaVersion()).toBe(1);
    await first.close();

    // Second open on the same file path. Phase 3 acceptance: must not
    // throw, must report the same schema version.
    const second = await SqliteVecMemoryStore.open({
      dbPath,
      embedder,
      vectorDims: VECTOR_DIMS,
    });
    expect(second.getSchemaVersion()).toBe(1);
    await second.close();

    // And a THIRD time, just to confirm the migration is truly
    // re-entrant.
    const third = await SqliteVecMemoryStore.open({
      dbPath,
      embedder,
      vectorDims: VECTOR_DIMS,
    });
    expect(third.getSchemaVersion()).toBe(1);
    await third.close();
  });

  it("vector unavailable — when loadSqliteVecExtension returns ok:false, recall falls back to LIKE AND warns", async () => {
    const logger = createCapturingLogger();
    const store = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
      loadExtension: () =>
        Promise.resolve({ ok: false, error: "deliberate test failure" }),
      logger,
    });

    expect(store.isVectorAvailable()).toBe(false);

    // The warning is surfaced once, at open time (not on every recall).
    expect(
      logger.warnings.some((w) => w.includes("vector_unavailable")),
    ).toBe(true);

    // Storing still works (we just skip the vec0 insert).
    const id = await store.storeSemantic({
      identityId: VLADIMIR,
      content: "favourite colour is teal",
    });
    expect(isMemoryEntryId(id)).toBe(true);

    // Recall falls back to LIKE-based scoring — a query that overlaps
    // with the content surfaces the entry; an unrelated query does not.
    const hit = await store.recall({
      identityId: VLADIMIR,
      query: "favourite colour",
    });
    expect(hit.entries).toHaveLength(1);
    expect(hit.entries[0]?.id).toBe(id);
    expect(hit.entries[0]?.content).toBe("favourite colour is teal");

    const miss = await store.recall({
      identityId: VLADIMIR,
      query: "completely unrelated keyword that doesn't appear",
    });
    expect(miss.entries).toEqual([]);

    await store.close();
  });

  it("recall returns an empty array (NOT throws) when the store has no entries for the identity", async () => {
    const store = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
    });

    const result = await store.recall({ identityId: VLADIMIR, query: "anything" });
    expect(result.entries).toEqual([]);

    await store.close();
  });

  it("forget removes the entry from both the base table and the vector table", async () => {
    const store = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
    });

    const id = await store.storeSemantic({
      identityId: VLADIMIR,
      content: "to be forgotten",
    });
    await store.forget(id);

    // After forget, recall should not surface the entry.
    const result = await store.recall({
      identityId: VLADIMIR,
      query: "to be forgotten",
    });
    expect(result.entries).toEqual([]);

    // And forget on the same id again is a silent no-op (idempotent
    // per Phase 1 contract).
    await expect(store.forget(id)).resolves.toBeUndefined();

    await store.close();
  });

  it("malformed semantic input is rejected by the Phase-1 Zod schema", async () => {
    const store = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
    });
    await expect(
      store.storeSemantic({ identityId: VLADIMIR, content: "" }),
    ).rejects.toThrow();
    await store.close();
  });

  it("malformed episodic input is rejected by the Phase-1 Zod schema", async () => {
    const store = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
    });

    const bad = {
      identityId: VLADIMIR,
      effectFamily: "persistent_session",
      effectId: "e",
      payload: {
        // messageRole missing → schema must reject
        messageText: "x",
        messageId: "m",
        occurredAt: VALID_ISO,
      },
    } as unknown as EpisodicMemoryEvent;

    await expect(store.storeEpisodic(bad)).rejects.toThrow();
    await store.close();
  });

  it("recall respects limit when more entries match", async () => {
    const store = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
    });

    await store.storeSemantic({ identityId: VLADIMIR, content: "alpha bravo" });
    await store.storeSemantic({ identityId: VLADIMIR, content: "alpha charlie" });
    await store.storeSemantic({ identityId: VLADIMIR, content: "alpha delta" });

    const result = await store.recall({
      identityId: VLADIMIR,
      query: "alpha",
      limit: 2,
    });
    expect(result.entries).toHaveLength(2);

    await store.close();
  });

  it("list with an effectFamily filter restricts to that family", async () => {
    const store = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
    });

    await store.storeEpisodic(buildSessionEvent(VLADIMIR, "m-1"));
    await store.storeEpisodic({
      identityId: VLADIMIR,
      effectFamily: "subagent",
      effectId: "effect-sub",
      payload: { subagentId: "s", displayName: "n", occurredAt: VALID_ISO },
    });

    const filtered = await store.list({
      identityId: VLADIMIR,
      effectFamily: "subagent",
    });
    expect(filtered.episodic).toHaveLength(1);
    expect(filtered.episodic[0]?.event.effectFamily).toBe("subagent");

    await store.close();
  });
});
