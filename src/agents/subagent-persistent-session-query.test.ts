import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
import { findLivePersistentSessionByLabel } from "./subagent-persistent-session-query.js";

const TG_ORIGIN: DeliveryContext = {
  channel: "telegram",
  accountId: "acc-1",
  to: "chat-1",
};

const OTHER_ORIGIN: DeliveryContext = {
  channel: "telegram",
  accountId: "acc-1",
  to: "chat-2",
};

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  const base: SessionEntry = {
    sessionId: "sess-id",
    updatedAt: 1_000,
    label: "Валера",
    deliveryContext: TG_ORIGIN,
    spawnedBy: "agent:main:main",
    subagentRole: "leaf",
  } as SessionEntry;
  return { ...base, ...overrides };
}

describe("findLivePersistentSessionByLabel", () => {
  it("matches a subagent entry with the requested label and origin", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:11111111-1111-1111-1111-111111111111": makeEntry(),
    };

    const match = findLivePersistentSessionByLabel({
      store,
      label: "Валера",
      requesterOrigin: TG_ORIGIN,
      targetAgentId: "main",
    });

    expect(match?.key).toBe("agent:main:subagent:11111111-1111-1111-1111-111111111111");
    expect(match?.entry.label).toBe("Валера");
  });

  it("matches even when entry.endedAt is set (G3 regression guard)", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:22222222-2222-2222-2222-222222222222": makeEntry({
        endedAt: 5_000,
        updatedAt: 5_000,
      }),
    };

    const match = findLivePersistentSessionByLabel({
      store,
      label: "Валера",
      requesterOrigin: TG_ORIGIN,
      targetAgentId: "main",
    });

    expect(match?.entry.endedAt).toBe(5_000);
  });

  it("trims whitespace before matching the label", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:33333333-3333-3333-3333-333333333333": makeEntry({
        label: "Валера",
      }),
    };

    const match = findLivePersistentSessionByLabel({
      store,
      label: "  Валера  ",
      requesterOrigin: TG_ORIGIN,
      targetAgentId: "main",
    });

    expect(match).toBeDefined();
  });

  it("returns undefined for empty label", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:44444444-4444-4444-4444-444444444444": makeEntry(),
    };

    const match = findLivePersistentSessionByLabel({
      store,
      label: "  ",
      requesterOrigin: TG_ORIGIN,
      targetAgentId: "main",
    });

    expect(match).toBeUndefined();
  });

  it("ignores non-subagent keys (main / group / global)", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main": makeEntry(),
      "agent:main:tg:group:chat-1": makeEntry(),
      global: makeEntry(),
      unknown: makeEntry(),
    };

    const match = findLivePersistentSessionByLabel({
      store,
      label: "Валера",
      requesterOrigin: TG_ORIGIN,
      targetAgentId: "main",
    });

    expect(match).toBeUndefined();
  });

  it("ignores entries from a different agent when targetAgentId is provided", () => {
    const store: Record<string, SessionEntry> = {
      "agent:other:subagent:55555555-5555-5555-5555-555555555555": makeEntry(),
    };

    const match = findLivePersistentSessionByLabel({
      store,
      label: "Валера",
      requesterOrigin: TG_ORIGIN,
      targetAgentId: "main",
    });

    expect(match).toBeUndefined();
  });

  it("matches across agents when targetAgentId is not provided", () => {
    const store: Record<string, SessionEntry> = {
      "agent:other:subagent:66666666-6666-6666-6666-666666666666": makeEntry(),
    };

    const match = findLivePersistentSessionByLabel({
      store,
      label: "Валера",
      requesterOrigin: TG_ORIGIN,
    });

    expect(match?.key).toBe("agent:other:subagent:66666666-6666-6666-6666-666666666666");
  });

  it("does not match when origin is different (different `to`)", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:77777777-7777-7777-7777-777777777777": makeEntry(),
    };

    const match = findLivePersistentSessionByLabel({
      store,
      label: "Валера",
      requesterOrigin: OTHER_ORIGIN,
      targetAgentId: "main",
    });

    expect(match).toBeUndefined();
  });

  it("does not match when label differs", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:88888888-8888-8888-8888-888888888888": makeEntry({
        label: "Петя",
      }),
    };

    const match = findLivePersistentSessionByLabel({
      store,
      label: "Валера",
      requesterOrigin: TG_ORIGIN,
      targetAgentId: "main",
    });

    expect(match).toBeUndefined();
  });

  it("returns the entry with the latest updatedAt when multiple match", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": makeEntry({
        updatedAt: 100,
      }),
      "agent:main:subagent:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb": makeEntry({
        updatedAt: 200,
      }),
      "agent:main:subagent:cccccccc-cccc-cccc-cccc-cccccccccccc": makeEntry({
        updatedAt: 50,
      }),
    };

    const match = findLivePersistentSessionByLabel({
      store,
      label: "Валера",
      requesterOrigin: TG_ORIGIN,
      targetAgentId: "main",
    });

    expect(match?.key).toBe("agent:main:subagent:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(match?.entry.updatedAt).toBe(200);
  });

  it("falls back to legacy lastChannel/lastTo origin fields", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:dddddddd-dddd-dddd-dddd-dddddddddddd": makeEntry({
        deliveryContext: undefined,
        lastChannel: "telegram",
        lastTo: "chat-1",
        lastAccountId: "acc-1",
      }),
    };

    const match = findLivePersistentSessionByLabel({
      store,
      label: "Валера",
      requesterOrigin: TG_ORIGIN,
      targetAgentId: "main",
    });

    expect(match).toBeDefined();
  });

  it("ignores entries without origin information", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee": makeEntry({
        deliveryContext: undefined,
        lastChannel: undefined,
        lastTo: undefined,
        lastAccountId: undefined,
        lastThreadId: undefined,
        origin: undefined,
      }),
    };

    const match = findLivePersistentSessionByLabel({
      store,
      label: "Валера",
      requesterOrigin: TG_ORIGIN,
      targetAgentId: "main",
    });

    expect(match).toBeUndefined();
  });
});
