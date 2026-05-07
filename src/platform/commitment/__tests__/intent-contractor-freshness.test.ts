import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { OpenClawConfig } from "../../../config/config.js";
import { asIdentityId, type IdentityId } from "../../identity/identity-id.js";
import { asMemoryEntryId } from "../../memory/memory-entry-id.js";
import type {
  EpisodicMemoryEvent,
  MemoryListQuery,
  MemoryListResult,
  MemoryRecallResult,
  MemoryStore,
  SemanticMemoryEntry,
  SemanticMemoryMetadata,
  SemanticMemoryQuery,
  SemanticMemoryWrite,
} from "../../memory/index.js";
import { asTaskId } from "../../task/task-id.js";
import type { TaskLedger } from "../../task/task-ledger.js";
import type {
  TaskCreateInput,
  TaskListQuery,
  TaskListResult,
  TaskRecord,
  TaskStatus,
  TaskUpdatePatch,
} from "../../task/task-record.js";
import {
  COMMUNICATION_EFFECT_FAMILY,
  createIntentContractor,
  type IntentContractorAdapter,
} from "../index.js";

/**
 * Slice "intent-contractor freshness/recency" — Phase 4.
 *
 * Tests the recency-aware reordering wired into `<memory>` and
 * `<active_tasks>` block builders, the new `<freshness_hints>` block,
 * the additive `now?` + `freshnessConfig?` deps on
 * `createIntentContractor`, and the frozen-layer integrity guard.
 *
 * Per sub-plan §6, no `vi.spyOn` on the function under test —
 * everything is exercised through real wiring with deterministic
 * stubs (memory store + task ledger + capturing adapter + injected
 * `now`).
 */

const VLADIMIR: IdentityId = asIdentityId("identity:vladimir");
const RAW_PROMPT = "what should I work on next?";

const NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20Z
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

function makeMemoryEntry(
  index: number,
  content: string,
  metadata: SemanticMemoryMetadata,
  score: number,
): SemanticMemoryEntry {
  return {
    id: asMemoryEntryId(`mem:test-${String(index)}`),
    identityId: VLADIMIR,
    content,
    metadata,
    score,
  };
}

function recallingMemoryStore(entries: readonly SemanticMemoryEntry[]): MemoryStore {
  return {
    async recall(_query: SemanticMemoryQuery): Promise<MemoryRecallResult> {
      return { entries };
    },
    async storeEpisodic(_event: EpisodicMemoryEvent) {
      throw new Error("storeEpisodic not used in these tests");
    },
    async storeSemantic(_write: SemanticMemoryWrite) {
      throw new Error("storeSemantic not used in these tests");
    },
    async list(_query: MemoryListQuery): Promise<MemoryListResult> {
      return { episodic: [], semantic: [] };
    },
    async forget() {
      // no-op
    },
  };
}

