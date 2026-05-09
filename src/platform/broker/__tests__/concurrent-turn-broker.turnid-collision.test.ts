import { describe, expect, it } from "vitest";

import { asIdentityId } from "../../identity/identity-id.js";
import {
  buildBrokerQueueKey,
  type BrokerEntry,
  type BrokerQueueKey,
} from "../broker-types.js";
import { createConcurrentTurnBroker } from "../concurrent-turn-broker.js";

/**
 * Slice S15 — fail-first regression for the turnId-collision concurrency
 * hazard.
 *
 * Hazard: `createConcurrentTurnBroker` keys `submitResolvers` on
 * `entry.turnId`. The broker contract on `BrokerEntry.turnId` says:
 *
 *   "opaque caller-supplied turn identifier; the broker treats it as a
 *    string and passes it through into Phase 6 telemetry. NOT used for
 *    dedup (callers own dedup at the queue layer above)."
 *
 * Reality (pre-fix): when two `submit(...)` calls arrive with the SAME
 * turnId — a legitimate scenario for retries, replays, or two channels
 * that derive their turn id from the same upstream message id — the
 * second `submitResolvers.set(turnId, resolve)` OVERWRITES the first.
 *
 * Concrete observable symptoms exercised below:
 *   (1) The first submit's promise NEVER resolves — its resolver was
 *       silently overwritten.
 *   (2) The second submit's promise resolves to `{kind:'completed'}`
 *       BEFORE its own runTurn callback has executed — it is fired by
 *       the first entry's drain `finally` block.
 *
 * This test pins both symptoms. After the fix (resolver indexed on a
 * broker-internal id, not the opaque caller-supplied turnId), both
 * submit promises resolve in admission order and only after their own
 * runTurn settles.
 *
 * Live evidence: same-turnId double-submit is reachable from any caller
 * that does NOT enforce uniqueness (Telegram + LSP retries, channel
 * fan-out where `messageId` is reused). The broker's docstring claims
 * turnId is opaque, but `submitResolvers` silently treats it as a
 * primary key.
 */

const IDENTITY = asIdentityId("identity:operator-a");
const KEY_A: BrokerQueueKey = buildBrokerQueueKey(IDENTITY, "telegram:1");

function makeEntry(
  queueKey: BrokerQueueKey,
  overrides: Partial<BrokerEntry> = {},
): BrokerEntry {
  return {
    turnId: overrides.turnId ?? "turn-1",
    queueKey,
    enqueuedAtMs: overrides.enqueuedAtMs ?? Date.now(),
    runTurn: overrides.runTurn ?? (async () => undefined),
  };
}

describe("S15 — turnId collision hazard", () => {
  it("settles BOTH submits in FIFO order when same turnId is reused", async () => {
    const broker = createConcurrentTurnBroker();

    const events: string[] = [];

    const COLLIDING_TURN_ID = "msg-42"; // upstream message id reused on retry

    // First submit: real work to do.
    const p1 = broker.submit(
      makeEntry(KEY_A, {
        turnId: COLLIDING_TURN_ID,
        runTurn: async () => {
          events.push("run-1");
        },
      }),
    );

    // Second submit: SAME turnId (legitimate same-key retry from caller).
    const p2 = broker.submit(
      makeEntry(KEY_A, {
        turnId: COLLIDING_TURN_ID,
        runTurn: async () => {
          events.push("run-2");
        },
      }),
    );

    // Race against a watchdog: if either submit hangs because its
    // resolver was clobbered, the watchdog fires first and the test
    // surfaces the hazard precisely.
    const watchdog = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), 500);
    });

    const settled = await Promise.race([
      Promise.all([p1, p2]).then(() => "both-settled" as const),
      watchdog,
    ]);

    expect(settled).toBe("both-settled");

    // Pre-fix bug: p2 resolves BEFORE run-2 executes (the first entry's
    // drain fires the second entry's resolver because the resolver map
    // was clobbered). Post-fix: both runTurn callbacks run before
    // either submit promise resolves.
    expect(events).toEqual(["run-1", "run-2"]);

    // Both must report `completed` (broker swallows runTurn rejections;
    // here both runTurns succeed).
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ kind: "completed" });
    expect(r2).toEqual({ kind: "completed" });

    await broker.shutdown();
  });

  it("does not deadlock when two same-turnId entries land on different keys", async () => {
    // Cross-key collision: p1 lands on KEY_A, p2 lands on a sibling key.
    // Pre-fix: the second submit's resolver overwrites the first in the
    // single global `submitResolvers` map — even though the entries
    // dispatch to different queues. The first entry's drain then
    // resolves the SECOND submit's promise (with kind:'completed' but
    // before run-2 executes), and the FIRST submit's promise hangs.
    const broker = createConcurrentTurnBroker();
    const KEY_B: BrokerQueueKey = buildBrokerQueueKey(IDENTITY, "telegram:2");

    let run1Done = false;
    let run2Done = false;

    const p1 = broker.submit(
      makeEntry(KEY_A, {
        turnId: "shared",
        runTurn: async () => {
          await new Promise((r) => setTimeout(r, 20));
          run1Done = true;
        },
      }),
    );
    const p2 = broker.submit(
      makeEntry(KEY_B, {
        turnId: "shared",
        runTurn: async () => {
          await new Promise((r) => setTimeout(r, 20));
          run2Done = true;
        },
      }),
    );

    const watchdog = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), 500);
    });

    const settled = await Promise.race([
      Promise.all([p1, p2]).then(() => "both-settled" as const),
      watchdog,
    ]);

    expect(settled).toBe("both-settled");

    // Both runTurn callbacks must have observably executed before
    // either submit promise resolves.
    expect(run1Done).toBe(true);
    expect(run2Done).toBe(true);

    await broker.shutdown();
  });
});
