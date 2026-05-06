import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMemoryRuntimeForTests,
} from "../../server/memory-store-bootstrap.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { OutboundCoalescer } from "../../infra/outbound/outbound-coalescer-types.js";
import type { RuntimeAttestation } from "../commitment/index.js";
import { resolveMemoryWiringForTurn } from "./memory-wiring.js";

const cfgWithIdentities = (): OpenClawConfig =>
  ({
    identities: {
      "identity:vladimir": {
        displayName: "Vladimir",
        mappings: [{ channel: "telegram", externalId: "123" }],
      },
    },
  } as unknown as OpenClawConfig);

const satisfied: RuntimeAttestation = {
  commitmentSatisfied: true,
  terminalState: "action_completed",
  acceptanceReason: "commitment_satisfied",
  stateBefore: {},
  stateAfter: {},
  satisfaction: { satisfied: true, evidence: [] },
};

const unsatisfied: RuntimeAttestation = {
  commitmentSatisfied: false,
  terminalState: "rejected",
  acceptanceReason: "commitment_unsatisfied",
  stateBefore: {},
  stateAfter: {},
  satisfaction: { satisfied: false, missing: ["evidence_missing"] },
};

describe("resolveMemoryWiringForTurn — slice E gateway wiring bridge", () => {
  beforeEach(() => {
    __resetMemoryRuntimeForTests();
  });
  afterEach(() => {
    __resetMemoryRuntimeForTests();
  });

  it("returns an empty wiring object when sessionKey is absent (legacy byte-identical shape)", async () => {
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      promptText: "hello",
    });
    expect(wiring).toEqual({});
  });

  it("returns an empty wiring object when sessionKey is empty / whitespace (anonymous-default)", async () => {
    expect(
      await resolveMemoryWiringForTurn({
        cfg: cfgWithIdentities(),
        sessionKey: "   ",
        promptText: "hi",
      }),
    ).toEqual({});
  });

  it("returns an empty wiring object when the session-key cannot be resolved to an identity (anonymous session)", async () => {
    // Identity registry has vladimir@telegram:123, but the key points
    // at peer 999 — no mapping → invariant #16 skips cleanly.
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      sessionKey: "agent:worker:telegram:direct:999",
      promptText: "hi",
    });
    expect(wiring).toEqual({});
  });

  it("populates memoryStore + identityId + onAttestation when the session-key resolves to an operator", async () => {
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      sessionKey: "agent:worker:telegram:direct:123",
      promptText: "remind me to drink water",
    });
    expect(wiring.memoryStore).toBeDefined();
    expect(wiring.identityId).toBe("identity:vladimir");
    expect(typeof wiring.onAttestation).toBe("function");
    expect(wiring.memoryLogger).toBeDefined();
  });

  it("the returned onAttestation writes episodic + semantic memory on commitmentSatisfied=true", async () => {
    const cfg = cfgWithIdentities();
    const wiring = await resolveMemoryWiringForTurn({
      cfg,
      sessionKey: "agent:worker:telegram:direct:123",
      sessionId: "session-abc",
      promptText: "remind me to drink water",
    });
    expect(wiring.memoryStore).toBeDefined();
    expect(wiring.onAttestation).toBeDefined();
    await wiring.onAttestation!(satisfied);
    const list = await wiring.memoryStore!.list({ identityId: wiring.identityId! });
    expect(list.episodic.length).toBeGreaterThanOrEqual(1);
    expect(list.semantic.length).toBeGreaterThanOrEqual(1);
    const semanticEntry = list.semantic[0];
    expect(semanticEntry?.content).toBe("remind me to drink water");
    expect(semanticEntry?.metadata?.source).toBe("persistent_session");
  });

  it("the returned onAttestation skips episodic AND semantic on commitmentSatisfied=false (reverse coverage)", async () => {
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      sessionKey: "agent:worker:telegram:direct:123",
      promptText: "do nothing",
    });
    await wiring.onAttestation!(unsatisfied);
    const list = await wiring.memoryStore!.list({ identityId: wiring.identityId! });
    expect(list.episodic).toEqual([]);
    expect(list.semantic).toEqual([]);
  });

  it("anonymous wiring (no sessionKey) cannot fire onAttestation because the field is absent", async () => {
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      promptText: "x",
    });
    // Hot-spread into RunTurnDecisionInput — nothing to fire.
    expect(wiring.onAttestation).toBeUndefined();
    expect(wiring.memoryStore).toBeUndefined();
    expect(wiring.identityId).toBeUndefined();
  });

  it("wrapped session scopes (cron / subagent / acp) resolve to anonymous (invariant #16)", async () => {
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      // The `cron` segment marks this as a wrapped scope — extract returns undefined.
      sessionKey: "agent:worker:cron:fire:abc",
      promptText: "x",
    });
    expect(wiring).toEqual({});
  });
});

