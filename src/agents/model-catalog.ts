import { type OpenClawConfig, loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { augmentModelCatalogWithProviderPlugins } from "../plugins/provider-runtime.runtime.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

const log = createSubsystemLogger("model-catalog");

export type ModelInputType = "text" | "image" | "document";

export type ModelCatalogCost = {
  input?: number;
  output?: number;
  request?: number;
  freeRequests?: boolean;
  rpmCoefficient?: number;
};

export type ModelCatalogStatus = {
  message?: string;
  successRate?: number;
  tps?: number;
  art?: number;
};

export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
  output?: string[];
  type?: string;
  active?: boolean;
  supportsTools?: boolean;
  architecture?: string;
  quantization?: string;
  ownedBy?: string;
  cost?: ModelCatalogCost;
  status?: ModelCatalogStatus;
};

type DiscoveredModel = {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
};

type PiSdkModule = typeof import("./pi-model-discovery.js");

let modelCatalogPromise: Promise<ModelCatalogEntry[]> | null = null;
let modelCatalogCachedAt = 0;
let hasLoggedModelCatalogError = false;
const defaultImportPiSdk = () => import("./pi-model-discovery-runtime.js");
let importPiSdk = defaultImportPiSdk;
let modelSuppressionPromise: Promise<typeof import("./model-suppression.runtime.js")> | undefined;

const NON_PI_NATIVE_MODEL_PROVIDERS = new Set(["kilocode"]);
const MODEL_CATALOG_CACHE_TTL_MS = 60_000;
const HYDRA_DISCOVERY_TIMEOUT_MS = 10_000;

function shouldLogModelCatalogTiming(): boolean {
  return process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1";
}

function loadModelSuppression() {
  modelSuppressionPromise ??= import("./model-suppression.runtime.js");
  return modelSuppressionPromise;
}

function normalizeConfiguredModelInput(input: unknown): ModelInputType[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = input.filter(
    (item): item is ModelInputType => item === "text" || item === "image" || item === "document",
  );
  return normalized.length > 0 ? normalized : undefined;
}

function readConfiguredOptInProviderModels(config: OpenClawConfig): ModelCatalogEntry[] {
  const providers = config.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }

  const out: ModelCatalogEntry[] = [];
  for (const [providerRaw, providerValue] of Object.entries(providers)) {
    const provider = providerRaw.toLowerCase().trim();
    if (!NON_PI_NATIVE_MODEL_PROVIDERS.has(provider)) {
      continue;
    }
    if (!providerValue || typeof providerValue !== "object") {
      continue;
    }

    const configuredModels = (providerValue as { models?: unknown }).models;
    if (!Array.isArray(configuredModels)) {
      continue;
    }

    for (const configuredModel of configuredModels) {
      if (!configuredModel || typeof configuredModel !== "object") {
        continue;
      }
      const idRaw = (configuredModel as { id?: unknown }).id;
      if (typeof idRaw !== "string") {
        continue;
      }
      const id = idRaw.trim();
      if (!id) {
        continue;
      }
      const rawName = (configuredModel as { name?: unknown }).name;
      const name = (typeof rawName === "string" ? rawName : id).trim() || id;
      const contextWindowRaw = (configuredModel as { contextWindow?: unknown }).contextWindow;
      const contextWindow =
        typeof contextWindowRaw === "number" && contextWindowRaw > 0 ? contextWindowRaw : undefined;
      const reasoningRaw = (configuredModel as { reasoning?: unknown }).reasoning;
      const reasoning = typeof reasoningRaw === "boolean" ? reasoningRaw : undefined;
      const input = normalizeConfiguredModelInput((configuredModel as { input?: unknown }).input);
      out.push({ id, name, provider, contextWindow, reasoning, input });
    }
  }

  return out;
}

