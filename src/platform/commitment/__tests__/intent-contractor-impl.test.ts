import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  DEFAULT_INTENT_CONTRACTOR_BACKEND,
  DEFAULT_INTENT_CONTRACTOR_CONFIDENCE_THRESHOLD,
  DEFAULT_INTENT_CONTRACTOR_MAX_TOKENS,
  DEFAULT_INTENT_CONTRACTOR_MODEL,
  DEFAULT_INTENT_CONTRACTOR_TIMEOUT_MS,
  PERSISTENT_SESSION_EFFECT_FAMILY,
  UNKNOWN_EFFECT_FAMILY,
  createIntentContractor,
  parseSemanticIntentResponse,
  resolveIntentContractorAdapter,
  resolveIntentContractorConfig,
  type IntentContractorAdapter,
} from "../index.js";
import type { EffectFamilyId } from "../ids.js";

const prompt = "create a persistent project session";

describe("IntentContractor config", () => {
  it("resolves PR-2 defaults", () => {
    expect(resolveIntentContractorConfig({ cfg: {} as OpenClawConfig })).toEqual({
      enabled: true,
      backend: DEFAULT_INTENT_CONTRACTOR_BACKEND,
      model: DEFAULT_INTENT_CONTRACTOR_MODEL,
      timeoutMs: DEFAULT_INTENT_CONTRACTOR_TIMEOUT_MS,
      maxTokens: DEFAULT_INTENT_CONTRACTOR_MAX_TOKENS,
      confidenceThreshold: DEFAULT_INTENT_CONTRACTOR_CONFIDENCE_THRESHOLD,
    });
  });

  it("resolves explicit agent default overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          embeddedPi: {
            intentContractor: {
              enabled: false,
              backend: "mock",
              model: "test/model",
              timeoutMs: 123,
              maxTokens: 45,
              confidenceThreshold: 0.75,
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveIntentContractorConfig({ cfg })).toEqual({
      enabled: false,
      backend: "mock",
      model: "test/model",
      timeoutMs: 123,
      maxTokens: 45,
      confidenceThreshold: 0.75,
    });
  });
});

describe("IntentContractor adapter resolution", () => {
  it("prefers injected adapters", () => {
    const adapter: IntentContractorAdapter = {
      classify: async () => ({
        desiredEffectFamily: PERSISTENT_SESSION_EFFECT_FAMILY,
        target: { kind: "session" },
        operation: { kind: "create" },
        constraints: {},
        uncertainty: [],
        confidence: 0.9,
      }),
    };

    expect(resolveIntentContractorAdapter("mock", { mock: adapter })).toBe(adapter);
  });

  it("returns undefined for unknown backends", () => {
    expect(resolveIntentContractorAdapter("missing", {})).toBeUndefined();
  });
});

describe("IntentContractor parsing", () => {
  it("parses and brands a valid semantic intent response", () => {
    const parsed = parseSemanticIntentResponse(
      JSON.stringify({
        desiredEffectFamily: "persistent_session",
        target: { kind: "session" },
        operation: { kind: "create" },
        constraints: { displayName: "Valera" },
        uncertainty: [],
        confidence: 0.91,
      }),
    );

    expect(parsed.parseResult).toBe("ok");
    expect(parsed.intent).toMatchObject({
      desiredEffectFamily: PERSISTENT_SESSION_EFFECT_FAMILY,
      target: { kind: "session" },
      operation: { kind: "create" },
      constraints: { displayName: "Valera" },
      confidence: 0.91,
    });
  });

  it("normalizes unregistered families to unknown with zero confidence", () => {
    const parsed = parseSemanticIntentResponse(
      JSON.stringify({
        desiredEffectFamily: "answer_delivered",
        target: { kind: "unspecified" },
        constraints: {},
        uncertainty: [],
        confidence: 0.88,
      }),
    );

    expect(parsed.intent).toMatchObject({
      desiredEffectFamily: UNKNOWN_EFFECT_FAMILY,
      uncertainty: ["family_not_in_registry"],
      confidence: 0,
    });
  });

  it("rejects invalid response schema without throwing", () => {
    const parsed = parseSemanticIntentResponse("{}");

    expect(parsed.intent).toBeNull();
    expect(parsed.parseResult).toBe("schema_invalid");
  });
});

describe("IntentContractor wrapper", () => {
  it("returns adapter intent and applies registry normalization", async () => {
    const adapter: IntentContractorAdapter = {
      classify: async () => ({
        desiredEffectFamily: "custom_family" as EffectFamilyId,
        target: { kind: "unspecified" },
        constraints: {},
        uncertainty: [],
        confidence: 0.8,
      }),
    };
    const contractor = createIntentContractor({
      cfg: {
        agents: {
          defaults: {
            embeddedPi: {
              intentContractor: { backend: "mock" },
            },
          },
        },
      } as OpenClawConfig,
      adapterRegistry: { mock: adapter },
    });

    await expect(contractor.classify(prompt)).resolves.toMatchObject({
      desiredEffectFamily: UNKNOWN_EFFECT_FAMILY,
      uncertainty: ["family_not_in_registry"],
      confidence: 0,
    });
  });

  it("converts adapter failures into low-confidence intent", async () => {
    const adapter: IntentContractorAdapter = {
      classify: async () => {
        throw new Error("boom");
      },
    };
    const contractor = createIntentContractor({
      cfg: {
        agents: {
          defaults: {
            embeddedPi: {
              intentContractor: { backend: "mock" },
            },
          },
        },
      } as OpenClawConfig,
      adapterRegistry: { mock: adapter },
    });

    await expect(contractor.classify(prompt)).resolves.toMatchObject({
      desiredEffectFamily: UNKNOWN_EFFECT_FAMILY,
      uncertainty: ["llm_error"],
      confidence: 0,
    });
  });
});
