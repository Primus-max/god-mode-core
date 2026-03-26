import { describe, expect, it } from "vitest";
import { getInitialProfile } from "./defaults.js";
import { applyTaskOverlay, resolveTaskOverlay } from "./overlay.js";

describe("resolveTaskOverlay", () => {
  it("selects document_first for builder document tasks", () => {
    const profile = getInitialProfile("builder")!;
    const overlay = resolveTaskOverlay(profile, {
      prompt: "Extract structured data from this PDF estimate",
      fileNames: ["estimate.pdf"],
    });
    expect(overlay?.id).toBe("document_first");
  });

  it("selects code_first for developer code tasks", () => {
    const profile = getInitialProfile("developer")!;
    const overlay = resolveTaskOverlay(profile, {
      prompt: "Fix the failing tests in repo.ts and rebuild",
      fileNames: ["repo.ts"],
    });
    expect(overlay?.id).toBe("code_first");
  });

  it("selects publish overlay when publish targets are present", () => {
    const profile = getInitialProfile("developer")!;
    const overlay = resolveTaskOverlay(profile, {
      prompt: "Release this package",
      publishTargets: ["github"],
    });
    expect(overlay?.id).toBe("publish_release");
  });

  it("selects general_chat for fun/general requests", () => {
    const profile = getInitialProfile("developer")!;
    const overlay = resolveTaskOverlay(profile, { prompt: "Tell me a fun story about TypeScript" });
    expect(overlay?.id).toBe("general_chat");
  });

  it("selects integration_first for integrator integration tasks", () => {
    const profile = getInitialProfile("integrator")!;
    const overlay = resolveTaskOverlay(profile, {
      prompt: "Validate the webhook integration and sync the connector rollout",
      integrations: ["slack"],
    });
    expect(overlay?.id).toBe("integration_first");
  });

  it("selects ops overlays for operator machine/bootstrap tasks", () => {
    const profile = getInitialProfile("operator")!;
    const machineOverlay = resolveTaskOverlay(profile, {
      prompt: "Run a command on the linked machine and check the kill switch",
    });
    expect(machineOverlay?.id).toBe("machine_control");

    const bootstrapOverlay = resolveTaskOverlay(profile, {
      prompt: "Bootstrap the missing capability before the next run",
    });
    expect(bootstrapOverlay?.id).toBe("bootstrap_capability");
  });

  it("selects media_first for media creation tasks", () => {
    const profile = getInitialProfile("media_creator")!;
    const overlay = resolveTaskOverlay(profile, {
      prompt: "Generate a thumbnail image and caption the audio track",
      fileNames: ["intro.wav"],
    });
    expect(overlay?.id).toBe("media_first");
  });
});

describe("applyTaskOverlay", () => {
  it("merges overlay hints with profile defaults", () => {
    const profile = getInitialProfile("developer")!;
    const overlay = profile.taskOverlays?.find((entry) => entry.id === "code_first");
    const effective = applyTaskOverlay(profile, overlay);
    expect(effective.preferredTools).toContain("exec");
    expect(effective.modelHints).toContain("tool-use");
    expect(effective.timeoutSeconds).toBe(300);
  });

  it("does not invent permissions while merging preferences", () => {
    const profile = getInitialProfile("builder")!;
    const overlay = profile.taskOverlays?.find((entry) => entry.id === "general_chat");
    const effective = applyTaskOverlay(profile, overlay);
    expect(effective.preferredTools).toContain("read");
    expect(effective.preferredTools).not.toContain("process");
  });
});
