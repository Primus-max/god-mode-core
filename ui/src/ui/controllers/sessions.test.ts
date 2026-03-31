import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySessionsChangedEvent,
  deleteSessionsAndRefresh,
  subscribeSessions,
  type SessionsState,
} from "./sessions.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

if (!("window" in globalThis)) {
  Object.assign(globalThis, {
    window: {
      confirm: () => false,
    },
  });
}

function createState(request: RequestFn, overrides: Partial<SessionsState> = {}): SessionsState {
  return {
    client: { request } as unknown as SessionsState["client"],
    connected: true,
    sessionsLoading: false,
    sessionsResult: null,
    sessionsError: null,
    sessionsFilterActive: "0",
    sessionsFilterLimit: "0",
    sessionsIncludeGlobal: true,
    sessionsIncludeUnknown: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("subscribeSessions", () => {
  it("registers for session change events", async () => {
    const request = vi.fn(async () => ({ subscribed: true }));
    const state = createState(request);

    await subscribeSessions(state);

    expect(request).toHaveBeenCalledWith("sessions.subscribe", {});
    expect(state.sessionsError).toBeNull();
  });
});

describe("deleteSessionsAndRefresh", () => {
  it("deletes multiple sessions and refreshes", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.delete") {
        return { ok: true };
      }
      if (method === "sessions.list") {
        return undefined;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const deleted = await deleteSessionsAndRefresh(state, ["key-a", "key-b"]);

    expect(deleted).toEqual(["key-a", "key-b"]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(1, "sessions.delete", {
      key: "key-a",
      deleteTranscript: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.delete", {
      key: "key-b",
      deleteTranscript: true,
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
    });
    expect(state.sessionsLoading).toBe(false);
  });

  it("returns empty array when user cancels", async () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request);
    vi.spyOn(window, "confirm").mockReturnValue(false);

    const deleted = await deleteSessionsAndRefresh(state, ["key-a"]);

    expect(deleted).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("returns partial results when some deletes fail", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.delete") {
        const p = params as { key: string };
        if (p.key === "key-b" || p.key === "key-c") {
          throw new Error(`delete failed: ${p.key}`);
        }
        return { ok: true };
      }
      if (method === "sessions.list") {
        return undefined;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const deleted = await deleteSessionsAndRefresh(state, ["key-a", "key-b", "key-c", "key-d"]);

    expect(deleted).toEqual(["key-a", "key-d"]);
    expect(state.sessionsError).toBe("Error: delete failed: key-b; Error: delete failed: key-c");
    expect(state.sessionsLoading).toBe(false);
  });

  it("returns empty array when already loading", async () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request, { sessionsLoading: true });

    const deleted = await deleteSessionsAndRefresh(state, ["key-a"]);

    expect(deleted).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("applySessionsChangedEvent", () => {
  it("patches an existing row from the flat sessions.changed snapshot", () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request, {
      sessionsResult: {
        ts: 1,
        path: "sessions.json",
        count: 1,
        defaults: { model: null, modelProvider: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:main",
            kind: "direct",
            updatedAt: 10,
            status: "running",
            totalTokens: 100,
          },
        ],
      },
    });

    const result = applySessionsChangedEvent(state, {
      sessionKey: "agent:main:main",
      reason: "patch",
      kind: "direct",
      updatedAt: 20,
      status: "blocked",
      totalTokens: 250,
      handoffTruthSource: "recovery",
      recoveryStatus: "approved",
    });

    expect(result).toEqual({ applied: true, shouldReload: false });
    expect(state.sessionsResult?.sessions[0]).toMatchObject({
      key: "agent:main:main",
      kind: "direct",
      updatedAt: 20,
      status: "blocked",
      totalTokens: 250,
      handoffTruthSource: "recovery",
      recoveryStatus: "approved",
    });
  });

  it("falls back to nested session for backward compatibility", () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request, {
      sessionsResult: {
        ts: 1,
        path: "sessions.json",
        count: 1,
        defaults: { model: null, modelProvider: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:main",
            kind: "direct",
            updatedAt: 10,
          },
        ],
      },
    });

    const result = applySessionsChangedEvent(state, {
      sessionKey: "agent:main:main",
      reason: "patch",
      session: {
        key: "agent:main:main",
        kind: "direct",
        updatedAt: 30,
        handoffRequestRunId: "request-2",
        handoffRunId: "run-2",
        handoffTruthSource: "recovery",
      },
    });

    expect(result).toEqual({ applied: true, shouldReload: false });
    expect(state.sessionsResult?.sessions[0]).toMatchObject({
      updatedAt: 30,
      handoffRequestRunId: "request-2",
      handoffRunId: "run-2",
      handoffTruthSource: "recovery",
    });
  });

  it("treats omitted optional fields as cleared in authoritative snapshots", () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request, {
      sessionsResult: {
        ts: 1,
        path: "sessions.json",
        count: 1,
        defaults: { model: null, modelProvider: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:main",
            kind: "direct",
            updatedAt: 10,
            runClosureSummary: {
              runId: "run-1",
              updatedAtMs: 10,
              outcomeStatus: "completed",
              verificationStatus: "verified",
              acceptanceStatus: "satisfied",
              action: "close",
              remediation: "none",
              reasonCode: "completed_with_output",
              reasons: ["ok"],
            },
            handoffTruthSource: "recovery",
            handoffRunId: "run-1",
            recoveryStatus: "blocked",
          },
        ],
      },
    });

    const result = applySessionsChangedEvent(state, {
      sessionKey: "agent:main:main",
      reason: "patch",
      kind: "direct",
      updatedAt: 40,
      status: "done",
    });

    expect(result).toEqual({ applied: true, shouldReload: false });
    expect(state.sessionsResult?.sessions[0]).toMatchObject({
      updatedAt: 40,
      status: "done",
    });
    expect(state.sessionsResult?.sessions[0]?.runClosureSummary).toBeUndefined();
    expect(state.sessionsResult?.sessions[0]?.handoffTruthSource).toBeUndefined();
    expect(state.sessionsResult?.sessions[0]?.handoffRunId).toBeUndefined();
    expect(state.sessionsResult?.sessions[0]?.recoveryStatus).toBeUndefined();
  });

  it("requests a reload for create/delete style events", () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request);

    expect(
      applySessionsChangedEvent(state, {
        sessionKey: "agent:main:main",
        reason: "create",
        kind: "direct",
        updatedAt: 10,
      }),
    ).toEqual({ applied: false, shouldReload: true });
  });
});
