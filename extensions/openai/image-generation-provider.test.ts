import * as providerAuth from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHydraImageGenerationProvider,
  buildOpenAIImageGenerationProvider,
} from "./image-generation-provider.js";

describe("OpenAI image-generation provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates PNG buffers from the OpenAI Images API", async () => {
    const resolveApiKeySpy = vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "sk-test",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            b64_json: Buffer.from("png-data").toString("base64"),
            revised_prompt: "revised",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildOpenAIImageGenerationProvider();
    const authStore = { version: 1, profiles: {} };
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-1",
      prompt: "draw a cat",
      cfg: {},
      authStore,
    });

    expect(resolveApiKeySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        store: authStore,
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "gpt-image-1",
          prompt: "draw a cat",
          n: 1,
          size: "1024x1024",
        }),
      }),
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          mimeType: "image/png",
          fileName: "image-1.png",
          revisedPrompt: "revised",
        },
      ],
      model: "gpt-image-1",
    });
  });

  it("rejects reference-image edits for now", async () => {
    const provider = buildOpenAIImageGenerationProvider();

    await expect(
      provider.generateImage({
        provider: "openai",
        model: "gpt-image-1",
        prompt: "Edit this image",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("x"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("does not support reference-image edits");
  });

  it("uses Hydra baseUrl and auth when configured as an OpenAI-compatible image provider", async () => {
    const resolveApiKeySpy = vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "sd-test",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: `![Generated Image](data:image/png;base64,${Buffer.from("hydra-image").toString("base64")})`,
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildHydraImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "hydra",
      model: "hydra-banana",
      prompt: "draw a cheerful banana",
      cfg: {
        models: {
          providers: {
            hydra: {
              baseUrl: "https://api-ru.hydraai.ru/v1",
            },
          },
        },
      },
    });

    expect(resolveApiKeySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "hydra",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api-ru.hydraai.ru/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "hydra-banana",
          messages: [
            {
              role: "user",
              content:
                "draw a cheerful banana\n\nGenerate exactly 1 image.\nRequested size: 1024x1024.\nReturn the generated image result directly.",
            },
          ],
        }),
      }),
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("hydra-image"),
          mimeType: "image/png",
          fileName: "image-1.png",
        },
      ],
      model: "hydra-banana",
      metadata: {
        rawContent: `![Generated Image](data:image/png;base64,${Buffer.from("hydra-image").toString("base64")})`,
      },
    });
  });
});
