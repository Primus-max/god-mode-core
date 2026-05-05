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

  it("rebuilds when cfg reference changes (cfg-reload semantics)", async () => {
    const deps: MemoryRuntimeDeps = {
      resolveEmbedder: async () => null,
    };
    const a = await getMemoryRuntime(cfgWithIdentities(), deps);
    const b = await getMemoryRuntime(cfgWithIdentities(), deps);
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
