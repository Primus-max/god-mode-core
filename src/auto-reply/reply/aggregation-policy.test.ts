/**
 * Unit tests for `aggregation-policy.ts`.
 *
 * Структурный invariant под тестом: на каждый external_user-turn parent-сессия
 * выпускает РОВНО ОДНО финальное user-facing сообщение в исходный канал.
 * Тесты покрывают decision-логику без обращения к runtime'у:
 *   - decideAggregationMode для разных combinations spawn/userChannel/mode.
 *   - shouldVerbatimForwardCompletion для completion-paths.
 *   - hasUserChannelTarget literal-checks.
 *   - formatAggregationLog event-shape.
 *
 * Reference invariants (`.cursor/rules/commitment-kernel-invariants.mdc`):
 *   - #5: gate работает по типизированному состоянию, не по тексту.
 *   - #6: classifier для non-user provenance не запускается; verbatim path
 *     обходит parent-LLM.
 */

import { describe, expect, it } from "vitest";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import {
  buildHoldingIdempotencyKey,
  buildVerbatimIdempotencyKey,
  decideAggregationMode,
  DEFAULT_AGGREGATION_MODE,
  formatAggregationLog,
  formatVerbatimWorkerContent,
  hasUserChannelTarget,
  HOLDING_MESSAGE_TEXT,
  shouldVerbatimForwardCompletion,
} from "./aggregation-policy.js";

const TG_CHANNEL: DeliveryContext = {
  channel: "telegram",
  to: "6533456892",
  accountId: "acct-1",
  threadId: "thread-1",
};

const INTERNAL_CHANNEL: DeliveryContext = {
  channel: "internal",
};

describe("aggregation-policy / hasUserChannelTarget", () => {
  it("recognizes deliverable channel + to as user-channel target", () => {
    expect(hasUserChannelTarget(TG_CHANNEL)).toBe(true);
  });

  it("rejects undefined", () => {
    expect(hasUserChannelTarget(undefined)).toBe(false);
  });

  it("rejects channel without to", () => {
    expect(hasUserChannelTarget({ channel: "telegram" })).toBe(false);
  });

  it("rejects to without channel", () => {
    expect(hasUserChannelTarget({ to: "6533456892" })).toBe(false);
  });
});

describe("aggregation-policy / decideAggregationMode", () => {
  it("returns 'none' when spawn was not accepted", () => {
    expect(
      decideAggregationMode({
        spawn: { accepted: false },
        userChannelTarget: true,
      }),
    ).toBe("none");
  });

  it("returns 'none' when no user-channel target", () => {
    expect(
      decideAggregationMode({
        spawn: { accepted: true, mode: "session" },
        userChannelTarget: false,
      }),
    ).toBe("none");
  });

  it("returns 'none' for one-shot run without expectsCompletionMessage", () => {
    expect(
      decideAggregationMode({
        spawn: { accepted: true, mode: "run", expectsCompletionMessage: false },
        userChannelTarget: true,
      }),
    ).toBe("none");
  });

  it("returns 'holding' (default) for persistent_session continuation", () => {
    expect(
      decideAggregationMode({
        spawn: { accepted: true, mode: "session" },
        userChannelTarget: true,
      }),
    ).toBe("holding");
  });

  it("returns 'holding' for followup with expectsCompletionMessage=true", () => {
    expect(
      decideAggregationMode({
        spawn: { accepted: true, mode: "run", expectsCompletionMessage: true },
        userChannelTarget: true,
      }),
    ).toBe("holding");
  });

  it("respects explicit configMode='await'", () => {
    expect(
      decideAggregationMode({
        spawn: { accepted: true, mode: "session" },
        userChannelTarget: true,
        configMode: "await",
      }),
    ).toBe("await");
  });

  it("default mode is exposed as 'holding'", () => {
    expect(DEFAULT_AGGREGATION_MODE).toBe("holding");
  });

  it("HOLDING_MESSAGE_TEXT не содержит эмодзи и не парсит prompt-text", () => {
    // Invariant #5: gate работает по типизированному state, текст
    // holding-сообщения генерируется детерминировано без чтения user-prompt'а.
    expect(typeof HOLDING_MESSAGE_TEXT).toBe("string");
    expect(HOLDING_MESSAGE_TEXT.trim().length).toBeGreaterThan(0);
    expect(HOLDING_MESSAGE_TEXT).not.toMatch(/\p{Emoji_Presentation}/u);
  });
});

