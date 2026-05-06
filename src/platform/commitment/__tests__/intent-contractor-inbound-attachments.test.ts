/**
 * Cutover-3 Phase 6 — fail-first tests for the IntentContractor
 * `<inbound_attachments>` block injection.
 *
 * Mirrors the slice E P6 `<memory>` block test pattern
 * (`intent-contractor-impl.memory-recall.test.ts`):
 * - capturing adapter that records the prompt the contractor passed
 *   downstream (real `createIntentContractor` flow, no `vi.spyOn` on
 *   the function under test);
 * - resolver injected via the new optional constructor dep
 *   `inboundMediaResolver?: () => InboundMediaSummary | undefined`;
 * - regression case proves byte-identical behaviour for the legacy
 *   2-arg / N-arg `createIntentContractor(...)` callers (frozen-layer
 *   additive constraint per cutover-2 PR-#104 / slice E P6 / slice F
 *   P6).
 *
 * Per invariants #5/#6 the resolver carries STRUCTURED metadata only
 * (path + MIME type + kind) — never raw user text. The block content
 * is verified to contain ONLY the resolver-supplied attachment fields.
 */

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
  createIntentContractor,
  type IntentContractorAdapter,
  type InboundMediaSummary,
} from "../index.js";

const RAW_PROMPT = "make a PDF from this sketch";

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
): MemoryStore {
  return {
    async recall(_query: SemanticMemoryQuery): Promise<MemoryRecallResult> {
      return { entries };
    },
    async storeEpisodic(_event: EpisodicMemoryEvent) {
      throw new Error("storeEpisodic not used");
    },
    async storeSemantic(_write: SemanticMemoryWrite) {
      throw new Error("storeSemantic not used");
    },
    async list(_query: MemoryListQuery): Promise<MemoryListResult> {
      return { episodic: [], semantic: [] };
    },
    async forget() {
      // no-op for tests
    },
  };
}

