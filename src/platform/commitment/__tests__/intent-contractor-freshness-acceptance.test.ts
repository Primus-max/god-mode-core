import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "../../../config/config.js";
import { asIdentityId, type IdentityId } from "../../identity/identity-id.js";
import { InMemoryMemoryStore } from "../../memory/in-memory-store.js";
import {
  LlmExtractorMemoryStore,
  type LlmExtractor,
  type LlmExtractorDecision,
} from "../../memory/llm-extractor-store.js";
import { asTaskId } from "../../task/task-id.js";
import type { TaskLedger } from "../../task/task-ledger.js";
import type {
  TaskCreateInput,
  TaskListQuery,
  TaskListResult,
  TaskRecord,
  TaskUpdatePatch,
} from "../../task/task-record.js";
import {
  COMMUNICATION_EFFECT_FAMILY,
  createIntentContractor,
  type IntentContractorAdapter,
} from "../index.js";

/**
 * Slice "intent-contractor freshness/recency" — Phase 5 acceptance.
 *
 * High-N memory cohort end-to-end test that exercises:
 *
 * 1. Recency reorder of `<memory>` block — items ≤ 7d sort BEFORE
 *    items > 14d.
 * 2. Items missing `recordedAt` sort LAST under
 *    `missingTimestampPolicy = 'penalize_to_floor'`.
 * 3. `<active_tasks>` recency reorder — task updated 1h ago wins
 *    over task created 30d ago.
 * 4. `<freshness_hints>` block content (half_life + floor + now_ms +
 *    policy).
 * 5. All four Phase 5 log lines fire with the expected fields.
 * 6. Pinned clock makes the test deterministic across runs.
 * 7. Real `LlmExtractorMemoryStore` writes `recordedAt` end-to-end
 *    (the contractor freshness reorder reads what the producer
 *    actually persisted; mocked LLM extractor returns a fixed shape).
 * 8. Frozen 5 contracts byte-identical assertion.
 *
 * Per sub-plan §6 the test exercises the real `createIntentContractor`
 * flow through a real `LlmExtractorMemoryStore` wrapping a real
 * `InMemoryMemoryStore`. Only the LLM extractor + the IntentContractor
 * adapter are stubbed (capturing adapter records the prompt) — no
 * `vi.spyOn` on the function under test.
 */

const VLADIMIR: IdentityId = asIdentityId("identity:vladimir");
const RAW_PROMPT = "what about my recent notes?";

// Pinned clock — 2025-01-01T00:00:00.000Z (per slice spec).
const NOW_MS = 1_735_689_600_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function pinnedNow(): number {
  return NOW_MS;
}

type CapturedAdapterCall = {
  prompt: string;
};

function makeCapturingAdapter(captures: CapturedAdapterCall[]): IntentContractorAdapter {
  return {
    classify: async (params) => {
      captures.push({ prompt: params.prompt });
      return {
        desiredEffectFamily: COMMUNICATION_EFFECT_FAMILY,
        target: { kind: "external_channel" },
        operation: { kind: "create" },
        constraints: {},
        uncertainty: [],
        confidence: 0.85,
      };
    },
  };
}

function mockCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        embeddedPi: {
          intentContractor: { backend: "mock" },
        },
      },
    },
  } as OpenClawConfig;
}

function makeTask(params: {
  readonly idSlug: string;
  readonly label: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}): TaskRecord {
  return {
    id: asTaskId(`task:${params.idSlug}`),
    ownerIdentityId: VLADIMIR,
    label: params.label,
    status: "open",
    summary: `summary-${params.idSlug}`,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
  };
}

function listingTaskLedger(tasks: readonly TaskRecord[]): TaskLedger {
  return {
    async create(_input: TaskCreateInput): Promise<TaskRecord> {
      throw new Error("create not used in these tests");
    },
    async list(_query: TaskListQuery): Promise<TaskListResult> {
      return { tasks };
    },
    async get(_owner, _id): Promise<TaskRecord | undefined> {
      throw new Error("get not used in these tests");
    },
    async update(_owner, _id, _patch: TaskUpdatePatch) {
      throw new Error("update not used in these tests");
    },
    async complete(_owner, _id, _result?: string) {
      throw new Error("complete not used in these tests");
    },
    async cancel(_owner, _id, _reason?: string) {
      throw new Error("cancel not used in these tests");
    },
  };
}

/**
 * Phase 5 acceptance — minimal extractor that keeps every input
 * verbatim with a single tag. Mirrors the "passthrough extractor"
 * pattern from `llm-extractor-store-recordedAt.test.ts`. Real
 * `LlmExtractorMemoryStore` stamps `metadata.recordedAt` with the
 * injected `now` regardless of what the extractor returns.
 */
