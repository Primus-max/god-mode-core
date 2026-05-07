/**
 * Bug F (persistent-worker subsequent push) Phase 5d — fail-first tests
 * for the production `deliveryDispatch` transport closure.
 *
 * Phase 5c (PR #281) wired `setProcessPersistentWorkerPushFireCallback`
 * at server bootstrap, but the `deliveryDispatch` parameter currently
 * uses a `transport_not_wired` stub that returns a structured
 * `dispatch_failed` envelope without throwing. Phase 5d closes this gap
 * so production push'ы actually arrive in Telegram/Slack via the
 * existing `dispatchCronDelivery`/`deliverOutboundPayloads` surface.
 *
 * Pre-fix proof: the file under test introduces
 * `createProductionPersistentWorkerPushDeliveryDispatch` — without that
 * helper the suite imports a non-existent symbol and fails at module
 * load (that IS the fail-first reproduction; the stub returning
 * `transport_not_wired` is the live regression on dev HEAD).
 *
 * No `vi.spyOn` shimming the helper under test (slice E discipline);
 * the dispatcher dependency (`deliverOutboundPayloads`-shaped function)
 * is dependency-injected so the closure is exercised against real
 * adapter glue — not a stubbed-out function under test.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createProductionPersistentWorkerPushDeliveryDispatch,
  type ProductionDeliveryDispatchDeps,
} from "./persistent-worker-push-bootstrap.js";
import type { PersistentWorkerPushDispatchPayload } from "../platform/persistent-worker/persistent-worker-push-runtime-adapter.js";
import { asIdentityId } from "../platform/identity/identity-id.js";
import type { ChannelId } from "../platform/commitment/ids.js";

const VLADIMIR = asIdentityId("identity:vladimir");
const TELEGRAM = "telegram" as ChannelId;

function makePayload(
  overrides: Partial<PersistentWorkerPushDispatchPayload> = {},
): PersistentWorkerPushDispatchPayload {
  return {
    workerRunId: "wrk-001",
    wrappedScopeIdentityId: VLADIMIR,
    completedAt: new Date(0).toISOString(),
    channel: TELEGRAM,
    to: "6533456892",
    content: "Daily push: 3 new artifacts.",
    ...overrides,
  };
}

/**
 * Minimal stand-in for the OpenClawConfig surface — the closure only
 * threads `cfg` through to `deliverOutboundPayloads` opaquely (the
 * channel/to are read off the payload), so we cast a structurally
 * compatible shape rather than building a full config fixture.
 */
const FAKE_CFG = {} as ProductionDeliveryDispatchDeps["cfg"];
const FAKE_CLI_DEPS = {} as ProductionDeliveryDispatchDeps["deps"];

