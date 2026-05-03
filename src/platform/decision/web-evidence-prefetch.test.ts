import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  filterWebSearchFromTools,
  hasWebSearchSignal,
  maybeFetchWebEvidence,
} from "./web-evidence-prefetch.js";

const cfg: OpenClawConfig = { agents: { defaults: {} } } as OpenClawConfig;

describe("hasWebSearchSignal", () => {
  it("returns false when neither requestedTools nor toolBundles signal web_search", () => {
    expect(
      hasWebSearchSignal({
        requestedTools: ["pdf"],
        toolBundles: ["artifact_authoring"],
      }),
    ).toBe(false);
  });

  it("returns true when requestedTools includes web_search", () => {
    expect(
      hasWebSearchSignal({
        requestedTools: ["pdf", "web_search"],
        toolBundles: undefined,
      }),
    ).toBe(true);
  });

  it("returns true when toolBundles includes public_web_lookup", () => {
    expect(
      hasWebSearchSignal({
        requestedTools: undefined,
        toolBundles: ["public_web_lookup"],
      }),
    ).toBe(true);
  });

  it("returns false when both inputs are undefined", () => {
    expect(
      hasWebSearchSignal({
        requestedTools: undefined,
        toolBundles: undefined,
      }),
    ).toBe(false);
  });
});

describe("filterWebSearchFromTools", () => {
  it("returns undefined when input is undefined", () => {
    expect(filterWebSearchFromTools(undefined)).toBeUndefined();
  });

  it("returns the same array when web_search is absent", () => {
    expect(filterWebSearchFromTools(["pdf", "image_generate"])).toEqual(["pdf", "image_generate"]);
  });

  it("filters web_search out when present", () => {
    expect(filterWebSearchFromTools(["pdf", "web_search", "image_generate"])).toEqual([
      "pdf",
      "image_generate",
    ]);
  });

  it("filters multiple web_search occurrences", () => {
    expect(filterWebSearchFromTools(["web_search", "pdf", "web_search"])).toEqual(["pdf"]);
  });
});

describe("maybeFetchWebEvidence", () => {
  it("returns undefined immediately when neither requestedTools nor toolBundles signal web_search", async () => {
    const result = await maybeFetchWebEvidence({
      requestedTools: undefined,
      toolBundles: undefined,
      userPrompt: "hi",
      cfg,
      sessionId: "s",
      turnId: "t",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined immediately when requestedTools + toolBundles are present but neither carries the web_search signal", async () => {
    const result = await maybeFetchWebEvidence({
      requestedTools: ["pdf", "image_generate"],
      toolBundles: ["artifact_authoring"],
      userPrompt: "hi",
      cfg,
      sessionId: "s",
      turnId: "t",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined and logs when the specialist transport fails (requestedTools signal)", async () => {
    const logger = vi.fn();
    const result = await maybeFetchWebEvidence({
      requestedTools: ["web_search"],
      toolBundles: undefined,
      userPrompt: "what is the latest news",
      cfg,
      sessionId: "s",
      turnId: "t",
      logger,
    });
    expect(result).toBeUndefined();
    expect(logger).toHaveBeenCalled();
    const message = logger.mock.calls[0]?.[0] ?? "";
    expect(message).toContain("[web-evidence-prefetch] specialist_failed");
  });

  it("triggers the prefetch when requestedTools omits web_search but the resolution contract carries the public_web_lookup bundle", async () => {
    const logger = vi.fn();
    const result = await maybeFetchWebEvidence({
      requestedTools: ["pdf"],
      toolBundles: ["artifact_authoring", "public_web_lookup"],
      userPrompt: "fetch the latest IT news and make a PDF summary",
      cfg,
      sessionId: "s",
      turnId: "t",
      logger,
    });
    expect(result).toBeUndefined();
    expect(logger).toHaveBeenCalled();
    const message = logger.mock.calls[0]?.[0] ?? "";
    expect(message).toContain("[web-evidence-prefetch] specialist_failed");
  });
});
