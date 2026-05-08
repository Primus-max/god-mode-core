/**
 * Slice F — fail-first tests for the `image_generate` runtime-adapter
 * wrapper that injects the inbound TG sketch path onto the tool's
 * `image:` arg before tool execution. Pinning the production trace
 * `gateway-pr315b.log` turnId
 * `a0ba62ec-5343-40cd-bc11-bd753eb8131a` (Vladimir's hand-drawn
 * ventilation sketch — bot called `image_generate { prompt: "..." }`
 * with NO `image:` arg, so it ran in text-to-image mode and produced a
 * different diagram).
 *
 * Boundary: the wrapper is the missing seam BETWEEN
 *   (1) `inboundMediaSummary.attachments[].path` populated by Slice E
 *       (PR #315) for non-webchat channels, and
 *   (2) the actual `image_generate` tool dispatch in `pi-agent-core`.
 *
 * Per AGENTS.md "tests must catch real bugs": these tests drive the
 * REAL wrapper (`wrapImageGenerateWithImg2ImgInjection`) through its
 * `execute` surface. They do NOT `vi.spyOn` the function-under-test;
 * they only spy on the inner `execute` of the wrapped tool to observe
 * what the wrapper passed forward. That confirms args mutation
 * actually crosses the seam, which is the exact symptom the slice
 * pins.
 */

import { describe, expect, it, vi } from "vitest";

import {
  RUNTIME_ADAPTER_IMG2IMG_BIND_LOG_PREFIX,
  applyImg2ImgInjectionToToolList,
  wrapImageGenerateWithImg2ImgInjection,
} from "./image-generate-img2img-wrapper.js";
import type { AnyAgentTool } from "../../tools/common.js";

type CapturedExecute = ReturnType<typeof vi.fn>;

function makeFakeImageGenerateTool(name = "image_generate"): {
  tool: AnyAgentTool;
  execute: CapturedExecute;
} {
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "ok" }],
  }));
  // Cast through unknown — `AnyAgentTool` is the broad runtime shape
  // used by pi-agent-core. The minimal contract for the wrapper is
  // `{ name, execute }`, mirrored verbatim here so the wrapper sees a
  // realistic input.
  const tool = {
    name,
    label: "Image Generation",
    description: "test fake",
    parameters: { type: "object" as const, properties: {} },
    execute,
  } as unknown as AnyAgentTool;
  return { tool, execute };
}

