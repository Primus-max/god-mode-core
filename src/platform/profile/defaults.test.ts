import { describe, expect, it } from "vitest";
import { INITIAL_PROFILE_IDS, INITIAL_PROFILES, getInitialProfile } from "./defaults.js";
import { extractProfileSignals } from "./signals.js";

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

  it("documents builder as project-designer coverage for calculations, spreadsheets, suppliers, ventilation", () => {
    const builder = getInitialProfile("builder");
    expect(builder?.description?.toLowerCase()).toMatch(/calculation/);
    expect(builder?.description?.toLowerCase()).toMatch(/spreadsheet/);
    expect(builder?.description?.toLowerCase()).toMatch(/supplier/);
    expect(builder?.description?.toLowerCase()).toMatch(/ventilation/);
    expect(builder?.taskOverlays?.map((o) => o.id)).toContain("project_designer");
  });
});

describe("extractProfileSignals builder-oriented prompts", () => {
  it("scores builder for spreadsheet calculations, supplier comparison, and ventilation language", () => {
    const calc = extractProfileSignals({ prompt: "spreadsheet calculation for concrete volumes" });
    const suppliers = extractProfileSignals({ prompt: "supplier comparison for rebar delivery" });
    const vent = extractProfileSignals({ prompt: "office ventilation air changes per hour" });
    expect(calc.some((s) => s.profileId === "builder")).toBe(true);
    expect(suppliers.some((s) => s.profileId === "builder")).toBe(true);
    expect(vent.some((s) => s.profileId === "builder")).toBe(true);
  });

  it("prefers builder over media when ventilation overlaps design wording", () => {
    const signals = extractProfileSignals({ prompt: "ventilation design air balance for atrium" });
    const builderWeight = signals
      .filter((s) => s.profileId === "builder")
      .reduce((acc, s) => acc + s.weight, 0);
    const mediaWeight = signals
      .filter((s) => s.profileId === "media_creator")
      .reduce((acc, s) => acc + s.weight, 0);
    expect(builderWeight).toBeGreaterThan(mediaWeight);
  });
});