function makeTask(params: {
  readonly idSlug: string;
  readonly label: string;
  readonly status: TaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}): TaskRecord {
  return {
    id: asTaskId(`task:${params.idSlug}`),
    ownerIdentityId: VLADIMIR,
    label: params.label,
    status: params.status,
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

/* -------------------------------------------------------------------- */
/*  <memory> block — recency reorder                                    */
/* -------------------------------------------------------------------- */

describe("IntentContractor freshness — <memory> block recency reorder", () => {
  it("memory entries with recent recordedAt sort BEFORE older ones (decay reorder)", async () => {
    const captures: CapturedAdapterCall[] = [];
    const recentMs = NOW_MS - ONE_HOUR_MS; // very fresh
    const oldMs = NOW_MS - 30 * ONE_DAY_MS; // ~4.3 half-lives at 7d → floored
    // Caller-supplied score of OLD is HIGHER than RECENT — the
    // freshness reorder must override the similarity-only ranking
    // because `combinedScore = score * recencyDecay`.
    const entries: SemanticMemoryEntry[] = [
      makeMemoryEntry(1, "stale-but-high-score", { recordedAt: oldMs }, 0.95),
      makeMemoryEntry(2, "fresh-content", { recordedAt: recentMs }, 0.5),
    ];
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore: recallingMemoryStore(entries),
      identityId: VLADIMIR,
      now: pinnedNow,
    });

    await contractor.classify(RAW_PROMPT);
    const prompt = captures[0]!.prompt;
    const memoryMatch = prompt.match(/<memory>(.*?)<\/memory>/s);
    expect(memoryMatch).not.toBeNull();
    const inner = JSON.parse(memoryMatch![1]) as {
      entries: Array<{ id: string; content: string; recencyDecay: number }>;
    };
    expect(inner.entries.map((e) => e.content)).toEqual([
      "fresh-content",
      "stale-but-high-score",
    ]);
    // recencyDecay payload extension landed on every entry.
    expect(inner.entries[0]!.recencyDecay).toBeGreaterThan(inner.entries[1]!.recencyDecay);
    // Fresh entry's decay is close to 1.0 (one hour ≪ 7-day half-life).
    expect(inner.entries[0]!.recencyDecay).toBeGreaterThan(0.99);
  });

  it("memory item missing recordedAt + penalize_to_floor → sorts last with DECAY_FLOOR", async () => {
    const captures: CapturedAdapterCall[] = [];
    const entries: SemanticMemoryEntry[] = [
      // Missing recordedAt → floor at 0.05; combinedScore ≈ 0.95*0.05 = 0.0475
      makeMemoryEntry(1, "legacy-no-timestamp", {}, 0.95),
      // Fresh, high decay (~1.0); combinedScore ≈ 0.5*1.0 = 0.5
      makeMemoryEntry(2, "fresh-low-score", { recordedAt: NOW_MS - ONE_HOUR_MS }, 0.5),
      // Mid-age: 14 days ≈ 2 half-lives, decay = 0.25; combinedScore ≈ 0.7*0.25 = 0.175
      makeMemoryEntry(3, "mid-age", { recordedAt: NOW_MS - 14 * ONE_DAY_MS }, 0.7),
    ];
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore: recallingMemoryStore(entries),
      identityId: VLADIMIR,
      now: pinnedNow,
    });

    await contractor.classify(RAW_PROMPT);
    const prompt = captures[0]!.prompt;
    const memoryMatch = prompt.match(/<memory>(.*?)<\/memory>/s);
    const inner = JSON.parse(memoryMatch![1]) as {
      entries: Array<{ content: string; recencyDecay: number }>;
    };
    expect(inner.entries.map((e) => e.content)).toEqual([
      "fresh-low-score",
      "mid-age",
      "legacy-no-timestamp",
    ]);
    // Floor entry's recencyDecay equals DECAY_FLOOR (0.05).
    expect(inner.entries[2]!.recencyDecay).toBe(0.05);
  });

  it("custom freshnessConfig: 1h half-life shrinks the window — older entries collapse to floor faster", async () => {
    // With default 7d half-life, a 6h-old entry has decay ≈ 0.964.
    // With a 1h half-life, the same 6h-old entry decays to floor (0.05).
    const captures: CapturedAdapterCall[] = [];
    const sixHoursAgo = NOW_MS - 6 * ONE_HOUR_MS;
    const halfHourAgo = NOW_MS - 30 * 60 * 1000;
    const entries: SemanticMemoryEntry[] = [
      makeMemoryEntry(1, "six-hours-ago-high-score", { recordedAt: sixHoursAgo }, 0.95),
      makeMemoryEntry(2, "half-hour-ago-low-score", { recordedAt: halfHourAgo }, 0.5),
    ];

    const defaultContractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore: recallingMemoryStore(entries),
      identityId: VLADIMIR,
      now: pinnedNow,
    });
    await defaultContractor.classify(RAW_PROMPT);
    const defaultMatch = captures[0]!.prompt.match(/<memory>(.*?)<\/memory>/s);
    const defaultInner = JSON.parse(defaultMatch![1]) as {
      entries: Array<{ content: string; recencyDecay: number }>;
    };
    // 7d half-life: combinedScore six-hours = 0.95*~0.964 ≈ 0.916
    //                              half-hour = 0.5*~0.997 ≈ 0.498
    // → older but high-score entry wins.
    expect(defaultInner.entries[0]!.content).toBe("six-hours-ago-high-score");

    captures.length = 0;
    const tightContractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore: recallingMemoryStore(entries),
      identityId: VLADIMIR,
      now: pinnedNow,
      freshnessConfig: { decayHalfLifeMs: ONE_HOUR_MS },
    });
    await tightContractor.classify(RAW_PROMPT);
    const tightMatch = captures[0]!.prompt.match(/<memory>(.*?)<\/memory>/s);
    const tightInner = JSON.parse(tightMatch![1]) as {
      entries: Array<{ content: string; recencyDecay: number }>;
    };
    // 1h half-life: combinedScore six-hours = 0.95*0.05 (floor) = 0.0475
    //                              half-hour = 0.5*~0.707 ≈ 0.354
    // → ranking inverts.
    expect(tightInner.entries[0]!.content).toBe("half-hour-ago-low-score");
  });

  it("default config (omitted freshnessConfig) applies 7-day half-life", async () => {
    const captures: CapturedAdapterCall[] = [];
    // One entry exactly one half-life old → recencyDecay should be exactly 0.5.
    const sevenDaysAgo = NOW_MS - 7 * ONE_DAY_MS;
    const entries: SemanticMemoryEntry[] = [
      makeMemoryEntry(1, "seven-days-old", { recordedAt: sevenDaysAgo }, 1.0),
    ];
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore: recallingMemoryStore(entries),
      identityId: VLADIMIR,
      now: pinnedNow,
      // freshnessConfig omitted — defaults applied.
    });

    await contractor.classify(RAW_PROMPT);
    const prompt = captures[0]!.prompt;
    const memoryMatch = prompt.match(/<memory>(.*?)<\/memory>/s);
    const inner = JSON.parse(memoryMatch![1]) as {
      entries: Array<{ recencyDecay: number }>;
    };
    expect(inner.entries[0]!.recencyDecay).toBeCloseTo(0.5, 6);
  });

  it("recordedAt accepts numeric epoch ms (matches producer-side stamp from llm-extractor-store)", async () => {
    const captures: CapturedAdapterCall[] = [];
    // Producer stamps `recordedAt` as a `number` (epoch ms) — this
    // test confirms the contractor's freshness extractor reads numeric
    // timestamps directly without parsing.
    const entries: SemanticMemoryEntry[] = [
      makeMemoryEntry(1, "numeric-ts", { recordedAt: NOW_MS - ONE_HOUR_MS }, 0.5),
    ];
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore: recallingMemoryStore(entries),
      identityId: VLADIMIR,
      now: pinnedNow,
    });

    await contractor.classify(RAW_PROMPT);
    const memoryMatch = captures[0]!.prompt.match(/<memory>(.*?)<\/memory>/s);
    const inner = JSON.parse(memoryMatch![1]) as {
      entries: Array<{ recencyDecay: number }>;
    };
    expect(inner.entries[0]!.recencyDecay).toBeGreaterThan(0.99);
  });
});

