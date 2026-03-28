import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { buildGatewaySessionRow, listSessionsFromStore } from "./session-utils.js";

describe("gateway session closure parity", () => {
  test("buildGatewaySessionRow hydrates persisted run closure summaries", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    const entry = {
      sessionId: "sess-closure",
      updatedAt: 2_000,
      status: "failed",
      startedAt: 1_500,
      endedAt: 1_900,
      runtimeMs: 400,
      runClosureSummary: {
        runId: "run-closure",
        requestRunId: "request-closure",
        parentRunId: "run-previous",
        sessionKey: "agent:main:main",
        updatedAtMs: 1_950,
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
    } as SessionEntry;

    const row = buildGatewaySessionRow({
      cfg,
      storePath: "/tmp/sessions.json",
      store: { "agent:main:main": entry },
      key: "agent:main:main",
      entry,
    });

    expect(row.status).toBe("blocked");
    expect(row.runClosureSummary).toEqual(
      expect.objectContaining({
        action: "retry",
        requestRunId: "request-closure",
        parentRunId: "run-previous",
        declaredIntent: "document",
        declaredRecipeId: "recipe.doc",
      }),
    );
  });

  test("listSessionsFromStore preserves run closure summaries for reload parity", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    const store = {
      "agent:main:main": {
        sessionId: "sess-closure",
        updatedAt: 2_000,
        status: "done",
        runClosureSummary: {
          runId: "run-closure",
          requestRunId: "request-closure",
          sessionKey: "agent:main:main",
          updatedAtMs: 1_950,
          outcomeStatus: "completed",
          verificationStatus: "verified",
          acceptanceStatus: "satisfied",
          action: "close",
          remediation: "none",
          reasonCode: "verified_execution",
          reasons: ["Execution contract was verified before final closure."],
          declaredIntent: "publish",
        },
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });
    const row = result.sessions.find((session) => session.key === "agent:main:main");

    expect(row?.status).toBe("done");
    expect(row?.runClosureSummary).toEqual(
      expect.objectContaining({
        action: "close",
        requestRunId: "request-closure",
        reasonCode: "verified_execution",
        declaredIntent: "publish",
      }),
    );
  });
});
