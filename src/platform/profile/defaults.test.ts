import { describe, expect, it } from "vitest";
import { INITIAL_PROFILE_IDS, INITIAL_PROFILES, getInitialProfile } from "./defaults.js";

describe("platform initial profiles", () => {
  it("contains the Stage 1 baseline profiles", () => {
    expect(INITIAL_PROFILE_IDS).toEqual(["general", "builder", "developer"]);
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
  });

  it("keeps only Stage 1 specialist set in defaults", () => {
    expect(INITIAL_PROFILES.map((profile) => profile.id)).not.toContain("integrator");
  });
});