/* -------------------------------------------------------------------- */
/*  <active_tasks> block — recency reorder                              */
/* -------------------------------------------------------------------- */

describe("IntentContractor freshness — <active_tasks> block recency reorder", () => {
  it("task with recent updatedAt sorts BEFORE task with stale updatedAt (createdAt ignored)", async () => {
    const captures: CapturedAdapterCall[] = [];
    const recentISO = new Date(NOW_MS - ONE_HOUR_MS).toISOString();
    const oldISO = new Date(NOW_MS - 30 * ONE_DAY_MS).toISOString();
    // Task A has the OLDER createdAt but RECENT updatedAt → wins.
    const tasks: TaskRecord[] = [
      makeTask({
        idSlug: "00000001",
        label: "old-but-nudged",
        status: "open",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: recentISO,
      }),
      makeTask({
        idSlug: "00000002",
        label: "recently-created-stale",
        status: "open",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: oldISO,
      }),
    ];
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      taskLedger: listingTaskLedger(tasks),
      identityId: VLADIMIR,
      now: pinnedNow,
    });

    await contractor.classify(RAW_PROMPT);
    const prompt = captures[0]!.prompt;
    const tasksMatch = prompt.match(/<active_tasks>(.*?)<\/active_tasks>/s);
    expect(tasksMatch).not.toBeNull();
    const inner = JSON.parse(tasksMatch![1]) as {
      tasks: Array<{ label: string }>;
    };
    expect(inner.tasks.map((t) => t.label)).toEqual([
      "old-but-nudged",
      "recently-created-stale",
    ]);
  });

  it("identical updatedAt across tasks → stable order (no reorder thrash)", async () => {
    const captures: CapturedAdapterCall[] = [];
    const sameUpdatedISO = new Date(NOW_MS - ONE_HOUR_MS).toISOString();
    const tasks: TaskRecord[] = [
      makeTask({
        idSlug: "00000001",
        label: "alpha",
        status: "open",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: sameUpdatedISO,
      }),
      makeTask({
        idSlug: "00000002",
        label: "beta",
        status: "open",
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: sameUpdatedISO,
      }),
    ];
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      taskLedger: listingTaskLedger(tasks),
      identityId: VLADIMIR,
      now: pinnedNow,
    });

    await contractor.classify(RAW_PROMPT);
    const prompt = captures[0]!.prompt;
    const tasksMatch = prompt.match(/<active_tasks>(.*?)<\/active_tasks>/s);
    const inner = JSON.parse(tasksMatch![1]) as {
      tasks: Array<{ id: string }>;
    };
    expect(inner.tasks).toHaveLength(2);
    // With equal updatedAt the freshness reorder is stable; the
    // builder's defensive secondary sort still applies the
    // createdAt-DESC fallback (newest createdAt first).
    expect(inner.tasks[0]!.id).toBe("task:00000002");
  });
});

