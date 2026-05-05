/**
 * Slice E gateway-wiring bridge — production memory-store + identity-registry
 * bootstrap (per-process singletons).
 *
 * This module is the production wiring point that closes the production-demo
 * gap left by Phase 7 (PR #170): the gateway runtime can now thread a real
 * `MemoryStore` and an `IdentityRegistry` into `RunTurnDecisionInput` instead
 * of leaving `memoryStore`/`identityId` undefined.
 *
 * Boundary discipline:
 * - Lives in `src/server/`, NOT in `src/platform/commitment/` (invariant #8)
 *   and NOT in `src/platform/decision/` (invariant #8 — the decision module
 *   IMPORTS this helper, the helper does NOT live inside decision).
 * - Imports only structured types (`MemoryStore`, `IdentityRegistry`) and the
 *   provider-agnostic embedding infrastructure under `src/memory/`.
 * - Defense-in-depth: every failure path in store construction (sqlite-vec
 *   load failure, missing node:sqlite, embedder construction throw) is
 *   caught and downgraded to an `InMemoryMemoryStore` so the gateway stays
 *   callable end-to-end (invariant #15 — memory layer is observability,
 *   not gating).
 * - Per-process singleton keyed on a STABLE SIGNATURE of the cfg fields
 *   the bootstrap actually reads (memorySearch defaults, agent ids,
 *   identities, state-dir). Reference identity is NOT used: the per-turn
 *   config resolver (`resolveCommandSecretRefsViaGateway` -> `structuredClone`
 *   in `src/cli/command-secret-gateway.ts`) deep-clones the cfg, so two
 *   sequential turns under stable config produce two distinct cfg refs
 *   with identical content. Pre-fix this caused the bootstrap to fire
 *   on every turn (observed 2026-05-05: four consecutive
 *   `[memory] slice-E memory bootstrap` lines across four turns).
 *   Cfg-reload semantics are still honoured: when one of the signature
 *   fields actually changes, the cache invalidates and the runtime
 *   rebuilds.
 */

import { listAgentIds } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import type { IdentitiesConfig } from "../config/zod-schema.identities.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
} from "../memory/embeddings.js";
import { loadIdentityRegistryFromConfig } from "../platform/identity/load-identities-from-config.js";
import type { IdentityRegistry } from "../platform/identity/identity-registry.js";
import {
  InMemoryMemoryStore,
  SqliteVecMemoryStore,
  defaultSqliteVecMemoryStorePath,
  type MemoryEmbedder,
  type MemoryStore,
  type SqliteVecMemoryStoreLogger,
} from "../platform/memory/index.js";

const log = createSubsystemLogger("memory");

/**
 * Public surface of the bootstrap. Both fields are non-null — the
 * `IdentityRegistry` returns an empty registry when the config has no
 * `identities` section (anonymous-default), and `memoryStore` falls back to
 * `InMemoryMemoryStore` so the contractor recall + Phase-5 hook remain
 * callable end-to-end without a configured embedder.
 */
export type MemoryRuntime = {
  readonly memoryStore: MemoryStore;
  readonly identityRegistry: IdentityRegistry;
};

/**
 * Test-injection seam. Production callers pass `cfg` only; tests inject
 * factories so they don't have to mock the embedding provider or the
 * sqlite-vec extension loader.
 */
export type MemoryRuntimeDeps = {
  readonly resolveEmbedder?: (cfg: OpenClawConfig) => Promise<MemoryEmbedder | null>;
  readonly openSqliteVecStore?: (params: {
    readonly dbPath: string;
    readonly embedder: MemoryEmbedder;
    readonly vectorDims: number;
    readonly logger: SqliteVecMemoryStoreLogger;
  }) => Promise<MemoryStore>;
  readonly logger?: { warn(message: string): void; info?(message: string): void };
};

const RUNTIME_KEY = Symbol.for("openclaw.slice-e.memory-runtime-singleton");

type Singleton = {
  signature: string;
  runtime: Promise<MemoryRuntime>;
};