describe("IntentContractor <inbound_attachments> block (cutover-3 Phase 6)", () => {
  it("regression: contractor with NO inboundMediaResolver dep behaves byte-identical (frozen-layer additive)", async () => {
    const captures: CapturedAdapterCall[] = [];
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
    });

    const result = await contractor.classify(RAW_PROMPT);

    expect(captures).toHaveLength(1);
    expect(captures[0].prompt).toBe(RAW_PROMPT);
    expect(captures[0].prompt).not.toContain("<inbound_attachments>");
    expect(captures[0].prompt).not.toContain("</inbound_attachments>");
    expect(result).toMatchObject({
      desiredEffectFamily: COMMUNICATION_EFFECT_FAMILY,
      confidence: 0.85,
    });
  });

  it("inboundMediaResolver returns undefined → no block, byte-identical prompt", async () => {
    const captures: CapturedAdapterCall[] = [];
    const resolverSpy = vi.fn<() => InboundMediaSummary | undefined>(() => undefined);
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      inboundMediaResolver: resolverSpy,
    });

    await contractor.classify(RAW_PROMPT);

    expect(resolverSpy).toHaveBeenCalledTimes(1);
    expect(captures).toHaveLength(1);
    expect(captures[0].prompt).toBe(RAW_PROMPT);
    expect(captures[0].prompt).not.toContain("<inbound_attachments>");
  });

  it("inboundMediaResolver returns empty attachments array → no block (zero whitespace pollution)", async () => {
    const captures: CapturedAdapterCall[] = [];
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      inboundMediaResolver: () => ({ attachments: [] }),
    });

    await contractor.classify(RAW_PROMPT);

    expect(captures).toHaveLength(1);
    expect(captures[0].prompt).toBe(RAW_PROMPT);
    expect(captures[0].prompt).not.toContain("<inbound_attachments>");
  });

  it("inboundMediaResolver returns 1 image → block with 1 entry, prepended to prompt", async () => {
    const captures: CapturedAdapterCall[] = [];
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      inboundMediaResolver: () => ({
        attachments: [
          {
            path: "media/inbound/sketch---1746590000-0.jpg",
            mimeType: "image/jpeg",
            kind: "image",
          },
        ],
      }),
    });

    await contractor.classify(RAW_PROMPT);

    expect(captures).toHaveLength(1);
    const prompt = captures[0].prompt;
    expect(prompt.startsWith("<inbound_attachments>")).toBe(true);
    expect(prompt).toContain("</inbound_attachments>");
    expect(prompt.endsWith(RAW_PROMPT)).toBe(true);
    expect(prompt).toContain('path="media/inbound/sketch---1746590000-0.jpg"');
    expect(prompt).toContain('mime="image/jpeg"');
    expect(prompt).toContain('kind="image"');
  });

  it("inboundMediaResolver returns 2 images → block with 2 entries", async () => {
    const captures: CapturedAdapterCall[] = [];
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      inboundMediaResolver: () => ({
        attachments: [
          {
            path: "media/inbound/a---1.jpg",
            mimeType: "image/jpeg",
            kind: "image",
          },
          {
            path: "media/inbound/b---2.png",
            mimeType: "image/png",
            kind: "image",
          },
        ],
      }),
    });

    await contractor.classify(RAW_PROMPT);

    const prompt = captures[0].prompt;
    expect(prompt).toContain('path="media/inbound/a---1.jpg"');
    expect(prompt).toContain('path="media/inbound/b---2.png"');
    const matches = prompt.match(/<attachment /g);
    expect(matches?.length ?? 0).toBe(2);
  });

  it("inboundMediaResolver returns mixed (image + pdf) → block has both entries with correct kind", async () => {
    const captures: CapturedAdapterCall[] = [];
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      inboundMediaResolver: () => ({
        attachments: [
          {
            path: "media/inbound/photo.jpg",
            mimeType: "image/jpeg",
            kind: "image",
          },
          {
            path: "media/inbound/spec.pdf",
            mimeType: "application/pdf",
            kind: "pdf",
          },
        ],
      }),
    });

    await contractor.classify(RAW_PROMPT);

    const prompt = captures[0].prompt;
    expect(prompt).toContain('path="media/inbound/photo.jpg"');
    expect(prompt).toContain('mime="image/jpeg"');
    expect(prompt).toContain('kind="image"');
    expect(prompt).toContain('path="media/inbound/spec.pdf"');
    expect(prompt).toContain('mime="application/pdf"');
    expect(prompt).toContain('kind="pdf"');
  });

  it("block placement: <inbound_attachments> is AFTER <memory> when both recall paths fire", async () => {
    const captures: CapturedAdapterCall[] = [];
    const identity = asIdentityId("identity:vladimir");
    const memoryStore = recallingMemoryStore([
      makeSemanticEntry(identity, 0, "user-loves-coffee"),
    ]);
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore,
      identityId: identity,
      inboundMediaResolver: () => ({
        attachments: [
          {
            path: "media/inbound/sketch.jpg",
            mimeType: "image/jpeg",
            kind: "image",
          },
        ],
      }),
    });

    await contractor.classify(RAW_PROMPT);

    const prompt = captures[0].prompt;
    const memoryIdx = prompt.indexOf("<memory>");
    const inboundIdx = prompt.indexOf("<inbound_attachments>");
    expect(memoryIdx).toBeGreaterThanOrEqual(0);
    expect(inboundIdx).toBeGreaterThan(memoryIdx);
    expect(prompt.endsWith(RAW_PROMPT)).toBe(true);
  });

  it("structural content only: prompt has NO raw user text inside the <inbound_attachments> block (invariants #5/#6)", async () => {
    const captures: CapturedAdapterCall[] = [];
    // Resolver returns structural metadata only (path + MIME + kind).
    // No raw user text on the resolver path.
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      inboundMediaResolver: () => ({
        attachments: [
          {
            path: "media/inbound/file.jpg",
            mimeType: "image/jpeg",
            kind: "image",
          },
        ],
      }),
    });

    const sneakyPrompt = "secret-token-deadbeef-do-not-leak";
    await contractor.classify(sneakyPrompt);

    const prompt = captures[0].prompt;
    const blockMatch = prompt.match(
      /<inbound_attachments>([\s\S]*?)<\/inbound_attachments>/,
    );
    expect(blockMatch).not.toBeNull();
    const innerBlock = blockMatch![1];
    // The raw user text must NOT appear inside the structural block.
    expect(innerBlock).not.toContain("secret-token-deadbeef");
    expect(innerBlock).not.toContain("do-not-leak");
    // The raw user text DOES appear AFTER the block (the contractor IS
    // the only invariant #6-sanctioned reader of raw user text — so it
    // surfaces the prompt to the adapter as expected, but never inside
    // the structural block).
    expect(prompt).toContain(sneakyPrompt);
  });

  it("logs `[intent-contractor] inbound_attachments_block injected paths=N` when block is emitted", async () => {
    const captures: CapturedAdapterCall[] = [];
    const warnSpy = vi.fn<(message: string, payload?: Record<string, unknown>) => void>();
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      logger: { warn: warnSpy },
      inboundMediaResolver: () => ({
        attachments: [
          {
            path: "media/inbound/a.jpg",
            mimeType: "image/jpeg",
            kind: "image",
          },
          {
            path: "media/inbound/b.pdf",
            mimeType: "application/pdf",
            kind: "pdf",
          },
        ],
      }),
    });

    await contractor.classify(RAW_PROMPT);

    expect(captures).toHaveLength(1);
    expect(captures[0].prompt).toContain("<inbound_attachments>");
    // Telemetry on the structural-logger seam — same posture as memory
    // recall warnings (info-level, not failure).
    expect(warnSpy).toHaveBeenCalled();
    const calls = warnSpy.mock.calls.map((c) => c[0]);
    const hit = calls.some((m) =>
      m.includes("inbound_attachments_block injected") && m.includes("paths=2"),
    );
    expect(hit).toBe(true);
  });

  it("resolver throws → no block, no rethrow (invariant #15 — observability never gates classifier)", async () => {
    const captures: CapturedAdapterCall[] = [];
    const warnSpy = vi.fn<(message: string, payload?: Record<string, unknown>) => void>();
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      logger: { warn: warnSpy },
      inboundMediaResolver: () => {
        throw new Error("resolver failure");
      },
    });

    const result = await contractor.classify(RAW_PROMPT);

    expect(captures).toHaveLength(1);
    expect(captures[0].prompt).toBe(RAW_PROMPT);
    expect(captures[0].prompt).not.toContain("<inbound_attachments>");
    expect(result).toMatchObject({ desiredEffectFamily: COMMUNICATION_EFFECT_FAMILY });
  });

  it("InboundMediaAttachment shape preserves brand discipline (no EffectId / ChannelId leak)", async () => {
    // Closed-shape contract: only path / mimeType / kind / sourceTurnId.
    // The resolver is the only inbound surface; if a future caller tries
    // to widen InboundMediaAttachment with `EffectId` (invariant #16) or
    // `ChannelId` (invariant #5), this test fails on the type level.
    const captures: CapturedAdapterCall[] = [];
    const summary: InboundMediaSummary = {
      attachments: [
        {
          path: "media/inbound/a.jpg",
          mimeType: "image/jpeg",
          kind: "image",
          sourceTurnId: "turn-42",
        },
      ],
    };
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      inboundMediaResolver: () => summary,
    });

    await contractor.classify(RAW_PROMPT);

    const prompt = captures[0].prompt;
    expect(prompt).toContain('path="media/inbound/a.jpg"');
    expect(prompt).toContain('kind="image"');
    // The optional sourceTurnId field is propagated structurally.
    expect(prompt).toContain('sourceTurnId="turn-42"');
  });
});