/* -------------------------------------------------------------------- */
/*  <freshness_hints> block                                             */
/* -------------------------------------------------------------------- */

describe("IntentContractor freshness — <freshness_hints> block", () => {
  it("emits <freshness_hints> when memory recall surfaces ≥1 entry (default config)", async () => {
    const captures: CapturedAdapterCall[] = [];
    const entries: SemanticMemoryEntry[] = [
      makeMemoryEntry(1, "ent", { recordedAt: NOW_MS - ONE_HOUR_MS }, 0.7),
    ];
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore: recallingMemoryStore(entries),
      identityId: VLADIMIR,
      now: pinnedNow,
    });

    await contractor.classify(RAW_PROMPT);
    const prompt = captures[0]!.prompt;
    expect(prompt).toContain("<freshness_hints>");
    expect(prompt).toContain("</freshness_hints>");
    // Block carries decoded defaults: 7d half-life, missing-policy.
    const hintsMatch = prompt.match(/<freshness_hints>([\s\S]*?)<\/freshness_hints>/);
    expect(hintsMatch).not.toBeNull();
    const block = hintsMatch![1];
    expect(block).toContain("<half_life_ms>604800000</half_life_ms>");
    expect(block).toContain(`<now_ms>${String(NOW_MS)}</now_ms>`);
    expect(block).toContain("<missing_ts_policy>penalize_to_floor</missing_ts_policy>");
    expect(block).toContain("<floor>0.05</floor>");
  });

  it("emits <freshness_hints> when only active_tasks surfaces (no memory recall)", async () => {
    const captures: CapturedAdapterCall[] = [];
    const tasks: TaskRecord[] = [
      makeTask({
        idSlug: "00000001",
        label: "one-task",
        status: "open",
        createdAt: "2026-05-05T10:00:00.000Z",
        updatedAt: "2026-05-05T10:00:00.000Z",
      }),
    ];
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      taskLedger: listingTaskLedger(tasks),
      identityId: VLADIMIR,
      now: pinnedNow,
    });

    await contractor.classify(RAW_PROMPT);
    expect(captures[0]!.prompt).toContain("<freshness_hints>");
  });

  it("OMITS <freshness_hints> when neither recall surfaces anything", async () => {
    const captures: CapturedAdapterCall[] = [];
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore: recallingMemoryStore([]),
      taskLedger: listingTaskLedger([]),
      identityId: VLADIMIR,
      now: pinnedNow,
    });

    await contractor.classify(RAW_PROMPT);
    const prompt = captures[0]!.prompt;
    expect(prompt).not.toContain("<freshness_hints>");
    expect(prompt).not.toContain("</freshness_hints>");
    expect(prompt).toBe(RAW_PROMPT);
  });

  it("custom freshnessConfig surfaces in <freshness_hints> block (operator-tunable)", async () => {
    const captures: CapturedAdapterCall[] = [];
    const entries: SemanticMemoryEntry[] = [
      makeMemoryEntry(1, "ent", { recordedAt: NOW_MS - ONE_HOUR_MS }, 0.7),
    ];
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore: recallingMemoryStore(entries),
      identityId: VLADIMIR,
      now: pinnedNow,
      freshnessConfig: {
        decayHalfLifeMs: 12 * ONE_HOUR_MS,
        missingTimestampPolicy: "treat_as_now",
      },
    });

    await contractor.classify(RAW_PROMPT);
    const prompt = captures[0]!.prompt;
    const hintsMatch = prompt.match(/<freshness_hints>([\s\S]*?)<\/freshness_hints>/);
    const block = hintsMatch![1];
    expect(block).toContain(`<half_life_ms>${String(12 * ONE_HOUR_MS)}</half_life_ms>`);
    expect(block).toContain("<missing_ts_policy>treat_as_now</missing_ts_policy>");
  });
});

