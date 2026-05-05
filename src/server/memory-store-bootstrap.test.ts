import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { asIdentityId } from "../platform/identity/identity-id.js";
import {
  InMemoryMemoryStore,
  type MemoryEmbedder,
  type MemoryStore,
} from "../platform/memory/index.js";
import {
  __resetMemoryRuntimeForTests,
  getMemoryRuntime,
  type MemoryRuntimeDeps,
} from "./memory-store-bootstrap.js";

const VECTOR_DIMS = 16;

function deterministicEmbedder(): MemoryEmbedder {
  return {
    embed(text: string): Promise<Float32Array> {
      const out = new Float32Array(VECTOR_DIMS);
      for (let i = 0; i < text.length && i < VECTOR_DIMS; i += 1) {
        out[i] = (text.charCodeAt(i) % 31) / 31;
      }
      return Promise.resolve(out);
    },
  };
}

function cfgWithIdentities(): OpenClawConfig {
  return {
    identities: {
      "identity:vladimir": {
        displayName: "Vladimir",
        mappings: [
          { channel: "telegram", externalId: "123" },
          { channel: "webchat", externalId: "web-1" },
        ],
      },
    },
  } as unknown as OpenClawConfig;
}

function emptyCfg(): OpenClawConfig {
  return {} as unknown as OpenClawConfig;
}

