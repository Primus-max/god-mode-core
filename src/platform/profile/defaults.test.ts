import { describe, expect, it } from "vitest";
import { INITIAL_PROFILE_IDS, INITIAL_PROFILES, getInitialProfile } from "./defaults.js";

describe("platform initial profiles", () => {
  it("contains the intended specialist catalog", () => {
    expect(INITIAL_PROFILE_IDS).toEqual([
      "general",
      "builder",
      "developer",
      "integrator",
      "operator",
      "media_creator",
    ]);
  });

  it("defines task overlays for automatic execution preference", () => {
    expect(getInitialProfile("builder")?.taskOverlays?.map((overlay) => overlay.id)).toContain(
      "document_first",
    );
    expect(getInitialProfile("developer")?.taskOverlays?.map((overlay) => overlay.id)).toContain(
      "code_first",
    );
    expect(getInitialProfile("developer")?.taskOverlays?.map((overlay) => overlay.id)).toContain(
      "general_chat",
    );
    expect(getInitialProfile("integrator")?.taskOverlays?.map((overlay) => overlay.id)).toContain(
      "integration_first",
    );
    expect(getInitialProfile("operator")?.taskOverlays?.map((overlay) => overlay.id)).toContain(
      "ops_first",
    );
    expect(
      getInitialProfile("media_creator")?.taskOverlays?.map((overlay) => overlay.id),
    ).toContain("media_first");
  });

  it("keeps schema ids and live defaults aligned", () => {
    expect(INITIAL_PROFILES.map((profile) => profile.id)).toEqual(INITIAL_PROFILE_IDS);
  });
});
