import { describe, expect, it } from "vitest";

import { asIdentityId } from "../identity/identity-id.js";
import { asTaskId } from "../task/task-id.js";

import {
  ArtifactCreatedPayloadSchema,
  EpisodicMemoryEventSchema,
  PersistentSessionCreatedPayloadSchema,
  ReminderSetPayloadSchema,
  SubagentCreatedPayloadSchema,
  TaskCancelledPayloadSchema,
  TaskCompletedPayloadSchema,
  TaskCreatedPayloadSchema,
  TaskFailedPayloadSchema,
  assertNeverEpisodic,
  type EpisodicMemoryEvent,
} from "./episodic-memory-event.js";

const VLADIMIR = asIdentityId("identity:vladimir");

const VALID_ISO = "2026-05-05T12:34:56.000Z";

describe("EpisodicMemoryEventSchema — round-trip on payload-bearing variant", () => {
  it("accepts a well-formed persistent_session.created event", () => {
    const event: EpisodicMemoryEvent = {
      identityId: VLADIMIR,
      effectFamily: "persistent_session",
      effectId: "effect-001",
      payload: {
        messageRole: "user",
        messageText: "remember that my favourite colour is teal",
        messageId: "msg-42",
        occurredAt: VALID_ISO,
      },
    };
    const parsed = EpisodicMemoryEventSchema.parse(event);
    expect(parsed.effectFamily).toBe("persistent_session");
    expect(parsed.identityId).toBe(VLADIMIR);
    if (parsed.effectFamily === "persistent_session") {
      expect(parsed.payload.messageText).toBe(event.payload.messageText);
    }
  });

  it("accepts both message roles", () => {
    for (const role of ["user", "assistant"] as const) {
      const event: EpisodicMemoryEvent = {
        identityId: VLADIMIR,
        effectFamily: "persistent_session",
        effectId: "e",
        payload: { messageRole: role, messageText: "x", messageId: "m", occurredAt: VALID_ISO },
      };
      const parsed = EpisodicMemoryEventSchema.parse(event);
      if (parsed.effectFamily === "persistent_session") {
        expect(parsed.payload.messageRole).toBe(role);
      }
    }
  });
});