describe("resolveMemoryWiringForTurn — onAttestation never throws on store failure", () => {
  beforeEach(() => {
    __resetMemoryRuntimeForTests();
  });
  afterEach(() => {
    __resetMemoryRuntimeForTests();
  });

  it("absorbs a thrown semantic-write so the calling turn is unaffected (invariant #15)", async () => {
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      sessionKey: "agent:worker:telegram:direct:123",
      promptText: "hello",
    });
    // Monkey-patch the store's storeSemantic to throw — proves the
    // wrapper catches it without re-throwing into the calling turn.
    const store = wiring.memoryStore!;
    const original = store.storeSemantic.bind(store);
    vi.spyOn(store, "storeSemantic").mockImplementation(async () => {
      throw new Error("sqlite write blew up");
    });
    await expect(wiring.onAttestation!(satisfied)).resolves.toBeUndefined();
    // Restore so cleanup is byte-identical.
    vi.spyOn(store, "storeSemantic").mockImplementation(original);
  });
});

describe("resolveMemoryWiringForTurn — slice F Phase 5 task ledger fan-out (Strategy A)", () => {
  beforeEach(() => {
    __resetMemoryRuntimeForTests();
  });
  afterEach(() => {
    __resetMemoryRuntimeForTests();
  });

  it("exposes taskLedger when MemoryRuntime supplies one and identity resolves", async () => {
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      sessionKey: "agent:worker:telegram:direct:123",
      promptText: "hi",
    });
    // The bootstrap fallback path always supplies an InMemoryTaskLedger
    // (mirrors slice E's InMemoryMemoryStore fallback discipline).
    expect(wiring.taskLedger).toBeDefined();
    expect(typeof wiring.taskLedger?.create).toBe("function");
    expect(typeof wiring.taskLedger?.list).toBe("function");
  });

  it("the returned onAttestation does NOT fan out a task hook when no taskInput is supplied (default behaviour)", async () => {
    // The wiring helper composes BOTH hooks behind the same callback,
    // but the task hook only fires when the wiring carries a non-empty
    // `taskInput` — the production demo path does not supply one in
    // Phase 5 (cron / explicit task tools in slices J / G fill it).
    // Reverse coverage: confirm the empty-input path produces zero
    // ledger writes even when the attestation satisfies.
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      sessionKey: "agent:worker:telegram:direct:123",
      promptText: "remind me to drink water",
    });
    const ledger = wiring.taskLedger!;
    const ledgerSpy = vi.spyOn(ledger, "create");

    await wiring.onAttestation!(satisfied);

    expect(ledgerSpy).not.toHaveBeenCalled();
    const tasks = await ledger.list({ ownerIdentityId: wiring.identityId! });
    expect(tasks.tasks).toEqual([]);
  });

  it("anonymous wiring (no sessionKey) does NOT expose taskLedger (parallel to memoryStore)", async () => {
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      promptText: "x",
    });
    expect(wiring.taskLedger).toBeUndefined();
    expect(wiring.memoryStore).toBeUndefined();
    expect(wiring.identityId).toBeUndefined();
  });

  it("byte-identical semantics when caller does NOT inject a taskLedger fanout — memory hook still writes", async () => {
    // Slice E regression guard: the existing memory-hook write path
    // must remain byte-identical. The task fan-out is additive; absent
    // a task input it is a pure no-op alongside the existing memory
    // write. The 9 prior memory-wiring tests already prove the memory
    // happy path; this test re-asserts that adding the task fan-out
    // surface did NOT regress the memory write contract.
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      sessionKey: "agent:worker:telegram:direct:123",
      sessionId: "session-regression",
      promptText: "memory regression check",
    });
    await wiring.onAttestation!(satisfied);
    const list = await wiring.memoryStore!.list({ identityId: wiring.identityId! });
    // Same expectations as the slice E happy-path test on line 86.
    expect(list.episodic.length).toBeGreaterThanOrEqual(1);
    expect(list.semantic.length).toBeGreaterThanOrEqual(1);
  });
});

