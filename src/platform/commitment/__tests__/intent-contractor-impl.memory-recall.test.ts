import { describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "../../../config/config.js";
import { asIdentityId } from "../../identity/identity-id.js";
import { asMemoryEntryId } from "../../memory/memory-entry-id.js";
import type {
  EpisodicMemoryEvent,
  MemoryListQuery,
  MemoryListResult,
  MemoryRecallResult,
  MemoryStore,
  SemanticMemoryEntry,
  SemanticMemoryQuery,
  SemanticMemoryWrite,
} from "../../memory/index.js";
import {
  COMMUNICATION_EFFECT_FAMILY,
  PERSISTENT_SESSION_EFFECT_FAMILY,
  UNKNOWN_EFFECT_FAMILY,
  createIntentContractor,
  type IntentContractorAdapter,
} from "../index.js";
import type { EffectFamilyId } from "../ids.js";

const RAW_PROMPT = "what reminders do I have?";

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

function makeSemanticEntry(
  identityId: ReturnType<typeof asIdentityId>,
  index: number,
  content: string,
): SemanticMemoryEntry {
  return {
    id: asMemoryEntryId(`mem:test-${String(index)}`),
    identityId,
    content,
    metadata: {},
    score: 1 - index * 0.1,
  };
}

function recallingMemoryStore(
  entries: readonly SemanticMemoryEntry[],
  recallSpy?: (query: SemanticMemoryQuery) => void,
): MemoryStore {
  return {
    async recall(query: SemanticMemoryQuery): Promise<MemoryRecallResult> {
      recallSpy?.(query);
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
      // no-op for tests
    },
  };
}

function failingMemoryStore(
  recallSpy: (query: SemanticMemoryQuery) => void,
  failure: Error,
): MemoryStore {
  return {
    async recall(query: SemanticMemoryQuery): Promise<MemoryRecallResult> {
      recallSpy(query);
      throw failure;
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
      // no-op for tests
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

describe("IntentContractor memory recall (slice E Phase 6)", () => {
  it("regression: contractor with NO memoryStore dep behaves byte-identical to today", async () => {
    const captures: CapturedAdapterCall[] = [];
    const adapter = makeCapturingAdapter(captures);
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
    });

    const result = await contractor.classify(RAW_PROMPT);

    expect(captures).toHaveLength(1);
    expect(captures[0].prompt).toBe(RAW_PROMPT);
    // No <memory> tag at all — zero whitespace pollution.
    expect(captures[0].prompt).not.toContain("<memory>");
    expect(captures[0].prompt).not.toContain("</memory>");
    // Result still a valid SemanticIntent.
    expect(result).toMatchObject({
      desiredEffectFamily: COMMUNICATION_EFFECT_FAMILY,
      confidence: 0.85,
    });
    expect(result.uncertainty).not.toContain("memory_recall_failed");
  });

  it("anonymous session (no IdentityId) → no recall attempted, no block", async () => {
    const captures: CapturedAdapterCall[] = [];
    const recallSpy = vi.fn<(query: SemanticMemoryQuery) => void>();
    const memoryStore = recallingMemoryStore(
      [makeSemanticEntry(asIdentityId("identity:vladimir"), 0, "fact-A")],
      recallSpy,
    );

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore,
      // identityId intentionally OMITTED — anonymous session.
    });

    await contractor.classify(RAW_PROMPT);

    expect(recallSpy).not.toHaveBeenCalled();
    expect(captures).toHaveLength(1);
    expect(captures[0].prompt).toBe(RAW_PROMPT);
    expect(captures[0].prompt).not.toContain("<memory>");
  });

  it("memoryStore present + identityId resolved + EMPTY result → NO <memory> block (zero whitespace pollution)", async () => {
    const captures: CapturedAdapterCall[] = [];
    const recallSpy = vi.fn<(query: SemanticMemoryQuery) => void>();
    const memoryStore = recallingMemoryStore([], recallSpy);

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore,
      identityId: asIdentityId("identity:vladimir"),
    });

    await contractor.classify(RAW_PROMPT);

    expect(recallSpy).toHaveBeenCalledTimes(1);
    expect(recallSpy.mock.calls[0][0]).toMatchObject({
      identityId: asIdentityId("identity:vladimir"),
      query: RAW_PROMPT,
      limit: 5,
    });
    expect(captures).toHaveLength(1);
    // Empty result must NOT inject a <memory> block.
    expect(captures[0].prompt).toBe(RAW_PROMPT);
    expect(captures[0].prompt).not.toContain("<memory>");
    expect(captures[0].prompt).not.toContain("</memory>");
  });

  it("memoryStore returns N=3 entries → exactly 3 entries inside <memory> block, prepended to prompt", async () => {
    const captures: CapturedAdapterCall[] = [];
    const identity = asIdentityId("identity:vladimir");
    const entries: SemanticMemoryEntry[] = [
      makeSemanticEntry(identity, 0, "user-loves-coffee"),
      makeSemanticEntry(identity, 1, "user-is-in-Moscow"),
      makeSemanticEntry(identity, 2, "user-prefers-Russian"),
    ];
    const memoryStore = recallingMemoryStore(entries);

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore,
      identityId: identity,
    });

    await contractor.classify(RAW_PROMPT);

    expect(captures).toHaveLength(1);
    const prompt = captures[0].prompt;
    expect(prompt.startsWith("<memory>")).toBe(true);
    expect(prompt).toContain("</memory>");
    expect(prompt.endsWith(RAW_PROMPT)).toBe(true);
    // Closed-shape JSON inside the block (mirroring <web_evidence> pattern).
    const match = prompt.match(/^<memory>(.*)<\/memory>/s);
    expect(match).not.toBeNull();
    const innerJson = JSON.parse(match![1]) as { entries: unknown[] };
    expect(Array.isArray(innerJson.entries)).toBe(true);
    expect(innerJson.entries).toHaveLength(3);
    // Each entry's content should appear in the block.
    expect(prompt).toContain("user-loves-coffee");
    expect(prompt).toContain("user-is-in-Moscow");
    expect(prompt).toContain("user-prefers-Russian");
  });

  it("recall failure (mocked throw) → no <memory> block, warning logged, contractor still returns valid SemanticIntent with memory_recall_failed uncertainty tag", async () => {
    const captures: CapturedAdapterCall[] = [];
    const warnSpy = vi.fn<(message: string, payload?: Record<string, unknown>) => void>();
    const recallSpy = vi.fn<(query: SemanticMemoryQuery) => void>();
    const memoryStore = failingMemoryStore(recallSpy, new Error("sqlite locked"));

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore,
      identityId: asIdentityId("identity:vladimir"),
      logger: { warn: warnSpy },
    });

    const result = await contractor.classify(RAW_PROMPT);

    expect(recallSpy).toHaveBeenCalledTimes(1);
    expect(captures).toHaveLength(1);
    // Failure must NOT inject a <memory> block — the adapter must see the original prompt unchanged.
    expect(captures[0].prompt).toBe(RAW_PROMPT);
    expect(captures[0].prompt).not.toContain("<memory>");
    // Warning must be logged. The contractor also emits the Phase 5
    // freshness telemetry log lines on the same `logger.warn` seam, so
    // we filter to the recall-failure record specifically rather than
    // asserting an exact call count.
    const failureCall = warnSpy.mock.calls.find((args) =>
      String(args[0] ?? "").includes("memory_recall_failed"),
    );
    expect(failureCall).toBeDefined();
    const warnPayload = `${String(failureCall![0] ?? "")} ${JSON.stringify(failureCall![1] ?? {})}`;
    expect(warnPayload).toContain("memory_recall_failed");
    // Contractor must still return a valid SemanticIntent (NEVER throws into the contractor flow).
    expect(result.desiredEffectFamily).toBe(COMMUNICATION_EFFECT_FAMILY);
    // Recall-failure uncertainty tag is appended.
    expect(result.uncertainty).toContain("memory_recall_failed");
  });

  it("recall failure does NOT throw into the contractor", async () => {
    const captures: CapturedAdapterCall[] = [];
    const warnSpy = vi.fn<(message: string, payload?: Record<string, unknown>) => void>();
    const memoryStore = failingMemoryStore(() => {}, new Error("embedder timeout"));

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore,
      identityId: asIdentityId("identity:vladimir"),
      logger: { warn: warnSpy },
    });

    // Must not throw.
    await expect(contractor.classify(RAW_PROMPT)).resolves.toMatchObject({
      desiredEffectFamily: COMMUNICATION_EFFECT_FAMILY,
    });
  });

  it("recall passes the raw prompt as the query string and the resolved IdentityId", async () => {
    const captures: CapturedAdapterCall[] = [];
    const identity = asIdentityId("identity:alice");
    const recallSpy = vi.fn<(query: SemanticMemoryQuery) => void>();
    const memoryStore = recallingMemoryStore(
      [makeSemanticEntry(identity, 0, "alice-pref")],
      recallSpy,
    );

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore,
      identityId: identity,
    });

    await contractor.classify("какие у меня напоминания");

    expect(recallSpy).toHaveBeenCalledTimes(1);
    expect(recallSpy.mock.calls[0][0]).toEqual({
      identityId: identity,
      query: "какие у меня напоминания",
      limit: 5,
    });
  });

  it("regression: existing 2-arg contractor instantiation (no memoryStore, no identityId) still types/runs as today", async () => {
    // Mirrors the existing test in intent-contractor-impl.test.ts to confirm
    // the optional new constructor params do NOT break callers that omit them.
    const adapter: IntentContractorAdapter = {
      classify: async () => ({
        desiredEffectFamily: "custom_family" as EffectFamilyId,
        target: { kind: "unspecified" },
        constraints: {},
        uncertainty: [],
        confidence: 0.8,
      }),
    };
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
    });

    await expect(contractor.classify("create a persistent project session")).resolves.toMatchObject({
      desiredEffectFamily: UNKNOWN_EFFECT_FAMILY,
      uncertainty: ["family_not_in_registry"],
      confidence: 0,
    });
  });

  it("default top-K limit is 5 when not overridden", async () => {
    const recallSpy = vi.fn<(query: SemanticMemoryQuery) => void>();
    const memoryStore = recallingMemoryStore([], recallSpy);

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter([]) },
      memoryStore,
      identityId: asIdentityId("identity:vladimir"),
    });

    await contractor.classify(RAW_PROMPT);

    expect(recallSpy.mock.calls[0][0].limit).toBe(5);
  });

  it("normalization of returned intent still applies on recall path (e.g. unknown family forces low-confidence)", async () => {
    const adapter: IntentContractorAdapter = {
      classify: async () => ({
        desiredEffectFamily: "answer_delivered" as EffectFamilyId,
        target: { kind: "unspecified" },
        constraints: {},
        uncertainty: [],
        confidence: 0.9,
      }),
    };
    const identity = asIdentityId("identity:vladimir");
    const memoryStore = recallingMemoryStore([makeSemanticEntry(identity, 0, "fact")]);

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
      memoryStore,
      identityId: identity,
    });

    await expect(contractor.classify(RAW_PROMPT)).resolves.toMatchObject({
      desiredEffectFamily: UNKNOWN_EFFECT_FAMILY,
      uncertainty: ["family_not_in_registry"],
      confidence: 0,
    });
  });

  it("baseline: 5-entry recall produces a <memory> block whose JSON parses cleanly with each entry's score and content", async () => {
    const captures: CapturedAdapterCall[] = [];
    const identity = asIdentityId("identity:vladimir");
    const entries: SemanticMemoryEntry[] = [
      makeSemanticEntry(identity, 0, "first"),
      makeSemanticEntry(identity, 1, "second"),
      makeSemanticEntry(identity, 2, "third"),
      makeSemanticEntry(identity, 3, "fourth"),
      makeSemanticEntry(identity, 4, "fifth"),
    ];

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore: recallingMemoryStore(entries),
      identityId: identity,
    });

    await contractor.classify(RAW_PROMPT);

    const prompt = captures[0].prompt;
    const match = prompt.match(/^<memory>(.*)<\/memory>(.*)$/s);
    expect(match).not.toBeNull();
    const block = match![1];
    const after = match![2];
    const parsed = JSON.parse(block) as { entries: Array<{ content: string; score: number }> };
    expect(parsed.entries).toHaveLength(5);
    expect(parsed.entries.map((entry) => entry.content)).toEqual([
      "first",
      "second",
      "third",
      "fourth",
      "fifth",
    ]);
    for (const entry of parsed.entries) {
      expect(typeof entry.score).toBe("number");
    }
    // Original prompt must still be present, after the block.
    expect(after.endsWith(RAW_PROMPT)).toBe(true);
  });
});
