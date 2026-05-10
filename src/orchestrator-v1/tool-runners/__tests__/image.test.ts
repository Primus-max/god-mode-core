/**
 * V1-CUTOVER S4 — image_generate runner unit tests.
 *
 * The runner is a thin wrapper around the existing pi-ai image-generation
 * pipeline (`src/image-generation/runtime.ts` -> `generateImage`) plus the
 * media saver (`src/media/store.ts` -> `saveMediaBuffer`). Both are
 * substituted via the runner's `RunImageGenerateDeps` test seam (same
 * pattern as `pdf.ts`'s `renderer`/`outputDir` opts) so tests never hit
 * the network or the filesystem.
 *
 * Why DI instead of `vi.mock`: the previous incarnation of this file used
 * `vi.mock("../../../image-generation/runtime.js", ...)` from the
 * `__tests__/` subdir. The factory silently never ran on Windows — the
 * runner imported the REAL `generateImage`, which threw "No
 * image-generation model configured" because the test profile has no
 * provider set. All 10 of 11 tests failed pre-existing on `dev` for that
 * reason. DI sidesteps the path-matching quirk entirely and matches the
 * convention used by every other test in this directory.
 *
 * Real symptom each test guards against — annotated inline.
 */

import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  runImageGenerate,
  type RunImageGenerateDeps,
} from "../image.js";

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

/**
 * Build a fresh `deps` object with vi.fn() spies the test can introspect.
 * One per test so call counts/args don't leak between tests.
 */
function buildDeps(overrides: Partial<RunImageGenerateDeps> = {}): {
  deps: RunImageGenerateDeps;
  generateImageSpy: ReturnType<typeof vi.fn>;
  saveMediaBufferSpy: ReturnType<typeof vi.fn>;
  loadConfigSpy: ReturnType<typeof vi.fn>;
} {
  const generateImageSpy = vi
    .fn()
    .mockResolvedValue(defaultGenerateResult());
  const saveMediaBufferSpy = vi
    .fn()
    .mockResolvedValue(defaultSavedMedia());
  const loadConfigSpy = vi.fn(() => ({}) as OpenClawConfig);
  const deps: RunImageGenerateDeps = {
    loadConfig: loadConfigSpy,
    generateImage: generateImageSpy as unknown as RunImageGenerateDeps["generateImage"],
    saveMediaBuffer:
      saveMediaBufferSpy as unknown as RunImageGenerateDeps["saveMediaBuffer"],
    ...overrides,
  };
  return { deps, generateImageSpy, saveMediaBufferSpy, loadConfigSpy };
}

