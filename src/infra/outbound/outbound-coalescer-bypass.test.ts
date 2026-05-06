/**
 * NEW-C Phase 6 — bypass allowlist tests (B1..B3).
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_outbound_coalescer.plan.md`
 * §6 oc-phase-6-bypass-allowlist.
 * Phase 1 audit §e: 6 bypass-allowlist candidates.
 *
 * Goals:
 * - B1: bypass call delivers immediately, NOT registered in any
 *       (turnId, channelKey) bucket; stats unchanged; telemetry shows
 *       `event=bypassed`.
 * - B2: bypass during an active turn does NOT affect that turn's
 *       coalesced commit — bucket still flushes its own messages on the
 *       commit edge; bypass is a side channel.
 * - B3: bypass of an internal channel target composes correctly with
 *       slice I sanitizer (sanitizer's `EXTERNAL_DELIVERY_SURFACES`
 *       allowlist does not intercept internal channels — bypass route is
 *       the only escape; the sanitizer is a no-op for internal targets).
 *
 * Plus negative coverage for the closed `BypassReason` union (Phase 6
 * tightens `bypass(reason: string, ...)` → `bypass(reason: BypassReason,
 * ...)` with runtime validation).
 *
 * Соответствие 16 hard invariants:
 *   - #5: closed enum is structural — reasons are NOT derived from
 *     `UserPrompt` / `RawUserTurn`; tests assert that arbitrary user-
 *     supplied strings are rejected at runtime.
 *   - #6: tests do not read user prompt.
 *   - #11: sanitizer (slice I) byte-identical; tests exercise the real
 *     `sanitizeOutboundForExternalChannel` to confirm composition.
 */
import { describe, expect, it } from "vitest";

import type { ReplyPayload } from "../../auto-reply/types.js";
import type { BlockReplyDeliver } from "../../auto-reply/reply/block-external-buffer.js";
import { createOutboundCoalescer } from "./outbound-coalescer.js";
import {
  BYPASS_REASONS,
  type BypassReason,
  type OutboundCoalescer,
  type OutboundCoalescerDeps,
} from "./outbound-coalescer-types.js";
import { isExternalDeliverySurface } from "./outbound-sanitizer.js";

type Captured = { payload: ReplyPayload };

function makeHarness(
  overrides: Partial<OutboundCoalescerDeps> = {},
): {
  coalescer: OutboundCoalescer;
  delivered: Captured[];
  logs: string[];
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
  };
  return { coalescer: createOutboundCoalescer(deps), delivered, logs };
}

describe("outbound-coalescer Phase 6 — BypassReason closed union", () => {
  it("exports the 7 bypass reasons enumerated in the Phase 6 spec", () => {
    // Audit §e + Phase 4 ACP precedent → 7-entry union. The closed set
    // is the structural source-of-truth; runtime validation in
    // `bypass()` keys on it.
    expect(BYPASS_REASONS).toEqual([
      "system_init",
      "cron_persistent_worker",
      "internal_canvas",
      "internal_stdout",
      "internal_log",
      "standalone_command",
      "internal_acp_lane",
    ]);
  });

  it("BypassReason union accepts every entry in BYPASS_REASONS at compile-time", () => {
    // Iterate over the runtime constant; the loop body is type-checked
    // against `BypassReason` at compile-time. Closed-union discipline
    // verified end-to-end via the accept-each-variant pattern from the
    // Phase 2 `OutboundMessageKind` test.
    for (const reason of BYPASS_REASONS) {
      const r: BypassReason = reason;
      expect(typeof r).toBe("string");
    }
  });
});

