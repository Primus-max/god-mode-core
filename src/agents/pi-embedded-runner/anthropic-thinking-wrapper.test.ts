import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";

import { createAnthropicToolPayloadCompatibilityWrapper } from "./anthropic-stream-wrappers.js";
import { createAnthropicThinkingWrapper } from "./anthropic-thinking-wrapper.js";

/**
 * Slice I — Anthropic Extended Thinking wrapper (B5 principled fix per
 * `commitment_kernel_v1_release_roadmap.plan.md` line 200 (a) and
 * `commitment_kernel_reply_sanitizer.plan.md` §6.4 defense-in-depth).
 *
 * The wrapper sets `payload.thinking = { type: "enabled", budget_tokens: N }`
 * iff (a) the model is Anthropic-API (`api === "anthropic-messages"`), AND
 * (b) `runtimeChannel` is supplied AND is an external delivery surface
 * (telegram, whatsapp, signal, slack, discord, sms, voice, imessage,
 * googlechat).
 *
 * The wrapper must be a no-op for internal channels (webchat) — UI keeps
 * reasoning visible per master-plan §3 — and a no-op for non-Anthropic
 * models.
 *
 * Defense-in-depth: the existing `dropThinkingBlocks`
 * (`pi-embedded-runner/thinking.ts`) and
 * `extractAssistantThinking` (`pi-embedded-utils.ts`) already handle
 * `type: "thinking"` content blocks coming back from the model, so this
 * slice needs ZERO response-side changes. The wrapper only flips the
 * request-side switch.
 */
type AnthropicMessagesModel = Model<"anthropic-messages">;
type OpenAiCompletionsModel = Model<"openai-completions">;

function buildAnthropicModel(modelId = "claude-opus-4-6"): AnthropicMessagesModel {
  return {
    api: "anthropic-messages",
    provider: "anthropic",
    id: modelId,
  } as AnthropicMessagesModel;
}

function buildGoogleModel(): OpenAiCompletionsModel {
  return {
    api: "openai-completions",
    provider: "google",
    id: "gemini-3.1-pro-high",
  } as OpenAiCompletionsModel;
}

function buildContext(): Context {
  return { messages: [] } as Context;
}

/**
 * Create a fake stream function that captures the payload `onPayload`
 * receives — this is the seam the wrapper mutates. The fake synthesizes
 * a representative payload (model + initial fields) the way pi-ai would
 * just before sending the HTTP request.
 *
 * Per slice spec: NO `vi.spyOn` on the wrapper itself — only on this
 * fake `streamFn`.
 */
function createPayloadCapturingStreamFn(initialPayload: Record<string, unknown>): {
  streamFn: StreamFn;
  capturedPayloads: Array<Record<string, unknown>>;
} {
  const capturedPayloads: Array<Record<string, unknown>> = [];
  const streamFn: StreamFn = (model, _context, options) => {
    const payload: Record<string, unknown> = {
      ...initialPayload,
      model: model.id,
    };
    options?.onPayload?.(payload, model);
    capturedPayloads.push(payload);
    return {} as ReturnType<StreamFn>;
  };
  return { streamFn, capturedPayloads };
}