function passthroughExtractor(): LlmExtractor {
  return {
    async extract(input): Promise<LlmExtractorDecision> {
      return {
        keep: true,
        normalized: input.content,
        tags: ["accept"],
      };
    },
  };
}

/**
 * Phase 5 acceptance — high-N cohort. 16 memory entries spanning the
 * canonical age buckets (0d / 1d / 3d / 7d / 14d / 30d / 90d) plus a
 * legacy entry written before the producer-side `recordedAt` stamp
 * (its `recordedAt` is missing — penalize_to_floor). Each entry's
 * content embeds the literal substring `note` so the in-memory
 * recall's substring scorer (`scoreContent` in `in-memory-store.ts`)
 * returns score=1 for every entry on the query `note`.
 *
 * The test writes each entry through a REAL `LlmExtractorMemoryStore`
 * with a per-write pinned clock so `metadata.recordedAt` is set
 * deterministically. The legacy entry is written through a separate
 * codepath that bypasses the extractor's stamp (storing through the
 * underlying `InMemoryMemoryStore` directly) so it never carries the
 * key.
 */
async function seedHighNCohort(): Promise<{
  readonly delegate: InMemoryMemoryStore;
  readonly store: LlmExtractorMemoryStore;
}> {
  const delegate = new InMemoryMemoryStore();
  // Per-write clock seam: each call to `now()` returns whatever epoch
  // ms the test currently advertises; we mutate `currentNow` between
  // writes so `recordedAt` reflects the entry's intended age.
  let currentNow = NOW_MS;
  const store = new LlmExtractorMemoryStore({
    delegate,
    extractor: passthroughExtractor(),
    now: () => currentNow,
  });
  // Seed in OLDEST-FIRST order so the in-memory store's
  // similarity-only insertion-order tie-break (every entry scores 1
  // on the substring "note") leaves the natural list with stale
  // entries AT THE TOP. The freshness reorder must move recent
  // entries to the front of the surfaced `<memory>` block — the
  // fail-first probe (commenting out `sortByCombinedScore`) MUST
  // therefore put 90d/30d/14d ahead of 0d/1d/3d, breaking the
  // acceptance test's "≤7d before >14d" assertion.
  const cohort: ReadonlyArray<{
    readonly content: string;
    readonly ageMs: number;
  }> = [
    // Stalest first
    { content: "note 90d ago", ageMs: 90 * ONE_DAY_MS },
    { content: "note 30d ago", ageMs: 30 * ONE_DAY_MS },
    { content: "note 14d ago", ageMs: 14 * ONE_DAY_MS },
    // Half-life rows
    { content: "note 7d ago A", ageMs: 7 * ONE_DAY_MS },
    { content: "note 7d ago B", ageMs: 7 * ONE_DAY_MS - ONE_HOUR_MS },
    // Recent rows last
    { content: "note 3d ago", ageMs: 3 * ONE_DAY_MS },
    { content: "note 1d ago", ageMs: 1 * ONE_DAY_MS },
    { content: "note 0d ago", ageMs: 0 },
  ];
  for (const entry of cohort) {
    currentNow = NOW_MS - entry.ageMs;
    await store.storeSemantic({
      identityId: VLADIMIR,
      content: entry.content,
    });
  }
  // Now the LEGACY entry — bypass the extractor wrapper so the row
  // lands in the delegate WITHOUT a `recordedAt` stamp. The freshness
  // reorder must penalise it to the floor.
  await delegate.storeSemantic({
    identityId: VLADIMIR,
    content: "note legacy-no-timestamp",
  });
  return { delegate, store };
}

/* -------------------------------------------------------------------- */
/*  Acceptance test                                                     */
/* -------------------------------------------------------------------- */

