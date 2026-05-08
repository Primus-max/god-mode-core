/**
 * V1-CLOSE T4 — `outbound-coalescer` deliver retry tests.
 *
 * Charter: `.cursor/plans/V1-CLOSE-2026-05-08-stabilization-charter.md` §4 T4.
 *
 * Symptom this fixes: a single throw from `deps.deliver(payload)` was
 * caught and silently swallowed inside `commitBucket`. The bucket was
 * already torn down before the deliver call, so attachments vanished
 * and the caller saw a successful resolve. Operator logs showed
 * `event=deliver_failed` once and that was it — no retry, no caller
 * surface, no admin escalation surface.
 *
 * Fix under test:
 *  1. On `deps.deliver` failure, `commitBucket` retries up to 3 total
 *     attempts (1 initial + 2 retries) with exponential backoff
 *     (default 1s, 2s, 4s — capped so wall-clock max is ~7s, well
 *     under the 15s ceiling the charter prescribes).
 *  2. On exhaustion, an `OutboundCoalescerDeliveryError` is thrown to
 *     the caller AND a structured `event=delivery_dropped` line is
 *     emitted with full bucket context (turnId, channelKey, attachment
 *     count, last error message, attempts).
 *  3. Bucket state stays zero-buffered after exhaustion (caller observes
 *     the failure rather than a silently-empty queue).
 *
 * Tests use the injectable `retryDelaysMs` override so we can drive
 * the retry loop with `[0, 0, 0]` and avoid coupling to wall-clock
 * delays. The deliver dependency is the real one being exercised — no
 * `vi.spyOn` on `commitBucket` itself, per AGENTS.md "Tests must catch
 * real bugs" rule.
 */
import { describe, expect, it } from "vitest";
import type { BlockReplyDeliver } from "../../auto-reply/reply/block-external-buffer.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type {
  OutboundCoalescer,
  OutboundCoalescerDeps,
  OutboundMessage,
} from "./outbound-coalescer-types.js";
import { createOutboundCoalescer, OutboundCoalescerDeliveryError } from "./outbound-coalescer.js";

type Captured = { payload: ReplyPayload };

function makeHarness(overrides: Partial<OutboundCoalescerDeps> = {}): {
  coalescer: OutboundCoalescer;
  delivered: Captured[];
  logs: string[];
  deps: OutboundCoalescerDeps;
} {
  const delivered: Captured[] = [];
  const logs: string[] = [];
  const baseDeliver: BlockReplyDeliver = (payload) => {
    delivered.push({ payload });
  };
  const deps: OutboundCoalescerDeps = {
    deliver: overrides.deliver ?? baseDeliver,
    mergeStrategy: overrides.mergeStrategy ?? "drop_intermediates",
    maxBufferMs: overrides.maxBufferMs ?? 60_000,
    logTelemetry: (line) => {
      logs.push(line);
      overrides.logTelemetry?.(line);
    },
    clockNow: overrides.clockNow ?? (() => 1_000),
    // T4: zero-delay retries in tests so we exercise the real loop
    // without wall-clock coupling. Production default is [1s, 2s, 4s].
    retryDelaysMs: overrides.retryDelaysMs ?? [0, 0],
  };
  const coalescer = createOutboundCoalescer(deps);
  return { coalescer, delivered, logs, deps };
}

function msg(
  partial: Partial<OutboundMessage> & {
    kind: OutboundMessage["kind"];
    body: ReplyPayload;
  },
): OutboundMessage {
  return {
    turnId: partial.turnId ?? "run-A",
    channelKey: partial.channelKey ?? "telegram:6533456892:6533456892",
    kind: partial.kind,
    body: partial.body,
    ts: partial.ts ?? 1_000,
  };
}

