/**
 * Targeted tests for the verbatim-forward branch added to
 * `subagent-announce.ts::runSubagentAnnounceFlow`.
 *
 * Closes audit-gap O2 (subagent-announce заходит в parent agent runtime
 * вместо delivery layer'а) на module-level. Проверяем именно структурный
 * контракт `tryDeliverVerbatimToUserChannel`: что worker.reply попадает
 * в channel send БЕЗ повторного `callGateway({method:"agent"})`,
 * с правильными channel/to/idempotencyKey, и что на любую делевери
 * ошибку gate откатывается на legacy path (return false).
 *
 * Hard invariants (`.cursor/rules/commitment-kernel-invariants.mdc`):
 *   - #5 / #6: gate не парсит prompt-text. Все решения принимаются по
 *     literal-полям `DeliveryContext` и enum значению `outcomeStatus`.
 *   - #11: пять frozen decision contracts не затронуты.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { tryDeliverVerbatimToUserChannel } = await import("./subagent-announce.js");
const { defaultRuntime } = await import("../runtime.js");
const callModule = await import("../gateway/call.js");

const TG_ORIGIN = {
  channel: "telegram",
  to: "6533456892",
  accountId: "acct-1",
  threadId: "thread-1",
};

let logSpy: ReturnType<typeof vi.spyOn>;
let callGatewaySpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy?.mockRestore();
  callGatewaySpy?.mockRestore();
  logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  callGatewaySpy = vi
    .spyOn(callModule, "callGateway")
    .mockImplementation(async () => undefined as unknown as never);
});

describe("subagent-announce / tryDeliverVerbatimToUserChannel", () => {
  it("returns false and logs verbatim_skipped:empty_reply for empty reply", async () => {
    const ok = await tryDeliverVerbatimToUserChannel({
      completionDirectOrigin: TG_ORIGIN,
      reply: "   ",
      targetRequesterSessionKey: "agent:default:main",
      childSessionKey: "agent:default:subagent:abc",
      childRunId: "run-1",
    });

    expect(ok).toBe(false);
    expect(callGatewaySpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0] as string).toContain("event=verbatim_skipped");
    expect(logSpy.mock.calls[0]?.[0] as string).toContain("reason=empty_reply");
  });

  it("returns false and logs verbatim_skipped:no_user_channel_target when channel/to missing", async () => {
    const ok = await tryDeliverVerbatimToUserChannel({
      completionDirectOrigin: { channel: "telegram" },
      reply: "result text",
      targetRequesterSessionKey: "agent:default:main",
      childSessionKey: "agent:default:subagent:abc",
      childRunId: "run-1",
    });

    expect(ok).toBe(false);
    expect(callGatewaySpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls[0]?.[0] as string).toContain("event=verbatim_skipped");
    expect(logSpy.mock.calls[0]?.[0] as string).toContain("reason=no_user_channel_target");
  });

  it("invokes callGateway({method:'send'}) with formatted reply, idempotencyKey and origin fields", async () => {
    const ok = await tryDeliverVerbatimToUserChannel({
      completionDirectOrigin: TG_ORIGIN,
      reply: "  итог: ок  ",
      targetRequesterSessionKey: "agent:default:main",
      childSessionKey: "agent:default:subagent:abc",
      childRunId: "run-1",
      label: "open-models-daily",
    });

    expect(ok).toBe(true);
    expect(callGatewaySpy).toHaveBeenCalledTimes(1);
    const arg = callGatewaySpy.mock.calls[0]?.[0] as {
      method: string;
      params: Record<string, unknown>;
      timeoutMs?: number;
    };
    expect(arg.method).toBe("send");
    expect(arg.timeoutMs).toBe(30_000);
    expect(arg.params).toMatchObject({
      to: "6533456892",
      channel: "telegram",
      accountId: "acct-1",
      threadId: "thread-1",
      sessionKey: "agent:default:main",
    });
    expect(typeof arg.params.message).toBe("string");
    expect(arg.params.message as string).toContain("итог: ок");
    expect(typeof arg.params.idempotencyKey).toBe("string");
    expect(arg.params.idempotencyKey as string).toContain(
      "subagent-aggregation:verbatim:agent:default:subagent:abc:run-1",
    );

    const lastLog = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(lastLog).toContain("event=worker_terminal_complete_verbatim");
    expect(lastLog).toContain("runId=run-1");
    expect(lastLog).toContain("content_bytes=");
  });

  it("does NOT call callGateway({method:'agent'}) — only 'send'", async () => {
    await tryDeliverVerbatimToUserChannel({
      completionDirectOrigin: TG_ORIGIN,
      reply: "ok",
      targetRequesterSessionKey: "agent:default:main",
      childSessionKey: "agent:default:subagent:abc",
      childRunId: "run-1",
    });

    for (const call of callGatewaySpy.mock.calls) {
      const methodArg = (call[0] as { method?: string })?.method;
      expect(methodArg).toBe("send");
    }
  });

  it("returns false and logs verbatim_skipped:gateway_send_failed when callGateway rejects", async () => {
    callGatewaySpy.mockImplementationOnce(() => Promise.reject(new Error("network down")));

    const ok = await tryDeliverVerbatimToUserChannel({
      completionDirectOrigin: TG_ORIGIN,
      reply: "ok",
      targetRequesterSessionKey: "agent:default:main",
      childSessionKey: "agent:default:subagent:abc",
      childRunId: "run-1",
    });

    expect(ok).toBe(false);
    const lastLog = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(lastLog).toContain("event=verbatim_skipped");
    expect(lastLog).toContain("reason=gateway_send_failed");
  });

  it("omits accountId / threadId fields when origin lacks them", async () => {
    const ok = await tryDeliverVerbatimToUserChannel({
      completionDirectOrigin: { channel: "telegram", to: "6533456892" },
      reply: "ok",
      targetRequesterSessionKey: "agent:default:main",
      childSessionKey: "agent:default:subagent:abc",
      childRunId: "run-1",
    });

    expect(ok).toBe(true);
    const arg = callGatewaySpy.mock.calls[0]?.[0] as {
      params: Record<string, unknown>;
    };
    expect(arg.params.accountId).toBeUndefined();
    expect(arg.params.threadId).toBeUndefined();
    expect(arg.params.channel).toBe("telegram");
    expect(arg.params.to).toBe("6533456892");
  });
});
