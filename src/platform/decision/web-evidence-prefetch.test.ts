import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  filterWebSearchFromTools,
  maybeFetchWebEvidence,
} from "./web-evidence-prefetch.js";

const cfg: OpenClawConfig = { agents: { defaults: {} } } as OpenClawConfig;

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
  it("returns undefined immediately when requestedTools is undefined", async () => {
    const result = await maybeFetchWebEvidence({
      requestedTools: undefined,
      userPrompt: "hi",
      cfg,
      sessionId: "s",
      turnId: "t",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined immediately when requestedTools omits web_search", async () => {
    const result = await maybeFetchWebEvidence({
      requestedTools: ["pdf", "image_generate"],
      userPrompt: "hi",
      cfg,
      sessionId: "s",
      turnId: "t",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined and logs when the specialist transport fails", async () => {
    const logger = vi.fn();
    const result = await maybeFetchWebEvidence({
      requestedTools: ["web_search"],
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
});
