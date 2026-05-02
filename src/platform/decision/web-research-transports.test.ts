import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createWebResearchComposerTransport,
  createWebResearchSpecialistTransport,
} from "./web-research-transports.js";

const cfg: OpenClawConfig = { agents: { defaults: {} } } as OpenClawConfig;

describe("web-research-transports", () => {
  it("createWebResearchSpecialistTransport returns a callable transport", () => {
    const transport = createWebResearchSpecialistTransport({ cfg });
    expect(typeof transport).toBe("function");
  });

  it("createWebResearchComposerTransport returns a callable transport", () => {
    const transport = createWebResearchComposerTransport({ cfg });
    expect(typeof transport).toBe("function");
  });

  it("specialist transport surfaces an error for an unresolvable model ref", async () => {
    const transport = createWebResearchSpecialistTransport({
      cfg,
      modelRef: "this-is-not-a-valid-ref",
    });
    await expect(
      transport({ prompt: "hi", systemMessage: "sys" }),
    ).rejects.toThrow();
  });

  it("composer transport surfaces an error for an unresolvable model ref", async () => {
    const transport = createWebResearchComposerTransport({
      cfg,
      modelRef: "this-is-not-a-valid-ref",
    });
    await expect(
      transport({ prompt: "hi", systemMessage: "sys", allowedTools: [] }),
    ).rejects.toThrow();
  });
});