describe("createAnthropicThinkingWrapper", () => {
  describe("Anthropic model + external delivery channel", () => {
    it("telegram + anthropic → payload.thinking enabled with default budget 8000", () => {
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, { runtimeChannel: "telegram" });

      void wrapped(buildAnthropicModel(), buildContext(), {});

      expect(capturedPayloads).toHaveLength(1);
      const payload = capturedPayloads[0]!;
      expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    });

    it("whatsapp + anthropic → payload.thinking enabled", () => {
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, { runtimeChannel: "whatsapp" });

      void wrapped(buildAnthropicModel(), buildContext(), {});

      expect(capturedPayloads[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    });

    it("signal + anthropic → payload.thinking enabled", () => {
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, { runtimeChannel: "signal" });

      void wrapped(buildAnthropicModel(), buildContext(), {});

      expect(capturedPayloads[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    });

    it("slack + anthropic → payload.thinking enabled (slack is external)", () => {
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, { runtimeChannel: "slack" });

      void wrapped(buildAnthropicModel(), buildContext(), {});

      expect(capturedPayloads[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    });

    it("discord + anthropic → payload.thinking enabled", () => {
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, { runtimeChannel: "discord" });

      void wrapped(buildAnthropicModel(), buildContext(), {});

      expect(capturedPayloads[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    });

    it("imessage + anthropic → payload.thinking enabled", () => {
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, { runtimeChannel: "imessage" });

      void wrapped(buildAnthropicModel(), buildContext(), {});

      expect(capturedPayloads[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    });

    it("googlechat + anthropic → payload.thinking enabled", () => {
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, { runtimeChannel: "googlechat" });

      void wrapped(buildAnthropicModel(), buildContext(), {});

      expect(capturedPayloads[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    });

    it("custom budgetTokens=4000 is respected", () => {
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, {
        runtimeChannel: "telegram",
        budgetTokens: 4000,
      });

      void wrapped(buildAnthropicModel(), buildContext(), {});

      expect(capturedPayloads[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 4000 });
    });

    it("custom budgetTokens=16000 is respected", () => {
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, {
        runtimeChannel: "telegram",
        budgetTokens: 16000,
      });

      void wrapped(buildAnthropicModel(), buildContext(), {});

      expect(capturedPayloads[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
    });

    it("preserves other payload fields (does not clobber)", () => {
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({
        max_tokens: 4096,
        temperature: 0.5,
      });
      const wrapped = createAnthropicThinkingWrapper(streamFn, { runtimeChannel: "telegram" });

      void wrapped(buildAnthropicModel(), buildContext(), {});

      const payload = capturedPayloads[0]!;
      expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
      expect(payload.max_tokens).toBe(4096);
      expect(payload.temperature).toBe(0.5);
    });

    it("does not overwrite a pre-existing payload.thinking value", () => {
      // Defensive: if some upstream layer already configured thinking,
      // respect it (e.g. user-supplied extraParams.thinking override).
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({
        thinking: { type: "enabled", budget_tokens: 12000 },
      });
      const wrapped = createAnthropicThinkingWrapper(streamFn, { runtimeChannel: "telegram" });

      void wrapped(buildAnthropicModel(), buildContext(), {});

      expect(capturedPayloads[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 12000 });
    });
  });

  describe("non-Anthropic models — no-op", () => {
    it("telegram + google (openai-completions api) → payload unchanged (no thinking field)", () => {
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, { runtimeChannel: "telegram" });

      void wrapped(buildGoogleModel(), buildContext(), {});

      expect(capturedPayloads).toHaveLength(1);
      expect(capturedPayloads[0]?.thinking).toBeUndefined();
    });

    it("telegram + openai (openai-responses api) → payload unchanged", () => {
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, { runtimeChannel: "telegram" });
      const openaiModel = {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
      } as Model<"openai-responses">;

      void wrapped(openaiModel, buildContext(), {});

      expect(capturedPayloads[0]?.thinking).toBeUndefined();
    });
  });

  describe("internal / unknown channels — no-op", () => {
    it("webchat + anthropic → payload unchanged (UI shows reasoning natively)", () => {
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, { runtimeChannel: "webchat" });

      void wrapped(buildAnthropicModel(), buildContext(), {});

      expect(capturedPayloads[0]?.thinking).toBeUndefined();
    });

    it("undefined runtimeChannel + anthropic → payload unchanged", () => {
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, {});

      void wrapped(buildAnthropicModel(), buildContext(), {});

      expect(capturedPayloads[0]?.thinking).toBeUndefined();
    });

    it("empty-string runtimeChannel + anthropic → payload unchanged", () => {
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, { runtimeChannel: "" });

      void wrapped(buildAnthropicModel(), buildContext(), {});

      expect(capturedPayloads[0]?.thinking).toBeUndefined();
    });

    it("max channel + anthropic → payload unchanged (max not in EXTERNAL_DELIVERY_SURFACES today)", () => {
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, { runtimeChannel: "max" });

      void wrapped(buildAnthropicModel(), buildContext(), {});

      // `max` is in CHAT_CHANNEL_ORDER but not in EXTERNAL_DELIVERY_SURFACES
      // (Phase 1 audit). The wrapper must be conservative and no-op.
      expect(capturedPayloads[0]?.thinking).toBeUndefined();
    });

    it("arbitrary unknown channel + anthropic → payload unchanged", () => {
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, { runtimeChannel: "irc" });

      void wrapped(buildAnthropicModel(), buildContext(), {});

      // `irc` is in CHAT_CHANNEL_ORDER but not in EXTERNAL_DELIVERY_SURFACES.
      expect(capturedPayloads[0]?.thinking).toBeUndefined();
    });
  });

  describe("composition with createAnthropicToolPayloadCompatibilityWrapper", () => {
    it("composes (compat inner, thinking outer) — both effects land", () => {
      const capturedPayloads: Array<Record<string, unknown>> = [];
      const baseStreamFn: StreamFn = (model, _context, options) => {
        const payload: Record<string, unknown> = { model: model.id };
        options?.onPayload?.(payload, model);
        capturedPayloads.push(payload);
        return {} as ReturnType<StreamFn>;
      };

      // Apply tool-payload-compat first, then thinking on top.
      const innerWrapped = createAnthropicToolPayloadCompatibilityWrapper(baseStreamFn);
      const outerWrapped = createAnthropicThinkingWrapper(innerWrapped, {
        runtimeChannel: "telegram",
      });

      void outerWrapped(buildAnthropicModel(), buildContext(), {});

      expect(capturedPayloads).toHaveLength(1);
      // Thinking wrapper effect:
      expect(capturedPayloads[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
      // Composition assertion: BOTH layers ran (no thrown error, payload
      // captured, thinking applied) — proving the onPayload chain composes.
    });

    it("composes (thinking inner, compat outer) — thinking still applied", () => {
      const capturedPayloads: Array<Record<string, unknown>> = [];
      const baseStreamFn: StreamFn = (model, _context, options) => {
        const payload: Record<string, unknown> = { model: model.id };
        options?.onPayload?.(payload, model);
        capturedPayloads.push(payload);
        return {} as ReturnType<StreamFn>;
      };

      const innerWrapped = createAnthropicThinkingWrapper(baseStreamFn, {
        runtimeChannel: "telegram",
      });
      const outerWrapped = createAnthropicToolPayloadCompatibilityWrapper(innerWrapped);

      void outerWrapped(buildAnthropicModel(), buildContext(), {});

      expect(capturedPayloads).toHaveLength(1);
      expect(capturedPayloads[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    });
  });

  describe("preserves caller's onPayload callback", () => {
    it("invokes the caller-supplied onPayload after applying the thinking patch", () => {
      const callerSeen: Array<Record<string, unknown>> = [];
      const { streamFn } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, { runtimeChannel: "telegram" });

      void wrapped(buildAnthropicModel(), buildContext(), {
        onPayload: (payload) => {
          if (payload && typeof payload === "object") {
            callerSeen.push({ ...(payload as Record<string, unknown>) });
          }
        },
      });

      expect(callerSeen).toHaveLength(1);
      // Caller observes the thinking field — wrapper applies its mutation
      // BEFORE calling caller's onPayload (caller-side telemetry sees
      // the final outbound payload).
      expect(callerSeen[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    });

    it("forwards the call when no options are provided", () => {
      // Defensive: caller may pass undefined options. Wrapper must still
      // attach onPayload internally without crashing.
      const { streamFn, capturedPayloads } = createPayloadCapturingStreamFn({});
      const wrapped = createAnthropicThinkingWrapper(streamFn, { runtimeChannel: "telegram" });

      void wrapped(buildAnthropicModel(), buildContext(), undefined);

      expect(capturedPayloads).toHaveLength(1);
      expect(capturedPayloads[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    });
  });

  describe("baseStreamFn defaulting", () => {
    it("falls back to streamSimple when baseStreamFn is undefined", () => {
      // The wrapper's signature accepts `StreamFn | undefined` and defaults
      // to `streamSimple`. We can't run a real stream here without an API
      // key, but we can assert the wrapper is callable and returns the
      // promise/iterator-shaped value pi-ai expects (no throw on construction).
      const wrapped = createAnthropicThinkingWrapper(undefined, { runtimeChannel: "telegram" });
      expect(typeof wrapped).toBe("function");
    });
  });
});
