/**
 * Cutover-3 Phase 6 — fail-first tests for the structural img2img
 * pre-binding helper exposed by the artifact runtime adapter.
 *
 * The helper (`injectInboundImageReferenceIntoToolArgs`) is the WRITE
 * side of the `INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION` flow.
 * When the affordance gate selects `IMAGE_CREATED_AFFORDANCE_ENTRY`
 * AND the precondition resolves with non-empty `paths`, the adapter
 * injects:
 *   - `image: paths[0]` for the single-ref case (one inbound image),
 *   - `images: paths` for the multi-ref case (two or more).
 *
 * Injection happens BEFORE the model formulates its tool call (same
 * structural pre-binding pattern Search-Composer 4b PR-#131 used for
 * `<web_evidence>` block injection).
 *
 * Bug #2 closure (audit §c): the `image_generate` tool already accepts
 * `image` / `images` schema params (`image-generate-tool.ts:118-128`)
 * and the provider transport already wires `inputImages` through to
 * Hydra `/v1/images/edits` (`runtime.ts:169`); the bug is the missing
 * structural pre-binding seam, which this helper closes.
 */

import { describe, expect, it, vi } from "vitest";

import {
  injectInboundImageReferenceIntoToolArgs,
  type ImageGenerateToolArgs,
  type InjectInboundImageReferenceResult,
} from "./artifact-runtime-adapter.js";

describe("injectInboundImageReferenceIntoToolArgs (cutover-3 Phase 6)", () => {
  it("precondition resolves with 1 path → tool args include `image: paths[0]`, no `images`", () => {
    const args: ImageGenerateToolArgs = { prompt: "redraw this in watercolor" };
    const result = injectInboundImageReferenceIntoToolArgs({
      toolName: "image_generate",
      toolArgs: args,
      preconditionValue: { paths: ["media/inbound/sketch.jpg"] },
    });
    expect(result.injected).toBe(true);
    expect(result.toolArgs.image).toBe("media/inbound/sketch.jpg");
    // For single-ref injection the multi-ref `images` field stays absent so
    // the provider does NOT see ambiguous duplicate inputs.
    expect(result.toolArgs.images).toBeUndefined();
  });

  it("precondition resolves with 2 paths → tool args include `images: paths` (multi-ref)", () => {
    const args: ImageGenerateToolArgs = { prompt: "merge these into one scene" };
    const paths = [
      "media/inbound/a.jpg",
      "media/inbound/b.png",
    ] as const;
    const result = injectInboundImageReferenceIntoToolArgs({
      toolName: "image_generate",
      toolArgs: args,
      preconditionValue: { paths },
    });
    expect(result.injected).toBe(true);
    expect(result.toolArgs.images).toEqual([...paths]);
    // Single-ref `image` stays absent on the multi-ref branch.
    expect(result.toolArgs.image).toBeUndefined();
  });

  it("precondition is null → no injection (from-scratch generation path preserved)", () => {
    const args: ImageGenerateToolArgs = { prompt: "draw a cat" };
    const result = injectInboundImageReferenceIntoToolArgs({
      toolName: "image_generate",
      toolArgs: args,
      preconditionValue: null,
    });
    expect(result.injected).toBe(false);
    expect(result.toolArgs.image).toBeUndefined();
    expect(result.toolArgs.images).toBeUndefined();
    expect(result.toolArgs.prompt).toBe("draw a cat");
  });

  it("precondition has empty `paths` array → no injection (defensive)", () => {
    const args: ImageGenerateToolArgs = { prompt: "draw a cat" };
    const result = injectInboundImageReferenceIntoToolArgs({
      toolName: "image_generate",
      toolArgs: args,
      preconditionValue: { paths: [] },
    });
    expect(result.injected).toBe(false);
    expect(result.toolArgs.image).toBeUndefined();
    expect(result.toolArgs.images).toBeUndefined();
  });

  it("non-`image_generate` tool → no injection (other tools untouched)", () => {
    const args: ImageGenerateToolArgs = { prompt: "ignored" };
    const result = injectInboundImageReferenceIntoToolArgs({
      toolName: "pdf",
      toolArgs: args,
      preconditionValue: { paths: ["media/inbound/sketch.jpg"] },
    });
    expect(result.injected).toBe(false);
    expect(result.toolArgs.image).toBeUndefined();
    expect(result.toolArgs.images).toBeUndefined();
  });

  it("logs `[image-generate] inputImages count=N referenceMode=img2img` on injection", () => {
    const logger = vi.fn<(line: string) => void>();
    const result: InjectInboundImageReferenceResult = injectInboundImageReferenceIntoToolArgs({
      toolName: "image_generate",
      toolArgs: { prompt: "img2img edit" },
      preconditionValue: { paths: ["media/inbound/a.jpg"] },
      logger,
    });
    expect(result.injected).toBe(true);
    expect(logger).toHaveBeenCalled();
    const calls = logger.mock.calls.map((c) => c[0]);
    const hit = calls.some(
      (line) =>
        line.includes("[image-generate]") &&
        line.includes("inputImages count=1") &&
        line.includes("referenceMode=img2img"),
    );
    expect(hit).toBe(true);
  });

  it("logs reflect multi-ref count when 2+ paths injected", () => {
    const logger = vi.fn<(line: string) => void>();
    injectInboundImageReferenceIntoToolArgs({
      toolName: "image_generate",
      toolArgs: { prompt: "merge" },
      preconditionValue: {
        paths: ["media/inbound/a.jpg", "media/inbound/b.png"],
      },
      logger,
    });
    const calls = logger.mock.calls.map((c) => c[0]);
    const hit = calls.some(
      (line) =>
        line.includes("inputImages count=2") &&
        line.includes("referenceMode=img2img"),
    );
    expect(hit).toBe(true);
  });

  it("does NOT mutate caller-supplied tool args (returns a NEW object)", () => {
    const args: ImageGenerateToolArgs = { prompt: "redraw" };
    const result = injectInboundImageReferenceIntoToolArgs({
      toolName: "image_generate",
      toolArgs: args,
      preconditionValue: { paths: ["media/inbound/a.jpg"] },
    });
    expect(result.toolArgs).not.toBe(args);
    expect(args.image).toBeUndefined();
    expect(result.toolArgs.image).toBe("media/inbound/a.jpg");
  });

  it("preserves caller-supplied `image` arg when precondition is null (no override)", () => {
    const args: ImageGenerateToolArgs = {
      prompt: "redraw",
      image: "media/explicit/user-supplied.jpg",
    };
    const result = injectInboundImageReferenceIntoToolArgs({
      toolName: "image_generate",
      toolArgs: args,
      preconditionValue: null,
    });
    expect(result.injected).toBe(false);
    expect(result.toolArgs.image).toBe("media/explicit/user-supplied.jpg");
  });
});
