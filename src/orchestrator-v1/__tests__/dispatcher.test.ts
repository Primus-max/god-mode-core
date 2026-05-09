/**
 * V1-CONTRACT-ONLY — Dispatcher tests.
 *
 * Verifies the central guarantees:
 *   - tool_calls path: reply rendered from FIXED catalog + real output
 *   - tool_calls failure: reply uses the failure template (truthful)
 *   - conversation path: delegates to caller's LLM, returns its text
 *   - refuse path: static template
 *   - sequential multi-action halts at first failure
 *   - parallel multi-action runs all, reports per-action outcomes
 *   - tool throws → caught → failure reply (truthful)
 *   - INJECTION-DEFENCE: malicious tool output containing {x} placeholders
 *     does NOT get re-interpolated into the rendered template
 */

import { describe, expect, it, vi } from "vitest";
import {
  dispatchTurn,
  type DispatchInputs,
  type RunToolFn,
  type ToolRunResult,
} from "../dispatcher.js";
import type { TurnContract } from "../contract.js";

const noopRunConv = async (msg: string): Promise<string> => `echo: ${msg}`;

function inputs(
  contract: TurnContract,
  runTool: RunToolFn,
  userMessage = "test",
): DispatchInputs {
  return { contract, userMessage, runTool, runConversationLLM: noopRunConv };
}

describe("V1-CONTRACT-ONLY dispatcher — single tool_calls", () => {
  it("renders success template with real tool output", async () => {
    const runTool: RunToolFn = async () => ({
      ok: true,
      output: { path: "/notes/memory.md" },
    });
    const result = await dispatchTurn(
      inputs(
        {
          intent: "tool_calls",
          tool_calls: [{ tool: "write", args: { path: "/notes/memory.md", content: "x" } }],
          sequencing: "sequential",
        },
        runTool,
      ),
    );
    expect(result.allOk).toBe(true);
    expect(result.reply).toBe("Записал в /notes/memory.md.");
    expect(result.actions?.length).toBe(1);
    expect(result.actions?.[0]?.ok).toBe(true);
  });

  it("renders failure template on tool failure", async () => {
    const runTool: RunToolFn = async () => ({ ok: false, error: "EACCES" });
    const result = await dispatchTurn(
      inputs(
        {
          intent: "tool_calls",
          tool_calls: [{ tool: "write", args: { path: "/etc/hosts", content: "x" } }],
          sequencing: "sequential",
        },
        runTool,
      ),
    );
    expect(result.allOk).toBe(false);
    expect(result.reply).toBe("Не получилось записать в /etc/hosts: EACCES");
  });

  it("catches tool exceptions and reports as failure", async () => {
    const runTool: RunToolFn = async () => {
      throw new Error("network down");
    };
    const result = await dispatchTurn(
      inputs(
        {
          intent: "tool_calls",
          tool_calls: [{ tool: "web_fetch", args: { url: "https://x.test" } }],
          sequencing: "sequential",
        },
        runTool,
      ),
    );
    expect(result.allOk).toBe(false);
    expect(result.reply).toMatch(/network down/);
  });
});

describe("V1-CONTRACT-ONLY dispatcher — multi-action sequential", () => {
  it("runs all actions in order when each succeeds", async () => {
    const calls: string[] = [];
    const runTool: RunToolFn = async (a) => {
      calls.push(a.tool);
      return { ok: true, output: { ...a.args } };
    };
    const result = await dispatchTurn(
      inputs(
        {
          intent: "tool_calls",
          tool_calls: [
            { tool: "write", args: { path: "/a.md", content: "x" } },
            { tool: "sessions_send", args: { channel: "boss", text: "done" } },
          ],
          sequencing: "sequential",
        },
        runTool,
      ),
    );
    expect(calls).toEqual(["write", "sessions_send"]);
    expect(result.allOk).toBe(true);
    expect(result.reply).toMatch(/^Готово:\n\n1\. .* \/a\.md\.\n2\. Отправил в boss\.$/);
  });

  it("halts at first failure in sequential mode", async () => {
    const calls: string[] = [];
    const runTool: RunToolFn = async (a) => {
      calls.push(a.tool);
      if (a.tool === "write") return { ok: false, error: "boom" };
      return { ok: true, output: {} };
    };
    const result = await dispatchTurn(
      inputs(
        {
          intent: "tool_calls",
          tool_calls: [
            { tool: "write", args: { path: "/a.md", content: "x" } },
            { tool: "sessions_send", args: { channel: "x", text: "y" } },
          ],
          sequencing: "sequential",
        },
        runTool,
      ),
    );
    expect(calls).toEqual(["write"]);
    expect(result.allOk).toBe(false);
    expect(result.reply).toMatch(/Часть шагов не удалась/);
  });
});