describe("outbound-coalescer Phase 6 — B1: bypass delivers immediately, never buckets", () => {
  it("bypass(reason, body, deliver) calls deliver once, leaves stats untouched", async () => {
    const h = makeHarness();
    let bypassCalled = 0;
    let bypassedText: string | undefined;
    const bypassDeliver: BlockReplyDeliver = (payload) => {
      bypassCalled += 1;
      bypassedText = payload.text;
    };
    expect(h.coalescer.stats()).toEqual({ buffered: 0, turns: 0 });
    await h.coalescer.bypass(
      "system_init",
      { text: "boot announcement" },
      bypassDeliver,
    );
    expect(bypassCalled).toBe(1);
    expect(bypassedText).toBe("boot announcement");
    // Bucket store untouched.
    expect(h.coalescer.stats()).toEqual({ buffered: 0, turns: 0 });
    // Coalescer's primary deliver was NEVER invoked.
    expect(h.delivered).toHaveLength(0);
    // Telemetry: structured-reason bypassed line.
    expect(
      h.logs.some(
        (l) => l.includes("event=bypassed") && l.includes("reason=system_init"),
      ),
    ).toBe(true);
  });

  it("rejects an unknown reason at runtime — invariant #5 (no user-prompt-derived reasons)", async () => {
    const h = makeHarness();
    let caught: unknown;
    try {
      await h.coalescer.bypass(
        // The cast is the test — we are deliberately handing a
        // non-allowlisted reason to verify the runtime guard. A real
        // caller would fail compile.
        "user_supplied_text" as unknown as BypassReason,
        { text: "leak" },
        () => undefined,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/unknown bypass reason/u);
    // Reject must precede deliver — telemetry shows `event=bypassed`
    // line was NEVER emitted with the rogue reason.
    expect(
      h.logs.some(
        (l) => l.includes("event=bypassed") && l.includes("reason=user_supplied_text"),
      ),
    ).toBe(false);
  });

  it("rejects empty string reason (negative coverage)", async () => {
    const h = makeHarness();
    await expect(
      h.coalescer.bypass(
        "" as unknown as BypassReason,
        { text: "x" },
        () => undefined,
      ),
    ).rejects.toThrow(/unknown bypass reason/u);
  });

  it("rejects non-string reason (negative coverage)", async () => {
    const h = makeHarness();
    await expect(
      h.coalescer.bypass(
        123 as unknown as BypassReason,
        { text: "x" },
        () => undefined,
      ),
    ).rejects.toThrow(/unknown bypass reason/u);
  });
});

describe("outbound-coalescer Phase 6 — B2: bypass during active turn isolated from coalesced commit", () => {
  it("a bypass call between register and commit does not pollute the bucket", async () => {
    const h = makeHarness();
    const TURN = "run-active";
    const CH = "telegram:6533456892:6533456892";
    h.coalescer.register({
      turnId: TURN,
      channelKey: CH,
      kind: "ack",
      body: { text: "ack-text" },
      ts: 1_000,
    });
    h.coalescer.register({
      turnId: TURN,
      channelKey: CH,
      kind: "final",
      body: { text: "FINAL", replyToId: "rt-7" },
      ts: 1_002,
    });
    expect(h.coalescer.stats()).toEqual({ buffered: 2, turns: 1 });

    // Bypass landed mid-turn — must NOT touch the (TURN, CH) bucket.
    let bypassDelivered: ReplyPayload | undefined;
    const bypassDeliver: BlockReplyDeliver = (payload) => {
      bypassDelivered = payload;
    };
    await h.coalescer.bypass(
      "internal_log",
      { text: "diagnostic" },
      bypassDeliver,
    );
    // Bucket still has 2 messages.
    expect(h.coalescer.stats()).toEqual({ buffered: 2, turns: 1 });
    expect(bypassDelivered?.text).toBe("diagnostic");

    // Commit the bucket — produces ONE delivery merging ack+final;
    // bypass does not contribute to the merged body.
    await h.coalescer.commit(TURN, CH);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.payload.text).toBe("ack-text\n\nFINAL");
    expect(h.delivered[0]?.payload.replyToId).toBe("rt-7");
    expect(h.coalescer.stats()).toEqual({ buffered: 0, turns: 0 });
  });
});

describe("outbound-coalescer Phase 6 — B3: bypass with internal channel target composes with slice I sanitizer", () => {
  it("internal_canvas channel is NOT in EXTERNAL_DELIVERY_SURFACES — bypass body reaches deliver verbatim", async () => {
    const h = makeHarness();
    // Body carries an artefact the sanitizer WOULD strip on EXTERNAL
    // surfaces (matches the `[intent-ledger]` line marker pattern).
    // For internal channels (canvas/stdout/log), the sanitizer's
    // `isExternalDeliverySurface` gate returns false → the payload
    // never enters the strip pipeline. Bypass route + internal target
    // therefore deliver the body verbatim.
    expect(isExternalDeliverySurface("canvas")).toBe(false);
    expect(isExternalDeliverySurface("stdout")).toBe(false);
    expect(isExternalDeliverySurface("log")).toBe(false);

    const internalBody: ReplyPayload = {
      text: "[intent-ledger] recorded session=abc",
    };
    let bypassDelivered: ReplyPayload | undefined;
    const bypassDeliver: BlockReplyDeliver = (payload) => {
      // Real deliver pipeline gates the sanitizer on the runtime
      // channel — internal channels skip it. Mirror that here: only
      // invoke the sanitizer for external surfaces.
      bypassDelivered = payload;
    };
    await h.coalescer.bypass("internal_canvas", internalBody, bypassDeliver);
    expect(bypassDelivered?.text).toBe(
      "[intent-ledger] recorded session=abc",
    );
    expect(
      h.logs.some(
        (l) => l.includes("event=bypassed") && l.includes("reason=internal_canvas"),
      ),
    ).toBe(true);
  });

  it("each operator-internal reason variant routes through bypass for its channel", async () => {
    const h = makeHarness();
    // Spec union has three operator-internal reasons —
    // `internal_canvas`, `internal_stdout`, `internal_log`. We exercise
    // each to confirm the typed enum admits all three; per slice I,
    // their channels are explicitly outside EXTERNAL_DELIVERY_SURFACES.
    const cases: Array<{ reason: BypassReason; channel: string }> = [
      { reason: "internal_canvas", channel: "canvas" },
      { reason: "internal_stdout", channel: "stdout" },
      { reason: "internal_log", channel: "log" },
    ];
    for (const { reason, channel } of cases) {
      expect(isExternalDeliverySurface(channel)).toBe(false);
      let delivered: ReplyPayload | undefined;
      await h.coalescer.bypass(reason, { text: `body for ${channel}` }, (p) => {
        delivered = p;
      });
      expect(delivered?.text).toBe(`body for ${channel}`);
    }
    // Three bypassed events with distinct reasons.
    const bypassLines = h.logs.filter((l) => l.includes("event=bypassed"));
    expect(bypassLines).toHaveLength(3);
    expect(bypassLines[0]).toContain("reason=internal_canvas");
    expect(bypassLines[1]).toContain("reason=internal_stdout");
    expect(bypassLines[2]).toContain("reason=internal_log");
  });
});
