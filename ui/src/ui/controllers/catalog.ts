import type { CapabilityCatalogSummary, RecipeCatalogSummary } from "../types.ts";

type CatalogListResult = {
  recipes?: RecipeCatalogSummary[];
  capabilities?: CapabilityCatalogSummary[];
};

export type CatalogState = {
  client: { request: <T = unknown>(method: string, params?: unknown) => Promise<T> } | null;
  connected: boolean;
  catalogLoading: boolean;
  catalogError: string | null;
  recipeCatalog: RecipeCatalogSummary[];
  capabilityCatalog: CapabilityCatalogSummary[];
};

export async function loadPlatformCatalog(state: CatalogState): Promise<void> {
  if (!state.client || !state.connected || state.catalogLoading) {
    if (!state.connected) {
      state.catalogError = null;
      state.recipeCatalog = [];
      state.capabilityCatalog = [];
    }
    return;
  }
  state.catalogLoading = true;
  state.catalogError = null;
  try {
    const [recipesRes, capabilitiesRes] = await Promise.all([
      state.client.request<CatalogListResult>("platform.recipes.list", {}),
      state.client.request<CatalogListResult>("platform.capabilities.list", {}),
    ]);
    state.recipeCatalog = Array.isArray(recipesRes?.recipes) ? recipesRes.recipes : [];
    state.capabilityCatalog = Array.isArray(capabilitiesRes?.capabilities)
      ? capabilitiesRes.capabilities
      : [];
  } catch (err) {
    state.catalogError = String(err);
  } finally {
    state.catalogLoading = false;
  }
}
