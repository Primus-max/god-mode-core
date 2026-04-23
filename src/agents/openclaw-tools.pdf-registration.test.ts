import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tools-pdf-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

describe("createOpenClawTools PDF registration", () => {
  it("includes pdf tool when pdfModel is configured", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            pdfModel: { primary: "openai/gpt-5-mini" },
          },
        },
      };

      const tools = createOpenClawTools({ config: cfg, agentDir });
      expect(tools.some((tool) => tool.name === "pdf")).toBe(true);
    });
  });

  it("includes pdf tool when only a Hydra provider apiKey is configured", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "hydra/gpt-5.3-codex" },
          },
        },
        models: {
          providers: {
            hydra: {
              baseUrl: "https://api-ru.hydraai.ru/v1",
              api: "openai-completions",
              apiKey: "hydra-test-key",
              models: [
                {
                  id: "gpt-5.3-codex",
                  name: "GPT-5.3 Codex",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 8_000,
                },
              ],
            },
          },
        },
      };

      const tools = createOpenClawTools({ config: cfg, agentDir });
      expect(tools.some((tool) => tool.name === "pdf")).toBe(true);
    });
  });

  it("keeps pdf tool visible without agentDir and fails closed on invoke", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          pdfModel: { primary: "openai/gpt-5-mini" },
        },
      },
    };

    const pdfTool = createOpenClawTools({ config: cfg }).find((tool) => tool.name === "pdf");
    expect(pdfTool).toBeDefined();
    if (!pdfTool) {
      throw new Error("expected pdf tool");
    }

    await expect(
      pdfTool.execute("call-missing-agentdir", {
        prompt: "Create a one-page PDF.",
        filename: "test.pdf",
      }),
    ).rejects.toThrow(/runtime agentDir is missing/i);
  });
});