describe("persistent-worker-push-bootstrap — Phase 5d production transport", () => {
  it("Case 1: factory returns a function (callback wired by bootstrap)", () => {
    const dispatch = createProductionPersistentWorkerPushDeliveryDispatch({
      cfg: FAKE_CFG,
      deps: FAKE_CLI_DEPS,
      deliverOutboundPayloads: async () => [
        { channel: "telegram", messageId: "tg:1" },
      ],
    });
    expect(typeof dispatch).toBe("function");
  });

  it("Case 2: successful dispatch via injected deliverer → { ok: true }; payload threaded through", async () => {
    const captured: Array<{
      channel: string;
      to: string;
      payloadCount: number;
      text: string | undefined;
    }> = [];
    const dispatch = createProductionPersistentWorkerPushDeliveryDispatch({
      cfg: FAKE_CFG,
      deps: FAKE_CLI_DEPS,
      deliverOutboundPayloads: async (params) => {
        captured.push({
          channel: params.channel,
          to: params.to,
          payloadCount: params.payloads.length,
          text:
            params.payloads[0] && typeof params.payloads[0].text === "string"
              ? params.payloads[0].text
              : undefined,
        });
        return [{ channel: "telegram", messageId: "tg:42" }];
      },
    });

    const result = await dispatch(makePayload());

    expect(result).toEqual({ ok: true });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.channel).toBe("telegram");
    expect(captured[0]?.to).toBe("6533456892");
    expect(captured[0]?.payloadCount).toBe(1);
    expect(captured[0]?.text).toBe("Daily push: 3 new artifacts.");
  });

  it("Case 3: deliverer returns empty results array → { ok: false, reason: 'dispatch_failed' }", async () => {
    // Production semantics: an empty results array means no channel
    // accepted the send (best-effort suppression / no-op routing).
    // The runtime adapter maps `{ ok: false }` into the closed-set
    // `dispatch_failed` reason — preserving the 8-entry failure surface
    // so #15 holds end-to-end.
    const dispatch = createProductionPersistentWorkerPushDeliveryDispatch({
      cfg: FAKE_CFG,
      deps: FAKE_CLI_DEPS,
      deliverOutboundPayloads: async () => [],
    });

    const result = await dispatch(makePayload());

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("dispatch_failed");
    }
  });

  it("Case 4: deliverer throws (paranoia) → { ok: false, reason: 'dispatch_failed' } (NEVER throws #15)", async () => {
    const dispatch = createProductionPersistentWorkerPushDeliveryDispatch({
      cfg: FAKE_CFG,
      deps: FAKE_CLI_DEPS,
      deliverOutboundPayloads: async () => {
        throw new Error("boom — channel adapter exploded");
      },
    });

    // Guard against the closure rethrowing — the public contract is the
    // closed-shape envelope (#15). If this expectation fires, the
    // adapter would surface `dispatch_failed` via the catch-all but the
    // closure itself MUST NOT throw.
    let threw = false;
    let result: Awaited<ReturnType<typeof dispatch>> | undefined;
    try {
      result = await dispatch(makePayload());
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(result!.ok).toBe(false);
    if (result && result.ok === false) {
      expect(result.reason).toBe("dispatch_failed");
    }
  });

  it("Case 5: payload shape adaptation — channel/to/content map onto deliverOutboundPayloads params", async () => {
    const captured: Array<{
      channel: string;
      to: string;
      bestEffort: boolean | undefined;
      hasIdentity: boolean;
      hasSession: boolean;
      payloadText: string | undefined;
    }> = [];
    const dispatch = createProductionPersistentWorkerPushDeliveryDispatch({
      cfg: FAKE_CFG,
      deps: FAKE_CLI_DEPS,
      deliverOutboundPayloads: async (params) => {
        captured.push({
          channel: params.channel,
          to: params.to,
          bestEffort: params.bestEffort,
          hasIdentity: params.identity !== undefined,
          hasSession: params.session !== undefined,
          payloadText:
            params.payloads[0] && typeof params.payloads[0].text === "string"
              ? params.payloads[0].text
              : undefined,
        });
        return [{ channel: "slack", messageId: "sl:7" }];
      },
    });

    const payload = makePayload({
      channel: "slack" as ChannelId,
      to: "U12345",
      content: "Hello from worker",
    });
    const result = await dispatch(payload);

    expect(result).toEqual({ ok: true });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.channel).toBe("slack");
    expect(captured[0]?.to).toBe("U12345");
    expect(captured[0]?.payloadText).toBe("Hello from worker");
  });

  it("Case 6 (defensive): empty channel in payload → { ok: false, reason: 'channel_invalid' }", async () => {
    // The closure rejects empty channels BEFORE invoking the deliverer
    // so a malformed payload cannot reach the outbound adapter.
    const deliverer = vi.fn(async () => [
      { channel: "telegram", messageId: "tg:0" },
    ]);
    const dispatch = createProductionPersistentWorkerPushDeliveryDispatch({
      cfg: FAKE_CFG,
      deps: FAKE_CLI_DEPS,
      deliverOutboundPayloads: deliverer as unknown as ProductionDeliveryDispatchDeps["deliverOutboundPayloads"],
    });

    const result = await dispatch(makePayload({ channel: "" as ChannelId }));

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("channel_invalid");
    }
    // Deliverer must NOT have been invoked.
    expect(deliverer).not.toHaveBeenCalled();
  });
});