describe("memory-store-bootstrap — slice E gateway wiring bridge", () => {
  beforeEach(() => {
    __resetMemoryRuntimeForTests();
  });

  afterEach(() => {
    __resetMemoryRuntimeForTests();
  });

  it("invokes the SqliteVec open factory with the configured embedder + dims when memory-config supplies an embedder", async () => {
    type Captured = {
      readonly dbPath: string;
      readonly vectorDims: number;
      readonly embedder: MemoryEmbedder;
    };
    const captured: Captured[] = [];
    const sentinel: MemoryStore = new InMemoryMemoryStore();
    const deps: MemoryRuntimeDeps = {
      resolveEmbedder: async () => deterministicEmbedder(),
      openSqliteVecStore: async (params) => {
        captured.push({
          dbPath: params.dbPath,
          vectorDims: params.vectorDims,
          embedder: params.embedder,
        });
        return sentinel;
      },
    };
    const { memoryStore } = await getMemoryRuntime(emptyCfg(), deps);
    // The bootstrap selected the persistent branch — the open factory
    // returned `sentinel`, NOT a default `InMemoryMemoryStore`.
    expect(memoryStore).toBe(sentinel);
    expect(captured).toHaveLength(1);
    const open = captured[0];
    expect(open?.dbPath).toMatch(/identity-memory\.sqlite$/);
    expect(open?.vectorDims).toBe(VECTOR_DIMS);
    // Probe the adapter — vectorDims should match what the embedder produces.
    const probe = await open?.embedder.embed("probe");
    expect(probe?.length).toBe(VECTOR_DIMS);
  });

  it("falls back to InMemoryMemoryStore when no embedder is configured (memory-config absent)", async () => {
    const deps: MemoryRuntimeDeps = {
      resolveEmbedder: async () => null,
      openSqliteVecStore: vi.fn(),
    };
    const { memoryStore } = await getMemoryRuntime(emptyCfg(), deps);
    expect(memoryStore).toBeInstanceOf(InMemoryMemoryStore);
    expect(deps.openSqliteVecStore).not.toHaveBeenCalled();
  });

  it("falls back to InMemoryMemoryStore when the embedder resolver throws (defense-in-depth)", async () => {
    const deps: MemoryRuntimeDeps = {
      resolveEmbedder: async () => {
        throw new Error("embedder construction blew up");
      },
    };
    const { memoryStore } = await getMemoryRuntime(emptyCfg(), deps);
    expect(memoryStore).toBeInstanceOf(InMemoryMemoryStore);
  });

  it("falls back to InMemoryMemoryStore when SqliteVecMemoryStore.open throws (defense-in-depth)", async () => {
    const warn: string[] = [];
    const deps: MemoryRuntimeDeps = {
      resolveEmbedder: async () => deterministicEmbedder(),
      openSqliteVecStore: async () => {
        throw new Error("sqlite-vec not loadable on this host");
      },
      logger: { warn: (m) => warn.push(m) },
    };
    const { memoryStore } = await getMemoryRuntime(emptyCfg(), deps);
    expect(memoryStore).toBeInstanceOf(InMemoryMemoryStore);
    expect(warn.some((line) => line.includes("SqliteVecMemoryStore.open failed"))).toBe(true);
  });

  it("memoizes per-cfg reference — same cfg returns the same runtime instance", async () => {
    const cfg = cfgWithIdentities();
    const deps: MemoryRuntimeDeps = {
      resolveEmbedder: async () => null,
    };
    const a = await getMemoryRuntime(cfg, deps);
    const b = await getMemoryRuntime(cfg, deps);
    expect(b).toBe(a);
    expect(b.memoryStore).toBe(a.memoryStore);
    expect(b.identityRegistry).toBe(a.identityRegistry);
  });

  it("memoizes across deep-cloned cfg objects with identical signature (4 turns -> 1 bootstrap)", async () => {
    // Reproduces the production bug: per-turn cfg resolution deep-clones
    // (`structuredClone`) the config, so reference equality breaks even
    // though the meaningful signature (memorySearch, identities,
    // state-dir) hasn't changed. The fix: key the singleton on a stable
    // signature so 4 sequential turns trigger ONE bootstrap.
    const infoMessages: string[] = [];
    const warnMessages: string[] = [];
    let resolverCalls = 0;
    const deps: MemoryRuntimeDeps = {
      resolveEmbedder: async () => {
        resolverCalls += 1;
        return null;
      },
      logger: {
        warn: (m) => warnMessages.push(m),
        info: (m) => infoMessages.push(m),
      },
    };
    const base = cfgWithIdentities();
    const turn1 = await getMemoryRuntime(structuredClone(base), deps);
    const turn2 = await getMemoryRuntime(structuredClone(base), deps);
    const turn3 = await getMemoryRuntime(structuredClone(base), deps);
    const turn4 = await getMemoryRuntime(structuredClone(base), deps);
    // Same singleton across all 4 turns (stable signature -> cache hit).
    expect(turn2).toBe(turn1);
    expect(turn3).toBe(turn1);
    expect(turn4).toBe(turn1);
    expect(turn4.memoryStore).toBe(turn1.memoryStore);
    expect(turn4.identityRegistry).toBe(turn1.identityRegistry);
    // Bootstrap-side effects fired exactly once.
    expect(resolverCalls).toBe(1);
    const bootstrapInfoLines = infoMessages.filter((line) =>
      line.includes("slice-E memory bootstrap"),
    );
    expect(bootstrapInfoLines).toHaveLength(1);
  });

  it("rebuilds when memorySearch signature changes (cfg-reload semantics)", async () => {
    // Real cfg-reload: the cached signature must invalidate when meaningful
    // memory-config fields change between calls. Pre-fix this test passed
    // because EVERY new cfg ref invalidated; post-fix it must still pass
    // because the signature now captures `memorySearch` provider/model.
    const deps: MemoryRuntimeDeps = {
      resolveEmbedder: async () => null,
    };
    const cfgA = {
      ...cfgWithIdentities(),
      agents: { defaults: { memorySearch: { provider: "gemini" } } },
    } as unknown as OpenClawConfig;
    const cfgB = {
      ...cfgWithIdentities(),
      agents: { defaults: { memorySearch: { provider: "openai" } } },
    } as unknown as OpenClawConfig;
    const a = await getMemoryRuntime(cfgA, deps);
    const b = await getMemoryRuntime(cfgB, deps);
    expect(b).not.toBe(a);
    expect(b.memoryStore).not.toBe(a.memoryStore);
  });

  it("rebuilds when identities signature changes (cfg-reload semantics)", async () => {
    const deps: MemoryRuntimeDeps = {
      resolveEmbedder: async () => null,
    };
    const cfgA = cfgWithIdentities();
    const cfgB = {
      identities: {
        "identity:vladimir": {
          displayName: "Vladimir",
          mappings: [{ channel: "telegram", externalId: "999" }],
        },
      },
    } as unknown as OpenClawConfig;
    const a = await getMemoryRuntime(cfgA, deps);
    const b = await getMemoryRuntime(cfgB, deps);
    expect(b).not.toBe(a);
    expect(b.memoryStore).not.toBe(a.memoryStore);
  });

  it("loads IdentityRegistry from cfg.identities so session-keys map to operators", async () => {
    const cfg = cfgWithIdentities();
    const deps: MemoryRuntimeDeps = {
      resolveEmbedder: async () => null,
    };
    const { identityRegistry } = await getMemoryRuntime(cfg, deps);
    expect(identityRegistry.resolve("telegram", "123")).toBe(asIdentityId("identity:vladimir"));
    expect(identityRegistry.resolve("webchat", "web-1")).toBe(asIdentityId("identity:vladimir"));
    expect(identityRegistry.resolve("telegram", "999")).toBeUndefined();
  });

  it("returns an empty IdentityRegistry when cfg has no identities section (anonymous-default)", async () => {
    const deps: MemoryRuntimeDeps = {
      resolveEmbedder: async () => null,
    };
    const { identityRegistry } = await getMemoryRuntime(emptyCfg(), deps);
    expect(identityRegistry.list()).toEqual([]);
    expect(identityRegistry.resolve("telegram", "anyone")).toBeUndefined();
  });
});
