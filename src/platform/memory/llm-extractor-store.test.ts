import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asIdentityId } from "../identity/identity-id.js";

import { type EpisodicMemoryEvent } from "./episodic-memory-event.js";
import { InMemoryMemoryStore } from "./in-memory-store.js";
import { isMemoryEntryId } from "./memory-entry-id.js";
import {
  LlmExtractorMemoryStore,
  type LlmExtractor,
  type LlmExtractorDecision,
  type LlmExtractorMemoryStoreLogger,
} from "./llm-extractor-store.js";
import type { MemoryStore } from "./memory-store.js";
import {
  SqliteVecMemoryStore,
  type MemoryEmbedder,
} from "./sqlite-vec-store.js";

/**
 * Slice E Phase 4 — `LlmExtractorMemoryStore` acceptance tests.
 *
 * Path B (in-house extractor) was chosen at the decision gate because
 * the `mem0ai` Node SDK is alpha-quality and the wrapper-pattern audit
 * (sub-plan §2.2) flagged "if the API is unstable enough that wrapping
 * costs more than implementing the LLM-extraction layer ourselves,
 * surface as a §6 amendment proposal and proceed with the pure-sqlite-vec
 * path (in-house LlmExtractor, ~150 LOC, single LLM call per write)."
 *
 * Per sub-plan §5 these tests:
 * - exercise REAL `InMemoryMemoryStore` and `SqliteVecMemoryStore`
 *   delegates (no spying on the function under test);
 * - inject the LLM extractor as a deterministic stub keyed on input
 *   content (per sub-plan "Test discipline" — no `vi.spyOn` on the
 *   function under test, only on the injected dep);
 * - cover the negative paths: extractor rejects junk content
 *   (`keep:false`) → entry is NOT persisted in the delegate, recall
 *   returns nothing for that content;
 * - run the EXACT SAME assertion suite from Phase 2's
 *   `InMemoryMemoryStore` acceptance tests against the wrapped store
 *   (constructor swap only) — that's the pluggability proof per
 *   sub-plan §5 Phase 4.
 */

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");

const VALID_ISO = "2026-05-05T12:34:56.000Z";

const VECTOR_DIMS = 32;

/**
 * Build a `persistent_session.created` event for `identity` with a given
 * `messageId`. Mirrors the helper in `in-memory-store.test.ts` so the
 * pluggability suite reads identically.
 */
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

/**
 * Deterministic stub embedder reused from the Phase 3 test file —
 * SHA-1 of input seeded into a `VECTOR_DIMS`-long Float32Array. Only
 * needed by the SqliteVec delegate tests.
 */
function createStubEmbedder(): MemoryEmbedder {
  return {
    embed(text: string): Promise<Float32Array> {
      const digest = createHash("sha1").update(text).digest();
      const out = new Float32Array(VECTOR_DIMS);
      for (let i = 0; i < VECTOR_DIMS; i += 1) {
        const byte = digest[i % digest.length] ?? 0;
        out[i] = (byte - 128) / 128;
      }
      return Promise.resolve(out);
    },
  };
}

/**
 * Capturing extractor stub. Calls are recorded so tests can assert the
 * exact text the extractor was asked about; the response for each input
 * is keyed off a `Map<content, decision>` populated by the test.
 *
 * The default decision (when no override is set) is `keep:true` with
 * the input text untouched — i.e. extraction-on. Negative-path tests
 * register a `keep:false` override to exercise the drop path.
 */
type StubExtractor = LlmExtractor & {
  readonly calls: ReadonlyArray<string>;
  setDecision(content: string, decision: LlmExtractorDecision): void;
  setError(content: string, error: Error): void;
};

function createStubExtractor(): StubExtractor {
  const calls: string[] = [];
  const decisions = new Map<string, LlmExtractorDecision>();
  const errors = new Map<string, Error>();
  return {
    async extract(input) {
      calls.push(input.content);
      const err = errors.get(input.content);
      if (err) {
        throw err;
      }
      const override = decisions.get(input.content);
      if (override) {
        return override;
      }
      // Default: keep the content verbatim with no extra tags.
      return Promise.resolve({
        keep: true,
        normalized: input.content,
        tags: [],
      });
    },
    get calls() {
      return calls;
    },
    setDecision(content, decision) {
      decisions.set(content, decision);
    },
    setError(content, error) {
      errors.set(content, error);
    },
  };
}

