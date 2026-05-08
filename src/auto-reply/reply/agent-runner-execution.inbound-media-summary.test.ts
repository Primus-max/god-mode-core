/**
 * Slice E — `buildInboundMediaSummaryForTurn` colocated tests.
 *
 * Pins the production trace `gateway-pr313.log` turn `ef694af9-…` symptom:
 * Telegram inbound photo with `MsgContext.MediaPath` set + `opts.images`
 * undefined → previously produced `inboundMediaSummary === undefined`,
 * starving the `INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION` resolver
 * of a `paths[]` to pre-bind onto `image_generate.image`. This test cohort:
 *
 *  A. Telegram inbound-photo path is mapped onto `attachments[].path`.
 *     Reproduces the production regression — fails on parent (the helper
 *     `buildInboundMediaSummaryForTurn` does not exist before Slice E).
 *  B. Webchat path still works (regression guard).
 *  C. Both sources combined + dedupe by path.
 *  D. End-to-end: feeds the helper output into the REAL frozen-layer
 *     `resolveInboundImageReferencePrecondition` resolver and asserts
 *     `paths[0]` matches the Telegram MediaPath. This is the symptom
 *     pin — img2img pre-bind would now have a path to use.
 *  E. Negative — heartbeat turn returns `undefined`.
 *
 * Per AGENTS.md "Tests must catch real bugs": no `vi.spyOn` on the
 * function under test; D exercises the real resolver code path.
 *
 * Module-cache hygiene: uses `vi.resetModules()` + dynamic `beforeAll`
 * re-import (PR-308 / PR-309 / PR-311 pattern) so this file survives
 * `--isolate=false` runs alongside auto-reply siblings whose top-level
 * `vi.mock` calls would otherwise race the SUT's module registration.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { resolveInboundImageReferencePrecondition } from "../../platform/commitment/inbound-image-reference-precondition-resolver.js";

let buildInboundMediaSummaryForTurn: (typeof import("./agent-runner-execution.js"))["buildInboundMediaSummaryForTurn"];

beforeAll(async () => {
  // Reset module cache so the SUT loads cleanly even when sibling
  // auto-reply test files have already populated the registry. PR-308 /
  // PR-309 / PR-311 pattern.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { vi } = await import("vitest");
  vi.resetModules();
  ({ buildInboundMediaSummaryForTurn } = await import("./agent-runner-execution.js"));
});

describe("buildInboundMediaSummaryForTurn — Slice E", () => {
  it("A. Telegram MediaPath is mapped onto attachments[].path (regression: production trace gateway-pr313.log turn ef694af9-…)", () => {
    // Symptom: Vladimir sent a hand-drawn ventilation sketch via
    // Telegram. `MsgContext.MediaPath` was set on the disk path; but
    // `opts.images` was undefined (webchat-only field). Pre-Slice-E
    // the construction at `agent-runner-execution.ts:521-527` produced
    // `inboundMediaSummary === undefined`, so the
    // INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION resolver had no
    // `paths[]` to pre-bind on `image_generate.image`.
    const sketchPath = "/openclaw/media/inbound/ventilation-sketch.jpg";
    const summary = buildInboundMediaSummaryForTurn({
      opts: undefined,
      sessionCtx: {
        MediaPath: sketchPath,
        MediaType: "image/jpeg",
      },
      isHeartbeat: false,
    });
    expect(summary).toBeDefined();
    expect(summary?.attachments).toHaveLength(1);
    expect(summary?.attachments[0]?.path).toBe(sketchPath);
    expect(summary?.attachments[0]?.kind).toBe("image");
    expect(summary?.attachments[0]?.mimeType).toBe("image/jpeg");
  });

  it("A2. Telegram MediaPaths (list form) — multiple files, each carries path", () => {
    // Multi-attachment Telegram album: MediaPaths array with per-entry
    // MediaTypes. Order must be preserved for resolver `paths[0]` reads.
    const summary = buildInboundMediaSummaryForTurn({
      sessionCtx: {
        MediaPaths: ["/openclaw/media/inbound/page1.png", "/openclaw/media/inbound/page2.png"],
        MediaTypes: ["image/png", "image/png"],
      },
      isHeartbeat: false,
    });
    expect(summary?.attachments).toHaveLength(2);
    expect(summary?.attachments.map((entry) => entry.path)).toEqual([
      "/openclaw/media/inbound/page1.png",
      "/openclaw/media/inbound/page2.png",
    ]);
    expect(summary?.attachments.every((entry) => entry.kind === "image")).toBe(true);
  });

  it("A3. MediaPath without MIME — kind inferred from filename extension", () => {
    // Older Telegram payloads sometimes omit MediaType; the helper
    // falls back to extension-based classification so the closed
    // `kind` enum is never lost.
    const summary = buildInboundMediaSummaryForTurn({
      sessionCtx: { MediaPath: "/tmp/photo.HEIC" },
      isHeartbeat: false,
    });
    expect(summary?.attachments[0]?.kind).toBe("image");
    expect(summary?.attachments[0]?.path).toBe("/tmp/photo.HEIC");
  });

  it("B. Webchat opts.images path still produces an attachment entry (regression guard)", () => {
    // Pre-Slice-E webchat path produced `{ kind: "image" }` with no
    // path/mime. Slice E preserves the modality-filter input
    // (`kind: "image"`) and sets `path: ""` so the resolver auto-skips
    // it (resolver guards on `path.length > 0`).
    const summary = buildInboundMediaSummaryForTurn({
      opts: { images: [{ mimeType: "image/png" }] },
      sessionCtx: undefined,
      isHeartbeat: false,
    });
    expect(summary?.attachments).toHaveLength(1);
    expect(summary?.attachments[0]?.kind).toBe("image");
    expect(summary?.attachments[0]?.path).toBe("");
    expect(summary?.attachments[0]?.mimeType).toBe("image/png");
  });

  it("C. Both sources combined — webchat + Telegram in the same summary, deduped by path", () => {
    // Cross-channel scenario: a webchat upload AND a Telegram-forwarded
    // image surface in the same turn. Both must funnel into the same
    // `attachments[]` array; non-empty paths are deduped first-seen.
    const telegramPath = "/openclaw/media/inbound/telegram-photo.jpg";
    const summary = buildInboundMediaSummaryForTurn({
      opts: { images: [{ mimeType: "image/png" }] },
      sessionCtx: {
        MediaPaths: [telegramPath, telegramPath /* duplicate must collapse */],
        MediaTypes: ["image/jpeg", "image/jpeg"],
      },
      isHeartbeat: false,
    });
    expect(summary?.attachments).toHaveLength(2);
    // Webchat entry first (insertion order), Telegram entry second.
    expect(summary?.attachments[0]?.path).toBe("");
    expect(summary?.attachments[0]?.kind).toBe("image");
    expect(summary?.attachments[1]?.path).toBe(telegramPath);
    expect(summary?.attachments[1]?.kind).toBe("image");
    // Dedupe — the second `MediaPaths` entry duplicating the first is
    // dropped so the resolver does NOT pre-bind the same path twice.
    const telegramOccurrences = summary!.attachments.filter((entry) => entry.path === telegramPath);
    expect(telegramOccurrences).toHaveLength(1);
  });

  it("D. End-to-end: helper output drives the REAL INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION resolver — pre-binds image_generate.image", () => {
    // Symptom pin from production trace `gateway-pr313.log` turn
    // `ef694af9-…` (Vladimir's ventilation sketch): the resolver,
    // when fed the helper's output, MUST produce a non-null
    // `{ paths: [<sketch-path>] }` so the runtime adapter can
    // pre-bind `image_generate.image`. This is what flips the bot
    // from text-to-image mode (broken) to img2img mode (fixed).
    //
    // No `vi.spyOn` — the resolver is the REAL frozen-layer code.
    const sketchPath = "/openclaw/media/inbound/ventilation-sketch.jpg";
    const summary = buildInboundMediaSummaryForTurn({
      sessionCtx: {
        MediaPath: sketchPath,
        MediaType: "image/jpeg",
      },
      isHeartbeat: false,
    });
    // Feed the helper output to the real resolver.
    const preconditionValue = resolveInboundImageReferencePrecondition(summary);
    expect(preconditionValue).not.toBeNull();
    expect(preconditionValue!.paths).toEqual([sketchPath]);
  });

  it("D2. Webchat-only summary — resolver returns null (no path to pre-bind)", () => {
    // Boundary: webchat entries carry `path: ""` and the resolver
    // explicitly skips entries where `path.length === 0`. So a
    // webchat-only turn must NOT trigger img2img pre-binding (keeping
    // text-to-image as the fallback when no disk file exists).
    const summary = buildInboundMediaSummaryForTurn({
      opts: { images: [{ mimeType: "image/png" }] },
      sessionCtx: undefined,
      isHeartbeat: false,
    });
    const preconditionValue = resolveInboundImageReferencePrecondition(summary);
    expect(preconditionValue).toBeNull();
  });

  it("D3. PDF inbound — resolver returns null (kind !== 'image')", () => {
    // Negative coverage for the resolver's `kind === 'image'` filter:
    // a PDF attachment must NOT be pre-bound on `image_generate`.
    const summary = buildInboundMediaSummaryForTurn({
      sessionCtx: {
        MediaPath: "/openclaw/media/inbound/spec.pdf",
        MediaType: "application/pdf",
      },
      isHeartbeat: false,
    });
    expect(summary?.attachments[0]?.kind).toBe("pdf");
    expect(resolveInboundImageReferencePrecondition(summary)).toBeNull();
  });

  it("E. Heartbeat turn — attachments empty (no spurious entries from internal-channel context)", () => {
    // Heartbeat turns never carry user-supplied media; even if the
    // ctx accidentally retains a stale MediaPath the helper short-
    // circuits to `undefined` so heartbeat traffic does not pollute
    // the modality requirement set OR trigger img2img pre-binding.
    const summary = buildInboundMediaSummaryForTurn({
      opts: undefined,
      sessionCtx: {
        MediaPath: "/should/be/ignored.jpg",
      },
      isHeartbeat: true,
    });
    expect(summary).toBeUndefined();
  });

  it("E2. Empty / undefined inputs — returns undefined (no spurious entries)", () => {
    // Negative boundary — a turn with neither webchat images nor a
    // MediaPath must produce `undefined`, NOT an empty-array
    // attachments object. Pre-Slice-E behaviour preserved.
    expect(buildInboundMediaSummaryForTurn({})).toBeUndefined();
    expect(
      buildInboundMediaSummaryForTurn({ opts: { images: [] }, sessionCtx: {} }),
    ).toBeUndefined();
  });

  it("E3. Empty-string MediaPath — treated as no-attachment (no zero-length path entry)", () => {
    // Defensive: some channel adapters may set `MediaPath: ""` when a
    // structurally-typed media field is unpopulated. The helper must
    // NOT produce an attachment entry for that — otherwise the
    // resolver would correctly skip it but the modality filter would
    // incorrectly add `image` requirement.
    expect(buildInboundMediaSummaryForTurn({ sessionCtx: { MediaPath: "" } })).toBeUndefined();
    expect(
      buildInboundMediaSummaryForTurn({
        sessionCtx: { MediaPaths: ["", "  "] },
      }),
    ).toBeUndefined();
  });
});
