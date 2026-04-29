import { describe, expect, it, vi } from "vitest";
import {
  createExternalBlockReplyDeferral,
  externalBufferFinalizeKind,
  mergeExternalDeferredReplyPayloads,
} from "./block-external-buffer.js";

describe("mergeExternalDeferredReplyPayloads", () => {
  it("joins text with blank lines and keeps tail metadata", () => {
    const merged = mergeExternalDeferredReplyPayloads([
      { text: "a" },
      { text: "b", replyToId: "x", replyToCurrent: true },
    ]);
    expect(merged.text).toBe("a\n\nb");
    expect(merged.replyToCurrent).toBe(true);
    expect(merged.replyToId).toBe("x");
  });
});

describe("externalBufferFinalizeKind", () => {
  it("is idempotent for same structural flag and count", () => {
    expect(externalBufferFinalizeKind(false, 3)).toBe("replay");
    expect(externalBufferFinalizeKind(false, 3)).toBe("replay");
    expect(externalBufferFinalizeKind(true, 2)).toBe("consolidated");
    expect(externalBufferFinalizeKind(true, 2)).toBe("consolidated");
    expect(externalBufferFinalizeKind(true, 0)).toBe("none");
  });
});

describe("createExternalBlockReplyDeferral", () => {
  it("defers then emits single consolidated payload after structural tool", async () => {
    const inner = vi.fn(async () => {});
    const d = createExternalBlockReplyDeferral({ turnId: "t1", sessionId: "s1" });
    const wrapped = d.wrapDeliver(inner);
    await wrapped({ text: "pre" });
    await wrapped({ text: "mid" });
    expect(inner).not.toHaveBeenCalled();
    d.notifyStructuralToolExecutionStarting();
    await wrapped({ text: "post" });
    expect(inner).not.toHaveBeenCalled();
    await d.finalizeAfterRun(inner);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith(
      expect.objectContaining({ text: "pre\n\nmid\n\npost" }),
      expect.anything(),
    );
  });

  it("replays all deferred chunks when no structural tool", async () => {
    const inner = vi.fn(async () => {});
    const d = createExternalBlockReplyDeferral({ turnId: "t2", sessionId: "s2" });
    const wrapped = d.wrapDeliver(inner);
    await wrapped({ text: "one" });
    await wrapped({ text: "two" });
    await d.finalizeAfterRun(inner);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(inner).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "one" }),
      expect.anything(),
    );
    expect(inner).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "two" }),
      expect.anything(),
    );
  });

  it("two deferrals do not share deferred payloads", async () => {
    const innerA = vi.fn(async () => {});
    const innerB = vi.fn(async () => {});
    const da = createExternalBlockReplyDeferral({ turnId: "a", sessionId: "sa" });
    const db = createExternalBlockReplyDeferral({ turnId: "b", sessionId: "sb" });
    await da.wrapDeliver(innerA)({ text: "a-only" });
    await db.wrapDeliver(innerB)({ text: "b-only" });
    await da.finalizeAfterRun(innerA);
    await db.finalizeAfterRun(innerB);
    expect(innerA).toHaveBeenCalledWith(expect.objectContaining({ text: "a-only" }), expect.anything());
    expect(innerB).toHaveBeenCalledWith(expect.objectContaining({ text: "b-only" }), expect.anything());
  });

  it("finalize is safe to call twice", async () => {
    const inner = vi.fn(async () => {});
    const d = createExternalBlockReplyDeferral({ turnId: "t3", sessionId: "s3" });
    await d.wrapDeliver(inner)({ text: "x" });
    await d.finalizeAfterRun(inner);
    await d.finalizeAfterRun(inner);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
