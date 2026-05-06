/**
 * NEW-C Phase 3 — `createOutboundCoalescer` impl tests.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_outbound_coalescer.plan.md`
 * §5 (Phase 3 fail-first matrix T1..T12).
 *
 * Goals:
 * - Exercise the real impl (no `vi.spyOn` on the function under test).
 * - Cover both merge strategies, watchdog timeout, cross-turn /
 *   cross-channel isolation, bypass route, deliver-failure isolation,
 *   idempotency.
 * - Capture telemetry lines via injected `logTelemetry` so the closed
 *   `[outbound-coalescer] event=<...>` event set is asserted on real
 *   runs.
 *
 * Notes on timer hygiene (AGENTS.md §Testing Guidelines): every test
 * that installs fake timers or live timers restores them in `finally`
 * blocks — keeps `--isolate=false` green.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReplyPayload } from "../../auto-reply/types.js";
import type { BlockReplyDeliver } from "../../auto-reply/reply/block-external-buffer.js";
import { createOutboundCoalescer } from "./outbound-coalescer.js";
import type {
  OutboundCoalescer,
  OutboundCoalescerDeps,
  OutboundMessage,
} from "./outbound-coalescer-types.js";

type CapturedDelivery = { payload: ReplyPayload; ts: number };

function makeHarness(
  overrides: Partial<OutboundCoalescerDeps> = {},
): {
  coalescer: OutboundCoalescer;
  delivered: CapturedDelivery[];
  logs: string[];
  setNow(t: number): void;
  deps: OutboundCoalescerDeps;
} {
  const delivered: CapturedDelivery[] = [];
  const logs: string[] = [];
  let now = 1_000;
  const baseDeliver: BlockReplyDeliver = (payload) => {
    delivered.push({ payload, ts: now });
  };
  const deps: OutboundCoalescerDeps = {
    deliver: overrides.deliver ?? baseDeliver,
    mergeStrategy: overrides.mergeStrategy ?? "drop_intermediates",
    maxBufferMs: overrides.maxBufferMs ?? 60_000,
    logTelemetry: (line) => {
      logs.push(line);
      overrides.logTelemetry?.(line);
    },
    clockNow: overrides.clockNow ?? (() => now),
  };
  const coalescer = createOutboundCoalescer(deps);
  return {
    coalescer,
    delivered,
    logs,
    setNow: (t: number) => {
      now = t;
    },
    deps,
  };
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

describe("outbound-coalescer (Phase 3) — register + commit happy path (T1)", () => {
  it("register one final → commit → deliver called once with that body", async () => {
    const h = makeHarness();
    h.coalescer.register(
      msg({ kind: "final", body: { text: "final body" }, ts: 1_001 }),
    );
    await h.coalescer.commit("run-A", "telegram:6533456892:6533456892");
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.payload.text).toBe("final body");
    expect(h.logs.some((l) => l.includes("event=registered"))).toBe(true);
    expect(
      h.logs.some(
        (l) =>
          l.includes("event=committed") &&
          l.includes("turnId=run-A") &&
          l.includes("messages_merged=1") &&
          l.includes("final_kind=final"),
      ),
    ).toBe(true);
  });
});

describe("outbound-coalescer — drop_intermediates merge (T2, T3)", () => {
  it("ack + intermediate + final → deliver final body with ack text prefixed (T2)", async () => {
    const h = makeHarness();
    h.coalescer.register(msg({ kind: "ack", body: { text: "ack-text" }, ts: 1_000 }));
    h.coalescer.register(
      msg({ kind: "intermediate", body: { text: "thinking..." }, ts: 1_001 }),
    );
    h.coalescer.register(
      msg({
        kind: "final",
        body: { text: "FINAL", replyToId: "rt-123" },
        ts: 1_002,
      }),
    );
    await h.coalescer.commit("run-A", "telegram:6533456892:6533456892");
    expect(h.delivered).toHaveLength(1);
    const out = h.delivered[0]?.payload;
    // ack prefixed onto final body, intermediates dropped
    expect(out?.text).toBe("ack-text\n\nFINAL");
    // metadata from final entry preserved
    expect(out?.replyToId).toBe("rt-123");
    expect(
      h.logs.some(
        (l) =>
          l.includes("event=committed") &&
          l.includes("messages_merged=3") &&
          l.includes("final_kind=final"),
      ),
    ).toBe(true);
  });

  it("ack + intermediate (no final) → deliver latest intermediate with ack prefix (T3)", async () => {
    const h = makeHarness();
    h.coalescer.register(msg({ kind: "ack", body: { text: "ack-prefix" }, ts: 1_000 }));
    h.coalescer.register(
      msg({ kind: "intermediate", body: { text: "older" }, ts: 1_001 }),
    );
    h.coalescer.register(
      msg({ kind: "intermediate", body: { text: "latest" }, ts: 1_002 }),
    );
    await h.coalescer.commit("run-A", "telegram:6533456892:6533456892");
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.payload.text).toBe("ack-prefix\n\nlatest");
    expect(
      h.logs.some(
        (l) =>
          l.includes("event=committed") &&
          l.includes("messages_merged=3") &&
          l.includes("final_kind=intermediate"),
      ),
    ).toBe(true);
  });
});

describe("outbound-coalescer — two finals → latest wins (T4)", () => {
  it("two finals → deliver latest only", async () => {
    const h = makeHarness();
    h.coalescer.register(msg({ kind: "final", body: { text: "first" }, ts: 1_000 }));
    h.coalescer.register(msg({ kind: "final", body: { text: "second" }, ts: 1_001 }));
    await h.coalescer.commit("run-A", "telegram:6533456892:6533456892");
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.payload.text).toBe("second");
  });
});

describe("outbound-coalescer — empty commit noop (T5)", () => {
  it("commit on empty bucket → noop telemetry, deliver NOT called", async () => {
    const h = makeHarness();
    await h.coalescer.commit("run-empty", "telegram:6533456892:6533456892");
    expect(h.delivered).toHaveLength(0);
    expect(h.logs.some((l) => l.includes("event=commit_noop"))).toBe(true);
    expect(h.logs.some((l) => l.includes("event=committed"))).toBe(false);
  });
});

describe("outbound-coalescer — watchdog timeout commit (T6, T7)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("watchdog fires after maxBufferMs → forced commit with timeout telemetry (T6)", async () => {
    const h = makeHarness({ maxBufferMs: 5_000 });
    h.setNow(1_000);
    h.coalescer.register(
      msg({ kind: "final", body: { text: "auto-committed" }, ts: 1_000 }),
    );
    expect(h.delivered).toHaveLength(0);
    // advance fake timer past watchdog window AND advance the injected
    // clock so the `waited_ms` telemetry reads the real elapsed time
    h.setNow(6_000);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.payload.text).toBe("auto-committed");
    expect(
      h.logs.some(
        (l) => l.includes("event=timeout_committed") && l.includes("waited_ms=5000"),
      ),
    ).toBe(true);
  });

  it("explicit commit clears watchdog → no double-fire (T7)", async () => {
    const h = makeHarness({ maxBufferMs: 5_000 });
    h.coalescer.register(msg({ kind: "final", body: { text: "early" }, ts: 1_000 }));
    await h.coalescer.commit("run-A", "telegram:6533456892:6533456892");
    expect(h.delivered).toHaveLength(1);
    // advance past where watchdog WOULD have fired
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.delivered).toHaveLength(1); // still only one
    expect(h.logs.some((l) => l.includes("event=timeout_committed"))).toBe(false);
  });
});

describe("outbound-coalescer — cross-turn / cross-channel isolation (T8, T9)", () => {
  it("commit(turn1, chA) leaves (turn2, chA) bucket intact (T8)", async () => {
    const h = makeHarness();
    h.coalescer.register(
      msg({
        turnId: "run-1",
        channelKey: "telegram:1:1",
        kind: "final",
        body: { text: "T1" },
        ts: 1_000,
      }),
    );
    h.coalescer.register(
      msg({
        turnId: "run-2",
        channelKey: "telegram:1:1",
        kind: "final",
        body: { text: "T2" },
        ts: 1_001,
      }),
    );
    await h.coalescer.commit("run-1", "telegram:1:1");
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.payload.text).toBe("T1");
    // turn2 bucket should still exist
    expect(h.coalescer.stats().buffered).toBe(1);
    await h.coalescer.commit("run-2", "telegram:1:1");
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]?.payload.text).toBe("T2");
  });

  it("same turnId, two channels: commitAll delivers TWICE — once per channel (T9)", async () => {
    const h = makeHarness();
    h.coalescer.register(
      msg({
        turnId: "run-X",
        channelKey: "telegram:1:1",
        kind: "final",
        body: { text: "via TG" },
        ts: 1_000,
      }),
    );
    h.coalescer.register(
      msg({
        turnId: "run-X",
        channelKey: "signal:+0:+1",
        kind: "final",
        body: { text: "via Signal" },
        ts: 1_001,
      }),
    );
    await h.coalescer.commitAll("run-X");
    expect(h.delivered).toHaveLength(2);
    const texts = h.delivered.map((d) => d.payload.text).sort();
    expect(texts).toEqual(["via Signal", "via TG"]);
  });
});

describe("outbound-coalescer — bypass route (T10)", () => {
  it("bypass routes around coalescer; bucket unaffected", async () => {
    const h = makeHarness();
    // pre-populate bucket
    h.coalescer.register(
      msg({ kind: "final", body: { text: "buffered" }, ts: 1_000 }),
    );
    let bypassCalled = 0;
    let bypassedText: string | undefined;
    const bypassDeliver: BlockReplyDeliver = (payload) => {
      bypassCalled += 1;
      bypassedText = payload.text;
    };
    await h.coalescer.bypass("system_init", { text: "boot-msg" }, bypassDeliver);
    expect(bypassCalled).toBe(1);
    expect(bypassedText).toBe("boot-msg");
    // bucket untouched: stats still reports buffered=1
    expect(h.coalescer.stats().buffered).toBe(1);
    expect(
      h.logs.some(
        (l) => l.includes("event=bypassed") && l.includes("reason=system_init"),
      ),
    ).toBe(true);
    // committed bucket still works
    await h.coalescer.commit("run-A", "telegram:6533456892:6533456892");
    expect(h.delivered.find((d) => d.payload.text === "buffered")).toBeDefined();
  });
});

describe("outbound-coalescer — failure isolation (T11)", () => {
  it("deliver throws → bucket cleared, telemetry warn, no propagation", async () => {
    const failingDeliver: BlockReplyDeliver = () => {
      throw new Error("channel adapter exploded");
    };
    const h = makeHarness({ deliver: failingDeliver });
    h.coalescer.register(msg({ kind: "final", body: { text: "boom" }, ts: 1_000 }));
    // commit should NOT throw
    await expect(
      h.coalescer.commit("run-A", "telegram:6533456892:6533456892"),
    ).resolves.toBeUndefined();
    // bucket cleared
    expect(h.coalescer.stats().buffered).toBe(0);
    expect(
      h.logs.some(
        (l) =>
          l.includes("event=deliver_failed") && l.includes("channel adapter exploded"),
      ),
    ).toBe(true);
    // coalescer keeps serving — register a NEW turn after failure
    h.coalescer.register(
      msg({
        turnId: "run-after-failure",
        kind: "final",
        body: { text: "still alive" },
        ts: 2_000,
      }),
    );
    await h.coalescer.commit(
      "run-after-failure",
      "telegram:6533456892:6533456892",
    );
    // delivered for second turn would also throw, but bucket clearing remains intact
    expect(h.coalescer.stats().buffered).toBe(0);
  });

  it("async deliver rejection is also isolated", async () => {
    const failingDeliver: BlockReplyDeliver = () =>
      Promise.reject(new Error("async fail"));
    const h = makeHarness({ deliver: failingDeliver });
    h.coalescer.register(msg({ kind: "final", body: { text: "x" }, ts: 1_000 }));
    await expect(
      h.coalescer.commit("run-A", "telegram:6533456892:6533456892"),
    ).resolves.toBeUndefined();
    expect(
      h.logs.some(
        (l) => l.includes("event=deliver_failed") && l.includes("async fail"),
      ),
    ).toBe(true);
  });
});

describe("outbound-coalescer — idempotent commit (T12)", () => {
  it("second commit after first = noop; no second deliver", async () => {
    const h = makeHarness();
    h.coalescer.register(msg({ kind: "final", body: { text: "once" }, ts: 1_000 }));
    await h.coalescer.commit("run-A", "telegram:6533456892:6533456892");
    expect(h.delivered).toHaveLength(1);
    await h.coalescer.commit("run-A", "telegram:6533456892:6533456892");
    expect(h.delivered).toHaveLength(1);
    expect(h.logs.filter((l) => l.includes("event=commit_noop")).length).toBe(1);
  });
});

describe("outbound-coalescer — merge_into_final strategy", () => {
  it("concatenates all body texts joined by \\n\\n; last entry's metadata as envelope", async () => {
    const h = makeHarness({ mergeStrategy: "merge_into_final" });
    h.coalescer.register(msg({ kind: "ack", body: { text: "A" }, ts: 1_000 }));
    h.coalescer.register(
      msg({ kind: "intermediate", body: { text: "B" }, ts: 1_001 }),
    );
    h.coalescer.register(
      msg({
        kind: "final",
        body: { text: "C", replyToId: "rt-final", audioAsVoice: true },
        ts: 1_002,
      }),
    );
    await h.coalescer.commit("run-A", "telegram:6533456892:6533456892");
    expect(h.delivered).toHaveLength(1);
    const out = h.delivered[0]?.payload;
    expect(out?.text).toBe("A\n\nB\n\nC");
    // last-entry metadata wins as canonical envelope
    expect(out?.replyToId).toBe("rt-final");
    expect(out?.audioAsVoice).toBe(true);
  });

  it("skips empty text fragments when concatenating", async () => {
    const h = makeHarness({ mergeStrategy: "merge_into_final" });
    h.coalescer.register(msg({ kind: "ack", body: { text: "" }, ts: 1_000 }));
    h.coalescer.register(
      msg({ kind: "final", body: { text: "only" }, ts: 1_001 }),
    );
    await h.coalescer.commit("run-A", "telegram:6533456892:6533456892");
    expect(h.delivered[0]?.payload.text).toBe("only");
  });
});

describe("outbound-coalescer — register telemetry depth", () => {
  it("registered event reports increasing bufferDepth per (turn, channel)", () => {
    const h = makeHarness();
    h.coalescer.register(msg({ kind: "ack", body: { text: "1" }, ts: 1_000 }));
    h.coalescer.register(
      msg({ kind: "intermediate", body: { text: "2" }, ts: 1_001 }),
    );
    h.coalescer.register(msg({ kind: "final", body: { text: "3" }, ts: 1_002 }));
    const depthLines = h.logs.filter((l) => l.includes("event=registered"));
    expect(depthLines).toHaveLength(3);
    expect(depthLines[0]).toContain("bufferDepth=1");
    expect(depthLines[1]).toContain("bufferDepth=2");
    expect(depthLines[2]).toContain("bufferDepth=3");
  });
});

describe("outbound-coalescer — stats() reflects bucket state", () => {
  it("buffered + turns count distinct turnIds", async () => {
    const h = makeHarness();
    expect(h.coalescer.stats()).toEqual({ buffered: 0, turns: 0 });
    h.coalescer.register(
      msg({ turnId: "t1", kind: "final", body: { text: "a" }, ts: 1 }),
    );
    h.coalescer.register(
      msg({ turnId: "t1", kind: "ack", body: { text: "b" }, ts: 2 }),
    );
    h.coalescer.register(
      msg({ turnId: "t2", kind: "final", body: { text: "c" }, ts: 3 }),
    );
    expect(h.coalescer.stats()).toEqual({ buffered: 3, turns: 2 });
    await h.coalescer.commitAll("t1");
    expect(h.coalescer.stats()).toEqual({ buffered: 1, turns: 1 });
  });
});
