import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as imageGenerationRuntime from "../image-generation/runtime.js";
import * as mediaStore from "../media/store.js";
import { createOpenClawTools } from "./openclaw-tools.js";

vi.mock("../plugins/tools.js", () => ({
  resolvePluginTools: () => [],
}));

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function stubImageGenerationProviders() {
  vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
    {
      id: "hydra",
      defaultModel: "hydra-banana",
      models: ["hydra-banana", "hydra-banana-pro"],
      capabilities: {
        generate: {
          supportsAspectRatio: true,
        },
        edit: {
          enabled: false,
        },
        geometry: {
          aspectRatios: ["1:1", "16:9"],
        },
      },
      generateImage: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
    {
      id: "openai",
      defaultModel: "gpt-image-1",
      models: ["gpt-image-1"],
      capabilities: {
        generate: {
          supportsSize: true,
        },
        edit: {
          enabled: false,
        },
        geometry: {
          sizes: ["1024x1024"],
        },
      },
      generateImage: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
  ]);
}

describe("openclaw tools image generation registration", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEYS", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEYS", "");
    vi.stubEnv("HYDRA_API_KEY", "");
    vi.stubEnv("HYDRA_API_KEYS", "");
    vi.stubEnv("OPENCLAW_ALLOW_LOCAL_IMAGE_FALLBACK", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("registers image_generate when image-generation config is present", () => {
    const tools = createOpenClawTools({
      config: asConfig({
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "openai/gpt-image-1",
            },
          },
        },
      }),
      agentDir: "/tmp/openclaw-agent-main",
    });

    expect(tools.map((tool) => tool.name)).toContain("image_generate");
  });

  it("registers image_generate when a compatible provider has env-backed auth", () => {
    stubImageGenerationProviders();
    vi.stubEnv("OPENAI_API_KEY", "openai-test");

    const tools = createOpenClawTools({
      config: asConfig({}),
      agentDir: "/tmp/openclaw-agent-main",
    });

    expect(tools.map((tool) => tool.name)).toContain("image_generate");
  });

  it("fails closed when no image-generation config or auth exists", async () => {
    stubImageGenerationProviders();

    const tools = createOpenClawTools({
      config: asConfig({}),
      agentDir: "/tmp/openclaw-agent-main",
    });
    const imageTool = tools.find((tool) => tool.name === "image_generate");
    expect(imageTool).toBeDefined();
    if (!imageTool) {
      throw new Error("expected image_generate tool");
    }
    await expect(imageTool.execute("call-no-auth", { prompt: "A cat" })).rejects.toThrow(
      /No image-generation model configured/,
    );
  });

  it("applies media_creator image-generation defaults ahead of generic config", async () => {
    stubImageGenerationProviders();
    const generateImageSpy = vi
      .spyOn(imageGenerationRuntime, "generateImage")
      .mockResolvedValue({
        provider: "hydra",
        model: "hydra-banana-pro",
        attempts: [],
        images: [
          {
            buffer: Buffer.from("fake-image"),
            mimeType: "image/png",
          },
        ],
      });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      path: "/tmp/rasta-cat.png",
      id: "rasta-cat.png",
      size: 10,
      contentType: "image/png",
    });

    const imageTool = createOpenClawTools({
      config: asConfig({
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "openai/gpt-image-1",
            },
          },
        },
      }),
      selectedProfileId: "media_creator",
      agentDir: "/tmp/openclaw-agent-main",
    }).find((tool) => tool.name === "image_generate");

    expect(imageTool).toBeDefined();
    if (!imageTool) {
      throw new Error("expected image_generate tool");
    }

    await imageTool.execute("call-media-creator", {
      prompt: "Cartoon rasta cat",
      filename: "rasta-cat.png",
    });

    expect(generateImageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          agents: {
            defaults: expect.objectContaining({
              imageGenerationModel: {
                primary: "hydra/hydra-banana-pro",
                fallbacks: ["openai/gpt-image-1"],
              },
            }),
          },
        }),
      }),
    );
  });
});
