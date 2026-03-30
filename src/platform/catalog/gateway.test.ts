import { describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../registry/capability-registry.js";
import { TRUSTED_CAPABILITY_CATALOG } from "../bootstrap/defaults.js";
import {
  createCapabilityCatalogGetGatewayMethod,
  createCapabilityCatalogListGatewayMethod,
  createRecipeCatalogGetGatewayMethod,
  createRecipeCatalogListGatewayMethod,
} from "./gateway.js";

describe("platform catalog gateway methods", () => {
  it("lists and fetches recipe catalog entries", async () => {
    const respond = vi.fn();
    await createRecipeCatalogListGatewayMethod()({
      params: {},
      req: { type: "req", method: "platform.recipes.list", id: "req-1" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        recipes: expect.arrayContaining([
          expect.objectContaining({
            id: "code_build_publish",
            requiredCapabilities: expect.arrayContaining(["node", "git"]),
          }),
        ]),
      }),
    );

    const getRespond = vi.fn();
    await createRecipeCatalogGetGatewayMethod()({
      params: { recipeId: "code_build_publish" },
      req: { type: "req", method: "platform.recipes.get", id: "req-2" },
      client: null,
      isWebchatConnect: () => false,
      respond: getRespond,
      context: {} as never,
    });
    expect(getRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        recipe: expect.objectContaining({
          id: "code_build_publish",
          acceptedInputs: expect.any(Array),
          publishTargets: expect.any(Array),
        }),
      }),
    );
  });

  it("lists and fetches capability catalog entries with recipe references", async () => {
    const registry = createCapabilityRegistry([], TRUSTED_CAPABILITY_CATALOG);
    const respond = vi.fn();
    await createCapabilityCatalogListGatewayMethod(registry)({
      params: {},
      req: { type: "req", method: "platform.capabilities.list", id: "req-3" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        capabilities: expect.arrayContaining([
          expect.objectContaining({
            id: "pdf-renderer",
            requiredByRecipes: expect.any(Array),
          }),
        ]),
      }),
    );

    const getRespond = vi.fn();
    await createCapabilityCatalogGetGatewayMethod(registry)({
      params: { capabilityId: "pdf-renderer" },
      req: { type: "req", method: "platform.capabilities.get", id: "req-4" },
      client: null,
      isWebchatConnect: () => false,
      respond: getRespond,
      context: {} as never,
    });
    expect(getRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        capability: expect.objectContaining({
          id: "pdf-renderer",
          catalogEntry: expect.objectContaining({
            capability: expect.objectContaining({ id: "pdf-renderer" }),
          }),
        }),
      }),
    );
  });
});
