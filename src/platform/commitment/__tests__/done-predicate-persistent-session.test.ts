import { describe, expect, it } from "vitest";
import type { DonePredicateCtx } from "../affordance.js";
import { persistentSessionCreatedPredicate } from "../done-predicate-persistent-session.js";
import type { AgentId, ISO8601, SessionId, SessionKey } from "../ids.js";
import type { SessionRecord } from "../world-state.js";

function sessionRecord(params: {
  sessionId: string;
  agentId: string;
  parentSessionKey?: string;
  createdAt?: string;
}): SessionRecord {
  return {
    sessionId: params.sessionId as SessionId,
    agentId: params.agentId as AgentId,
    parentSessionKey: (params.parentSessionKey ?? "agent:main:main") as SessionKey,
    status: "active",
    createdAt: (params.createdAt ?? "2026-04-27T08:00:00.000Z") as ISO8601,
  };
}

function ctx(overrides: Partial<DonePredicateCtx>): DonePredicateCtx {
  return {
    stateBefore: {},
    stateAfter: {},
    expectedDelta: {},
    receipts: {
      entries: [],
    },
    trace: {
      steps: [],
    },
    ...overrides,
  };
}

describe("persistentSessionCreatedPredicate", () => {
  it("accepts expected added sessions when state-after contains matching records", () => {
    const result = persistentSessionCreatedPredicate(
      ctx({
        stateAfter: {
          sessions: {
            followupRegistry: [
              sessionRecord({ sessionId: "agent:worker:main", agentId: "worker" }),
            ],
          },
        },
        expectedDelta: {
          sessions: {
            followupRegistry: {
              added: [{ sessionId: "agent:worker:main" as SessionId, agentId: "worker" as AgentId }],
            },
          },
        },
      }),
    );

    expect(result).toEqual({
      satisfied: true,
      evidence: [
        {
          kind: "session_record.created",
          value: {
            sessionId: "agent:worker:main",
            agentId: "worker",
            observedAt: "2026-04-27T08:00:00.000Z",
          },
        },
      ],
    });
  });

  it("rejects when the expected session record is missing in state-after", () => {
    expect(
      persistentSessionCreatedPredicate(
        ctx({
          stateAfter: {
            sessions: {
              followupRegistry: [],
            },
          },
          expectedDelta: {
            sessions: {
              followupRegistry: {
                added: [
                  { sessionId: "agent:missing:main" as SessionId, agentId: "missing" as AgentId },
                ],
              },
            },
          },
        }),
      ),
    ).toEqual({
      satisfied: false,
      missing: ["session_record_missing:agent:missing:main"],
    });
  });

  it("rejects partial matches when any expected session is absent", () => {
    expect(
      persistentSessionCreatedPredicate(
        ctx({
          stateAfter: {
            sessions: {
              followupRegistry: [
                sessionRecord({ sessionId: "agent:present:main", agentId: "present" }),
              ],
            },
          },
          expectedDelta: {
            sessions: {
              followupRegistry: {
                added: [
                  { sessionId: "agent:present:main" as SessionId, agentId: "present" as AgentId },
                  { sessionId: "agent:missing:main" as SessionId, agentId: "missing" as AgentId },
                ],
              },
            },
          },
        }),
      ),
    ).toEqual({
      satisfied: false,
      missing: ["session_record_missing:agent:missing:main"],
    });
  });

  it("rejects empty expected added deltas", () => {
    expect(
      persistentSessionCreatedPredicate(
        ctx({
          expectedDelta: {
            sessions: {
              followupRegistry: {
                added: [],
              },
            },
          },
        }),
      ),
    ).toEqual({
      satisfied: false,
      missing: ["expected_delta_empty"],
    });
  });

  it("ignores hostile receipts and only trusts observed state-after", () => {
    expect(
      persistentSessionCreatedPredicate(
        ctx({
          stateAfter: {
            sessions: {
              followupRegistry: [],
            },
          },
          expectedDelta: {
            sessions: {
              followupRegistry: {
                added: [
                  { sessionId: "agent:receipt:main" as SessionId, agentId: "receipt" as AgentId },
                ],
              },
            },
          },
          receipts: {
            entries: [
              {
                kind: "session_record.created",
                payload: {
                  sessionId: "agent:receipt:main",
                  agentId: "receipt",
                },
              },
            ],
          },
        }),
      ),
    ).toEqual({
      satisfied: false,
      missing: ["session_record_missing:agent:receipt:main"],
    });
  });
});