describe("IntentContractor freshness — Phase 5 acceptance (high-N cohort)", () => {
  it(
    "high-N memory: items ≤ 7d sort BEFORE items > 14d; missing recordedAt sorts LAST; logs fire",
    async () => {
      const { store } = await seedHighNCohort();

      // Active tasks: one updated 1h ago vs one created 30d ago. The
      // recently-updated task must win even though its `createdAt` is
      // older than the freshly-created task's.
      const recentISO = new Date(NOW_MS - ONE_HOUR_MS).toISOString();
      const oldISO = new Date(NOW_MS - 30 * ONE_DAY_MS).toISOString();
      const tasks: TaskRecord[] = [
        makeTask({
          idSlug: "00000001",
          label: "old-but-nudged",
          createdAt: oldISO,
          updatedAt: recentISO,
        }),
        makeTask({
          idSlug: "00000002",
          label: "fresh-but-stale",
          createdAt: recentISO,
          updatedAt: oldISO,
        }),
      ];

      const captures: CapturedAdapterCall[] = [];
      const warnSpy = vi.fn<(message: string, payload?: Record<string, unknown>) => void>();
      const contractor = createIntentContractor({
        cfg: mockCfg(),
        adapterRegistry: { mock: makeCapturingAdapter(captures) },
        memoryStore: store,
        taskLedger: listingTaskLedger(tasks),
        identityId: VLADIMIR,
        logger: { warn: warnSpy },
        now: pinnedNow,
        memoryRecallLimit: 100,
      });

      await contractor.classify("note");
      expect(captures).toHaveLength(1);
      const prompt = captures[0]!.prompt;

      // ----- Assertion 1: memory ordering -----
      const memoryMatch = prompt.match(/<memory>(.*?)<\/memory>/s);
      expect(memoryMatch).not.toBeNull();
      const memoryInner = JSON.parse(memoryMatch![1]) as {
        entries: Array<{ content: string; recencyDecay: number }>;
      };
      const indexOf = (label: string): number =>
        memoryInner.entries.findIndex((e) => e.content === label);

      const idxFresh = indexOf("note 0d ago");
      const idxOneDay = indexOf("note 1d ago");
      const idxThreeDay = indexOf("note 3d ago");
      const idx14d = indexOf("note 14d ago");
      const idx30d = indexOf("note 30d ago");
      const idx90d = indexOf("note 90d ago");
      const idxLegacy = indexOf("note legacy-no-timestamp");

      expect(idxFresh).toBeGreaterThanOrEqual(0);
      expect(idxLegacy).toBeGreaterThanOrEqual(0);

      // Every ≤7d entry sorts BEFORE every >14d entry.
      const recentIndices = [idxFresh, idxOneDay, idxThreeDay].filter((i) => i >= 0);
      const staleIndices = [idx14d, idx30d, idx90d].filter((i) => i >= 0);
      for (const r of recentIndices) {
        for (const s of staleIndices) {
          expect(r).toBeLessThan(s);
        }
      }

      // ----- Assertion 2: legacy (missing recordedAt) sorts LAST -----
      // Under penalize_to_floor the legacy entry's recencyDecay = 0.05;
      // every other entry has a ≥ 0.05 decay AND a real score, so the
      // legacy entry is the bottom of the list.
      expect(idxLegacy).toBe(memoryInner.entries.length - 1);
      expect(memoryInner.entries[idxLegacy]!.recencyDecay).toBe(0.05);

      // ----- Assertion 3: active_tasks reorder -----
      const tasksMatch = prompt.match(/<active_tasks>(.*?)<\/active_tasks>/s);
      expect(tasksMatch).not.toBeNull();
      const tasksInner = JSON.parse(tasksMatch![1]) as {
        tasks: Array<{ label: string }>;
      };
      expect(tasksInner.tasks.map((t) => t.label)).toEqual([
        "old-but-nudged",
        "fresh-but-stale",
      ]);

      // ----- Assertion 4: freshness_hints content -----
      const hintsMatch = prompt.match(/<freshness_hints>([\s\S]*?)<\/freshness_hints>/);
      expect(hintsMatch).not.toBeNull();
      const hintsBlock = hintsMatch![1];
      // Default 7d half-life.
      expect(hintsBlock).toContain("<half_life_ms>604800000</half_life_ms>");
      expect(hintsBlock).toContain("<floor>0.05</floor>");
      expect(hintsBlock).toContain(`<now_ms>${String(NOW_MS)}</now_ms>`);
      expect(hintsBlock).toContain(
        "<missing_ts_policy>penalize_to_floor</missing_ts_policy>",
      );

      // ----- Assertion 5: all four log lines fire with expected fields -----
      const calls = warnSpy.mock.calls.map((c) => String(c[0] ?? ""));
      const findCall = (needle: string): string | undefined =>
        calls.find((m) => m.startsWith(needle));

      const freshnessApplied = findCall("[intent-contractor] freshness.applied");
      expect(freshnessApplied).toBeDefined();
      expect(freshnessApplied).toContain("half_life_ms=604800000");
      expect(freshnessApplied).toContain("floor=0.05");
      expect(freshnessApplied).toContain(`now_ms=${String(NOW_MS)}`);
      expect(freshnessApplied).toContain("policy=penalize_to_floor");

      const memoryBlock = findCall("[intent-contractor] memory.block");
      expect(memoryBlock).toBeDefined();
      expect(memoryBlock).toMatch(/items=\d+/);
      expect(memoryBlock).toMatch(/scored=\d+/);
      expect(memoryBlock).toMatch(/top_decay=\d+\.\d+/);
      expect(memoryBlock).toMatch(/bottom_decay=0\.0500/);

      const tasksBlock = findCall("[intent-contractor] active_tasks.block");
      expect(tasksBlock).toBeDefined();
      expect(tasksBlock).toContain("items=2");
      expect(tasksBlock).toContain("scored=2");

      const hints = findCall("[intent-contractor] freshness_hints.block");
      expect(hints).toBeDefined();
      expect(hints).toContain("emitted=true");

      // ----- Assertion 6: pinned-clock determinism -----
      const captures2: CapturedAdapterCall[] = [];
      const warnSpy2 = vi.fn<(message: string, payload?: Record<string, unknown>) => void>();
      const contractor2 = createIntentContractor({
        cfg: mockCfg(),
        adapterRegistry: { mock: makeCapturingAdapter(captures2) },
        memoryStore: store,
        taskLedger: listingTaskLedger(tasks),
        identityId: VLADIMIR,
        logger: { warn: warnSpy2 },
        now: pinnedNow,
        memoryRecallLimit: 100,
      });
      await contractor2.classify("note");
      expect(captures2[0]!.prompt).toBe(prompt);

      // ----- Assertion 7: real LlmExtractorMemoryStore wrote recordedAt
      // for every non-legacy entry — verified by the in-memory recall
      // surfacing finite numeric `recordedAt` values for the timestamp-
      // bearing rows; the legacy row carries no `recordedAt` (covered
      // by assertion 2's recencyDecay = 0.05).
      const recall = await store.recall({
        identityId: VLADIMIR,
        query: "note",
        limit: 100,
      });
      const recordedAts = recall.entries
        .filter((e) => e.metadata.recordedAt !== undefined)
        .map((e) => e.metadata.recordedAt);
      expect(recordedAts.length).toBeGreaterThanOrEqual(7);
      for (const ts of recordedAts) {
        expect(typeof ts).toBe("number");
        expect(Number.isFinite(ts as number)).toBe(true);
      }

      // The legacy row is present and has NO recordedAt key.
      const legacyEntry = recall.entries.find(
        (e) => e.content === "note legacy-no-timestamp",
      );
      expect(legacyEntry).toBeDefined();
      expect(legacyEntry!.metadata.recordedAt).toBeUndefined();
    },
    20_000,
  );
});