type CapturingLogger = LlmExtractorMemoryStoreLogger & {
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

/* ------------------------------------------------------------------ */
/* 1. Interface conformance + extraction round-trip                    */
/* ------------------------------------------------------------------ */

describe("LlmExtractorMemoryStore — `implements MemoryStore` (Phase-1 interface conformance)", () => {
  it("a fresh LlmExtractorMemoryStore wrapping InMemoryMemoryStore is assignable to MemoryStore", () => {
    const store: MemoryStore = new LlmExtractorMemoryStore({
      delegate: new InMemoryMemoryStore(),
      extractor: createStubExtractor(),
    });
    expect(store).toBeInstanceOf(LlmExtractorMemoryStore);
  });
});

describe("LlmExtractorMemoryStore — extraction-on round-trip", () => {
  it("storeSemantic with keep:true persists the normalized entry in the delegate (recall finds it)", async () => {
    const delegate = new InMemoryMemoryStore();
    const extractor = createStubExtractor();
    extractor.setDecision("the operator's favourite colour is teal", {
      keep: true,
      normalized: "operator favourite colour: teal",
      tags: ["preference", "colour"],
    });

    const store = new LlmExtractorMemoryStore({ delegate, extractor });

    const id = await store.storeSemantic({
      identityId: VLADIMIR,
      content: "the operator's favourite colour is teal",
      metadata: { source: "operator" },
    });

    expect(isMemoryEntryId(id)).toBe(true);
    expect(extractor.calls).toEqual(["the operator's favourite colour is teal"]);

    // Persisted entry uses the NORMALIZED text — that's the whole point
    // of the extraction layer.
    const result = await store.recall({
      identityId: VLADIMIR,
      query: "favourite colour",
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.content).toBe("operator favourite colour: teal");
    // Tags from extractor are merged into the metadata under the
    // `extractor_tags` key (single-string CSV-encoded — metadata schema
    // forbids arrays, see `SemanticMemoryMetadataSchema`).
    expect(result.entries[0]?.metadata.source).toBe("operator");
    expect(result.entries[0]?.metadata.extractor_tags).toBe("preference,colour");
  });

  it("episodic events bypass the extractor (no LLM call) and reach the delegate verbatim", async () => {
    const delegate = new InMemoryMemoryStore();
    const extractor = createStubExtractor();
    const store = new LlmExtractorMemoryStore({ delegate, extractor });

    const event = buildSessionEvent(VLADIMIR, "m-1");
    const id = await store.storeEpisodic(event);

    // Episodic surface is already structured per sub-plan §5 #4 / #5
    // — the LLM extractor is only on the SEMANTIC write path.
    expect(extractor.calls).toEqual([]);

    const list = await store.list({ identityId: VLADIMIR });
    expect(list.episodic).toHaveLength(1);
    expect(list.episodic[0]?.id).toBe(id);
    expect(list.episodic[0]?.event).toEqual(event);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Extraction-off (keep:false) negative path                        */
/* ------------------------------------------------------------------ */

describe("LlmExtractorMemoryStore — extraction-off rejects junk content", () => {
  it("storeSemantic with keep:false does NOT persist the entry; recall returns nothing", async () => {
    const delegate = new InMemoryMemoryStore();
    const extractor = createStubExtractor();
    extractor.setDecision("ok thanks lol", {
      keep: false,
      normalized: "ok thanks lol",
      tags: [],
    });

    const store = new LlmExtractorMemoryStore({ delegate, extractor });

    const id = await store.storeSemantic({
      identityId: VLADIMIR,
      content: "ok thanks lol",
    });

    // Per sub-plan §5 Phase 4: the extraction filter must drop junk.
    // We surface a sentinel id (`mem:dropped-...`) so callers have an
    // observability handle, but NO row is created in the delegate.
    expect(isMemoryEntryId(id)).toBe(true);
    expect(id.startsWith("mem:dropped-")).toBe(true);

    const recall = await store.recall({
      identityId: VLADIMIR,
      query: "ok thanks lol",
    });
    expect(recall.entries).toEqual([]);

    const list = await store.list({ identityId: VLADIMIR });
    expect(list.semantic).toEqual([]);
  });

  it("forget on a sentinel `mem:dropped-...` id is a no-op (resolves)", async () => {
    const delegate = new InMemoryMemoryStore();
    const extractor = createStubExtractor();
    extractor.setDecision("noise", { keep: false, normalized: "noise", tags: [] });
    const store = new LlmExtractorMemoryStore({ delegate, extractor });
    const id = await store.storeSemantic({ identityId: VLADIMIR, content: "noise" });
    await expect(store.forget(id)).resolves.toBeUndefined();
  });

  it("extractor crash → write degrades to passthrough + warning logged (defense-in-depth, sub-plan §1 #15)", async () => {
    const delegate = new InMemoryMemoryStore();
    const extractor = createStubExtractor();
    extractor.setError("boom", new Error("LLM provider timeout"));
    const logger = createCapturingLogger();
    const store = new LlmExtractorMemoryStore({ delegate, extractor, logger });

    // Per sub-plan §1 invariant #15: extraction is OBSERVABILITY, not
    // gating — even if extraction crashes, the underlying store stays
    // callable. We persist verbatim and surface a warning.
    const id = await store.storeSemantic({
      identityId: VLADIMIR,
      content: "boom",
    });
    expect(isMemoryEntryId(id)).toBe(true);
    expect(id.startsWith("mem:dropped-")).toBe(false);

    const recall = await store.recall({ identityId: VLADIMIR, query: "boom" });
    expect(recall.entries).toHaveLength(1);
    expect(recall.entries[0]?.content).toBe("boom");
    expect(logger.warnings.some((w) => w.includes("extractor_error"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Identity isolation                                                */
/* ------------------------------------------------------------------ */

describe("LlmExtractorMemoryStore — identity isolation through the wrapper", () => {
  it("entries written via the wrapper under VLADIMIR are NOT visible to ALICE", async () => {
    const delegate = new InMemoryMemoryStore();
    const extractor = createStubExtractor();
    const store = new LlmExtractorMemoryStore({ delegate, extractor });

    await store.storeEpisodic(buildSessionEvent(VLADIMIR, "v-1"));
    await store.storeSemantic({
      identityId: VLADIMIR,
      content: "vladimir's favourite colour is teal",
    });

    const aliceList = await store.list({ identityId: ALICE });
    expect(aliceList.episodic).toEqual([]);
    expect(aliceList.semantic).toEqual([]);

    const aliceRecall = await store.recall({
      identityId: ALICE,
      query: "favourite colour",
    });
    expect(aliceRecall.entries).toEqual([]);

    const vladimirRecall = await store.recall({
      identityId: VLADIMIR,
      query: "favourite colour",
    });
    expect(vladimirRecall.entries).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Pluggability — same suite as Phase 2 InMemoryMemoryStore         */
/*    acceptance, but against LlmExtractorMemoryStore                   */
/* ------------------------------------------------------------------ */

describe("LlmExtractorMemoryStore — Phase-2 pluggability suite (constructor-swap proof)", () => {
  /**
   * Helper: build the Phase-4 store with a default (passthrough)
   * extractor. The pluggability proof is exactly that this store
   * passes the SAME assertion shape as `InMemoryMemoryStore` —
   * sub-plan §5 Phase 4 acceptance.
   */
  function makeStore(): { store: LlmExtractorMemoryStore; extractor: StubExtractor } {
    const delegate = new InMemoryMemoryStore();
    const extractor = createStubExtractor();
    const store = new LlmExtractorMemoryStore({ delegate, extractor });
    return { store, extractor };
  }

  it("storeEpisodic returns a well-formed MemoryEntryId surfaced by list", async () => {
    const { store } = makeStore();
    const event = buildSessionEvent();
    const id = await store.storeEpisodic(event);
    expect(isMemoryEntryId(id)).toBe(true);

    const result = await store.list({ identityId: VLADIMIR });
    expect(result.episodic).toHaveLength(1);
    expect(result.episodic[0]?.id).toBe(id);
    expect(result.episodic[0]?.event).toEqual(event);
    expect(result.semantic).toEqual([]);
  });

  it("storeEpisodic mints stable, distinct ids across repeated calls", async () => {
    const { store } = makeStore();
    const id1 = await store.storeEpisodic(buildSessionEvent(VLADIMIR, "m-1"));
    const id2 = await store.storeEpisodic(buildSessionEvent(VLADIMIR, "m-2"));
    expect(id1).not.toBe(id2);
  });

  it("storeSemantic + recall returns the entry with score > 0 when content matches", async () => {
    const { store } = makeStore();
    const id = await store.storeSemantic({
      identityId: VLADIMIR,
      content: "favourite colour is teal",
      metadata: { source: "operator" },
    });
    expect(isMemoryEntryId(id)).toBe(true);

    const result = await store.recall({
      identityId: VLADIMIR,
      query: "favourite colour",
    });
    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    expect(entry?.id).toBe(id);
    expect(entry?.identityId).toBe(VLADIMIR);
    expect(entry?.content).toBe("favourite colour is teal");
    expect(entry?.metadata.source).toBe("operator");
    expect((entry?.score ?? 0) > 0).toBe(true);
  });

  it("recall returns an empty array (NOT throws) when nothing matches", async () => {
    const { store } = makeStore();
    await store.storeSemantic({
      identityId: VLADIMIR,
      content: "favourite colour is teal",
    });
    const result = await store.recall({
      identityId: VLADIMIR,
      query: "completely unrelated keyword",
    });
    expect(result.entries).toEqual([]);
  });

  it("recall returns an empty array on a store that has never been written to", async () => {
    const { store } = makeStore();
    const result = await store.recall({ identityId: VLADIMIR, query: "anything" });
    expect(result.entries).toEqual([]);
  });

  it("storeSemantic rejects an empty content string (Zod schema)", async () => {
    const { store, extractor } = makeStore();
    await expect(
      store.storeSemantic({ identityId: VLADIMIR, content: "" }),
    ).rejects.toThrow();
    // The extractor must NOT have been called when input fails Zod
    // validation — extractor is downstream of the schema gate.
    expect(extractor.calls).toEqual([]);
  });

  it("forget on a kept entry is idempotent and removes it from the delegate", async () => {
    const { store } = makeStore();
    const id = await store.storeSemantic({
      identityId: VLADIMIR,
      content: "shared text",
    });
    await expect(store.forget(id)).resolves.toBeUndefined();
    // calling forget twice is a silent no-op per Phase-1 contract
    await expect(store.forget(id)).resolves.toBeUndefined();

    const recall = await store.recall({ identityId: VLADIMIR, query: "shared" });
    expect(recall.entries).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Pluggability — also passes against SqliteVecMemoryStore delegate */
/* ------------------------------------------------------------------ */

describe("LlmExtractorMemoryStore — pluggability against SqliteVecMemoryStore delegate", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "openclaw-llm-extractor-"));
    dbPath = path.join(tmpDir, "identity-memory.sqlite");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — Windows may hold a brief sqlite handle.
    }
  });

  it("the same acceptance suite passes against a SqliteVec delegate (constructor swap only)", async () => {
    const delegate = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
    });
    const extractor = createStubExtractor();
    extractor.setDecision("the operator's favourite colour is teal", {
      keep: true,
      normalized: "operator favourite colour: teal",
      tags: ["preference"],
    });
    const store = new LlmExtractorMemoryStore({ delegate, extractor });

    const id = await store.storeSemantic({
      identityId: VLADIMIR,
      content: "the operator's favourite colour is teal",
    });
    expect(isMemoryEntryId(id)).toBe(true);

    const result = await store.recall({
      identityId: VLADIMIR,
      query: "operator favourite colour: teal",
    });
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0]?.content).toBe("operator favourite colour: teal");

    await delegate.close();
  });

  it("extraction-off (keep:false) prevents persistence in the SqliteVec delegate", async () => {
    const delegate = await SqliteVecMemoryStore.open({
      dbPath,
      embedder: createStubEmbedder(),
      vectorDims: VECTOR_DIMS,
    });
    const extractor = createStubExtractor();
    extractor.setDecision("noise", { keep: false, normalized: "noise", tags: [] });
    const store = new LlmExtractorMemoryStore({ delegate, extractor });

    const id = await store.storeSemantic({ identityId: VLADIMIR, content: "noise" });
    expect(id.startsWith("mem:dropped-")).toBe(true);

    const recall = await store.recall({ identityId: VLADIMIR, query: "noise" });
    expect(recall.entries).toEqual([]);

    const list = await store.list({ identityId: VLADIMIR });
    expect(list.semantic).toEqual([]);

    await delegate.close();
  });
});