function getStore(): { current?: Singleton } {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[RUNTIME_KEY]) {
    g[RUNTIME_KEY] = { current: undefined };
  }
  return g[RUNTIME_KEY] as { current?: Singleton };
}

/**
 * Stable cfg signature for memoization. Captures only the fields the
 * bootstrap actually reads — agent ids (drives `defaultResolveEmbedder`'s
 * primary-agent pick), per-agent + default `memorySearch` (drives the
 * embedder provider/model/local), `identities` (drives the identity
 * registry), and state-dir env (drives the sqlite-vec db path).
 *
 * `JSON.stringify` is sufficient because all signature inputs are plain
 * JSON-shaped config values. Any field NOT in the signature is treated as
 * memoization-irrelevant — changing those fields will NOT invalidate the
 * cache, which is intentional: those fields are not load-bearing for the
 * memory runtime.
 */
function computeMemoryRuntimeSignature(cfg: OpenClawConfig): string {
  const agentsCfg = (cfg as unknown as {
    agents?: { defaults?: { memorySearch?: unknown }; entries?: unknown };
  }).agents;
  const identitiesCfg = (cfg as unknown as { identities?: unknown }).identities;
  // STATE_DIR / OPENCLAW_STATE_DIR / HOME — anything that influences
  // `defaultSqliteVecMemoryStorePath`. We hash the resolved path itself
  // so any of those env-derived inputs participate in the signature
  // without us re-listing the env-var contract here.
  let stateDirComponent: string;
  try {
    stateDirComponent = defaultSqliteVecMemoryStorePath();
  } catch {
    stateDirComponent = "<unresolved>";
  }
  try {
    return JSON.stringify({
      agents: agentsCfg ?? null,
      identities: identitiesCfg ?? null,
      stateDir: stateDirComponent,
    });
  } catch {
    // Defense-in-depth: a non-serializable cfg (cycle, BigInt) would
    // otherwise crash the gateway boot. Return a unique sentinel so the
    // bootstrap behaves like a "no cache" — every call rebuilds, but
    // nothing throws. Operators see warnings from `buildMemoryRuntime`.
    return `<unhashable:${Date.now()}-${Math.random()}>`;
  }
}

/**
 * Resolve the per-process memory runtime — `{ memoryStore, identityRegistry }`.
 * Cached on a stable cfg signature (NOT reference identity): the per-turn
 * config resolver deep-clones the cfg, so reference equality would force
 * a rebuild on every turn. Two cfgs with the same signature share the
 * cached runtime; a real cfg-reload that changes one of the signature
 * fields invalidates the cache and rebuilds. The cache lives on
 * `globalThis` keyed by a `Symbol.for` to survive ESM module-level
 * dedup quirks.
 */
export async function getMemoryRuntime(
  cfg: OpenClawConfig,
  deps: MemoryRuntimeDeps = {},
): Promise<MemoryRuntime> {
  const store = getStore();
  const signature = computeMemoryRuntimeSignature(cfg);
  if (store.current && store.current.signature === signature) {
    return store.current.runtime;
  }
  const logger = deps.logger ?? log;
  if (store.current) {
    logger.info?.(
      "slice-E memory bootstrap: rebuilding memory runtime — cfg signature changed",
    );
  }
  const runtime = buildMemoryRuntime(cfg, deps);
  store.current = { signature, runtime };
  return runtime;
}

/**
 * Reset the per-process singleton. Test-only — production never calls this.
 */
export function __resetMemoryRuntimeForTests(): void {
  const store = getStore();
  store.current = undefined;
}