describe("Slice F — wrapImageGenerateWithImg2ImgInjection", () => {
  it("A: img2img injection happens — sketch path lands on args.image when LLM did NOT supply image", async () => {
    // Pins production trace gateway-pr315b.log turnId
    // a0ba62ec-5343-40cd-bc11-bd753eb8131a — bot called
    // `image_generate { prompt: "ventilation scheme" }` with no
    // `image:` arg, the wrapper must fill it from the Slice E summary.
    const { tool, execute } = makeFakeImageGenerateTool();
    const wrapped = wrapImageGenerateWithImg2ImgInjection({
      tool,
      inboundMediaSummary: {
        attachments: [
          {
            kind: "image",
            path: "/tmp/openclaw/media/inbound/sketch.jpg",
            mimeType: "image/jpeg",
          },
        ],
      },
      turnId: "a0ba62ec-5343-40cd-bc11-bd753eb8131a",
    });
    expect(wrapped.execute).toBeDefined();
    await wrapped.execute?.(
      "tool-call-1",
      { prompt: "ventilation scheme" },
      undefined as unknown as AbortSignal,
      undefined,
    );
    expect(execute).toHaveBeenCalledTimes(1);
    const forwardedArgs = execute.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(forwardedArgs.image).toBe("/tmp/openclaw/media/inbound/sketch.jpg");
    expect(forwardedArgs.prompt).toBe("ventilation scheme");
  });

  it("B: explicit `image:` arg from LLM is preserved (no overwrite)", async () => {
    // Regression guard — when the model itself picks a path, the
    // wrapper must not stomp it (e.g. it picked one of two inbound
    // images explicitly). Symptom we MUST avoid: silent override of a
    // deliberate model choice.
    const { tool, execute } = makeFakeImageGenerateTool();
    const wrapped = wrapImageGenerateWithImg2ImgInjection({
      tool,
      inboundMediaSummary: {
        attachments: [
          {
            kind: "image",
            path: "/tmp/openclaw/media/inbound/sketch.jpg",
            mimeType: "image/jpeg",
          },
        ],
      },
      turnId: "turn-b",
    });
    await wrapped.execute?.(
      "tool-call-2",
      { prompt: "draw X", image: "/tmp/openclaw/media/explicit/llm-chosen.jpg" },
      undefined as unknown as AbortSignal,
      undefined,
    );
    const forwardedArgs = execute.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(forwardedArgs.image).toBe("/tmp/openclaw/media/explicit/llm-chosen.jpg");
  });

  it("C: no inbound image — tool_call passes through unchanged", async () => {
    // Regression guard — preserves the from-scratch generation path
    // verbatim when no inbound attachments surfaced this turn (e.g.
    // pure text prompt "draw a cat").
    const { tool, execute } = makeFakeImageGenerateTool();
    const wrapped = wrapImageGenerateWithImg2ImgInjection({
      tool,
      inboundMediaSummary: undefined,
      turnId: "turn-c",
    });
    await wrapped.execute?.(
      "tool-call-3",
      { prompt: "draw a cat" },
      undefined as unknown as AbortSignal,
      undefined,
    );
    const forwardedArgs = execute.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(forwardedArgs.image).toBeUndefined();
    expect(forwardedArgs.images).toBeUndefined();
    expect(forwardedArgs.prompt).toBe("draw a cat");
  });

  it("D: non-image attachment kind (`pdf`) — no injection on `args.image`", async () => {
    // Resolver-level filter pins this too, but pin at adapter layer
    // explicitly so a future resolver loosening cannot quietly bind a
    // PDF path onto an image-generate args slot.
    const { tool, execute } = makeFakeImageGenerateTool();
    const wrapped = wrapImageGenerateWithImg2ImgInjection({
      tool,
      inboundMediaSummary: {
        attachments: [
          {
            kind: "pdf",
            path: "/tmp/openclaw/media/inbound/report.pdf",
            mimeType: "application/pdf",
          },
        ],
      },
      turnId: "turn-d",
    });
    await wrapped.execute?.(
      "tool-call-4",
      { prompt: "draw" },
      undefined as unknown as AbortSignal,
      undefined,
    );
    const forwardedArgs = execute.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(forwardedArgs.image).toBeUndefined();
    expect(forwardedArgs.images).toBeUndefined();
  });

  it("E: non-`image_generate` tool — wrapper returns the tool verbatim (no execute mutation)", async () => {
    const { tool, execute } = makeFakeImageGenerateTool("pdf");
    const wrapped = wrapImageGenerateWithImg2ImgInjection({
      tool,
      inboundMediaSummary: {
        attachments: [
          {
            kind: "image",
            path: "/tmp/openclaw/media/inbound/sketch.jpg",
            mimeType: "image/jpeg",
          },
        ],
      },
      turnId: "turn-e",
    });
    // The wrapper short-circuits: same identity as the input tool.
    expect(wrapped).toBe(tool);
    await wrapped.execute?.(
      "tool-call-5",
      { prompt: "ignored" },
      undefined as unknown as AbortSignal,
      undefined,
    );
    const forwardedArgs = execute.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(forwardedArgs.image).toBeUndefined();
  });

  it("F: telemetry log line fires on injection — `[runtime-adapter] image_generate img2img-bind path=<p> turnId=<id>`", async () => {
    // Live-verify gate uses this exact prefix to confirm the wrapper
    // executed in production. If the prefix or path/turnId schema
    // drifts, gateway-pr315b.log diff stays empty and the live
    // verifier reports a regression.
    const logger = vi.fn<(line: string) => void>();
    const { tool } = makeFakeImageGenerateTool();
    const wrapped = wrapImageGenerateWithImg2ImgInjection({
      tool,
      inboundMediaSummary: {
        attachments: [
          {
            kind: "image",
            path: "/tmp/openclaw/media/inbound/sketch.jpg",
            mimeType: "image/jpeg",
          },
        ],
      },
      turnId: "a0ba62ec-5343-40cd-bc11-bd753eb8131a",
      logger,
    });
    await wrapped.execute?.(
      "tool-call-6",
      { prompt: "ventilation scheme" },
      undefined as unknown as AbortSignal,
      undefined,
    );
    expect(logger).toHaveBeenCalled();
    const calls = logger.mock.calls.map((c) => c[0]);
    const hit = calls.find(
      (line) =>
        typeof line === "string" &&
        line.startsWith(RUNTIME_ADAPTER_IMG2IMG_BIND_LOG_PREFIX) &&
        line.includes("path=/tmp/openclaw/media/inbound/sketch.jpg") &&
        line.includes("turnId=a0ba62ec-5343-40cd-bc11-bd753eb8131a"),
    );
    expect(hit).toBeDefined();
  });

  it("F2: telemetry NOT emitted on pass-through (preserved explicit `image:`)", async () => {
    // Negative twin of F — when the wrapper does NOT inject (because
    // the LLM supplied an explicit `image:` path) the telemetry line
    // MUST NOT fire. Otherwise the live-verify gate would be muddied
    // with bind events for runs that did not actually img2img-bind.
    const logger = vi.fn<(line: string) => void>();
    const { tool } = makeFakeImageGenerateTool();
    const wrapped = wrapImageGenerateWithImg2ImgInjection({
      tool,
      inboundMediaSummary: {
        attachments: [
          {
            kind: "image",
            path: "/tmp/openclaw/media/inbound/sketch.jpg",
            mimeType: "image/jpeg",
          },
        ],
      },
      turnId: "turn-f2",
      logger,
    });
    await wrapped.execute?.(
      "tool-call-7",
      { prompt: "draw", image: "/tmp/openclaw/media/explicit/from-llm.jpg" },
      undefined as unknown as AbortSignal,
      undefined,
    );
    const callsHittingPrefix = logger.mock.calls
      .map((c) => c[0])
      .filter(
        (line): line is string =>
          typeof line === "string" &&
          line.startsWith(RUNTIME_ADAPTER_IMG2IMG_BIND_LOG_PREFIX),
      );
    expect(callsHittingPrefix).toHaveLength(0);
  });

  it("G: empty inboundMediaSummary.attachments — pass-through (defensive — image-only summary may show up empty after filter)", async () => {
    const { tool, execute } = makeFakeImageGenerateTool();
    const wrapped = wrapImageGenerateWithImg2ImgInjection({
      tool,
      inboundMediaSummary: { attachments: [] },
      turnId: "turn-g",
    });
    await wrapped.execute?.(
      "tool-call-8",
      { prompt: "x" },
      undefined as unknown as AbortSignal,
      undefined,
    );
    const forwardedArgs = execute.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(forwardedArgs.image).toBeUndefined();
  });

  it("H: multi-ref (2 inbound images) — fills `images` array AND telemetry count=2 fires", async () => {
    // Edge of the resolver — the pure injector switches between
    // `image:` (single) and `images:` (multi) depending on path arity.
    // The wrapper layer MUST surface count=N in telemetry so live
    // verification can tell single-ref from multi-ref runs apart.
    const logger = vi.fn<(line: string) => void>();
    const { tool, execute } = makeFakeImageGenerateTool();
    const wrapped = wrapImageGenerateWithImg2ImgInjection({
      tool,
      inboundMediaSummary: {
        attachments: [
          { kind: "image", path: "/tmp/a.jpg", mimeType: "image/jpeg" },
          { kind: "image", path: "/tmp/b.png", mimeType: "image/png" },
        ],
      },
      turnId: "turn-h",
      logger,
    });
    await wrapped.execute?.(
      "tool-call-9",
      { prompt: "merge" },
      undefined as unknown as AbortSignal,
      undefined,
    );
    const forwardedArgs = execute.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(forwardedArgs.image).toBeUndefined();
    expect(forwardedArgs.images).toEqual(["/tmp/a.jpg", "/tmp/b.png"]);
    const hit = logger.mock.calls
      .map((c) => c[0])
      .find(
        (line): line is string =>
          typeof line === "string" &&
          line.startsWith(RUNTIME_ADAPTER_IMG2IMG_BIND_LOG_PREFIX) &&
          line.includes("count=2"),
      );
    expect(hit).toBeDefined();
  });

  it("I: original execute receives the SAME toolCallId / signal / onUpdate forwarded verbatim", async () => {
    // Defense — verify the wrapper does not silently swallow signal /
    // onUpdate. Without this guard, a wrapper bug could break tool
    // abort / streaming progress reporting on `image_generate`.
    const { tool, execute } = makeFakeImageGenerateTool();
    const wrapped = wrapImageGenerateWithImg2ImgInjection({
      tool,
      inboundMediaSummary: {
        attachments: [
          { kind: "image", path: "/tmp/sketch.jpg", mimeType: "image/jpeg" },
        ],
      },
      turnId: "turn-i",
    });
    const ac = new AbortController();
    const onUpdate = vi.fn();
    await wrapped.execute?.("tool-call-10", { prompt: "x" }, ac.signal, onUpdate);
    expect(execute).toHaveBeenCalledTimes(1);
    const callArgs = execute.mock.calls[0];
    expect(callArgs?.[0]).toBe("tool-call-10");
    expect(callArgs?.[2]).toBe(ac.signal);
    expect(callArgs?.[3]).toBe(onUpdate);
  });
});