describe("resolveMemoryWiringForTurn — cutover-3 Phase 5 artifact hook fan-out", () => {
  beforeEach(() => {
    __resetMemoryRuntimeForTests();
  });
  afterEach(() => {
    __resetMemoryRuntimeForTests();
  });

  it("the returned onAttestation does NOT write an artifact entry when no artifactWriteInput is supplied (default behaviour)", async () => {
    // Reverse coverage: the wiring fans out to the artifact hook but the
    // hook self-filters on `artifactInput` presence, so the default
    // path (no artifact input) emits ZERO artifact-family episodic
    // entries even when the attestation satisfies.
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      sessionKey: "agent:worker:telegram:direct:123",
      promptText: "hello",
    });
    await wiring.onAttestation!(satisfied);
    const list = await wiring.memoryStore!.list({ identityId: wiring.identityId! });
    const artifactEntries = list.episodic.filter(
      (entry) => entry.event.effectFamily === "artifact",
    );
    expect(artifactEntries).toEqual([]);
  });

  it("the returned onAttestation writes an artifact-family episodic entry when artifactWriteInput + effectFamily=artifact are supplied", async () => {
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      sessionKey: "agent:worker:telegram:direct:123",
      sessionId: "session-art-1",
      promptText: "сделай PDF",
      effectFamily: "artifact",
      artifactWriteInput: {
        artifactId: "artifact:pdf:wiring-1",
        kind: "pdf",
        occurredAt: "2026-05-06T12:00:00.000Z",
        effectId: "pdf.created",
      },
    });
    await wiring.onAttestation!(satisfied);
    const list = await wiring.memoryStore!.list({ identityId: wiring.identityId! });
    const artifactEntries = list.episodic.filter(
      (entry) => entry.event.effectFamily === "artifact",
    );
    expect(artifactEntries).toHaveLength(1);
    expect(artifactEntries[0]?.event.effectId).toBe("pdf.created");
  });

  it("the returned onAttestation does NOT write an artifact entry when effectFamily is not artifact (cross-family no-op)", async () => {
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      sessionKey: "agent:worker:telegram:direct:123",
      sessionId: "session-art-cross",
      promptText: "answer me",
      effectFamily: "communication",
      artifactWriteInput: {
        artifactId: "artifact:image:should-not-write",
        kind: "image",
        occurredAt: "2026-05-06T12:00:00.000Z",
      },
    });
    await wiring.onAttestation!(satisfied);
    const list = await wiring.memoryStore!.list({ identityId: wiring.identityId! });
    const artifactEntries = list.episodic.filter(
      (entry) => entry.event.effectFamily === "artifact",
    );
    expect(artifactEntries).toEqual([]);
  });

  it("the returned onAttestation does NOT write an artifact entry on commitmentSatisfied=false (reverse)", async () => {
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      sessionKey: "agent:worker:telegram:direct:123",
      sessionId: "session-art-rev",
      promptText: "rejected turn",
      effectFamily: "artifact",
      artifactWriteInput: {
        artifactId: "artifact:pdf:rejected",
        kind: "pdf",
        occurredAt: "2026-05-06T12:00:00.000Z",
      },
    });
    await wiring.onAttestation!(unsatisfied);
    const list = await wiring.memoryStore!.list({ identityId: wiring.identityId! });
    const artifactEntries = list.episodic.filter(
      (entry) => entry.event.effectFamily === "artifact",
    );
    expect(artifactEntries).toEqual([]);
  });

  it("absorbs a thrown artifact-write so the calling turn is unaffected (invariant #15 — defense-in-depth)", async () => {
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      sessionKey: "agent:worker:telegram:direct:123",
      sessionId: "session-art-throw",
      promptText: "hello",
      effectFamily: "artifact",
      artifactWriteInput: {
        artifactId: "artifact:pdf:throw",
        kind: "pdf",
        occurredAt: "2026-05-06T12:00:00.000Z",
      },
    });
    const store = wiring.memoryStore!;
    const original = store.storeEpisodic.bind(store);
    vi.spyOn(store, "storeEpisodic").mockImplementation(async () => {
      throw new Error("artifact write blew up");
    });
    await expect(wiring.onAttestation!(satisfied)).resolves.toBeUndefined();
    vi.spyOn(store, "storeEpisodic").mockImplementation(original);
  });
});

