import { describe, expect, test } from "vitest";
import { formatForLog, shortId, summarizeAgentEventForWsLog } from "./ws-log.js";

describe("gateway ws log helpers", () => {
  test.each([
    {
      name: "compacts uuids",
      input: "12345678-1234-1234-1234-123456789abc",
      expected: "12345678…9abc",
    },
    {
      name: "compacts long strings",
      input: "a".repeat(30),
      expected: "aaaaaaaaaaaa…aaaa",
    },
    {
      name: "trims before checking length",
      input: " short ",
      expected: "short",
    },
  ])("shortId $name", ({ input, expected }) => {
    expect(shortId(input)).toBe(expected);
  });

  test.each([
    {
      name: "formats Error instances",
      input: Object.assign(new Error("boom"), { name: "TestError" }),
      expected: "TestError: boom",
    },
    {
      name: "formats message-like objects with codes",
      input: { name: "Oops", message: "failed", code: "E1" },
      expected: "Oops: failed: code=E1",
    },
  ])("formatForLog $name", ({ input, expected }) => {
    expect(formatForLog(input)).toBe(expected);
  });

  test("formatForLog redacts obvious secrets", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const out = formatForLog({ token });
    expect(out).toContain("token");
    expect(out).not.toContain(token);
    expect(out).toContain("…");
  });

  test("summarizeAgentEventForWsLog compacts assistant payloads", () => {
    const summary = summarizeAgentEventForWsLog({
      runId: "12345678-1234-1234-1234-123456789abc",
      sessionKey: "agent:main:main",
      stream: "assistant",
      seq: 2,
      data: {
        text: "hello\n\nworld ".repeat(20),
        mediaUrls: ["a", "b"],
      },
    });

    expect(summary).toMatchObject({
      agent: "main",
      run: "12345678…9abc",
      session: "main",
      stream: "assistant",
      aseq: 2,
      media: 2,
    });
    expect(summary.text).toBeTypeOf("string");
    expect(summary.text).not.toContain("\n");
  });

  test("summarizeAgentEventForWsLog includes tool metadata", () => {
    expect(
      summarizeAgentEventForWsLog({
        runId: "run-1",
        stream: "tool",
        data: { phase: "start", name: "fetch", toolCallId: "12345678-1234-1234-1234-123456789abc" },
      }),
    ).toMatchObject({
      run: "run-1",
      stream: "tool",
      tool: "start:fetch",
      call: "12345678…9abc",
    });
  });

  test("summarizeAgentEventForWsLog includes lifecycle errors with compact previews", () => {
    const summary = summarizeAgentEventForWsLog({
      runId: "run-2",
      sessionKey: "agent:main:thread-1",
      stream: "lifecycle",
      data: {
        phase: "abort",
        aborted: true,
        error: "fatal ".repeat(40),
      },
    });

    expect(summary).toMatchObject({
      agent: "main",
      session: "thread-1",
      stream: "lifecycle",
      phase: "abort",
      aborted: true,
    });
    expect(summary.error).toBeTypeOf("string");
    expect((summary.error as string).length).toBeLessThanOrEqual(120);
  });

  test("summarizeAgentEventForWsLog preserves invalid session keys and unknown-stream reasons", () => {
    expect(
      summarizeAgentEventForWsLog({
        sessionKey: "bogus-session",
        stream: "other",
        data: { reason: "dropped" },
      }),
    ).toEqual({
      session: "bogus-session",
      stream: "other",
      reason: "dropped",
    });
  });

  test("summarizeAgentEventForWsLog includes runtime closure summaries", () => {
    expect(
      summarizeAgentEventForWsLog({
        runId: "run-closure",
        sessionKey: "agent:main:thread-1",
        stream: "runtime",
        data: {
          phase: "closure",
          summary: {
            runId: "run-closure",
            sessionKey: "agent:main:thread-1",
            updatedAtMs: 2_000,
            outcomeStatus: "partial",
            verificationStatus: "mismatch",
            acceptanceStatus: "retryable",
            action: "retry",
            remediation: "semantic_retry",
            reasonCode: "contract_mismatch",
            reasons: ["Execution contract did not match the declared intent."],
            declaredIntent: "document",
            declaredRecipeId: "recipe.doc",
          },
        },
      }),
    ).toMatchObject({
      run: "run-closure",
      agent: "main",
      session: "thread-1",
      stream: "runtime",
      phase: "closure",
      action: "retry",
      code: "contract_mismatch",
      outcome: "partial",
      intent: "document",
      recipe: "recipe.doc",
    });
  });
});
