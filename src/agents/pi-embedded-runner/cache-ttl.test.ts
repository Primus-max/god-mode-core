import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveProviderCacheTtlEligibility: (params: {
    context: { provider: string; modelId: string };
  }) => {
    if (params.context.provider === "anthropic") {
      return true;
    }
    if (params.context.provider === "moonshot" || params.context.provider === "zai") {
      return true;
    }
    if (params.context.provider === "openrouter") {
      return ["anthropic/", "moonshot/", "moonshotai/", "zai/"].some((prefix) =>
        params.context.modelId.startsWith(prefix),
      );
    }
    return undefined;
  },
}));

// `test/setup.ts` (and other test files in the same vitest --no-isolate worker)
// transitively pre-loads `cache-ttl.js`'s dependency chain via
// `../../plugins/provider-runtime.js`, capturing the REAL
// `resolveProviderCacheTtlEligibility` reference BEFORE this file's `vi.mock`
// factory registers. Without `vi.resetModules()` the SUT keeps the real
// binding (which returns `undefined` because no plugins are registered in
// the test worker), so `isCacheTtlEligibleProvider` falls through to `false`
// for providers that should be eligible. Same root cause as PR #303 / #304 /
// #305 / #308.
let isCacheTtlEligibleProvider: (typeof import("./cache-ttl.js"))["isCacheTtlEligibleProvider"];

beforeAll(async () => {
  vi.resetModules();
  const cacheTtl = await import("./cache-ttl.js");
  isCacheTtlEligibleProvider = cacheTtl.isCacheTtlEligibleProvider;
});

describe("isCacheTtlEligibleProvider", () => {
  it("allows anthropic", () => {
    expect(isCacheTtlEligibleProvider("anthropic", "claude-sonnet-4-20250514")).toBe(true);
  });

  it("allows moonshot and zai providers", () => {
    expect(isCacheTtlEligibleProvider("moonshot", "kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("zai", "glm-5")).toBe(true);
  });

  it("is case-insensitive for native providers", () => {
    expect(isCacheTtlEligibleProvider("Moonshot", "Kimi-K2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("ZAI", "GLM-5")).toBe(true);
  });

  it("allows openrouter cache-ttl models", () => {
    expect(isCacheTtlEligibleProvider("openrouter", "anthropic/claude-sonnet-4")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "moonshotai/kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "moonshot/kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "zai/glm-5")).toBe(true);
  });

  it("rejects unsupported providers and models", () => {
    expect(isCacheTtlEligibleProvider("openai", "gpt-4o")).toBe(false);
    expect(isCacheTtlEligibleProvider("openrouter", "openai/gpt-4o")).toBe(false);
  });
});