describe("resolveMemoryWiringForTurn — NEW-C Phase 5 outbound-coalescer commit hook fan-out", () => {
  beforeEach(() => {
    __resetMemoryRuntimeForTests();
  });
  afterEach(() => {
    __resetMemoryRuntimeForTests();
  });

  function makeStubCoalescer(): OutboundCoalescer & {
    readonly commitAllCalls: ReadonlyArray<string>;
  } {
    const commitAllCalls: string[] = [];
    return {
      register: () => {},
      commit: async () => {},
      commitAll: async (turnId: string) => {
        commitAllCalls.push(turnId);
      },
      bypass: async () => {},
      stats: () => ({ buffered: 0, turns: 0 }),
      commitAllCalls,
    };
  }

  it("the returned onAttestation does NOT call coalescer.commitAll when outboundCoalescer is omitted (default decision-layer wiring)", async () => {
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      sessionKey: "agent:worker:telegram:direct:123",
      promptText: "hi",
    });
    // No coalescer plumbed → primary trigger is wired but inert.
    await expect(wiring.onAttestation!(satisfied)).resolves.toBeUndefined();
    // No assertion target other than "no throw"; the coalescer surface
    // simply isn't reachable from this branch.
  });

  it("the returned onAttestation calls coalescer.commitAll(turnId) on commitmentSatisfied=true when both deps are supplied", async () => {
    const stubCoalescer = makeStubCoalescer();
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      sessionKey: "agent:worker:telegram:direct:123",
      sessionId: "session-coalescer-1",
      promptText: "hello",
      outboundCoalescer: stubCoalescer,
      outboundTurnId: "run-coalescer-1",
    });
    await wiring.onAttestation!(satisfied);
    expect(stubCoalescer.commitAllCalls).toEqual(["run-coalescer-1"]);
  });

  it("the returned onAttestation does NOT call coalescer.commitAll on commitmentSatisfied=false (reverse coverage)", async () => {
    const stubCoalescer = makeStubCoalescer();
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      sessionKey: "agent:worker:telegram:direct:123",
      sessionId: "session-coalescer-rev",
      promptText: "denied",
      outboundCoalescer: stubCoalescer,
      outboundTurnId: "run-coalescer-rev",
    });
    await wiring.onAttestation!(unsatisfied);
    expect(stubCoalescer.commitAllCalls).toEqual([]);
  });

  it("absorbs a thrown coalescer.commitAll so the calling turn is unaffected (invariant #15)", async () => {
    const throwing: OutboundCoalescer = {
      register: () => {},
      commit: async () => {},
      commitAll: async () => {
        throw new Error("coalescer detonated");
      },
      bypass: async () => {},
      stats: () => ({ buffered: 0, turns: 0 }),
    };
    const wiring = await resolveMemoryWiringForTurn({
      cfg: cfgWithIdentities(),
      sessionKey: "agent:worker:telegram:direct:123",
      sessionId: "session-coalescer-throw",
      promptText: "hi",
      outboundCoalescer: throwing,
      outboundTurnId: "run-coalescer-throw",
    });
    await expect(wiring.onAttestation!(satisfied)).resolves.toBeUndefined();
  });
});