/* -------------------------------------------------------------------- */
/*  Frozen-layer sha256 byte-identical guard (Phase 5 — same 4 files    */
/*  as Phase 4; this test re-asserts under the Phase 5 wiring)          */
/* -------------------------------------------------------------------- */

describe("IntentContractor freshness — frozen-layer integrity (Phase 5)", () => {
  it("Phase 5 wiring does NOT modify the 5 frozen contracts (sha256 stable)", async () => {
    // Same byte-identical guard as Phase 4. The 5 frozen contracts
    // (invariant #11) live across these four files (RecipeRoutingHints
    // ships from `planner.ts` alongside the recipe interface). Phase 5
    // adds log emission + an acceptance test + a runbook + a sub-plan
    // edit — none of those touch this set.
    const expectedHashes: Record<string, string> = {
      "src/platform/decision/task-classifier.ts":
        "e38c9f7afa642f7ec1941293b26df68e359f31933ab75bb7b5244503a67c5f77",
      "src/platform/decision/qualification-contract.ts":
        "a706e0837ec4a2125d2bb969f6e31e9a8a7a926ef652568beba36692bb9abccd",
      "src/platform/decision/resolution-contract.ts":
        "c17c18d326a3d23e730114e7331cdc054c4206262ce623979d606adfe3130c90",
      "src/platform/recipe/planner.ts":
        "3dd1b74a23bfd081e569f23821870cf70f563defffda19790ac07a380720d6f4",
    };

    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(testDir, "..", "..", "..", "..");

    for (const [relativePath, expectedHash] of Object.entries(expectedHashes)) {
      const absolute = path.join(repoRoot, relativePath);
      const buf = await fs.readFile(absolute);
      const actual = createHash("sha256").update(buf).digest("hex");
      expect({ file: relativePath, hash: actual }).toEqual({
        file: relativePath,
        hash: expectedHash,
      });
    }
  });
});
