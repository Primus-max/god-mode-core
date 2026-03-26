import { describe, expect, it, vi } from "vitest";
import { createProfileResolveGatewayMethod } from "./gateway.js";

describe("profile gateway method", () => {
  it("resolves a specialist runtime snapshot from the current draft", async () => {
    const respond = vi.fn();

    await createProfileResolveGatewayMethod()({
      params: {
        sessionKey: "main",
        draft: "Review this TypeScript repo, run tests if needed, and prepare a GitHub release.",
      },
      req: { type: "req", method: "platform.profile.resolve", id: "req-profile-1" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessionKey: "main",
        selectedProfileId: "developer",
        activeProfileId: "developer",
        recipeId: "code_build_publish",
        taskOverlayId: expect.any(String),
        draftApplied: true,
        override: expect.objectContaining({
          supported: false,
          mode: "auto",
        }),
      }),
    );

    const snapshot = respond.mock.calls[0]?.[1] as {
      reasoningSummary?: string;
      preferredTools?: string[];
      confidence?: number;
    };
    expect(snapshot.reasoningSummary).toContain("code_build_publish");
    expect(snapshot.preferredTools).toContain("exec");
    expect(snapshot.confidence).toBeGreaterThan(0);
  });
});
