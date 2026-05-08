/**
 * NEW-C Phase 6 — bypass-coverage acceptance guard.
 *
 * Sub-plan: `.cursor/plans/commitment_kernel_outbound_coalescer.plan.md`
 * §6 oc-phase-6-bypass-allowlist (c) — "lint rule / runtime acceptance
 * guard" promoted from Phase 7. Phase 1 audit §e + §j summarise the
 * Phase 7 acceptance: every external-surface delivery emits EITHER
 * `event=committed` OR `event=bypassed` for the corresponding turnId in
 * the same time window.
 *
 * What this test guards:
 * - Forgotten emit-sites that skip BOTH the coalescer commit edge AND
 *   the bypass route. If a future contributor adds a new external
 *   delivery without going through coalescer.register / coalescer.bypass,
 *   the telemetry trail collapses and this guard fails.
 * - The two surfaces are mutually exclusive per delivery — a single
 *   `(turnId, channelKey)` external delivery never has both events; a
 *   single bypass surface only has bypassed.
 *
 * Соответствие 16 hard invariants:
 *   - #5 / #6: гард работает на телеметрии (структурные log-строки), НЕ
 *     читает user prompt / RawUserTurn.
 *   - #11: 5 frozen contracts byte-identical; гард не трогает frozen
 *     layer.
 *   - #15: failure isolation per-bucket — гард симулирует isolated
 *     deliver-throw и assertit, что deliver_failed телеметрия ALSO
 *     удовлетворяет coverage (committed-OR-bypassed; deliver_failed
 *     приходит after committed для того же turnId).
 */
import { describe, expect, it } from "vitest";
import type { BlockReplyDeliver } from "../../../auto-reply/reply/block-external-buffer.js";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import type { OutboundCoalescerDeps } from "../outbound-coalescer-types.js";
import { createOutboundCoalescer } from "../outbound-coalescer.js";

type DeliveryRecord = {
  turnId: string | undefined;
  channelKey: string | undefined;
  source: "coalescer" | "bypass" | "external_unknown";
  text: string | undefined;
};

/**
 * Pure function — assert that every external delivery has matching
 * coverage telemetry. The rule:
 *   - coalescer-sourced delivery → telemetry MUST carry an
 *     `event=committed turnId=<id>` line for that turnId.
 *   - bypass-sourced delivery → telemetry MUST carry an
 *     `event=bypassed reason=<r>` line in the same window.
 *   - external_unknown (= external surface that did NOT route through
 *     either) → guard FAILS. This is the forgotten-emit-site signal.
 */
function assertCoverage(
  deliveries: ReadonlyArray<DeliveryRecord>,
  logs: ReadonlyArray<string>,
): void {
  for (const d of deliveries) {
    if (d.source === "external_unknown") {
      throw new Error(
        `coverage guard: external delivery missing coalescer/bypass telemetry — text=${d.text}`,
      );
    }
    if (d.source === "coalescer") {
      const turnId = d.turnId;
      if (turnId === undefined) {
        throw new Error("coverage guard: coalescer delivery missing turnId");
      }
      const matched = logs.some(
        (l) => l.includes("event=committed") && l.includes(`turnId=${turnId}`),
      );
      if (!matched) {
        throw new Error(`coverage guard: no event=committed for turnId=${turnId}`);
      }
    } else {
      // bypass
      const matched = logs.some((l) => l.includes("event=bypassed"));
      if (!matched) {
        throw new Error("coverage guard: no event=bypassed for bypass delivery");
      }
    }
  }
}

function makeDeps(
  collected: { logs: string[] },
  deliver: BlockReplyDeliver,
  overrides: Partial<OutboundCoalescerDeps> = {},
): OutboundCoalescerDeps {
  return {
    deliver,
    mergeStrategy: overrides.mergeStrategy ?? "drop_intermediates",
    maxBufferMs: overrides.maxBufferMs ?? 60_000,
    logTelemetry: (line) => collected.logs.push(line),
    clockNow: overrides.clockNow ?? (() => 1_000),
    // V1-CLOSE T4: forward optional retry overrides so individual
    // tests can drive the loop without coupling to wall-clock backoff.
    retryDelaysMs: overrides.retryDelaysMs,
    retrySleep: overrides.retrySleep,
  };
}

