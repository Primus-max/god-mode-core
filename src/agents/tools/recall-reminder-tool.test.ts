/**
 * Slice K Phase 4 — fail-first tests for `RecallReminderTool`.
 *
 * Covers the per-family summary reducer × 4 LIT families (artifact,
 * repo, task, persistent_session), date-window filter, cross-family
 * union, anonymous fail-closed (ZERO MemoryStore calls — sub-plan
 * acceptance #8), free-form `query: string` rejection (invariants
 * #5/#6 reverse — sub-plan acceptance #4), identity isolation
 * reverse-test, empty-result-satisfies, partial-result tolerance, and
 * newest-first sort + limit.
 *
 * Tests use a real `InMemoryMemoryStore` (slice E Phase 2) — no
 * `vi.spyOn` on the function under test or its private dependency.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createReminderWorldStateCollector,
  type ReminderTurnKey,
  type ReminderWorldStateCollector,
} from "../../platform/commitment/reminder-world-state-observer.js";
import type { SessionId } from "../../platform/commitment/ids.js";
import { asIdentityId, type IdentityId } from "../../platform/identity/identity-id.js";
import { InMemoryMemoryStore } from "../../platform/memory/in-memory-store.js";
import type { MemoryStore } from "../../platform/memory/memory-store.js";
import type { ReminderQueryShape } from "../../platform/reminder/index.js";
import { asTaskId } from "../../platform/task/task-id.js";

import { recallReminderTool } from "./recall-reminder-tool.js";

const SESSION_A = "session:a" as SessionId;
const IDENTITY_A: IdentityId = asIdentityId("identity:operator-a");
const IDENTITY_B: IdentityId = asIdentityId("identity:operator-b");

function turnKey(sessionId: SessionId, turnId: string): ReminderTurnKey {
  return { sessionId, turnId };
}

async function seedArtifact(
  store: InMemoryMemoryStore,
  identityId: IdentityId,
  kind: string,
  occurredAt: string,
  artifactId: string = `art-${kind}-${occurredAt}`,
) {
  return store.storeEpisodic({
    identityId,
    effectFamily: "artifact",
    effectId: "artifact.created",
    payload: { artifactId, kind, occurredAt },
  });
}

async function seedRepo(
  store: InMemoryMemoryStore,
  identityId: IdentityId,
  kind: "branch_created" | "commit_landed" | "merge_completed" | "diff_observed",
  occurredAt: string,
  branchName?: string,
  commitSha?: string,
) {
  return store.storeEpisodic({
    identityId,
    effectFamily: "repo",
    effectId: "repo.commit_landed",
    payload: {
      repoOperationId: `repo-${kind}-${occurredAt}`,
      kind,
      ...(branchName ? { branchName } : {}),
      ...(commitSha ? { commitSha } : {}),
      occurredAt,
    },
  });
}

async function seedTaskCreated(
  store: InMemoryMemoryStore,
  identityId: IdentityId,
  taskSlug: string,
  label: string,
  occurredAt: string,
) {
  return store.storeEpisodic({
    identityId,
    effectFamily: "task",
    effectId: "task.created",
    payload: {
      kind: "created",
      taskId: asTaskId(`task:${taskSlug}`),
      ownerIdentityId: identityId,
      label,
      occurredAt,
    },
  });
}

async function seedPersistentSession(
  store: InMemoryMemoryStore,
  identityId: IdentityId,
  text: string,
  occurredAt: string,
  messageId: string = `msg-${occurredAt}`,
) {
  return store.storeEpisodic({
    identityId,
    effectFamily: "persistent_session",
    effectId: "persistent_session.created",
    payload: {
      messageRole: "user",
      messageText: text,
      messageId,
      occurredAt,
    },
  });
}

describe("recallReminderTool — per-family summary reducer", () => {
  it("artifact family — summary formatted as `<KIND>: <kind>` and includes the occurredAt", async () => {
    const store = new InMemoryMemoryStore();
    await seedArtifact(store, IDENTITY_A, "pdf", "2026-05-04T10:00:00.000Z");

    const collector = createReminderWorldStateCollector();
    const r = await recallReminderTool({
      query: {
        ownerIdentityId: IDENTITY_A,
        effectFamilyFilter: ["artifact"],
      } as ReminderQueryShape,
      memoryStore: store,
      collector,
      sessionId: SESSION_A,
      turnId: "turn-1",
    });

    expect(r.entries).toHaveLength(1);
    const entry = r.entries[0]!;
    expect(entry.effectFamily).toBe("artifact");
    expect(entry.summary).toContain("PDF");
    expect(entry.occurredAt).toBe("2026-05-04T10:00:00.000Z");
  });

  it("repo family — summary names branch / commit short-sha", async () => {
    const store = new InMemoryMemoryStore();
    await seedRepo(
      store,
      IDENTITY_A,
      "branch_created",
      "2026-05-04T10:00:00.000Z",
      "feature/x",
    );
    await seedRepo(
      store,
      IDENTITY_A,
      "commit_landed",
      "2026-05-05T10:00:00.000Z",
      "feature/x",
      "abcdef1234567890abcdef1234567890abcdef12",
    );

    const collector = createReminderWorldStateCollector();
    const r = await recallReminderTool({
      query: {
        ownerIdentityId: IDENTITY_A,
        effectFamilyFilter: ["repo"],
      } as ReminderQueryShape,
      memoryStore: store,
      collector,
      sessionId: SESSION_A,
      turnId: "turn-1",
    });

    expect(r.entries).toHaveLength(2);
    const summaries = r.entries.map((e) => e.summary);
    expect(summaries.some((s) => s.includes("Branch feature/x"))).toBe(true);
    expect(summaries.some((s) => s.includes("Commit abcdef1"))).toBe(true);
  });

  it("task family — summary formatted as `<label> [<status>]`", async () => {
    const store = new InMemoryMemoryStore();
    await seedTaskCreated(
      store,
      IDENTITY_A,
      "ship-feature-x",
      "Ship feature X",
      "2026-05-04T10:00:00.000Z",
    );

    const collector = createReminderWorldStateCollector();
    const r = await recallReminderTool({
      query: {
        ownerIdentityId: IDENTITY_A,
        effectFamilyFilter: ["task"],
      } as ReminderQueryShape,
      memoryStore: store,
      collector,
      sessionId: SESSION_A,
      turnId: "turn-1",
    });

    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.summary).toContain("Ship feature X");
    expect(r.entries[0]!.summary).toContain("[created]");
  });

  it("persistent_session family — summary truncates the message text and tags the role", async () => {
    const store = new InMemoryMemoryStore();
    await seedPersistentSession(
      store,
      IDENTITY_A,
      "hello world this is a much longer operator-side message that should be truncated by the reducer to fit within the 120-char operator-facing summary cap.",
      "2026-05-04T10:00:00.000Z",
    );

    const collector = createReminderWorldStateCollector();
    const r = await recallReminderTool({
      query: {
        ownerIdentityId: IDENTITY_A,
        effectFamilyFilter: ["persistent_session"],
      } as ReminderQueryShape,
      memoryStore: store,
      collector,
      sessionId: SESSION_A,
      turnId: "turn-1",
    });

    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.summary.startsWith("[user]")).toBe(true);
    expect(r.entries[0]!.summary.length).toBeLessThanOrEqual(120);
  });
});

describe("recallReminderTool — recallWindow filter", () => {
  it("includes only entries whose occurredAt falls inside [from, until]", async () => {
    const store = new InMemoryMemoryStore();
    await seedArtifact(store, IDENTITY_A, "pdf", "2026-04-30T10:00:00.000Z", "art-old");
    await seedArtifact(store, IDENTITY_A, "pdf", "2026-05-04T10:00:00.000Z", "art-mid");
    await seedArtifact(store, IDENTITY_A, "pdf", "2026-05-09T10:00:00.000Z", "art-new");

    const collector = createReminderWorldStateCollector();
    const r = await recallReminderTool({
      query: {
        ownerIdentityId: IDENTITY_A,
        effectFamilyFilter: ["artifact"],
        recallWindow: {
          from: "2026-05-01T00:00:00.000Z",
          until: "2026-05-08T00:00:00.000Z",
        },
      } as ReminderQueryShape,
      memoryStore: store,
      collector,
      sessionId: SESSION_A,
      turnId: "turn-1",
    });

    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.occurredAt).toBe("2026-05-04T10:00:00.000Z");
  });

  it("rejects malformed `from` / `until` via the Zod schema (no MemoryStore calls)", async () => {
    const store = new InMemoryMemoryStore();
    const listSpy = vi.spyOn(store, "list");

    const r = await recallReminderTool({
      query: {
        ownerIdentityId: IDENTITY_A,
        recallWindow: { from: "not-a-date", until: "also-bad" },
      } as ReminderQueryShape,
      memoryStore: store,
      collector: createReminderWorldStateCollector(),
      sessionId: SESSION_A,
      turnId: "turn-1",
    });

    expect(r.entries).toEqual([]);
    expect(r.unmatched).toContain("identity_unavailable");
    expect(listSpy).not.toHaveBeenCalled();
  });
});

describe("recallReminderTool — cross-family union (default filter)", () => {
  it("default filter unions persistent_session + task + artifact + repo (policy_* / subagent / reminder excluded)", async () => {
    const store = new InMemoryMemoryStore();
    await seedArtifact(store, IDENTITY_A, "pdf", "2026-05-04T10:00:00.000Z");
    await seedRepo(store, IDENTITY_A, "branch_created", "2026-05-04T11:00:00.000Z", "feature/x");
    await seedTaskCreated(store, IDENTITY_A, "task-a", "Task A", "2026-05-04T12:00:00.000Z");
    await seedPersistentSession(store, IDENTITY_A, "hello", "2026-05-04T13:00:00.000Z");

    const collector = createReminderWorldStateCollector();
    const r = await recallReminderTool({
      query: { ownerIdentityId: IDENTITY_A } as ReminderQueryShape,
      memoryStore: store,
      collector,
      sessionId: SESSION_A,
      turnId: "turn-1",
    });

    const families = new Set(r.entries.map((e) => e.effectFamily));
    expect(families.has("artifact")).toBe(true);
    expect(families.has("repo")).toBe(true);
    expect(families.has("task")).toBe(true);
    expect(families.has("persistent_session")).toBe(true);
  });
});

describe("recallReminderTool — anonymous fail-closed", () => {
  it("anonymous (empty ownerIdentityId) returns identity_unavailable AND issues ZERO MemoryStore calls (acceptance #8)", async () => {
    const store = new InMemoryMemoryStore();
    const listSpy = vi.spyOn(store, "list");
    const recallSpy = vi.spyOn(store, "recall");

    const r = await recallReminderTool({
      query: {
        ownerIdentityId: "" as unknown as IdentityId,
      } as ReminderQueryShape,
      memoryStore: store,
      collector: createReminderWorldStateCollector(),
      sessionId: SESSION_A,
      turnId: "turn-1",
    });

    expect(r.entries).toEqual([]);
    expect(r.unmatched).toContain("identity_unavailable");
    expect(listSpy).not.toHaveBeenCalled();
    expect(recallSpy).not.toHaveBeenCalled();
  });
});

describe("recallReminderTool — invariants #5/#6 reverse (free-form rejection)", () => {
  it("rejects a top-level free-form `query: string` field at the OUTER tool boundary (acceptance #4)", async () => {
    const store = new InMemoryMemoryStore();
    const listSpy = vi.spyOn(store, "list");

    const r = await recallReminderTool({
      // The closed schema accepts a structured `query` object; passing
      // a free-form string here is the invariant #5/#6 reverse case.
      query: "какой PDF я делал на прошлой неделе?" as unknown as ReminderQueryShape,
      memoryStore: store,
      collector: createReminderWorldStateCollector(),
      sessionId: SESSION_A,
      turnId: "turn-1",
    });

    expect(r.entries).toEqual([]);
    expect(r.unmatched).toContain("identity_unavailable");
    expect(listSpy).not.toHaveBeenCalled();
  });
});

describe("recallReminderTool — identity isolation", () => {
  it("operator A NEVER sees operator B's entries (acceptance #6 reverse-test)", async () => {
    const store = new InMemoryMemoryStore();
    await seedArtifact(store, IDENTITY_A, "pdf", "2026-05-04T10:00:00.000Z", "art-A");
    await seedArtifact(store, IDENTITY_B, "pdf", "2026-05-04T11:00:00.000Z", "art-B");

    const collector = createReminderWorldStateCollector();
    const r = await recallReminderTool({
      query: {
        ownerIdentityId: IDENTITY_A,
        effectFamilyFilter: ["artifact"],
      } as ReminderQueryShape,
      memoryStore: store,
      collector,
      sessionId: SESSION_A,
      turnId: "turn-1",
    });

    expect(r.entries).toHaveLength(1);
    // Operator A only sees their own row — defense in depth: the
    // memory store keys on identityId, AND the tool passes identityId
    // through unchanged.
    expect(r.entries[0]!.payloadRef.effectId).toBe("artifact.created");
  });
});

describe("recallReminderTool — empty-result satisfies", () => {
  it("zero entries IS success — emits recordReminderQueried with resultCount=0", async () => {
    const store = new InMemoryMemoryStore();
    // No seeded entries.

    const collector = createReminderWorldStateCollector();
    const r = await recallReminderTool({
      query: {
        ownerIdentityId: IDENTITY_A,
        effectFamilyFilter: ["artifact"],
      } as ReminderQueryShape,
      memoryStore: store,
      collector,
      sessionId: SESSION_A,
      turnId: "turn-1",
    });

    expect(r.entries).toEqual([]);
    // The runtime adapter emits even on the empty case — observer slice
    // populates so the predicate satisfies.
    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    const last = collector.getActiveLastQuery();
    expect(last).toBeDefined();
    expect(last?.resultCount).toBe(0);
  });
});

describe("recallReminderTool — partial-result tolerance", () => {
  it("per-family read failure surfaces `family_unavailable` while other families still contribute entries", async () => {
    const store = new InMemoryMemoryStore();
    await seedArtifact(store, IDENTITY_A, "pdf", "2026-05-04T10:00:00.000Z");
    await seedTaskCreated(store, IDENTITY_A, "task-a", "Task A", "2026-05-04T12:00:00.000Z");

    // Wrap real store; reject only the `repo` family list.
    const flaky: MemoryStore = {
      storeEpisodic: store.storeEpisodic.bind(store),
      storeSemantic: store.storeSemantic.bind(store),
      recall: store.recall.bind(store),
      forget: store.forget.bind(store),
      list: async (q) => {
        if (q.effectFamily === "repo") {
          throw new Error("repo backend transient failure");
        }
        return store.list(q);
      },
    };

    const collector = createReminderWorldStateCollector();
    const r = await recallReminderTool({
      query: {
        ownerIdentityId: IDENTITY_A,
        effectFamilyFilter: ["artifact", "repo", "task"],
      } as ReminderQueryShape,
      memoryStore: flaky,
      collector,
      sessionId: SESSION_A,
      turnId: "turn-1",
    });

    expect(r.unmatched).toContain("family_unavailable");
    expect(r.entries.length).toBeGreaterThanOrEqual(2);
    expect(r.entries.some((e) => e.effectFamily === "artifact")).toBe(true);
    expect(r.entries.some((e) => e.effectFamily === "task")).toBe(true);
  });

  it("policy_* families are excluded from the default filter — operator does not see policy_* slots", async () => {
    const store = new InMemoryMemoryStore();
    const listSpy = vi.spyOn(store, "list");

    await recallReminderTool({
      query: { ownerIdentityId: IDENTITY_A } as ReminderQueryShape,
      memoryStore: store,
      collector: createReminderWorldStateCollector(),
      sessionId: SESSION_A,
      turnId: "turn-1",
    });

    const families = listSpy.mock.calls.map((c) => c[0].effectFamily);
    expect(families).not.toContain("policy_approval");
    expect(families).not.toContain("policy_budget");
    expect(families).not.toContain("policy_role");
    expect(families).not.toContain("policy_retry");
    expect(families).not.toContain("policy_escalation");
    expect(families).not.toContain("subagent");
    expect(families).not.toContain("reminder");
  });
});

describe("recallReminderTool — sort + limit", () => {
  it("entries are sorted newest-first across families", async () => {
    const store = new InMemoryMemoryStore();
    await seedArtifact(store, IDENTITY_A, "pdf", "2026-05-01T10:00:00.000Z", "art-old");
    await seedRepo(store, IDENTITY_A, "branch_created", "2026-05-04T10:00:00.000Z", "feature/x");
    await seedTaskCreated(store, IDENTITY_A, "task-a", "Task A", "2026-05-03T10:00:00.000Z");

    const collector = createReminderWorldStateCollector();
    const r = await recallReminderTool({
      query: { ownerIdentityId: IDENTITY_A } as ReminderQueryShape,
      memoryStore: store,
      collector,
      sessionId: SESSION_A,
      turnId: "turn-1",
    });

    const occurredAts = r.entries.map((e) => e.occurredAt);
    const sorted = [...occurredAts].sort().reverse();
    expect(occurredAts).toEqual(sorted);
  });

  it("limit caps the overall returned entries (defaults retain all when below cap)", async () => {
    const store = new InMemoryMemoryStore();
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await seedArtifact(
        store,
        IDENTITY_A,
        "pdf",
        `2026-05-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
        `art-${i}`,
      );
    }

    const collector = createReminderWorldStateCollector();
    const r = await recallReminderTool({
      query: {
        ownerIdentityId: IDENTITY_A,
        effectFamilyFilter: ["artifact"],
        limit: 3,
      } as ReminderQueryShape,
      memoryStore: store,
      collector,
      sessionId: SESSION_A,
      turnId: "turn-1",
    });

    expect(r.entries).toHaveLength(3);
  });
});

describe("recallReminderTool — defensive failures", () => {
  it("memoryStore undefined returns memory_store_unavailable + ZERO calls (production-wiring bug surface)", async () => {
    const collector = createReminderWorldStateCollector();
    const r = await recallReminderTool({
      query: { ownerIdentityId: IDENTITY_A } as ReminderQueryShape,
      memoryStore: undefined,
      collector,
      sessionId: SESSION_A,
      turnId: "turn-1",
    });

    expect(r.entries).toEqual([]);
    expect(r.unmatched).toContain("memory_store_unavailable");
  });

  it("collector undefined still computes entries but surfaces family_unavailable so the predicate cannot satisfy without observer wiring", async () => {
    const store = new InMemoryMemoryStore();
    await seedArtifact(store, IDENTITY_A, "pdf", "2026-05-04T10:00:00.000Z");

    const r = await recallReminderTool({
      query: {
        ownerIdentityId: IDENTITY_A,
        effectFamilyFilter: ["artifact"],
      } as ReminderQueryShape,
      memoryStore: store,
      collector: undefined,
      sessionId: SESSION_A,
      turnId: "turn-1",
    });

    expect(r.entries).toHaveLength(1);
    expect(r.unmatched).toContain("family_unavailable");
  });
});