describe("EpisodicMemoryEventSchema — stub variants typed but parseable", () => {
  it("accepts a subagent.created stub event", () => {
    const event: EpisodicMemoryEvent = {
      identityId: VLADIMIR,
      effectFamily: "subagent",
      effectId: "subagent-effect",
      payload: { subagentId: "agent-1", displayName: "Researcher", occurredAt: VALID_ISO },
    };
    const parsed = EpisodicMemoryEventSchema.parse(event);
    expect(parsed.effectFamily).toBe("subagent");
  });

  it("accepts a reminder.set stub event", () => {
    const event: EpisodicMemoryEvent = {
      identityId: VLADIMIR,
      effectFamily: "reminder",
      effectId: "reminder-effect",
      payload: { reminderId: "r-1", fireAt: VALID_ISO, occurredAt: VALID_ISO },
    };
    const parsed = EpisodicMemoryEventSchema.parse(event);
    expect(parsed.effectFamily).toBe("reminder");
  });

  it("accepts an artifact.created stub event", () => {
    const event: EpisodicMemoryEvent = {
      identityId: VLADIMIR,
      effectFamily: "artifact",
      effectId: "artifact-effect",
      payload: { artifactId: "a-1", kind: "document", occurredAt: VALID_ISO },
    };
    const parsed = EpisodicMemoryEventSchema.parse(event);
    expect(parsed.effectFamily).toBe("artifact");
  });

  // Slice F Phase 2 — additive `task.*` variants. Typed-but-INERT until
  // slice F Phase 5 wires emit sites; these tests cover the schema shape
  // only. Existing 4 prior families above remain byte-identical.
  it("accepts a task.created stub event", () => {
    const event: EpisodicMemoryEvent = {
      identityId: VLADIMIR,
      effectFamily: "task",
      effectId: "task-effect-created",
      payload: {
        kind: "created",
        taskId: asTaskId("task:0001"),
        ownerIdentityId: VLADIMIR,
        label: "Draft retrospective",
        occurredAt: VALID_ISO,
      },
    };
    const parsed = EpisodicMemoryEventSchema.parse(event);
    expect(parsed.effectFamily).toBe("task");
    if (parsed.effectFamily === "task" && parsed.payload.kind === "created") {
      expect(parsed.payload.taskId).toBe("task:0001");
      expect(parsed.payload.label).toBe("Draft retrospective");
    }
  });

  it("accepts a task.completed stub event with optional result", () => {
    const event: EpisodicMemoryEvent = {
      identityId: VLADIMIR,
      effectFamily: "task",
      effectId: "task-effect-completed",
      payload: {
        kind: "completed",
        taskId: asTaskId("task:0001"),
        ownerIdentityId: VLADIMIR,
        result: "Posted retrospective to #eng-leads",
        occurredAt: VALID_ISO,
      },
    };
    const parsed = EpisodicMemoryEventSchema.parse(event);
    expect(parsed.effectFamily).toBe("task");
    if (parsed.effectFamily === "task" && parsed.payload.kind === "completed") {
      expect(parsed.payload.result).toBe("Posted retrospective to #eng-leads");
    }
  });

  it("accepts a task.cancelled stub event", () => {
    const event: EpisodicMemoryEvent = {
      identityId: VLADIMIR,
      effectFamily: "task",
      effectId: "task-effect-cancelled",
      payload: {
        kind: "cancelled",
        taskId: asTaskId("task:0001"),
        ownerIdentityId: VLADIMIR,
        occurredAt: VALID_ISO,
      },
    };
    const parsed = EpisodicMemoryEventSchema.parse(event);
    expect(parsed.effectFamily).toBe("task");
    if (parsed.effectFamily === "task" && parsed.payload.kind === "cancelled") {
      expect(parsed.payload.taskId).toBe("task:0001");
    }
  });

  it("accepts a task.failed stub event with optional result", () => {
    const event: EpisodicMemoryEvent = {
      identityId: VLADIMIR,
      effectFamily: "task",
      effectId: "task-effect-failed",
      payload: {
        kind: "failed",
        taskId: asTaskId("task:0001"),
        ownerIdentityId: VLADIMIR,
        result: "Upstream API timed out",
        occurredAt: VALID_ISO,
      },
    };
    const parsed = EpisodicMemoryEventSchema.parse(event);
    expect(parsed.effectFamily).toBe("task");
    if (parsed.effectFamily === "task" && parsed.payload.kind === "failed") {
      expect(parsed.payload.result).toBe("Upstream API timed out");
    }
  });

  it("rejects a task event with an unknown payload `kind` literal", () => {
    expect(() =>
      EpisodicMemoryEventSchema.parse({
        identityId: VLADIMIR,
        effectFamily: "task",
        effectId: "e",
        payload: {
          kind: "snoozed",
          taskId: asTaskId("task:0001"),
          ownerIdentityId: VLADIMIR,
          occurredAt: VALID_ISO,
        },
      }),
    ).toThrow();
  });

  it("rejects a task event with a malformed taskId (no `task:` prefix)", () => {
    expect(() =>
      EpisodicMemoryEventSchema.parse({
        identityId: VLADIMIR,
        effectFamily: "task",
        effectId: "e",
        payload: {
          kind: "created",
          taskId: "0001",
          ownerIdentityId: VLADIMIR,
          label: "x",
          occurredAt: VALID_ISO,
        },
      }),
    ).toThrow();
  });
});

describe("EpisodicMemoryEventSchema — negative cases", () => {
  it("rejects an unknown effectFamily", () => {
    const malformed = {
      identityId: VLADIMIR,
      effectFamily: "totally_made_up",
      effectId: "e",
      payload: { foo: 1 },
    };
    expect(() => EpisodicMemoryEventSchema.parse(malformed)).toThrow();
  });

  it("rejects a persistent_session event with a wrong-shape payload (missing messageId)", () => {
    const malformed = {
      identityId: VLADIMIR,
      effectFamily: "persistent_session",
      effectId: "e",
      payload: { messageRole: "user", messageText: "x", occurredAt: VALID_ISO },
    };
    expect(() => EpisodicMemoryEventSchema.parse(malformed)).toThrow();
  });

  it("rejects a persistent_session event with a malformed identityId", () => {
    const malformed = {
      identityId: "vladimir", // missing the `identity:` prefix
      effectFamily: "persistent_session",
      effectId: "e",
      payload: {
        messageRole: "user",
        messageText: "x",
        messageId: "m",
        occurredAt: VALID_ISO,
      },
    };
    expect(() => EpisodicMemoryEventSchema.parse(malformed)).toThrow();
  });

  it("rejects an event with an empty effectId", () => {
    const malformed = {
      identityId: VLADIMIR,
      effectFamily: "persistent_session",
      effectId: "",
      payload: {
        messageRole: "user",
        messageText: "x",
        messageId: "m",
        occurredAt: VALID_ISO,
      },
    };
    expect(() => EpisodicMemoryEventSchema.parse(malformed)).toThrow();
  });

  it("rejects an event with a non-ISO occurredAt string", () => {
    const malformed = {
      identityId: VLADIMIR,
      effectFamily: "persistent_session",
      effectId: "e",
      payload: {
        messageRole: "user",
        messageText: "x",
        messageId: "m",
        occurredAt: "yesterday",
      },
    };
    expect(() => EpisodicMemoryEventSchema.parse(malformed)).toThrow();
  });

  it("rejects an event with a wrong messageRole literal", () => {
    const malformed = {
      identityId: VLADIMIR,
      effectFamily: "persistent_session",
      effectId: "e",
      payload: {
        messageRole: "system",
        messageText: "x",
        messageId: "m",
        occurredAt: VALID_ISO,
      },
    };
    expect(() => EpisodicMemoryEventSchema.parse(malformed)).toThrow();
  });

  it("rejects a non-object input", () => {
    expect(() => EpisodicMemoryEventSchema.parse(null)).toThrow();
    expect(() => EpisodicMemoryEventSchema.parse(undefined)).toThrow();
    expect(() => EpisodicMemoryEventSchema.parse("string")).toThrow();
    expect(() => EpisodicMemoryEventSchema.parse(42)).toThrow();
  });
});