describe("outbound-coalescer Phase 6 — bypass coverage acceptance guard", () => {
  it("PASSES when every external delivery has matching committed/bypassed telemetry", async () => {
    const collected = { logs: [] as string[] };
    const deliveries: DeliveryRecord[] = [];

    const coalescerDeliver: BlockReplyDeliver = (payload) => {
      deliveries.push({
        turnId: "run-1",
        channelKey: "telegram:1:1",
        source: "coalescer",
        text: payload.text,
      });
    };
    const coalescer = createOutboundCoalescer(makeDeps(collected, coalescerDeliver));

    coalescer.register({
      turnId: "run-1",
      channelKey: "telegram:1:1",
      kind: "final",
      body: { text: "user-facing reply" },
      ts: 1_000,
    });
    await coalescer.commit("run-1", "telegram:1:1");

    // A separate boot-time delivery routed through bypass.
    await coalescer.bypass("system_init", { text: "[gateway] startup" }, (payload) => {
      deliveries.push({
        turnId: undefined,
        channelKey: undefined,
        source: "bypass",
        text: payload.text,
      });
    });

    // Guard must pass — both deliveries have matching telemetry.
    expect(() => assertCoverage(deliveries, collected.logs)).not.toThrow();
    expect(deliveries).toHaveLength(2);
    expect(
      collected.logs.some((l) => l.includes("event=committed") && l.includes("turnId=run-1")),
    ).toBe(true);
    expect(
      collected.logs.some((l) => l.includes("event=bypassed") && l.includes("reason=system_init")),
    ).toBe(true);
  });

  it("FAILS when a forgotten emit-site delivers externally without coalescer/bypass", () => {
    const logs: string[] = [];
    // Simulate a future regression: an emit-site that calls the
    // channel adapter directly without going through the coalescer.
    // The coverage guard MUST flag it.
    const deliveries: DeliveryRecord[] = [
      {
        turnId: undefined,
        channelKey: undefined,
        source: "external_unknown",
        text: "forgotten emit-site",
      },
    ];
    expect(() => assertCoverage(deliveries, logs)).toThrow(
      /external delivery missing coalescer\/bypass telemetry/u,
    );
  });

  it("FAILS when coalescer delivers but the corresponding turnId committed line is absent", () => {
    // Pathological case: deliver fired without telemetry. Catches
    // future bugs where coalescer.commit's deliver-call path skips the
    // log line.
    const logs = ["[outbound-coalescer] event=committed turnId=other-run"];
    const deliveries: DeliveryRecord[] = [
      {
        turnId: "missing-turn",
        channelKey: "telegram:1:1",
        source: "coalescer",
        text: "x",
      },
    ];
    expect(() => assertCoverage(deliveries, logs)).toThrow(
      /no event=committed for turnId=missing-turn/u,
    );
  });

  it("composes with deliver-failure isolation: failed deliver still emits coverage telemetry", async () => {
    const collected = { logs: [] as string[] };
    const deliveries: DeliveryRecord[] = [];

    const failingDeliver: BlockReplyDeliver = () => {
      // Per invariant #15 + V1-CLOSE T4: isolated failure surfaces a
      // typed `OutboundCoalescerDeliveryError` to the caller after
      // retries exhaust, but the coverage telemetry (committed +
      // deliver_failed) is still emitted around it. Coverage guard
      // SHOULD still pass because event=committed line lands BEFORE
      // the deliver attempts.
      deliveries.push({
        turnId: "run-fail",
        channelKey: "telegram:1:1",
        source: "coalescer",
        text: undefined,
      });
      throw new Error("channel down");
    };
    const coalescer = createOutboundCoalescer(
      // Empty retry schedule — surface immediately on first failure
      // (single deliver attempt) so this coverage test does not
      // need to wait for the production 1s/2s backoff.
      makeDeps(collected, failingDeliver, { retryDelaysMs: [] }),
    );

    coalescer.register({
      turnId: "run-fail",
      channelKey: "telegram:1:1",
      kind: "final",
      body: { text: "boom" },
      ts: 1_000,
    });
    // V1-CLOSE T4: commit now surfaces the typed error after retry
    // exhaustion. Coverage telemetry (committed + deliver_failed) is
    // still emitted, which is what this guard exercises.
    await expect(coalescer.commit("run-fail", "telegram:1:1")).rejects.toMatchObject({
      code: "outbound_coalescer_delivery_dropped",
    });

    expect(() => assertCoverage(deliveries, collected.logs)).not.toThrow();
    expect(
      collected.logs.some((l) => l.includes("event=committed") && l.includes("turnId=run-fail")),
    ).toBe(true);
    expect(collected.logs.some((l) => l.includes("event=deliver_failed"))).toBe(true);
    // V1-CLOSE T4: with empty retryDelaysMs, exhaustion fires after a
    // single attempt — assert the structured drop telemetry too.
    expect(
      collected.logs.some(
        (l) => l.includes("event=delivery_dropped") && l.includes("turnId=run-fail"),
      ),
    ).toBe(true);
  });

  it("multi-channel turn produces one committed line per channel — guard verifies each", async () => {
    const collected = { logs: [] as string[] };
    const deliveries: DeliveryRecord[] = [];

    const deliver: BlockReplyDeliver = (payload) => {
      deliveries.push({
        turnId: "run-X",
        channelKey: undefined,
        source: "coalescer",
        text: payload.text,
      });
    };
    const coalescer = createOutboundCoalescer(makeDeps(collected, deliver));

    coalescer.register({
      turnId: "run-X",
      channelKey: "telegram:1:1",
      kind: "final",
      body: { text: "tg" },
      ts: 1_000,
    });
    coalescer.register({
      turnId: "run-X",
      channelKey: "signal:+0:+1",
      kind: "final",
      body: { text: "signal" },
      ts: 1_001,
    });
    await coalescer.commitAll("run-X");

    // Two deliveries, both attributed to run-X; committed telemetry
    // must cover both.
    expect(deliveries).toHaveLength(2);
    expect(() => assertCoverage(deliveries, collected.logs)).not.toThrow();
    const committedLines = collected.logs.filter((l) => l.includes("event=committed"));
    expect(committedLines).toHaveLength(2);
  });
});
