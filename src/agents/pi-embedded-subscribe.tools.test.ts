import { describe, expect, it } from "vitest";
import {
  buildToolExecutionReceipt,
  extractToolErrorMessage,
} from "./pi-embedded-subscribe.tools.js";

describe("extractToolErrorMessage", () => {
  it("ignores non-error status values", () => {
    expect(extractToolErrorMessage({ details: { status: "0" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "completed" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "ok" } })).toBeUndefined();
  });

  it("keeps error-like status values", () => {
    expect(extractToolErrorMessage({ details: { status: "failed" } })).toBe("failed");
    expect(extractToolErrorMessage({ details: { status: "timeout" } })).toBe("timeout");
  });

  it("sanitizes internal policy denials in tool error messages and receipts", () => {
    const result = {
      details: {
        status: "error",
        error: "Only reminder scheduling is allowed from this chat.",
      },
    };

    expect(extractToolErrorMessage(result)).toBe(
      "This action is not allowed from this chat or tool context.",
    );
    expect(
      buildToolExecutionReceipt({
        toolName: "cron",
        toolCallId: "tool-1",
        isToolError: true,
        result,
      }).reasons,
    ).toEqual(["This action is not allowed from this chat or tool context."]);
  });
});
