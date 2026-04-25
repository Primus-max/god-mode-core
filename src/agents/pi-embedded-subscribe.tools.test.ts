import { describe, expect, it } from "vitest";
import {
  buildToolExecutionReceipt,
  extractToolErrorMessage,
} from "./pi-embedded-subscribe.tools.js";
import { sanitizeToolErrorReasonForReceipt } from "./tool-error-sanitizer.js";

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
    ).toEqual(["tool_not_allowed_in_channel"]);
  });

  it("does not invent receipt reasons for unclassified tool errors", () => {
    const result = {
      details: {
        status: "error",
        error: "ENOENT: no such file or directory",
      },
    };

    expect(sanitizeToolErrorReasonForReceipt("ENOENT: no such file or directory")).toBeUndefined();
    expect(
      buildToolExecutionReceipt({
        toolName: "read",
        toolCallId: "tool-2",
        isToolError: true,
        result,
      }).reasons,
    ).toBeUndefined();
  });

  it("classifies transient tool errors into receipt reasons", () => {
    expect(sanitizeToolErrorReasonForReceipt("upstream returned HTTP 503")).toBe(
      "tool_temporarily_unavailable",
    );
  });
});
