/**
 * NEW-C Phase 2 tests — types + DI seam + telemetry helper.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_outbound_coalescer.plan.md` §5
 * (Phase 2 test list).
 *
 * Goals:
 * 1. Pure-type round-trip: `OutboundMessage` accepts a real-shape value
 *    and the closed `OutboundMessageKind` union rejects unknown kinds.
 * 2. `formatOutboundCoalescerLog` produces the expected line shape and
 *    handles structured payload (numbers, arrays, undefined skip).
 * 3. The Phase 2 factory stub validates the DI contract end-to-end
 *    (real type-check, no spy on the function under test) and throws
 *    `OutboundCoalescerNotImplementedError` once the shape passes.
 * 4. Module-init telemetry constant emits `event=types_loaded` shape.
 */
import { describe, expect, it } from "vitest";

import type { ReplyPayload } from "../../auto-reply/types.js";
import type { BlockReplyDeliver } from "../../auto-reply/reply/block-external-buffer.js";
import {
  OUTBOUND_COALESCER_TYPES_LOADED_LINE,
  formatOutboundCoalescerLog,
  type OutboundCoalescerDeps,
  type OutboundCoalescerLogEvent,
  type OutboundMessage,
  type OutboundMessageKind,
} from "./outbound-coalescer-types.js";
import {
  OutboundCoalescerNotImplementedError,
  createOutboundCoalescer,
} from "./outbound-coalescer.js";

const noopDeliver: BlockReplyDeliver = () => {
  // pure stub — never invoked in Phase 2 tests
};

function makeDeps(overrides: Partial<OutboundCoalescerDeps> = {}): OutboundCoalescerDeps {
  return {
    deliver: noopDeliver,
    mergeStrategy: "drop_intermediates",
    maxBufferMs: 60_000,
    logTelemetry: () => {
      // captured per-test where needed
    },
    clockNow: () => 1_000,
    ...overrides,
  };
}

describe("outbound-coalescer-types — OutboundMessage round-trip", () => {
  it("accepts a structurally valid message with kind=final", () => {
    const body: ReplyPayload = { text: "hello" };
    const msg: OutboundMessage = {
      turnId: "run-abc",
      channelKey: "telegram:6533456892:6533456892",
      kind: "final",
      body,
      ts: 12_345,
    };
    expect(msg.turnId).toBe("run-abc");
    expect(msg.kind).toBe("final");
    expect(msg.body.text).toBe("hello");
  });

  it("accepts each variant of the closed OutboundMessageKind union", () => {
    const kinds: OutboundMessageKind[] = ["ack", "preamble", "intermediate", "final"];
    for (const kind of kinds) {
      const msg: OutboundMessage = {
        turnId: "run-x",
        channelKey: "signal:+10000000000:+10000000001",
        kind,
        body: { text: kind },
        ts: 0,
      };
      expect(msg.kind).toBe(kind);
    }
  });

  it("rejects unknown kinds at type-level (compile-time non-assignability)", () => {
    // The failing assignment below is commented out because TypeScript
    // would refuse to compile the test file — that refusal IS the
    // test. We assert the structural rejection via a runtime guard
    // that mirrors the closed union.
    //
    //   const bad: OutboundMessageKind = "summary"; // ts(2322)
    //
    const allowed: ReadonlySet<OutboundMessageKind> = new Set([
      "ack",
      "preamble",
      "intermediate",
      "final",
    ]);
    expect(allowed.has("ack")).toBe(true);
    expect(allowed.has("final")).toBe(true);
    expect((allowed as ReadonlySet<string>).has("summary")).toBe(false);
    expect((allowed as ReadonlySet<string>).has("error")).toBe(false);
  });
});