async function buildMemoryRuntime(
  cfg: OpenClawConfig,
  deps: MemoryRuntimeDeps,
): Promise<MemoryRuntime> {
  const logger = deps.logger ?? log;
  // The slice D schema introduced `identities` (`zod-schema.identities.ts`)
  // but the hand-rolled `OpenClawConfig` type in `types.openclaw.ts` does
  // not yet carry the field. Reading via a structural cast keeps this
  // module decoupled from the type-side cleanup that belongs in a slice
  // D follow-up; the runtime value is already validated by the Zod
  // schema at config load.
  const identitiesCfg = (cfg as unknown as { identities?: IdentitiesConfig })
    .identities;
  let identityRegistry: IdentityRegistry;
  try {
    identityRegistry = loadIdentityRegistryFromConfig(identitiesCfg);
  } catch (err) {
    // Defense-in-depth (invariant #15): a malformed identities section
    // (duplicate IdentityId, empty externalId, etc.) MUST NOT crash the
    // gateway — surface the error and ship an empty registry so every
    // turn becomes anonymous (no recall, no memory write). Operators
    // see the warning at startup and fix the config.
    logger.warn(
      `slice-E memory bootstrap: identity registry load failed (${describeError(err)}); using empty (anonymous) registry`,
    );
    identityRegistry = loadIdentityRegistryFromConfig(undefined);
  }
  const memoryStore = await buildMemoryStore(cfg, deps);
  return { memoryStore, identityRegistry };
}

async function buildMemoryStore(
  cfg: OpenClawConfig,
  deps: MemoryRuntimeDeps,
): Promise<MemoryStore> {
  const logger = deps.logger ?? log;
  const resolveEmbedder = deps.resolveEmbedder ?? defaultResolveEmbedder;
  let embedder: MemoryEmbedder | null = null;
  try {
    embedder = await resolveEmbedder(cfg);
  } catch (err) {
    logger.warn(
      `slice-E memory bootstrap: embedder resolution failed (${describeError(err)}); using InMemoryMemoryStore`,
    );
    return new InMemoryMemoryStore();
  }
  if (!embedder) {
    logger.info?.(
      "slice-E memory bootstrap: no embedder configured; using InMemoryMemoryStore (recall persists in-process only)",
    );
    return new InMemoryMemoryStore();
  }
  try {
    const open = deps.openSqliteVecStore ?? defaultOpenSqliteVecStore;
    return await open({
      dbPath: defaultSqliteVecMemoryStorePath(),
      embedder,
      vectorDims: await probeEmbedderDims(embedder),
      logger: { warn: (m) => logger.warn(m) },
    });
  } catch (err) {
    logger.warn(
      `slice-E memory bootstrap: SqliteVecMemoryStore.open failed (${describeError(err)}); using InMemoryMemoryStore`,
    );
    return new InMemoryMemoryStore();
  }
}

async function defaultResolveEmbedder(cfg: OpenClawConfig): Promise<MemoryEmbedder | null> {
  const agentIds = listAgentIds(cfg);
  const primaryAgentId = agentIds[0];
  if (!primaryAgentId) {
    return null;
  }
  const memSearch = resolveMemorySearchConfig(cfg, primaryAgentId);
  if (!memSearch) {
    return null;
  }
  const result = await createEmbeddingProvider({
    config: cfg,
    provider: memSearch.provider,
    ...(memSearch.remote ? { remote: memSearch.remote } : {}),
    model: memSearch.model,
    fallback: memSearch.fallback,
    ...(memSearch.outputDimensionality ? { outputDimensionality: memSearch.outputDimensionality } : {}),
    ...(memSearch.local ? { local: memSearch.local } : {}),
  });
  if (!result.provider) {
    return null;
  }
  return adaptEmbedder(result.provider);
}

function adaptEmbedder(provider: EmbeddingProvider): MemoryEmbedder {
  return {
    async embed(text: string): Promise<Float32Array> {
      const vector = await provider.embedQuery(text);
      return Float32Array.from(vector);
    },
  };
}

async function probeEmbedderDims(embedder: MemoryEmbedder): Promise<number> {
  const sample = await embedder.embed("dimension-probe");
  if (!Number.isInteger(sample.length) || sample.length <= 0) {
    throw new Error(`embedder returned invalid vector length ${String(sample.length)}`);
  }
  return sample.length;
}

async function defaultOpenSqliteVecStore(params: {
  readonly dbPath: string;
  readonly embedder: MemoryEmbedder;
  readonly vectorDims: number;
  readonly logger: SqliteVecMemoryStoreLogger;
}): Promise<MemoryStore> {
  return SqliteVecMemoryStore.open(params);
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
