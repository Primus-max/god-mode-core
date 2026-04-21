import { describe, expect, it } from "vitest";
import { resolveTelegramProgressTargetFromSessionContext } from "./bot.js";

describe("resolveTelegramProgressTargetFromSessionContext", () => {
  it("resolves chatId from telegram session context", () => {
    const target = resolveTelegramProgressTargetFromSessionContext({
      frameSessionId: "session-1",
      frameChannelId: "telegram",
      accountId: "main",
      store: {
        "agent:main:session-1": {
          sessionId: "session-1",
          updatedAt: 1000,
          deliveryContext: {
            channel: "telegram",
            to: "12345",
            accountId: "main",
          },
        },
      },
    });
    expect(target).toEqual({ chatId: "12345" });
  });
});