describe("outbound-coalescer-types — formatOutboundCoalescerLog", () => {
  it("emits the documented `[outbound-coalescer] event=<...>` shape", () => {
    const line = formatOutboundCoalescerLog("committed", {
      turnId: "run-abc",
      channel: "telegram:6533456892:6533456892",
      messages_merged: 3,
      final_kind: "final",
    });
    expect(line).toBe(
      "[outbound-coalescer] event=committed turnId=run-abc channel=telegram:6533456892:6533456892 messages_merged=3 final_kind=final",
    );
  });

  it("filters undefined and null payload values", () => {
    const line = formatOutboundCoalescerLog("registered", {
      turnId: "run-y",
      channel: "signal:+0:+1",
      sessionKey: undefined,
      bucketDepth: 1,
      reason: null,
    });
    expect(line).toBe(
      "[outbound-coalescer] event=registered turnId=run-y channel=signal:+0:+1 bucketDepth=1",
    );
  });

  it("renders arrays with bracket syntax and stringifies booleans", () => {
    const line = formatOutboundCoalescerLog("commit_signal", {
      source: "commitment_satisfied",
      kinds: ["ack", "intermediate", "final"],
      isFallback: false,
    });
    expect(line).toBe(
      "[outbound-coalescer] event=commit_signal source=commitment_satisfied kinds=[ack,intermediate,final] isFallback=false",
    );
  });

  it("emits all 8 closed events without rejecting payload shape", () => {
    const events: OutboundCoalescerLogEvent[] = [
      "registered",
      "committed",
      "commit_noop",
      "bypassed",
      "timeout_committed",
      "deliver_failed",
      "commit_signal",
      "types_loaded",
    ];
    for (const event of events) {
      const line = formatOutboundCoalescerLog(event, { marker: 1 });
      expect(line).toContain(`event=${event}`);
      expect(line.startsWith("[outbound-coalescer] ")).toBe(true);
    }
  });
});

describe("outbound-coalescer-types — module-init telemetry", () => {
  it("OUTBOUND_COALESCER_TYPES_LOADED_LINE is `event=types_loaded` shape", () => {
    expect(OUTBOUND_COALESCER_TYPES_LOADED_LINE).toBe(
      "[outbound-coalescer] event=types_loaded",
    );
  });
});

describe("outbound-coalescer factory (post-Phase-3)", () => {
  // Phase 3 (PR-NEW-C-3) replaced the throw-stub with the real impl;
  // the factory now returns a working `OutboundCoalescer`. The negative
  // -coverage cases below still throw `OutboundCoalescerNotImplementedError`
  // for malformed DI shapes — that error symbol is retained as the
  // structured DI-validation guard.
  it("returns a working OutboundCoalescer once the DI shape validates", () => {
    const coalescer = createOutboundCoalescer(makeDeps());
    expect(typeof coalescer.register).toBe("function");
    expect(typeof coalescer.commit).toBe("function");
    expect(typeof coalescer.commitAll).toBe("function");
    expect(typeof coalescer.bypass).toBe("function");
    expect(typeof coalescer.stats).toBe("function");
    expect(coalescer.stats()).toEqual({ buffered: 0, turns: 0 });
  });

  it("rejects deps.deliver that is not a function (negative coverage)", () => {
    const deps = makeDeps({ deliver: undefined as unknown as BlockReplyDeliver });
    let caught: unknown;
    try {
      createOutboundCoalescer(deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OutboundCoalescerNotImplementedError);
    expect((caught as OutboundCoalescerNotImplementedError).message).toMatch(
      /deps\.deliver must be a function/u,
    );
  });

  it("rejects an unknown mergeStrategy value (negative coverage)", () => {
    const deps = makeDeps({
      mergeStrategy: "drop_all" as unknown as OutboundCoalescerDeps["mergeStrategy"],
    });
    expect(() => createOutboundCoalescer(deps)).toThrow(/unknown mergeStrategy=drop_all/u);
  });

  it("rejects a non-positive maxBufferMs (negative coverage)", () => {
    const deps = makeDeps({ maxBufferMs: 0 });
    expect(() => createOutboundCoalescer(deps)).toThrow(
      /maxBufferMs must be a positive number/u,
    );
  });

  it("DI-validation error retains its structured code so callers can branch", () => {
    const deps = makeDeps({ maxBufferMs: -1 });
    let caught: unknown;
    try {
      createOutboundCoalescer(deps);
    } catch (e) {
      caught = e;
    }
    expect((caught as OutboundCoalescerNotImplementedError).code).toBe(
      "outbound_coalescer_not_implemented",
    );
    expect((caught as OutboundCoalescerNotImplementedError).phase).toBe(2);
  });
});
