import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { type OpenClawConfig, loadConfig } from "../config/config.js";
import {
  canonicalizeMainSessionAlias,
  loadSessionStore,
  resolveAllAgentSessionStoreTargetsSync,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
  resolveStorePath,
  type SessionEntry,
  type SessionStoreTarget,
} from "../config/sessions.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";

function canonicalizeSessionKeyForAgent(agentId: string, key: string): string {
  const lowered = key.toLowerCase();
  if (lowered === "global" || lowered === "unknown") {
    return lowered;
  }
  if (lowered.startsWith("agent:")) {
    return lowered;
  }
  return `agent:${normalizeAgentId(agentId)}:${lowered}`;
}

function resolveDefaultStoreAgentId(cfg: OpenClawConfig): string {
  return normalizeAgentId(resolveDefaultAgentId(cfg));
}

export function resolveSessionStoreKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): string {
  const raw = (params.sessionKey ?? "").trim();
  if (!raw) {
    return raw;
  }
  const rawLower = raw.toLowerCase();
  if (rawLower === "global" || rawLower === "unknown") {
    return rawLower;
  }

  const parsed = parseAgentSessionKey(raw);
  if (parsed) {
    const agentId = normalizeAgentId(parsed.agentId);
    const lowered = raw.toLowerCase();
    const canonical = canonicalizeMainSessionAlias({
      cfg: params.cfg,
      agentId,
      sessionKey: lowered,
    });
    return canonical !== lowered ? canonical : lowered;
  }

  const lowered = raw.toLowerCase();
  const rawMainKey = normalizeMainKey(params.cfg.session?.mainKey);
  if (lowered === "main" || lowered === rawMainKey) {
    return resolveMainSessionKey(params.cfg);
  }
  const agentId = resolveDefaultStoreAgentId(params.cfg);
  return canonicalizeSessionKeyForAgent(agentId, lowered);
}

function resolveSessionStoreAgentId(cfg: OpenClawConfig, canonicalKey: string): string {
  if (canonicalKey === "global" || canonicalKey === "unknown") {
    return resolveDefaultStoreAgentId(cfg);
  }
  const parsed = parseAgentSessionKey(canonicalKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  return resolveDefaultStoreAgentId(cfg);
}

function findStoreMatch(
  store: Record<string, SessionEntry>,
  ...candidates: string[]
): { entry: SessionEntry; key: string } | undefined {
  for (const candidate of candidates) {
    if (candidate && store[candidate]) {
      return { entry: store[candidate], key: candidate };
    }
  }
  const loweredSet = new Set(
    candidates.filter(Boolean).map((candidate) => candidate.toLowerCase()),
  );
  for (const key of Object.keys(store)) {
    if (loweredSet.has(key.toLowerCase())) {
      return { entry: store[key], key };
    }
  }
  return undefined;
}

function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

function buildGatewaySessionStoreScanTargets(params: {
  cfg: OpenClawConfig;
  key: string;
  canonicalKey: string;
  agentId: string;
}): string[] {
  const targets = new Set<string>();
  if (params.canonicalKey) {
    targets.add(params.canonicalKey);
  }
  if (params.key && params.key !== params.canonicalKey) {
    targets.add(params.key);
  }
  if (params.canonicalKey === "global" || params.canonicalKey === "unknown") {
    return [...targets];
  }
  const agentMainKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId });
  if (params.canonicalKey === agentMainKey) {
    targets.add(`agent:${params.agentId}:main`);
  }
  return [...targets];
}

function resolveGatewaySessionStoreCandidates(
  cfg: OpenClawConfig,
  agentId: string,
): SessionStoreTarget[] {
  const storeConfig = cfg.session?.store;
  const defaultTarget = {
    agentId,
    storePath: resolveStorePath(storeConfig, { agentId }),
  };
  if (!isStorePathTemplate(storeConfig)) {
    return [defaultTarget];
  }
  const targets = new Map<string, SessionStoreTarget>();
  targets.set(defaultTarget.storePath, defaultTarget);
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    if (target.agentId === agentId) {
      targets.set(target.storePath, target);
    }
  }
  return [...targets.values()];
}

function resolveGatewaySessionStoreLookup(params: {
  cfg: OpenClawConfig;
  key: string;
  canonicalKey: string;
  agentId: string;
}): {
  storePath: string;
  store: Record<string, SessionEntry>;
  match: { entry: SessionEntry; key: string } | undefined;
} {
  const scanTargets = buildGatewaySessionStoreScanTargets(params);
  const candidates = resolveGatewaySessionStoreCandidates(params.cfg, params.agentId);
  const fallback = candidates[0] ?? {
    agentId: params.agentId,
    storePath: resolveStorePath(params.cfg.session?.store, { agentId: params.agentId }),
  };
  let selectedStorePath = fallback.storePath;
  let selectedStore = loadSessionStore(fallback.storePath);
  let selectedMatch = findStoreMatch(selectedStore, ...scanTargets);
  let selectedUpdatedAt = selectedMatch?.entry.updatedAt ?? Number.NEGATIVE_INFINITY;

  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    const store = loadSessionStore(candidate.storePath);
    const match = findStoreMatch(store, ...scanTargets);
    if (!match) {
      continue;
    }
    const updatedAt = match.entry.updatedAt ?? 0;
    if (!selectedMatch || updatedAt >= selectedUpdatedAt) {
      selectedStorePath = candidate.storePath;
      selectedStore = store;
      selectedMatch = match;
      selectedUpdatedAt = updatedAt;
    }
  }

  return {
    storePath: selectedStorePath,
    store: selectedStore,
    match: selectedMatch,
  };
}

export function loadSessionEntry(sessionKey: string) {
  const cfg = loadConfig();
  const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey });
  const agentId = resolveSessionStoreAgentId(cfg, canonicalKey);
  const { storePath, store, match } = resolveGatewaySessionStoreLookup({
    cfg,
    key: sessionKey.trim(),
    canonicalKey,
    agentId,
  });
  const legacyKey = match?.key !== canonicalKey ? match?.key : undefined;
  return { cfg, storePath, store, entry: match?.entry, canonicalKey, legacyKey };
}