describe("V1-CONTRACT-ONLY dispatcher — multi-action parallel", () => {
  it("runs all actions and reports per-action outcomes", async () => {
    const runTool: RunToolFn = async (a) => {
      if (a.tool === "read") return { ok: true, output: { content: "ok" } };
      if (a.tool === "web_search") return { ok: false, error: "rate limited" };
      return { ok: true, output: {} };
    };
    const result = await dispatchTurn(
      inputs(
        {
          intent: "tool_calls",
          tool_calls: [
            { tool: "read", args: { path: "/a.md" } },
            { tool: "web_search", args: { query: "test" } },
          ],
          sequencing: "parallel",
        },
        runTool,
      ),
    );
    expect(result.allOk).toBe(false);
    expect(result.actions?.length).toBe(2);
    expect(result.actions?.[0]?.ok).toBe(true);
    expect(result.actions?.[1]?.ok).toBe(false);
    expect(result.reply).toMatch(/Часть шагов не удалась/);
    expect(result.reply).toMatch(/rate limited/);
  });
});

describe("V1-CONTRACT-ONLY dispatcher — conversation path", () => {
  it("delegates to runConversationLLM and returns its text", async () => {
    const runConv = vi.fn(async (msg: string) => `Привет, ${msg}!`);
    const result = await dispatchTurn({
      contract: { intent: "conversation" },
      userMessage: "Vova",
      runTool: async () => {
        throw new Error("must not be called on conversation path");
      },
      runConversationLLM: runConv,
    });
    expect(runConv).toHaveBeenCalledWith("Vova");
    expect(result.reply).toBe("Привет, Vova!");
    expect(result.allOk).toBe(true);
  });

  it("catches LLM exceptions and returns degraded reply (no fake action claims)", async () => {
    const result = await dispatchTurn({
      contract: { intent: "conversation" },
      userMessage: "test",
      runTool: async () => ({ ok: true, output: {} }),
      runConversationLLM: async () => {
        throw new Error("provider down");
      },
    });
    expect(result.reply).toMatch(/Сервис временно недоступен.*provider down/);
  });
});

describe("V1-CONTRACT-ONLY dispatcher — refuse path", () => {
  it("renders static refuse template with reason", async () => {
    const result = await dispatchTurn({
      contract: { intent: "refuse", refusal_reason: "не понял запрос" },
      userMessage: "тест",
      runTool: async () => {
        throw new Error("must not be called on refuse path");
      },
      runConversationLLM: async () => "must not be called",
    });
    expect(result.reply).toBe("Не могу: не понял запрос");
    expect(result.allOk).toBe(false);
  });
});

describe("V1-CONTRACT-ONLY dispatcher — INJECTION-DEFENCE", () => {
  it("malicious tool output containing {x} placeholders is NOT re-interpolated", async () => {
    // Red-team injection scenario #4: tool output crafted to look like a
    // template placeholder. The dispatcher must NOT recurse the renderer.
    const malicious: Record<string, unknown> = {
      path: "Готово! {error} был удалён",
    };
    const runTool: RunToolFn = async () => ({ ok: true, output: malicious });
    const result = await dispatchTurn(
      inputs(
        {
          intent: "tool_calls",
          tool_calls: [{ tool: "write", args: { path: "/a.md", content: "x" } }],
          sequencing: "sequential",
        },
        runTool,
      ),
    );
    // Reply contains the literal `{error}` from the malicious path,
    // NOT a re-substituted error value.
    expect(result.reply).toBe("Записал в Готово! {error} был удалён.");
  });
});