function mergeConfiguredOptInProviderModels(params: {
  config: OpenClawConfig;
  models: ModelCatalogEntry[];
}): void {
  const configured = readConfiguredOptInProviderModels(params.config);
  if (configured.length === 0) {
    return;
  }

  const seen = new Set(
    params.models.map(
      (entry) => `${entry.provider.toLowerCase().trim()}::${entry.id.toLowerCase().trim()}`,
    ),
  );

  for (const entry of configured) {
    const key = `${entry.provider.toLowerCase().trim()}::${entry.id.toLowerCase().trim()}`;
    if (seen.has(key)) {
      continue;
    }
    params.models.push(entry);
    seen.add(key);
  }
}

export function resetModelCatalogCacheForTest() {
  modelCatalogPromise = null;
  modelCatalogCachedAt = 0;
  hasLoggedModelCatalogError = false;
  importPiSdk = defaultImportPiSdk;
}

// Test-only escape hatch: allow mocking the dynamic import to simulate transient failures.
export function __setModelCatalogImportForTest(loader?: () => Promise<PiSdkModule>) {
  importPiSdk = loader ?? defaultImportPiSdk;
}

type HydraApiModelPricing = {
  type?: unknown;
  in_cost_per_million?: unknown;
  out_cost_per_million?: unknown;
  cost_per_million?: unknown;
  cost_per_request?: unknown;
  free_requests?: unknown;
};

type HydraApiModel = {
  id?: unknown;
  name?: unknown;
  context?: unknown;
  type?: unknown;
  active?: unknown;
  reasoning?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
  supported_file_types?: unknown;
  endpoints?: unknown;
  architecture?: unknown;
  quantization?: unknown;
  owned_by?: unknown;
  pricing?: HydraApiModelPricing | null;
  rpm_coefficient?: unknown;
};

type HydraModelsResponse = {
  data?: HydraApiModel[];
};

type HydraStatusEntry = {
  message?: unknown;
  success_rate?: unknown;
  tps?: unknown;
  art?: unknown;
};

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((item) => normalizeNonEmptyString(item)?.toLowerCase())
    .filter((item): item is string => Boolean(item));
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

function normalizeHydraCatalogInput(params: {
  inputModalities?: string[];
  supportedFileTypes?: string[];
}): ModelInputType[] | undefined {
  const inputs = new Set<ModelInputType>();
  for (const modality of params.inputModalities ?? []) {
    if (modality === "text") {
      inputs.add("text");
    }
    if (modality === "image") {
      inputs.add("image");
    }
    if (modality === "document" || modality === "file" || modality === "pdf") {
      inputs.add("document");
    }
  }
  for (const fileType of params.supportedFileTypes ?? []) {
    if (fileType === "pdf" || fileType === "doc" || fileType === "docx" || fileType === "txt") {
      inputs.add("document");
    }
  }
  return inputs.size > 0 ? Array.from(inputs) : undefined;
}

