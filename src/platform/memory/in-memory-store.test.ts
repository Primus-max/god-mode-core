import { describe, expect, it } from "vitest";

import { asIdentityId } from "../identity/identity-id.js";

import {
  EpisodicMemoryEventSchema,
  type EpisodicMemoryEvent,
} from "./episodic-memory-event.js";
import { InMemoryMemoryStore } from "./in-memory-store.js";
import { asMemoryEntryId, isMemoryEntryId } from "./memory-entry-id.js";
import type { MemoryStore } from "./memory-store.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const ALICE = asIdentityId("identity:alice");

const VALID_ISO = "2026-05-05T12:34:56.000Z";

/**
 * Build a `persistent_session.created` event for `identity` with a given
 * `messageId`. Convenience helper so tests stay short — the only varying
 * part across most tests is `messageId` + `identityId`.
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

describe("InMemoryMemoryStore — `implements MemoryStore` (Phase-1 interface conformance)", () => {
  it("a fresh InMemoryMemoryStore is assignable to the MemoryStore interface", () => {
    // Phase-1's `MemoryStore` is the contract slices F / G / J consume.
    // The compile-time assignment below is the load-bearing assertion;
    // the runtime check is a smoke-only `instanceof` so vitest reports
    // a deterministic pass/fail.
    const store: MemoryStore = new InMemoryMemoryStore();
    expect(store).toBeInstanceOf(InMemoryMemoryStore);
  });
});

describe("InMemoryMemoryStore — episodic round-trip", () => {
  it("storeEpisodic returns a well-formed MemoryEntryId surfaced by list", async () => {
    const store = new InMemoryMemoryStore();
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
    const store = new InMemoryMemoryStore();
    const id1 = await store.storeEpisodic(buildSessionEvent(VLADIMIR, "m-1"));
    const id2 = await store.storeEpisodic(buildSessionEvent(VLADIMIR, "m-2"));
    expect(id1).not.toBe(id2);
  });
});

describe("InMemoryMemoryStore — semantic round-trip", () => {
  it("storeSemantic + recall returns the entry with score > 0 when content matches", async () => {
    const store = new InMemoryMemoryStore();
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
    expect(entry?.metadata).toEqual({ source: "operator" });
    expect(entry?.score).toBeGreaterThan(0);
  });

  it("recall returns an empty array (NOT throws) when nothing matches", async () => {
    const store = new InMemoryMemoryStore();
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
    const store = new InMemoryMemoryStore();
    const result = await store.recall({ identityId: VLADIMIR, query: "anything" });
    expect(result.entries).toEqual([]);
  });

  it("recall metadata defaults to {} when storeSemantic was called without metadata", async () => {
    const store = new InMemoryMemoryStore();
    await store.storeSemantic({ identityId: VLADIMIR, content: "hello world" });
    const result = await store.recall({ identityId: VLADIMIR, query: "hello" });
    expect(result.entries[0]?.metadata).toEqual({});
  });

  it("recall respects the limit field when more entries match", async () => {
    const store = new InMemoryMemoryStore();
    await store.storeSemantic({ identityId: VLADIMIR, content: "alpha bravo" });
    await store.storeSemantic({ identityId: VLADIMIR, content: "alpha charlie" });
    await store.storeSemantic({ identityId: VLADIMIR, content: "alpha delta" });

    const result = await store.recall({
      identityId: VLADIMIR,
      query: "alpha",
      limit: 2,
    });

    expect(result.entries).toHaveLength(2);
  });
});

describe("InMemoryMemoryStore — tryForget removes from the store and is idempotent", () => {
  it("tryForget removes a semantic entry; subsequent recall does not surface it", async () => {
    const store = new InMemoryMemoryStore();
    const id = await store.storeSemantic({
      identityId: VLADIMIR,
      content: "favourite colour is teal",
    });

    expect(await store.tryForget(id)).toBe(true);

    const recall = await store.recall({ identityId: VLADIMIR, query: "favourite colour" });
    expect(recall.entries).toEqual([]);

    const list = await store.list({ identityId: VLADIMIR });
    expect(list.semantic).toEqual([]);
  });

  it("tryForget removes an episodic entry; subsequent list does not surface it", async () => {
    const store = new InMemoryMemoryStore();
    const id = await store.storeEpisodic(buildSessionEvent(VLADIMIR, "to-be-forgotten"));

    expect(await store.tryForget(id)).toBe(true);

    const list = await store.list({ identityId: VLADIMIR });
    expect(list.episodic).toEqual([]);
  });

  it("tryForget on an unknown id resolves to false (idempotent no-op)", async () => {
    const store = new InMemoryMemoryStore();
    const id = await store.storeSemantic({ identityId: VLADIMIR, content: "x" });
    expect(await store.tryForget(id)).toBe(true);
    // calling tryForget on the SAME id a second time → false, not throw
    expect(await store.tryForget(id)).toBe(false);
  });

  it("forget (Phase-1 interface, void-returning) is a silent idempotent miss", async () => {
    const store = new InMemoryMemoryStore();
    const id = await store.storeSemantic({ identityId: VLADIMIR, content: "x" });
    // Phase-1 contract: forget resolves successfully on hit AND on miss.
    await expect(store.forget(id)).resolves.toBeUndefined();
    await expect(store.forget(id)).resolves.toBeUndefined();
  });
});

describe("InMemoryMemoryStore — identity isolation", () => {
  it("entries stored under one identity are NOT visible to another via list", async () => {
    const store = new InMemoryMemoryStore();
    await store.storeEpisodic(buildSessionEvent(VLADIMIR, "v-1"));
    await store.storeSemantic({ identityId: VLADIMIR, content: "vladimir's secret" });

    const aliceList = await store.list({ identityId: ALICE });
    expect(aliceList.episodic).toEqual([]);
    expect(aliceList.semantic).toEqual([]);
  });

  it("entries stored under one identity are NOT visible to another via recall", async () => {
    const store = new InMemoryMemoryStore();
    await store.storeSemantic({
      identityId: VLADIMIR,
      content: "vladimir's favourite colour is teal",
    });

    const aliceRecall = await store.recall({
      identityId: ALICE,
      query: "favourite colour",
    });
    expect(aliceRecall.entries).toEqual([]);

    // sanity: the entry IS visible under the writing identity
    const vRecall = await store.recall({
      identityId: VLADIMIR,
      query: "favourite colour",
    });
    expect(vRecall.entries).toHaveLength(1);
  });

  it("each identity sees only its own entries even when contents are byte-identical", async () => {
    const store = new InMemoryMemoryStore();
    await store.storeSemantic({ identityId: VLADIMIR, content: "shared text" });
    await store.storeSemantic({ identityId: ALICE, content: "shared text" });

    const vRecall = await store.recall({ identityId: VLADIMIR, query: "shared" });
    const aRecall = await store.recall({ identityId: ALICE, query: "shared" });

    expect(vRecall.entries).toHaveLength(1);
    expect(aRecall.entries).toHaveLength(1);
    expect(vRecall.entries[0]?.id).not.toBe(aRecall.entries[0]?.id);
    expect(vRecall.entries[0]?.identityId).toBe(VLADIMIR);
    expect(aRecall.entries[0]?.identityId).toBe(ALICE);
  });
});

describe("InMemoryMemoryStore — listPaginated is stable-ordered by insertion time", () => {
  it("paginates 5 episodic events in pages of [2, 2, 1] in insertion order", async () => {
    const store = new InMemoryMemoryStore();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await store.storeEpisodic(buildSessionEvent(VLADIMIR, `m-${i}`));
      ids.push(id);
    }

    // page 1
    const page1 = await store.listPaginated({ identityId: VLADIMIR, limit: 2 });
    expect(page1.episodic.map((row) => row.id)).toEqual([ids[0], ids[1]]);

    // page 2 — cursor is the last id from page 1
    const lastIdPage1 = page1.episodic[page1.episodic.length - 1]?.id;
    expect(lastIdPage1).toBeDefined();
    const page2 = await store.listPaginated({
      identityId: VLADIMIR,
      limit: 2,
      after: lastIdPage1,
    });
    expect(page2.episodic.map((row) => row.id)).toEqual([ids[2], ids[3]]);

    // page 3 — final partial page
    const lastIdPage2 = page2.episodic[page2.episodic.length - 1]?.id;
    expect(lastIdPage2).toBeDefined();
    const page3 = await store.listPaginated({
      identityId: VLADIMIR,
      limit: 2,
      after: lastIdPage2,
    });
    expect(page3.episodic.map((row) => row.id)).toEqual([ids[4]]);

    // page 4 — past the end → empty
    const lastIdPage3 = page3.episodic[page3.episodic.length - 1]?.id;
    expect(lastIdPage3).toBeDefined();
    const page4 = await store.listPaginated({
      identityId: VLADIMIR,
      limit: 2,
      after: lastIdPage3,
    });
    expect(page4.episodic).toEqual([]);
  });

  it("limit=0 returns an empty page without crashing", async () => {
    const store = new InMemoryMemoryStore();
    await store.storeEpisodic(buildSessionEvent());
    const result = await store.list({ identityId: VLADIMIR, limit: 0 });
    expect(result.episodic).toEqual([]);
    expect(result.semantic).toEqual([]);
  });

  it("a negative limit returns an empty page without crashing", async () => {
    const store = new InMemoryMemoryStore();
    await store.storeEpisodic(buildSessionEvent());
    const result = await store.list({ identityId: VLADIMIR, limit: -3 });
    expect(result.episodic).toEqual([]);
    expect(result.semantic).toEqual([]);
  });

  it("an unknown `after` cursor returns an empty page (NOT throws)", async () => {
    const store = new InMemoryMemoryStore();
    await store.storeEpisodic(buildSessionEvent());
    const result = await store.listPaginated({
      identityId: VLADIMIR,
      after: asMemoryEntryId("mem:does-not-exist"),
    });
    // unknown cursor → opaque = "past the end" → empty page, not error
    expect(result.episodic).toEqual([]);
  });

  it("effectFamily filter restricts the listing to one family", async () => {
    const store = new InMemoryMemoryStore();
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
  });
});

describe("InMemoryMemoryStore — malformed input is rejected by the schema", () => {
  it("storeEpisodic rejects a malformed event via the Phase-1 Zod schema", async () => {
    const store = new InMemoryMemoryStore();
    // missing payload.messageRole (required) → schema should reject
    const bad = {
      identityId: VLADIMIR,
      effectFamily: "persistent_session",
      effectId: "e",
      payload: {
        // messageRole missing
        messageText: "x",
        messageId: "m",
        occurredAt: VALID_ISO,
      },
    } as unknown as EpisodicMemoryEvent;

    await expect(store.storeEpisodic(bad)).rejects.toThrow();
  });

  it("storeSemantic rejects an empty content string", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.storeSemantic({ identityId: VLADIMIR, content: "" }),
    ).rejects.toThrow();
  });

  it("Phase-1 EpisodicMemoryEventSchema parses what storeEpisodic accepts (round-trip)", () => {
    const event = buildSessionEvent();
    expect(() => EpisodicMemoryEventSchema.parse(event)).not.toThrow();
  });
});
