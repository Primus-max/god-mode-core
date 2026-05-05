import { describe, expect, it } from "vitest";

import { asIdentityId } from "../identity/identity-id.js";

import {
  ArtifactCreatedPayloadSchema,
  EpisodicMemoryEventSchema,
  PersistentSessionCreatedPayloadSchema,
  ReminderSetPayloadSchema,
  SubagentCreatedPayloadSchema,
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
    expect(classify(sessionEvent)).toBe("session:user");
    expect(classify(subagentEvent)).toBe("subagent:s");
    expect(classify(reminderEvent)).toBe("reminder:r");
    expect(classify(artifactEvent)).toBe("artifact:a");
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
