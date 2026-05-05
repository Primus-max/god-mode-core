import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMemoryRuntimeForTests,
} from "../../server/memory-store-bootstrap.js";
import type { OpenClawConfig } from "../../config/config.js";
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
