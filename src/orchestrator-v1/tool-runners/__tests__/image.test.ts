/**
 * V1-CUTOVER S4 — image_generate runner unit tests.
 *
 * The runner is a thin wrapper around the existing pi-ai image-generation
 * pipeline (`src/image-generation/runtime.ts` -> `generateImage`) plus the
 * media saver (`src/media/store.ts` -> `saveMediaBuffer`). Both are mocked
 * at module boundary so tests never hit the network or the filesystem.
 *
 * Real symptom this file guards against: if the runner forgets `await` on
 * `generateImage(...)`, the dispatcher renders `{url}` as `undefined` and
 * the user sees "Сгенерировал: undefined". The success path therefore
 * asserts `output.url` is a non-empty string.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateImageMock = vi.fn();
const saveMediaBufferMock = vi.fn();
const loadConfigMock = vi.fn(() => ({}));

vi.mock("../../../image-generation/runtime.js", () => ({
  generateImage: (...args: unknown[]) => generateImageMock(...args),
}));

vi.mock("../../../media/store.js", () => ({
  saveMediaBuffer: (...args: unknown[]) => saveMediaBufferMock(...args),
}));

vi.mock("../../../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

beforeEach(() => {
  generateImageMock.mockReset();
  saveMediaBufferMock.mockReset();
  loadConfigMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function asTurnAction(args: { prompt: string; size?: string; style?: string }) {
  return { tool: "image_generate" as const, args };
}

function defaultGenerateResult() {
  return {
    images: [
      {
        buffer: Buffer.from("fake-png-bytes"),
        mimeType: "image/png",
        fileName: "test.png",
      },
    ],
    provider: "openai",
    model: "gpt-image-1",
    attempts: [],
  };
}

function defaultSavedMedia(p = "C:/state/media/tool-image-generation/abc.png") {
  return {
    path: p,
    size: 14,
    contentType: "image/png",
    id: "abc.png",
  };
}

describe("runImageGenerate (S4)", () => {
  it("success: returns ok=true with string-typed url from saved media path", async () => {
    generateImageMock.mockResolvedValue(defaultGenerateResult());
    saveMediaBufferMock.mockResolvedValue(defaultSavedMedia());

    const { runImageGenerate } = await import("../image.js");
    const result = await runImageGenerate(asTurnAction({ prompt: "a cat" }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // The whole point of the regression guard: url must be a real string,
    // not `undefined` (forgot-await symptom).
    expect(typeof result.output.url).toBe("string");
    expect(result.output.url).toBeTruthy();
    expect(result.output.url).toBe("C:/state/media/tool-image-generation/abc.png");
  });

  it("calls underlying generateImage with the prompt", async () => {
    generateImageMock.mockResolvedValue(defaultGenerateResult());
    saveMediaBufferMock.mockResolvedValue(defaultSavedMedia());

    const { runImageGenerate } = await import("../image.js");
    await runImageGenerate(asTurnAction({ prompt: "a serene lake at dawn" }));

    expect(generateImageMock).toHaveBeenCalledTimes(1);
    const callArg = generateImageMock.mock.calls[0]![0] as { prompt: string };
    expect(callArg.prompt).toBe("a serene lake at dawn");
  });

  it("passes size through to underlying client when provided", async () => {
    generateImageMock.mockResolvedValue(defaultGenerateResult());
    saveMediaBufferMock.mockResolvedValue(defaultSavedMedia());

    const { runImageGenerate } = await import("../image.js");
    await runImageGenerate(asTurnAction({ prompt: "x", size: "1024x1024" }));

    const callArg = generateImageMock.mock.calls[0]![0] as { size?: string };
    expect(callArg.size).toBe("1024x1024");
  });

  it("omits size when not provided (does not send empty string)", async () => {
    generateImageMock.mockResolvedValue(defaultGenerateResult());
    saveMediaBufferMock.mockResolvedValue(defaultSavedMedia());

    const { runImageGenerate } = await import("../image.js");
    await runImageGenerate(asTurnAction({ prompt: "x" }));

    const callArg = generateImageMock.mock.calls[0]![0] as { size?: unknown };
    expect(callArg.size === undefined || callArg.size === null).toBe(true);
  });

  it("style hint is forwarded by appending to the prompt (no upstream style param)", async () => {
    generateImageMock.mockResolvedValue(defaultGenerateResult());
    saveMediaBufferMock.mockResolvedValue(defaultSavedMedia());

    const { runImageGenerate } = await import("../image.js");
    await runImageGenerate(asTurnAction({ prompt: "a cat", style: "watercolor" }));

    const callArg = generateImageMock.mock.calls[0]![0] as { prompt: string };
    // style is preserved in some shape — either as its own field or merged
    // into the prompt. We only assert it isn't dropped silently.
    expect(callArg.prompt.toLowerCase()).toContain("watercolor");
  });

  it("failure: underlying client throws → ok=false with non-empty error", async () => {
    generateImageMock.mockRejectedValue(new Error("upstream 500"));
    saveMediaBufferMock.mockResolvedValue(defaultSavedMedia());

    const { runImageGenerate } = await import("../image.js");
    const result = await runImageGenerate(asTurnAction({ prompt: "x" }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.error).toContain("upstream 500");
  });

  it("failure: content-policy rejection → error preserved", async () => {
    generateImageMock.mockRejectedValue(
      new Error("content_policy_violation: prompt rejected"),
    );
    saveMediaBufferMock.mockResolvedValue(defaultSavedMedia());

    const { runImageGenerate } = await import("../image.js");
    const result = await runImageGenerate(asTurnAction({ prompt: "...evil..." }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("content_policy_violation");
  });

  it("failure: generateImage returns zero images → ok=false", async () => {
    generateImageMock.mockResolvedValue({
      images: [],
      provider: "openai",
      model: "gpt-image-1",
      attempts: [],
    });
    saveMediaBufferMock.mockResolvedValue(defaultSavedMedia());

    const { runImageGenerate } = await import("../image.js");
    const result = await runImageGenerate(asTurnAction({ prompt: "x" }));

    expect(result.ok).toBe(false);
  });

  it("failure: saveMediaBuffer throws → ok=false (disk error not masked)", async () => {
    generateImageMock.mockResolvedValue(defaultGenerateResult());
    saveMediaBufferMock.mockRejectedValue(new Error("ENOSPC: no space"));

    const { runImageGenerate } = await import("../image.js");
    const result = await runImageGenerate(asTurnAction({ prompt: "x" }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("ENOSPC");
  });

  it("regression guard: success url is never the literal string 'undefined'", async () => {
    // Forgot-await symptom: if the runner did `const r = generateImage(...)`
    // (no await), `r` would be a Promise; later `r.images[0]` -> undefined,
    // saveMediaBuffer never called, output.url renders as undefined string
    // in the template ("Сгенерировал: undefined"). This test fails for
    // any implementation that lets `output.url` be undefined or "undefined".
    generateImageMock.mockResolvedValue(defaultGenerateResult());
    saveMediaBufferMock.mockResolvedValue(defaultSavedMedia());

    const { runImageGenerate } = await import("../image.js");
    const result = await runImageGenerate(asTurnAction({ prompt: "x" }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.output.url).not.toBe("undefined");
    expect(result.output.url).not.toBeUndefined();
    expect(String(result.output.url).length).toBeGreaterThan(0);
  });

  it("dispatcher template would render successfully (no unfilled {url})", async () => {
    // Integration check: simulate what the dispatcher does — render the
    // success template with the runner output. The dispatcher's
    // `allPlaceholdersPresent` would reject `{url}` if our output dropped
    // it. We assert here that the runner provides exactly that key.
    generateImageMock.mockResolvedValue(defaultGenerateResult());
    saveMediaBufferMock.mockResolvedValue(
      defaultSavedMedia("C:/state/media/tool-image-generation/zzz.png"),
    );

    const { runImageGenerate } = await import("../image.js");
    const result = await runImageGenerate(asTurnAction({ prompt: "x" }));
    if (!result.ok) throw new Error("expected ok");

    const { renderTemplate, lookupTemplate } = await import("../../reply-templates.js");
    const template = lookupTemplate("image_generate", "success");
    const rendered = renderTemplate(template, result.output);

    expect(rendered).toBe("Сгенерировал: C:/state/media/tool-image-generation/zzz.png");
    expect(rendered).not.toContain("{url}");
    expect(rendered).not.toContain("undefined");
  });
});
