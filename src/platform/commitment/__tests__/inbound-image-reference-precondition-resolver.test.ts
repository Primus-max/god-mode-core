/**
 * Cutover-3 Phase 6 — fail-first tests for the inbound-image-reference
 * precondition resolver factory.
 *
 * The resolver factory is exported from a SIBLING file
 * (`inbound-image-reference-precondition-resolver.ts`) — not a new entry
 * in `affordance-registry.ts`. This keeps the Phase-4 affordance registry
 * BYTE-IDENTICAL while still surfacing the resolver to the runtime adapter
 * (Phase 5 → Phase 6) which consumes the precondition value to inject
 * `image:` / `images:` into the `image_generate` tool args.
 *
 * Per invariant #5 / #6 the resolver reads STRUCTURED inbound-media
 * metadata only (path + MIME + closed `kind` enumeration). It NEVER
 * reads raw user text.
 */

import { describe, expect, it } from "vitest";

import type { InboundMediaSummary } from "../intent-contractor-impl.js";
import {
  resolveInboundImageReferencePrecondition,
  createInboundImageReferencePreconditionResolver,
  type InboundImageReferencePreconditionValue,
} from "../inbound-image-reference-precondition-resolver.js";

describe("resolveInboundImageReferencePrecondition (cutover-3 Phase 6)", () => {
  it("returns paths.length=1 when summary has 1 image attachment", () => {
    const summary: InboundMediaSummary = {
      attachments: [
        { path: "media/inbound/sketch.jpg", mimeType: "image/jpeg", kind: "image" },
      ],
    };
    const result = resolveInboundImageReferencePrecondition(summary);
    expect(result).not.toBeNull();
    expect(result!.paths).toEqual(["media/inbound/sketch.jpg"]);
  });

  it("returns paths.length=2 when summary has 2 image attachments (preserves order)", () => {
    const summary: InboundMediaSummary = {
      attachments: [
        { path: "media/inbound/a.jpg", mimeType: "image/jpeg", kind: "image" },
        { path: "media/inbound/b.png", mimeType: "image/png", kind: "image" },
      ],
    };
    const result = resolveInboundImageReferencePrecondition(summary);
    expect(result).not.toBeNull();
    expect(result!.paths).toEqual(["media/inbound/a.jpg", "media/inbound/b.png"]);
  });

  it("filters mixed (image + pdf) → paths only contain image entries", () => {
    const summary: InboundMediaSummary = {
      attachments: [
        { path: "media/inbound/photo.jpg", mimeType: "image/jpeg", kind: "image" },
        { path: "media/inbound/spec.pdf", mimeType: "application/pdf", kind: "pdf" },
        { path: "media/inbound/extra.png", mimeType: "image/png", kind: "image" },
      ],
    };
    const result = resolveInboundImageReferencePrecondition(summary);
    expect(result).not.toBeNull();
    expect(result!.paths).toEqual([
      "media/inbound/photo.jpg",
      "media/inbound/extra.png",
    ]);
  });

  it("returns null when summary contains only PDFs (no images)", () => {
    const summary: InboundMediaSummary = {
      attachments: [
        { path: "media/inbound/spec.pdf", mimeType: "application/pdf", kind: "pdf" },
      ],
    };
    const result = resolveInboundImageReferencePrecondition(summary);
    expect(result).toBeNull();
  });

  it("returns null when summary is empty", () => {
    const summary: InboundMediaSummary = { attachments: [] };
    const result = resolveInboundImageReferencePrecondition(summary);
    expect(result).toBeNull();
  });

  it("returns null when summary is undefined (no inbound media this turn)", () => {
    const result = resolveInboundImageReferencePrecondition(undefined);
    expect(result).toBeNull();
  });

  it("respects kind='image' filter (kind='other' / kind='docx' both skipped)", () => {
    const summary: InboundMediaSummary = {
      attachments: [
        { path: "media/inbound/note.txt", mimeType: "text/plain", kind: "other" },
        { path: "media/inbound/template.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "docx" },
        { path: "media/inbound/photo.jpg", mimeType: "image/jpeg", kind: "image" },
      ],
    };
    const result = resolveInboundImageReferencePrecondition(summary);
    expect(result).not.toBeNull();
    expect(result!.paths).toEqual(["media/inbound/photo.jpg"]);
  });

  it("createInboundImageReferencePreconditionResolver wraps a resolver into a callable", () => {
    const summary: InboundMediaSummary = {
      attachments: [
        { path: "media/inbound/sketch.jpg", mimeType: "image/jpeg", kind: "image" },
      ],
    };
    const factory = createInboundImageReferencePreconditionResolver(() => summary);
    const resolved = factory();
    expect(resolved).not.toBeNull();
    expect(resolved!.paths).toEqual(["media/inbound/sketch.jpg"]);
  });

  it("createInboundImageReferencePreconditionResolver — resolver returns undefined → null", () => {
    const factory = createInboundImageReferencePreconditionResolver(() => undefined);
    const resolved = factory();
    expect(resolved).toBeNull();
  });

  it("returned value preserves brand discipline (paths is readonly string[])", () => {
    const summary: InboundMediaSummary = {
      attachments: [
        { path: "media/inbound/a.jpg", mimeType: "image/jpeg", kind: "image" },
      ],
    };
    const result = resolveInboundImageReferencePrecondition(summary);
    expect(result).not.toBeNull();
    // Ensure the returned object is the closed `{ paths }` shape, not a leaked
    // raw user text field or `EffectId`/`ChannelId` (invariants #5 / #16).
    const value: InboundImageReferencePreconditionValue = result!;
    expect(Object.keys(value)).toEqual(["paths"]);
  });
});