describe("aggregation-policy / shouldVerbatimForwardCompletion", () => {
  it("returns true for ok worker with deliverable user-channel target", () => {
    expect(
      shouldVerbatimForwardCompletion({
        expectsCompletionMessage: true,
        requesterIsSubagent: false,
        outcomeStatus: "ok",
        completionDirectOrigin: TG_CHANNEL,
        reply: "Got 10 models in S/M/L tiers",
      }),
    ).toBe(true);
  });

  it("returns false when expectsCompletionMessage=false", () => {
    expect(
      shouldVerbatimForwardCompletion({
        expectsCompletionMessage: false,
        requesterIsSubagent: false,
        outcomeStatus: "ok",
        completionDirectOrigin: TG_CHANNEL,
        reply: "summary",
      }),
    ).toBe(false);
  });

  it("returns false when requester is itself a subagent (intra-orchestration)", () => {
    expect(
      shouldVerbatimForwardCompletion({
        expectsCompletionMessage: true,
        requesterIsSubagent: true,
        outcomeStatus: "ok",
        completionDirectOrigin: TG_CHANNEL,
        reply: "summary",
      }),
    ).toBe(false);
  });

  it("returns false for non-deliverable channel target", () => {
    expect(
      shouldVerbatimForwardCompletion({
        expectsCompletionMessage: true,
        requesterIsSubagent: false,
        outcomeStatus: "ok",
        completionDirectOrigin: INTERNAL_CHANNEL,
        reply: "summary",
      }),
    ).toBe(false);
  });

  it("returns false for outcome=error/timeout (legacy fallback path runs)", () => {
    for (const status of ["error", "timeout", "unknown"] as const) {
      expect(
        shouldVerbatimForwardCompletion({
          expectsCompletionMessage: true,
          requesterIsSubagent: false,
          outcomeStatus: status,
          completionDirectOrigin: TG_CHANNEL,
          reply: "summary",
        }),
      ).toBe(false);
    }
  });

  it("returns false for empty reply", () => {
    expect(
      shouldVerbatimForwardCompletion({
        expectsCompletionMessage: true,
        requesterIsSubagent: false,
        outcomeStatus: "ok",
        completionDirectOrigin: TG_CHANNEL,
        reply: "  ",
      }),
    ).toBe(false);
  });
});

describe("aggregation-policy / formatVerbatimWorkerContent", () => {
  it("оборачивает reply в 'Готово:\\n\\n…' по умолчанию", () => {
    const out = formatVerbatimWorkerContent({ reply: "row1\nrow2" });
    expect(out).toBe("Готово:\n\nrow1\nrow2");
  });

  it("trim'ит whitespace вокруг reply", () => {
    const out = formatVerbatimWorkerContent({ reply: "\n\n  body  \n\n" });
    expect(out).toBe("Готово:\n\nbody");
  });

  it("не добавляет prefix при withReadyPrefix=false", () => {
    const out = formatVerbatimWorkerContent({ reply: "raw", withReadyPrefix: false });
    expect(out).toBe("raw");
  });
});

describe("aggregation-policy / idempotency keys", () => {
  it("verbatim key привязан к childRunId + childSessionKey", () => {
    const k = buildVerbatimIdempotencyKey({
      childRunId: "run-1",
      childSessionKey: "agent:default:subagent:abc",
    });
    expect(k).toBe("subagent-aggregation:verbatim:agent:default:subagent:abc:run-1");
  });

  it("holding key привязан к parent + child + (опционально) runId", () => {
    expect(
      buildHoldingIdempotencyKey({
        parentSessionKey: "agent:default:main",
        childSessionKey: "agent:default:subagent:abc",
        childRunId: "run-1",
      }),
    ).toBe("subagent-aggregation:holding:agent:default:main:agent:default:subagent:abc:run-1");

    expect(
      buildHoldingIdempotencyKey({
        parentSessionKey: "agent:default:main",
        childSessionKey: "agent:default:subagent:abc",
      }),
    ).toBe("subagent-aggregation:holding:agent:default:main:agent:default:subagent:abc");
  });
});

describe("aggregation-policy / formatAggregationLog", () => {
  it("включает event-name и mode/parent/child/runId/label/content_bytes/reason", () => {
    const log = formatAggregationLog({
      event: "holding_sent",
      mode: "holding",
      parentSessionKey: "agent:default:main",
      childSessionKey: "agent:default:subagent:abc",
      childRunId: "run-1",
      label: "open-models-daily",
      contentBytes: 4096,
      reason: "spawn_tool_observed",
    });
    expect(log).toMatch(/^\[subagent-aggregation\]/);
    expect(log).toContain("event=holding_sent");
    expect(log).toContain("mode=holding");
    expect(log).toContain("parent=agent:default:main");
    expect(log).toContain("child=agent:default:subagent:abc");
    expect(log).toContain("runId=run-1");
    expect(log).toContain("label=open-models-daily");
    expect(log).toContain("content_bytes=4096");
    expect(log).toContain("reason=spawn_tool_observed");
  });

  it("опускает поля при их отсутствии", () => {
    const log = formatAggregationLog({ event: "policy_passthrough" });
    expect(log).toBe("[subagent-aggregation] event=policy_passthrough");
  });
});