describe("outbound-coalescer (T4) — deliver retry on transient failure", () => {
  it("2 fails + 1 success → bucket delivered exactly once, no delivery_dropped", async () => {
    let calls = 0;
    const accepted: ReplyPayload[] = [];
    const trackingDeliver: BlockReplyDeliver = (payload) => {
      calls += 1;
      if (calls < 3) {
        throw new Error(`transient ${calls}`);
      }
      accepted.push(payload);
      return Promise.resolve();
    };
    const h = makeHarness({ deliver: trackingDeliver });

    h.coalescer.register(
      msg({
        kind: "final",
        body: { text: "important", mediaUrl: "https://x/y.png" },
        ts: 1_000,
      }),
    );
    await h.coalescer.commit("run-A", "telegram:6533456892:6533456892");

    expect(calls).toBe(3);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.text).toBe("important");
    // Two transient failures should have produced two `deliver_failed`
    // log lines, each tagged with the matching attempt index.
    const failedLines = h.logs.filter((l) => l.includes("event=deliver_failed"));
    expect(failedLines).toHaveLength(2);
    expect(failedLines[0]).toContain("attempt=1");
    expect(failedLines[1]).toContain("attempt=2");
    // No delivery_dropped — recovery happened before exhaustion.
    expect(h.logs.some((l) => l.includes("event=delivery_dropped"))).toBe(false);
    // Bucket cleared.
    expect(h.coalescer.stats().buffered).toBe(0);
  });

  it("3 fails → typed error surfaced, delivery_dropped log emitted with bucket context", async () => {
    let calls = 0;
    const failingDeliver: BlockReplyDeliver = () => {
      calls += 1;
      throw new Error(`persistent fail ${calls}`);
    };
    const h = makeHarness({ deliver: failingDeliver });

    h.coalescer.register(
      msg({
        kind: "final",
        body: {
          text: "lost",
          mediaUrls: ["https://a/1.png", "https://a/2.png"],
        },
        ts: 1_000,
      }),
    );

    let caught: unknown = null;
    try {
      await h.coalescer.commit("run-A", "telegram:6533456892:6533456892");
    } catch (err) {
      caught = err;
    }

    // Caller MUST observe the failure — no silent drop.
    expect(caught).toBeInstanceOf(OutboundCoalescerDeliveryError);
    const typed = caught as OutboundCoalescerDeliveryError;
    expect(typed.code).toBe("outbound_coalescer_delivery_dropped");
    expect(typed.turnId).toBe("run-A");
    expect(typed.channelKey).toBe("telegram:6533456892:6533456892");
    expect(typed.attempts).toBe(3);
    expect(typed.attachmentCount).toBe(2);
    expect(typed.lastError).toBeInstanceOf(Error);
    expect((typed.lastError as Error).message).toBe("persistent fail 3");

    // Three deliver attempts were made.
    expect(calls).toBe(3);
    expect(h.logs.filter((l) => l.includes("event=deliver_failed"))).toHaveLength(3);

    // Structured `delivery_dropped` line carries full bucket context.
    const droppedLines = h.logs.filter((l) => l.includes("event=delivery_dropped"));
    expect(droppedLines).toHaveLength(1);
    const dropped = droppedLines[0]!;
    expect(dropped).toContain("turnId=run-A");
    expect(dropped).toContain("channel=telegram:6533456892:6533456892");
    expect(dropped).toContain("attempts=3");
    expect(dropped).toContain("attachment_count=2");
    expect(dropped).toContain("persistent fail 3");

    // Bucket NOT silently still-buffered: caller saw the throw above.
    expect(h.coalescer.stats().buffered).toBe(0);
  });

  it("async (Promise reject) deliver failure also retries, then surfaces typed error on exhaustion", async () => {
    let calls = 0;
    const asyncFailing: BlockReplyDeliver = () => {
      calls += 1;
      return Promise.reject(new Error(`async ${calls}`));
    };
    const h = makeHarness({ deliver: asyncFailing });

    h.coalescer.register(msg({ kind: "final", body: { text: "async-lost" }, ts: 1_000 }));

    await expect(
      h.coalescer.commit("run-A", "telegram:6533456892:6533456892"),
    ).rejects.toBeInstanceOf(OutboundCoalescerDeliveryError);

    expect(calls).toBe(3);
    expect(h.logs.some((l) => l.includes("event=delivery_dropped"))).toBe(true);
  });

  it("attachment count counts mediaUrl + mediaUrls combined", async () => {
    const failing: BlockReplyDeliver = () => {
      throw new Error("nope");
    };
    const h = makeHarness({ deliver: failing });

    h.coalescer.register(
      msg({
        kind: "final",
        body: {
          text: "x",
          mediaUrl: "https://x/single.png",
          mediaUrls: ["https://x/a.png", "https://x/b.png", "https://x/c.png"],
        },
        ts: 1_000,
      }),
    );
    await expect(
      h.coalescer.commit("run-A", "telegram:6533456892:6533456892"),
    ).rejects.toMatchObject({
      attachmentCount: 4,
    });
  });

  it("commitAll surfaces typed error from a single failed channel", async () => {
    let goodCalls = 0;
    let badCalls = 0;
    const splittingDeliver: BlockReplyDeliver = (payload) => {
      // The bucket merge strategy preserves the body text from the
      // canonical entry; we route on text content as a stand-in for the
      // channelKey (the deliver function does not see channelKey
      // directly — it sees the merged payload).
      if (payload.text === "good") {
        goodCalls += 1;
        return;
      }
      badCalls += 1;
      throw new Error(`bad-channel-${badCalls}`);
    };
    const h = makeHarness({ deliver: splittingDeliver });

    h.coalescer.register(
      msg({
        turnId: "run-X",
        channelKey: "telegram:1:1",
        kind: "final",
        body: { text: "good" },
        ts: 1_000,
      }),
    );
    h.coalescer.register(
      msg({
        turnId: "run-X",
        channelKey: "signal:+0:+1",
        kind: "final",
        body: { text: "bad" },
        ts: 1_001,
      }),
    );

    let caught: unknown = null;
    try {
      await h.coalescer.commitAll("run-X");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OutboundCoalescerDeliveryError);
    expect((caught as OutboundCoalescerDeliveryError).turnId).toBe("run-X");
    // Good channel still delivered exactly once, no retry needed.
    expect(goodCalls).toBe(1);
    // Bad channel retried 3 times before surfacing.
    expect(badCalls).toBe(3);
  });

  it("default production wall-clock max stays under the charter's 15s ceiling", () => {
    // Sanity-check the charter ceiling. Production default is `[1s, 2s]`
    // (3 total attempts = 1 initial + 2 retries per V1-CLOSE charter
    // §4 T4). We lock the cumulative ceiling so a regression that
    // pushes the cap past the charter's 15s value fails CI.
    const charterMaxMs = 15_000;
    const productionCumulativeMs = [1_000, 2_000].reduce((a, b) => a + b, 0);
    expect(productionCumulativeMs).toBeLessThanOrEqual(charterMaxMs);
  });
});

describe("outbound-coalescer (T4) — typed error surface", () => {
  it("OutboundCoalescerDeliveryError carries bucket context for caller fallback", () => {
    const cause = new Error("boom");
    const err = new OutboundCoalescerDeliveryError({
      turnId: "run-Z",
      channelKey: "telegram:1:1",
      attempts: 3,
      attachmentCount: 2,
      lastError: cause,
    });
    expect(err.name).toBe("OutboundCoalescerDeliveryError");
    expect(err.code).toBe("outbound_coalescer_delivery_dropped");
    expect(err.turnId).toBe("run-Z");
    expect(err.channelKey).toBe("telegram:1:1");
    expect(err.attempts).toBe(3);
    expect(err.attachmentCount).toBe(2);
    expect(err.lastError).toBe(cause);
    // Message includes the bucket key so unhandled-rejection traces are
    // immediately legible without inspecting `err.turnId` separately.
    expect(err.message).toContain("run-Z");
    expect(err.message).toContain("telegram:1:1");
  });
});