function normalizeHydraCatalogCost(
  pricing: HydraApiModelPricing | null | undefined,
  rpmCoefficient: unknown,
): ModelCatalogCost | undefined {
  if (!pricing || typeof pricing !== "object") {
    return normalizeFiniteNumber(rpmCoefficient) ? { rpmCoefficient: Number(rpmCoefficient) } : undefined;
  }
  const next: ModelCatalogCost = {};
  const inCost = normalizeFiniteNumber(pricing.in_cost_per_million);
  const outCost = normalizeFiniteNumber(pricing.out_cost_per_million);
  const sharedCost = normalizeFiniteNumber(pricing.cost_per_million);
  const requestCost = normalizeFiniteNumber(pricing.cost_per_request);
  if (inCost !== undefined) {
    next.input = inCost;
  }
  if (outCost !== undefined) {
    next.output = outCost;
  }
  if (sharedCost !== undefined) {
    next.input = next.input ?? sharedCost;
  }
  if (requestCost !== undefined) {
    next.request = requestCost;
  }
  if (typeof pricing.free_requests === "boolean") {
    next.freeRequests = pricing.free_requests;
  }
  const normalizedRpmCoefficient = normalizeFiniteNumber(rpmCoefficient);
  if (normalizedRpmCoefficient !== undefined) {
    next.rpmCoefficient = normalizedRpmCoefficient;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeHydraCatalogStatus(entry: HydraStatusEntry | undefined): ModelCatalogStatus | undefined {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const next: ModelCatalogStatus = {};
  const message = normalizeNonEmptyString(entry.message);
  if (message) {
    next.message = message;
  }
  const successRate = normalizeFiniteNumber(entry.success_rate);
  if (successRate !== undefined) {
    next.successRate = successRate;
  }
  const tps = normalizeFiniteNumber(entry.tps);
  if (tps !== undefined) {
    next.tps = tps;
  }
  const art = normalizeFiniteNumber(entry.art);
  if (art !== undefined) {
    next.art = art;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeHydraSupportsTools(params: {
  endpoints?: string[];
  outputModalities?: string[];
}): boolean | undefined {
  if (!(params.endpoints?.includes("/chat/completions") ?? false)) {
    return false;
  }
  if (params.outputModalities?.includes("embed")) {
    return false;
  }
  return params.outputModalities?.includes("text") ?? true;
}

function mergeCatalogEntry(existing: ModelCatalogEntry, incoming: ModelCatalogEntry): ModelCatalogEntry {
  return {
    ...existing,
    ...incoming,
    name: existing.name || incoming.name,
    contextWindow: incoming.contextWindow ?? existing.contextWindow,
    reasoning: incoming.reasoning ?? existing.reasoning,
    input: incoming.input ?? existing.input,
    output: incoming.output ?? existing.output,
    type: incoming.type ?? existing.type,
    active: incoming.active ?? existing.active,
    supportsTools: incoming.supportsTools ?? existing.supportsTools,
    architecture: incoming.architecture ?? existing.architecture,
    quantization: incoming.quantization ?? existing.quantization,
    ownedBy: incoming.ownedBy ?? existing.ownedBy,
    cost:
      existing.cost || incoming.cost ? { ...(existing.cost ?? {}), ...(incoming.cost ?? {}) } : undefined,
    status:
      existing.status || incoming.status
        ? { ...(existing.status ?? {}), ...(incoming.status ?? {}) }
        : undefined,
  };
}

function appendOrMergeCatalogEntries(params: {
  models: ModelCatalogEntry[];
  incoming: ModelCatalogEntry[];
}): void {
  const byKey = new Map(
    params.models.map((entry, index) => [
      `${entry.provider.toLowerCase().trim()}::${entry.id.toLowerCase().trim()}`,
      index,
    ]),
  );
  for (const entry of params.incoming) {
    const key = `${entry.provider.toLowerCase().trim()}::${entry.id.toLowerCase().trim()}`;
    const existingIndex = byKey.get(key);
    if (existingIndex === undefined) {
      params.models.push(entry);
      byKey.set(key, params.models.length - 1);
      continue;
    }
    params.models[existingIndex] = mergeCatalogEntry(params.models[existingIndex], entry);
  }
}

async function fetchHydraCatalogEntries(config: OpenClawConfig): Promise<ModelCatalogEntry[]> {
  const providerConfig = config.models?.providers?.hydra;
  const baseUrl = normalizeNonEmptyString(providerConfig?.baseUrl);
  if (!baseUrl) {
    return [];
  }

  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const modelsUrl = new URL("models", normalizedBaseUrl).toString();
  const statusUrl = new URL("models/status", normalizedBaseUrl).toString();

  try {
    const [modelsResponse, statusResponse] = await Promise.all([
      fetch(modelsUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(HYDRA_DISCOVERY_TIMEOUT_MS),
      }),
      fetch(statusUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(HYDRA_DISCOVERY_TIMEOUT_MS),
      }).catch(() => null),
    ]);

    if (!modelsResponse.ok) {
      throw new Error(`hydra /models returned ${modelsResponse.status}`);
    }

    const modelsPayload = (await modelsResponse.json()) as HydraModelsResponse;
    if (!Array.isArray(modelsPayload.data) || modelsPayload.data.length === 0) {
      return [];
    }

    const statusPayload = statusResponse && statusResponse.ok
      ? ((await statusResponse.json()) as Record<string, HydraStatusEntry>)
      : {};

    const entries: ModelCatalogEntry[] = [];
    for (const model of modelsPayload.data) {
      const id = normalizeNonEmptyString(model.id);
      if (!id) {
        continue;
      }
      const inputModalities = normalizeStringArray(model.input_modalities);
      const outputModalities = normalizeStringArray(model.output_modalities);
      const supportedFileTypes = normalizeStringArray(model.supported_file_types);
      const endpoints = normalizeStringArray(model.endpoints);
      const entry: ModelCatalogEntry = {
        id,
        name: normalizeNonEmptyString(model.name) ?? id,
        provider: "hydra",
        contextWindow: normalizeFiniteNumber(model.context),
        reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
        input: normalizeHydraCatalogInput({ inputModalities, supportedFileTypes }),
        output: outputModalities,
        type: normalizeNonEmptyString(model.type)?.toLowerCase(),
        active: typeof model.active === "boolean" ? model.active : undefined,
        supportsTools: normalizeHydraSupportsTools({ endpoints, outputModalities }),
        architecture: normalizeNonEmptyString(model.architecture),
        quantization: normalizeNonEmptyString(model.quantization),
        ownedBy: normalizeNonEmptyString(model.owned_by),
        cost: normalizeHydraCatalogCost(model.pricing, model.rpm_coefficient),
        status: normalizeHydraCatalogStatus(statusPayload[id]),
      };
      entries.push(entry);
    }
    return entries;
  } catch (error) {
    log.warn(`Failed to discover Hydra model capabilities: ${String(error)}`);
    return [];
  }
}

export async function loadModelCatalog(params?: {
  config?: OpenClawConfig;
  useCache?: boolean;
}): Promise<ModelCatalogEntry[]> {
  if (params?.useCache === false) {
    modelCatalogPromise = null;
    modelCatalogCachedAt = 0;
  }
  if (
    modelCatalogPromise &&
    modelCatalogCachedAt > 0 &&
    Date.now() - modelCatalogCachedAt < MODEL_CATALOG_CACHE_TTL_MS
  ) {
    return modelCatalogPromise;
  }
  modelCatalogPromise = null;

  modelCatalogPromise = (async () => {
    const models: ModelCatalogEntry[] = [];
    const timingEnabled = shouldLogModelCatalogTiming();
    const startMs = timingEnabled ? Date.now() : 0;
    const logStage = (stage: string, extra?: string) => {
      if (!timingEnabled) {
        return;
      }
      const suffix = extra ? ` ${extra}` : "";
      log.info(`model-catalog stage=${stage} elapsedMs=${Date.now() - startMs}${suffix}`);
    };
    const sortModels = (entries: ModelCatalogEntry[]) =>
      entries.sort((a, b) => {
        const p = a.provider.localeCompare(b.provider);
        if (p !== 0) {
          return p;
        }
        return a.name.localeCompare(b.name);
      });
    try {
      const cfg = params?.config ?? loadConfig();
      await ensureOpenClawModelsJson(cfg);
      logStage("models-json-ready");
      // IMPORTANT: keep the dynamic import *inside* the try/catch.
      // If this fails once (e.g. during a pnpm install that temporarily swaps node_modules),
      // we must not poison the cache with a rejected promise (otherwise all channel handlers
      // will keep failing until restart).
      const piSdk = await importPiSdk();
      logStage("pi-sdk-imported");
      const agentDir = resolveOpenClawAgentDir();
      const { shouldSuppressBuiltInModel } = await loadModelSuppression();
      logStage("catalog-deps-ready");
      const { join } = await import("node:path");
      const authStorage = piSdk.discoverAuthStorage(agentDir);
      logStage("auth-storage-ready");
      const registry = new (piSdk.ModelRegistry as unknown as {
        new (
          authStorage: unknown,
          modelsFile: string,
        ):
          | Array<DiscoveredModel>
          | {
              getAll: () => Array<DiscoveredModel>;
            };
      })(authStorage, join(agentDir, "models.json"));
      logStage("registry-ready");
      const entries = Array.isArray(registry) ? registry : registry.getAll();
      logStage("registry-read", `entries=${entries.length}`);
      for (const entry of entries) {
        const id = String(entry?.id ?? "").trim();
        if (!id) {
          continue;
        }
        const provider = String(entry?.provider ?? "").trim();
        if (!provider) {
          continue;
        }
        if (shouldSuppressBuiltInModel({ provider, id })) {
          continue;
        }
        const name = String(entry?.name ?? id).trim() || id;
        const contextWindow =
          typeof entry?.contextWindow === "number" && entry.contextWindow > 0
            ? entry.contextWindow
            : undefined;
        const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : undefined;
        const input = Array.isArray(entry?.input) ? entry.input : undefined;
        models.push({ id, name, provider, contextWindow, reasoning, input });
      }
      mergeConfiguredOptInProviderModels({ config: cfg, models });
      logStage("configured-models-merged", `entries=${models.length}`);
      const supplemental = await augmentModelCatalogWithProviderPlugins({
        config: cfg,
        env: process.env,
        context: {
          config: cfg,
          agentDir,
          env: process.env,
          entries: [...models],
        },
      });
      if (supplemental.length > 0) {
        appendOrMergeCatalogEntries({ models, incoming: supplemental });
      }
      logStage("plugin-models-merged", `entries=${models.length}`);
      const hydraSupplemental = await fetchHydraCatalogEntries(cfg);
      if (hydraSupplemental.length > 0) {
        appendOrMergeCatalogEntries({ models, incoming: hydraSupplemental });
      }
      logStage("hydra-models-merged", `entries=${models.length}`);

      if (models.length === 0) {
        // If we found nothing, don't cache this result so we can try again.
        modelCatalogPromise = null;
        modelCatalogCachedAt = 0;
      }

      const sorted = sortModels(models);
      modelCatalogCachedAt = Date.now();
      logStage("complete", `entries=${sorted.length}`);
      return sorted;
    } catch (error) {
      if (!hasLoggedModelCatalogError) {
        hasLoggedModelCatalogError = true;
        log.warn(`Failed to load model catalog: ${String(error)}`);
      }
      // Don't poison the cache on transient dependency/filesystem issues.
      modelCatalogPromise = null;
      modelCatalogCachedAt = 0;
      if (models.length > 0) {
        return sortModels(models);
      }
      return [];
    }
  })();

  return modelCatalogPromise;
}

/**
 * Check if a model supports image input based on its catalog entry.
 */
export function modelSupportsVision(entry: ModelCatalogEntry | undefined): boolean {
  return entry?.input?.includes("image") ?? false;
}

/**
 * Check if a model supports native document/PDF input based on its catalog entry.
 */
export function modelSupportsDocument(entry: ModelCatalogEntry | undefined): boolean {
  return entry?.input?.includes("document") ?? false;
}

/**
 * Find a model in the catalog by provider and model ID.
 */
export function findModelInCatalog(
  catalog: ModelCatalogEntry[],
  provider: string,
  modelId: string,
): ModelCatalogEntry | undefined {
  const normalizedProvider = provider.toLowerCase().trim();
  const normalizedModelId = modelId.toLowerCase().trim();
  return catalog.find(
    (entry) =>
      entry.provider.toLowerCase() === normalizedProvider &&
      entry.id.toLowerCase() === normalizedModelId,
  );
}