describe("Per-payload schemas — direct round-trip", () => {
  it("PersistentSessionCreatedPayloadSchema round-trips", () => {
    const payload = {
      messageRole: "assistant" as const,
      messageText: "ok",
      messageId: "m",
      occurredAt: VALID_ISO,
    };
    expect(PersistentSessionCreatedPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("SubagentCreatedPayloadSchema round-trips", () => {
    const payload = { subagentId: "s", displayName: "Sub", occurredAt: VALID_ISO };
    expect(SubagentCreatedPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("ReminderSetPayloadSchema round-trips", () => {
    const payload = { reminderId: "r", fireAt: VALID_ISO, occurredAt: VALID_ISO };
    expect(ReminderSetPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("ArtifactCreatedPayloadSchema round-trips", () => {
    const payload = { artifactId: "a", kind: "image", occurredAt: VALID_ISO };
    expect(ArtifactCreatedPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("each per-payload schema rejects a missing field", () => {
    expect(() => PersistentSessionCreatedPayloadSchema.parse({})).toThrow();
    expect(() => SubagentCreatedPayloadSchema.parse({ subagentId: "s" })).toThrow();
    expect(() =>
      ReminderSetPayloadSchema.parse({ reminderId: "r", fireAt: VALID_ISO }),
    ).toThrow();
    expect(() =>
      ArtifactCreatedPayloadSchema.parse({ artifactId: "a", kind: "image" }),
    ).toThrow();
  });

  // Slice F Phase 2 — task.* per-payload schemas (additive).
  it("TaskCreatedPayloadSchema round-trips", () => {
    const payload = {
      kind: "created" as const,
      taskId: "task:0001",
      ownerIdentityId: VLADIMIR,
      label: "Draft retrospective",
      occurredAt: VALID_ISO,
    };
    expect(TaskCreatedPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("TaskCompletedPayloadSchema round-trips with optional result", () => {
    const withResult = {
      kind: "completed" as const,
      taskId: "task:0001",
      ownerIdentityId: VLADIMIR,
      result: "done",
      occurredAt: VALID_ISO,
    };
    const withoutResult = {
      kind: "completed" as const,
      taskId: "task:0001",
      ownerIdentityId: VLADIMIR,
      occurredAt: VALID_ISO,
    };
    expect(TaskCompletedPayloadSchema.parse(withResult)).toEqual(withResult);
    expect(TaskCompletedPayloadSchema.parse(withoutResult)).toEqual(withoutResult);
  });

  it("TaskCancelledPayloadSchema round-trips", () => {
    const payload = {
      kind: "cancelled" as const,
      taskId: "task:0001",
      ownerIdentityId: VLADIMIR,
      occurredAt: VALID_ISO,
    };
    expect(TaskCancelledPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("TaskFailedPayloadSchema round-trips with optional result", () => {
    const payload = {
      kind: "failed" as const,
      taskId: "task:0001",
      ownerIdentityId: VLADIMIR,
      result: "upstream timeout",
      occurredAt: VALID_ISO,
    };
    expect(TaskFailedPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("each task.* per-payload schema rejects a missing required field", () => {
    expect(() =>
      TaskCreatedPayloadSchema.parse({
        kind: "created",
        taskId: asTaskId("task:0001"),
        ownerIdentityId: VLADIMIR,
        // label missing
        occurredAt: VALID_ISO,
      }),
    ).toThrow();
    expect(() =>
      TaskCompletedPayloadSchema.parse({
        kind: "completed",
        taskId: asTaskId("task:0001"),
        // ownerIdentityId missing
        occurredAt: VALID_ISO,
      }),
    ).toThrow();
    expect(() =>
      TaskCancelledPayloadSchema.parse({
        kind: "cancelled",
        // taskId missing
        ownerIdentityId: VLADIMIR,
        occurredAt: VALID_ISO,
      }),
    ).toThrow();
    expect(() =>
      TaskFailedPayloadSchema.parse({
        kind: "failed",
        taskId: asTaskId("task:0001"),
        ownerIdentityId: VLADIMIR,
        // occurredAt missing
      }),
    ).toThrow();
  });

  it("task.* schemas reject mismatched discriminator literals", () => {
    expect(() =>
      TaskCreatedPayloadSchema.parse({
        kind: "completed",
        taskId: asTaskId("task:0001"),
        ownerIdentityId: VLADIMIR,
        label: "x",
        occurredAt: VALID_ISO,
      }),
    ).toThrow();
  });
});

describe("EpisodicMemoryEvent — discriminated-union exhaustiveness compile-check", () => {
  // This test is mostly a runtime smoke; the real assertion is that a
  // switch over `event.effectFamily` MUST cover all four variants or
  // the call to `assertNeverEpisodic(event)` becomes a compile error.
  // If a future contributor adds a 5th variant without extending the
  // switch, the file fails to compile — which is the strongest signal
  // that we want.
  function classify(event: EpisodicMemoryEvent): string {
    switch (event.effectFamily) {
      case "persistent_session":
        return `session:${event.payload.messageRole}`;
      case "subagent":
        return `subagent:${event.payload.subagentId}`;
      case "reminder":
        return `reminder:${event.payload.reminderId}`;
      case "artifact":
        return `artifact:${event.payload.artifactId}`;
      case "task":
        return `task:${event.payload.kind}`;
      case "policy_approval":
        return `policy_approval:${event.payload.reason}`;
      case "policy_budget":
        return `policy_budget:${event.payload.reason}`;
      case "policy_role":
        return `policy_role:${event.payload.reason}`;
      case "policy_retry":
        return `policy_retry:${event.payload.reason}`;
      case "policy_escalation":
        return `policy_escalation:${event.payload.escalationId}`;
      default:
        return assertNeverEpisodic(event);
    }
  }

  it("classifier covers every variant of the discriminated union", () => {
    const sessionEvent: EpisodicMemoryEvent = {
      identityId: VLADIMIR,
      effectFamily: "persistent_session",
      effectId: "e",
      payload: { messageRole: "user", messageText: "x", messageId: "m", occurredAt: VALID_ISO },
    };
    const subagentEvent: EpisodicMemoryEvent = {
      identityId: VLADIMIR,
      effectFamily: "subagent",
      effectId: "e",
      payload: { subagentId: "s", displayName: "n", occurredAt: VALID_ISO },
    };
    const reminderEvent: EpisodicMemoryEvent = {
      identityId: VLADIMIR,
      effectFamily: "reminder",
      effectId: "e",
      payload: { reminderId: "r", fireAt: VALID_ISO, occurredAt: VALID_ISO },
    };
    const artifactEvent: EpisodicMemoryEvent = {
      identityId: VLADIMIR,
      effectFamily: "artifact",
      effectId: "e",
      payload: { artifactId: "a", kind: "image", occurredAt: VALID_ISO },
    };
    const taskEvent: EpisodicMemoryEvent = {
      identityId: VLADIMIR,
      effectFamily: "task",
      effectId: "e",
      payload: {
        kind: "created",
        taskId: asTaskId("task:0001"),
        ownerIdentityId: VLADIMIR,
        label: "x",
        occurredAt: VALID_ISO,
      },
    };
    expect(classify(sessionEvent)).toBe("session:user");
    expect(classify(subagentEvent)).toBe("subagent:s");
    expect(classify(reminderEvent)).toBe("reminder:r");
    expect(classify(artifactEvent)).toBe("artifact:a");
    expect(classify(taskEvent)).toBe("task:created");
  });

  it("assertNeverEpisodic throws at runtime when fed an impossible value (defensive)", () => {
    // Cast through `unknown` because a `never` parameter cannot be
    // constructed legitimately — this is the runtime-only fallback
    // in case e.g. JSON deserialisation produces an out-of-band variant
    // that the compiler couldn't have caught.
    const bogus = { effectFamily: "totally_made_up" } as unknown as never;
    expect(() => assertNeverEpisodic(bogus)).toThrow();
  });
});