/* -------------------------------------------------------------------- */
/*  Determinism + clock seam                                            */
/* -------------------------------------------------------------------- */

describe("IntentContractor freshness — clock seam determinism", () => {
  it("pinned `now` makes the freshness output reproducible across runs", async () => {
    const entries: SemanticMemoryEntry[] = [
      makeMemoryEntry(1, "first", { recordedAt: NOW_MS - 2 * ONE_HOUR_MS }, 0.6),
      makeMemoryEntry(2, "second", { recordedAt: NOW_MS - 1 * ONE_HOUR_MS }, 0.6),
    ];

    const captures1: CapturedAdapterCall[] = [];
    const c1 = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures1) },
      memoryStore: recallingMemoryStore(entries),
      identityId: VLADIMIR,
      now: pinnedNow,
    });
    await c1.classify(RAW_PROMPT);

    const captures2: CapturedAdapterCall[] = [];
    const c2 = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures2) },
      memoryStore: recallingMemoryStore(entries),
      identityId: VLADIMIR,
      now: pinnedNow,
    });
    await c2.classify(RAW_PROMPT);

    expect(captures1[0]!.prompt).toBe(captures2[0]!.prompt);
  });

  it("now defaults to Date.now when unspecified (does not throw)", async () => {
    // Sanity: omitting `now` exercises the default-to-Date.now branch.
    // Block content is non-deterministic but the call must succeed.
    const captures: CapturedAdapterCall[] = [];
    const entries: SemanticMemoryEntry[] = [
      makeMemoryEntry(1, "ent", { recordedAt: Date.now() - ONE_HOUR_MS }, 0.7),
    ];
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore: recallingMemoryStore(entries),
      identityId: VLADIMIR,
      // now omitted
    });

    await expect(contractor.classify(RAW_PROMPT)).resolves.toBeTruthy();
    expect(captures[0]!.prompt).toContain("<memory>");
    expect(captures[0]!.prompt).toContain("<freshness_hints>");
  });
});

/* -------------------------------------------------------------------- */
/*  Frozen-layer sha256 byte-identical guard                            */
/* -------------------------------------------------------------------- */

describe("IntentContractor freshness — frozen-layer integrity", () => {
  it("Phase 4 wiring does NOT modify the 5 frozen contracts (sha256 stable)", async () => {
    // The 5 contracts frozen by invariant #11. Phase 4 lands additive
    // deps on `createIntentContractor`; these 5 files MUST stay
    // byte-identical to dev SHA `56742aaeb1` (predecessor for Phase 4).
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
    // testDir = .../src/platform/commitment/__tests__ → repoRoot four levels up.
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