describe("Slice F — applyImg2ImgInjectionToToolList", () => {
  it("walks the tool list, wraps only `image_generate`, leaves siblings by-reference", async () => {
    const { tool: imageTool, execute: imageExec } = makeFakeImageGenerateTool();
    const { tool: pdfTool } = makeFakeImageGenerateTool("pdf");
    const { tool: webSearchTool } = makeFakeImageGenerateTool("web_search");
    const list = applyImg2ImgInjectionToToolList({
      tools: [pdfTool, imageTool, webSearchTool],
      inboundMediaSummary: {
        attachments: [
          { kind: "image", path: "/tmp/sketch.jpg", mimeType: "image/jpeg" },
        ],
      },
      turnId: "turn-list",
    });
    // pdf and web_search pass through by reference.
    expect(list[0]).toBe(pdfTool);
    expect(list[2]).toBe(webSearchTool);
    // image_generate is replaced by a new wrapper (different identity).
    expect(list[1]).not.toBe(imageTool);
    expect(list[1]?.name).toBe("image_generate");
    // And driving the wrapped image tool injects.
    await list[1]?.execute?.(
      "tool-call-list",
      { prompt: "x" },
      undefined as unknown as AbortSignal,
      undefined,
    );
    const forwardedArgs = imageExec.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(forwardedArgs.image).toBe("/tmp/sketch.jpg");
  });
});
