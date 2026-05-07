import { describe, expect, it } from "vitest";

import { asIdentityId } from "../../identity/identity-id.js";
import { InMemoryMemoryStore } from "../in-memory-store.js";
import {
  LlmExtractorMemoryStore,
  type LlmExtractor,
  type LlmExtractorDecision,
} from "../llm-extractor-store.js";

/**
 * Slice "intent-contractor freshness/recency" — Phase 4 / Change 1.
 *
 * Producer-side `recordedAt` write. The extractor wrapper stamps every
 * persisted SEMANTIC entry with `metadata.recordedAt = <epoch ms>` at
 * write time so the contractor's Phase 4 freshness reorder (sub-plan
 * §6 + audit §b.2) has a dependable timestamp on every newly-written
 * row. Legacy rows without the key fall through
 * `missingTimestampPolicy = 'penalize_to_floor'` per audit §d.
 *
 * Tests use the constructor `now?: () => number` seam to pin the clock
 * deterministically — no `Date.now()` reads in assertions.
 */

const VLADIMIR = asIdentityId("identity:vladimir");
const PINNED_NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20Z

function makePassthroughExtractor(): LlmExtractor {
  return {
    async extract(input): Promise<LlmExtractorDecision> {
      return {
        keep: true,
        normalized: input.content,
        tags: [],
      };
    },
  };
}

function makeKeepWithTagsExtractor(tags: readonly string[]): LlmExtractor {
  return {
    async extract(input): Promise<LlmExtractorDecision> {
      return {
        keep: true,
        normalized: input.content,
        tags,
      };
    },
  };
}

describe("LlmExtractorMemoryStore — recordedAt write (Phase 4 / Change 1)", () => {
  it("storeSemantic stamps metadata.recordedAt with the injected clock value (no caller-supplied tags)", async () => {
    const delegate = new InMemoryMemoryStore();
    const store = new LlmExtractorMemoryStore({
      delegate,
      extractor: makePassthroughExtractor(),
      now: () => PINNED_NOW_MS,
    });

    await store.storeSemantic({
      identityId: VLADIMIR,
      content: "user prefers dark mode",
    });

    const recall = await store.recall({
      identityId: VLADIMIR,
      query: "dark mode",
    });
    expect(recall.entries).toHaveLength(1);
    const recordedAt = recall.entries[0]?.metadata.recordedAt;
    expect(typeof recordedAt).toBe("number");
    expect(recordedAt).toBe(PINNED_NOW_MS);
  });

  it("storeSemantic stamps recordedAt alongside extractor_tags + caller metadata (additive merge)", async () => {
    const delegate = new InMemoryMemoryStore();
    const store = new LlmExtractorMemoryStore({
      delegate,
      extractor: makeKeepWithTagsExtractor(["preference", "ui"]),
      now: () => PINNED_NOW_MS,
    });

    await store.storeSemantic({
      identityId: VLADIMIR,
      content: "favourite editor",
      metadata: { source: "operator" },
    });

    const recall = await store.recall({
      identityId: VLADIMIR,
      query: "favourite",
    });
    expect(recall.entries).toHaveLength(1);
    const meta = recall.entries[0]!.metadata;
    expect(meta.source).toBe("operator");
    expect(meta.extractor_tags).toBe("preference,ui");
    expect(meta.recordedAt).toBe(PINNED_NOW_MS);
  });

  it("recordedAt defaults to Date.now when no `now` seam injected (positive number, not NaN)", async () => {
    const delegate = new InMemoryMemoryStore();
    const before = Date.now();
    const store = new LlmExtractorMemoryStore({
      delegate,
      extractor: makePassthroughExtractor(),
    });

    await store.storeSemantic({
      identityId: VLADIMIR,
      content: "untimed entry",
    });
    const after = Date.now();

    const recall = await store.recall({ identityId: VLADIMIR, query: "untimed" });
    const recordedAt = recall.entries[0]?.metadata.recordedAt;
    expect(typeof recordedAt).toBe("number");
    expect(Number.isFinite(recordedAt)).toBe(true);
    expect(recordedAt as number).toBeGreaterThanOrEqual(before);
    expect(recordedAt as number).toBeLessThanOrEqual(after);
  });

  it("extractor crash → passthrough write still stamps recordedAt (defense-in-depth)", async () => {
    const delegate = new InMemoryMemoryStore();
    const crashing: LlmExtractor = {
      async extract() {
        throw new Error("LLM provider timeout");
      },
    };
    const store = new LlmExtractorMemoryStore({
      delegate,
      extractor: crashing,
      now: () => PINNED_NOW_MS,
    });

    await store.storeSemantic({
      identityId: VLADIMIR,
      content: "boom",
    });

    const recall = await store.recall({ identityId: VLADIMIR, query: "boom" });
    expect(recall.entries).toHaveLength(1);
    expect(recall.entries[0]?.metadata.recordedAt).toBe(PINNED_NOW_MS);
  });

  it("dropped (keep:false) entries do NOT call the delegate — recordedAt stamp irrelevant", async () => {
    const delegate = new InMemoryMemoryStore();
    const dropping: LlmExtractor = {
      async extract(input): Promise<LlmExtractorDecision> {
        return { keep: false, normalized: input.content, tags: [] };
      },
    };
    const store = new LlmExtractorMemoryStore({
      delegate,
      extractor: dropping,
      now: () => PINNED_NOW_MS,
    });

    const id = await store.storeSemantic({
      identityId: VLADIMIR,
      content: "junk",
    });
    expect(id.startsWith("mem:dropped-")).toBe(true);

    const recall = await store.recall({ identityId: VLADIMIR, query: "junk" });
    expect(recall.entries).toEqual([]);
  });
});
