import { describe, expect, it, vi } from "vitest";
import { loadPlatformCatalog, type CatalogState } from "./catalog.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createState(request: RequestFn, overrides: Partial<CatalogState> = {}): CatalogState {
  return {
    client: { request } as unknown as CatalogState["client"],
    connected: true,
    catalogLoading: false,
    catalogError: null,
    recipeCatalog: [],
    capabilityCatalog: [],
    ...overrides,
  };
}

describe("platform catalog controller", () => {
  it("loads recipe and capability catalog data from gateway methods", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "platform.recipes.list") {
        return {
          recipes: [
            {
              id: "doc_ingest",
              purpose: "Extract, summarize, and audit document payloads",
              riskLevel: "low",
              allowedProfiles: [{ id: "builder", label: "Builder" }],
              requiredCapabilities: ["pdf-renderer"],
              publishTargets: [],
              producedArtifacts: [],
            },
          ],
        };
      }
      if (method === "platform.capabilities.list") {
        return {
          capabilities: [
            {
              id: "pdf-renderer",
              label: "PDF Renderer",
              status: "missing",
              source: "catalog",
              trusted: true,
              installMethod: "download",
              requiredBins: ["playwright"],
              requiredEnv: [],
              tags: ["pdf"],
              requiredByRecipes: [
                {
                  id: "doc_ingest",
                  purpose: "Extract, summarize, and audit document payloads",
                },
              ],
              requiredByRecipeCount: 1,
            },
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);

    await loadPlatformCatalog(state);

    expect(request).toHaveBeenCalledWith("platform.recipes.list", {});
    expect(request).toHaveBeenCalledWith("platform.capabilities.list", {});
    expect(state.recipeCatalog).toHaveLength(1);
    expect(state.capabilityCatalog).toHaveLength(1);
    expect(state.catalogError).toBeNull();
  });
});