describe("runImageGenerate (S4)", () => {
  it("success: returns ok=true with string-typed url from saved media path", async () => {
    // Catches: dispatcher would render `{url}` as `undefined` if the
    // runner ever returned `{ ok: true, output: { url: undefined } }`.
    const { deps } = buildDeps();
    const result = await runImageGenerate(asTurnAction({ prompt: "a cat" }), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(typeof result.output.url).toBe("string");
    expect(result.output.url).toBeTruthy();
    expect(result.output.url).toBe("C:/state/media/tool-image-generation/abc.png");
  });

  it("calls underlying generateImage with the prompt", async () => {
    // Catches: runner silently dropping the prompt or sending a hard-coded
    // string would still produce a path; this asserts the prompt threads.
    const { deps, generateImageSpy } = buildDeps();
    await runImageGenerate(
      asTurnAction({ prompt: "a serene lake at dawn" }),
      deps,
    );

    expect(generateImageSpy).toHaveBeenCalledTimes(1);
    const callArg = generateImageSpy.mock.calls[0]![0] as { prompt: string };
    expect(callArg.prompt).toBe("a serene lake at dawn");
  });

  it("passes size through to underlying client when provided", async () => {
    // Catches: forgetting to forward `size` would silently default the
    // provider to its baseline resolution despite the user requesting one.
    const { deps, generateImageSpy } = buildDeps();
    await runImageGenerate(
      asTurnAction({ prompt: "x", size: "1024x1024" }),
      deps,
    );

    const callArg = generateImageSpy.mock.calls[0]![0] as { size?: string };
    expect(callArg.size).toBe("1024x1024");
  });

  it("omits size when not provided (does not send empty string)", async () => {
    // Catches: sending `size: ""` to providers like OpenAI causes a
    // 400 invalid_request — runner must omit when absent.
    const { deps, generateImageSpy } = buildDeps();
    await runImageGenerate(asTurnAction({ prompt: "x" }), deps);

    const callArg = generateImageSpy.mock.calls[0]![0] as { size?: unknown };
    expect(callArg.size === undefined || callArg.size === null).toBe(true);
  });

  it("style hint is forwarded by appending to the prompt (no upstream style param)", async () => {
    // Catches: silently dropping `style` would lose user intent. Upstream
    // `generateImage` has no `style` param — runner must merge it into prompt.
    const { deps, generateImageSpy } = buildDeps();
    await runImageGenerate(
      asTurnAction({ prompt: "a cat", style: "watercolor" }),
      deps,
    );

    const callArg = generateImageSpy.mock.calls[0]![0] as { prompt: string };
    expect(callArg.prompt.toLowerCase()).toContain("watercolor");
  });

  it("failure: underlying client throws → ok=false with non-empty error", async () => {
    // Catches: a thrown error escaping the runner would propagate up
    // through dispatcher and crash the turn instead of being rendered
    // as a failure template.
    const { deps } = buildDeps({
      generateImage: vi
        .fn()
        .mockRejectedValue(new Error("upstream 500")) as unknown as RunImageGenerateDeps["generateImage"],
    });
    const result = await runImageGenerate(asTurnAction({ prompt: "x" }), deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.error).toContain("upstream 500");
  });

  it("failure: content-policy rejection → error preserved", async () => {
    // Catches: stripping/replacing the upstream error message would hide
    // the real reason from logs; user-facing text comes from the catalog
    // template, but operators rely on `result.error` being verbatim.
    const { deps } = buildDeps({
      generateImage: vi
        .fn()
        .mockRejectedValue(
          new Error("content_policy_violation: prompt rejected"),
        ) as unknown as RunImageGenerateDeps["generateImage"],
    });
    const result = await runImageGenerate(
      asTurnAction({ prompt: "...evil..." }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("content_policy_violation");
  });

  it("failure: generateImage returns zero images → ok=false", async () => {
    // Catches: empty `images: []` array silently producing
    // `{ ok: true, output: { url: undefined } }` — would render as
    // "Сгенерировал: undefined" in chat.
    const { deps } = buildDeps({
      generateImage: vi.fn().mockResolvedValue({
        images: [],
        provider: "openai",
        model: "gpt-image-1",
        attempts: [],
      }) as unknown as RunImageGenerateDeps["generateImage"],
    });
    const result = await runImageGenerate(asTurnAction({ prompt: "x" }), deps);

    expect(result.ok).toBe(false);
  });

  it("failure: saveMediaBuffer throws → ok=false (disk error not masked)", async () => {
    // Catches: a disk error during persistence must not be swallowed —
    // user gets failure template, operator sees the real ENOSPC in logs.
    const { deps } = buildDeps({
      saveMediaBuffer: vi
        .fn()
        .mockRejectedValue(new Error("ENOSPC: no space")) as unknown as RunImageGenerateDeps["saveMediaBuffer"],
    });
    const result = await runImageGenerate(asTurnAction({ prompt: "x" }), deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("ENOSPC");
  });

  it("regression guard: success url is never the literal string 'undefined'", async () => {
    // Catches the exact forgot-await symptom: if the runner did
    // `const r = generateImage(...)` (no await), `r` would be a Promise;
    // later `r.images[0]` -> undefined, saveMediaBuffer never called,
    // output.url renders as the string "undefined" in the template
    // ("Сгенерировал: undefined").
    const { deps } = buildDeps();
    const result = await runImageGenerate(asTurnAction({ prompt: "x" }), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.output.url).not.toBe("undefined");
    expect(result.output.url).not.toBeUndefined();
    expect(String(result.output.url).length).toBeGreaterThan(0);
  });

  it("dispatcher template would render successfully (no unfilled {url})", async () => {
    // Integration check: simulate what the dispatcher does — render the
    // success template with the runner output. Catches: runner returning
    // `{ output: { path } }` instead of `{ output: { url } }` would leave
    // the `{url}` placeholder unfilled.
    const { deps } = buildDeps({
      saveMediaBuffer: vi
        .fn()
        .mockResolvedValue(
          defaultSavedMedia("C:/state/media/tool-image-generation/zzz.png"),
        ) as unknown as RunImageGenerateDeps["saveMediaBuffer"],
    });
    const result = await runImageGenerate(asTurnAction({ prompt: "x" }), deps);
    if (!result.ok) throw new Error("expected ok");

    const { renderTemplate, lookupTemplate } = await import(
      "../../reply-templates.js"
    );
    const template = lookupTemplate("image_generate", "success");
    const rendered = renderTemplate(template, result.output);

    expect(rendered).toBe(
      "Сгенерировал: C:/state/media/tool-image-generation/zzz.png",
    );
    expect(rendered).not.toContain("{url}");
    expect(rendered).not.toContain("undefined");
  });
});
