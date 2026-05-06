import { describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "../../../config/config.js";
import { asIdentityId } from "../../identity/identity-id.js";
import { asMemoryEntryId } from "../../memory/memory-entry-id.js";
import type {
  EpisodicMemoryEvent,
  MemoryListQuery,
  MemoryListResult,
  MemoryRecallResult,
  MemoryStore,
  SemanticMemoryEntry,
  SemanticMemoryQuery,
  SemanticMemoryWrite,
} from "../../memory/index.js";
import { asTaskId } from "../../task/task-id.js";
import type { TaskLedger, TaskNotFound } from "../../task/task-ledger.js";
import type {
  TaskCreateInput,
  TaskListQuery,
  TaskListResult,
  TaskRecord,
  TaskStatus,
  TaskUpdatePatch,
} from "../../task/task-record.js";
import {
  COMMUNICATION_EFFECT_FAMILY,
  TASK_RECALL_FAILED_UNCERTAINTY,
  createIntentContractor,
  type IntentContractorAdapter,
} from "../index.js";

const RAW_PROMPT = "какие у меня сейчас задачи?";

type CapturedAdapterCall = {
  prompt: string;
};

function makeCapturingAdapter(captures: CapturedAdapterCall[]): IntentContractorAdapter {
  return {
    classify: async (params) => {
      captures.push({ prompt: params.prompt });
      return {
        desiredEffectFamily: COMMUNICATION_EFFECT_FAMILY,
        target: { kind: "external_channel" },
        operation: { kind: "create" },
        constraints: {},
        uncertainty: [],
        confidence: 0.85,
      };
    },
  };
}

function makeTask(params: {
  readonly idSlug: string;
  readonly label: string;
  readonly status: TaskStatus;
  readonly createdAt: string;
}): TaskRecord {
  return {
    id: asTaskId(`task:${params.idSlug}`),
    ownerIdentityId: asIdentityId("identity:vladimir"),
    label: params.label,
    status: params.status,
    summary: `summary-${params.idSlug}`,
    createdAt: params.createdAt,
    updatedAt: params.createdAt,
  };
}

function listingTaskLedger(
  tasks: readonly TaskRecord[],
  listSpy?: (query: TaskListQuery) => void,
): TaskLedger {
  return {
    async create(_input: TaskCreateInput): Promise<TaskRecord> {
      throw new Error("create not used in these tests");
    },
    async list(query: TaskListQuery): Promise<TaskListResult> {
      listSpy?.(query);
      return { tasks };
    },
    async get(): Promise<TaskRecord | undefined> {
      throw new Error("get not used in these tests");
    },
    async update(): Promise<TaskRecord | TaskNotFound> {
      throw new Error("update not used in these tests");
    },
    async complete(): Promise<TaskRecord | TaskNotFound> {
      throw new Error("complete not used in these tests");
    },
    async cancel(): Promise<TaskRecord | TaskNotFound> {
      throw new Error("cancel not used in these tests");
    },
  };
}

function failingTaskLedger(
  listSpy: (query: TaskListQuery) => void,
  failure: Error,
): TaskLedger {
  return {
    async create(_input: TaskCreateInput): Promise<TaskRecord> {
      throw new Error("create not used in these tests");
    },
    async list(query: TaskListQuery): Promise<TaskListResult> {
      listSpy(query);
      throw failure;
    },
    async get(): Promise<TaskRecord | undefined> {
      throw new Error("get not used in these tests");
    },
    async update(_owner, _id, _patch: TaskUpdatePatch): Promise<TaskRecord | TaskNotFound> {
      throw new Error("update not used in these tests");
    },
    async complete(): Promise<TaskRecord | TaskNotFound> {
      throw new Error("complete not used in these tests");
    },
    async cancel(): Promise<TaskRecord | TaskNotFound> {
      throw new Error("cancel not used in these tests");
    },
  };
}

function makeSemanticEntry(
  identityId: ReturnType<typeof asIdentityId>,
  index: number,
  content: string,
): SemanticMemoryEntry {
  return {
    id: asMemoryEntryId(`mem:test-${String(index)}`),
    identityId,
    content,
    metadata: {},
    score: 1 - index * 0.1,
  };
}

function recallingMemoryStore(
  entries: readonly SemanticMemoryEntry[],
  recallSpy?: (query: SemanticMemoryQuery) => void,
): MemoryStore {
  return {
    async recall(query: SemanticMemoryQuery): Promise<MemoryRecallResult> {
      recallSpy?.(query);
      return { entries };
    },
    async storeEpisodic(_event: EpisodicMemoryEvent) {
      throw new Error("storeEpisodic not used in these tests");
    },
    async storeSemantic(_write: SemanticMemoryWrite) {
      throw new Error("storeSemantic not used in these tests");
    },
    async list(_query: MemoryListQuery): Promise<MemoryListResult> {
      return { episodic: [], semantic: [] };
    },
    async forget() {
      // no-op
    },
  };
}

function mockCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        embeddedPi: {
          intentContractor: { backend: "mock" },
        },
      },
    },
  } as OpenClawConfig;
}

describe("IntentContractor active-tasks recall (slice F Phase 6)", () => {
  it("regression: contractor with NO taskLedger dep behaves byte-identical to today (no <active_tasks> tag)", async () => {
    const captures: CapturedAdapterCall[] = [];
    const adapter = makeCapturingAdapter(captures);
    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: adapter },
    });

    const result = await contractor.classify(RAW_PROMPT);

    expect(captures).toHaveLength(1);
    expect(captures[0]!.prompt).toBe(RAW_PROMPT);
    expect(captures[0]!.prompt).not.toContain("<active_tasks>");
    expect(captures[0]!.prompt).not.toContain("</active_tasks>");
    expect(result.uncertainty).not.toContain(TASK_RECALL_FAILED_UNCERTAINTY);
  });

  it("anonymous session (no IdentityId) → no taskLedger.list call, no <active_tasks> block", async () => {
    const captures: CapturedAdapterCall[] = [];
    const listSpy = vi.fn<(query: TaskListQuery) => void>();
    const taskLedger = listingTaskLedger(
      [makeTask({ idSlug: "00000001", label: "should-not-appear", status: "open", createdAt: "2026-05-05T10:00:00.000Z" })],
      listSpy,
    );

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      taskLedger,
      // identityId intentionally OMITTED — anonymous session.
    });

    await contractor.classify(RAW_PROMPT);

    expect(listSpy).not.toHaveBeenCalled();
    expect(captures).toHaveLength(1);
    expect(captures[0]!.prompt).toBe(RAW_PROMPT);
    expect(captures[0]!.prompt).not.toContain("<active_tasks>");
  });

  it("taskLedger present + identityId resolved + EMPTY result → NO <active_tasks> block (zero whitespace pollution)", async () => {
    const captures: CapturedAdapterCall[] = [];
    const listSpy = vi.fn<(query: TaskListQuery) => void>();
    const taskLedger = listingTaskLedger([], listSpy);

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      taskLedger,
      identityId: asIdentityId("identity:vladimir"),
    });

    await contractor.classify(RAW_PROMPT);

    // Recall MUST have been attempted with the resolved identity.
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy.mock.calls[0]![0]).toMatchObject({
      ownerIdentityId: asIdentityId("identity:vladimir"),
    });
    expect(captures).toHaveLength(1);
    // Empty result must NOT inject a block.
    expect(captures[0]!.prompt).toBe(RAW_PROMPT);
    expect(captures[0]!.prompt).not.toContain("<active_tasks>");
    expect(captures[0]!.prompt).not.toContain("</active_tasks>");
  });

  it("N=3 active tasks → exactly 3 entries inside <active_tasks> block, prepended to prompt", async () => {
    const captures: CapturedAdapterCall[] = [];
    const tasks: ReadonlyArray<TaskRecord> = [
      makeTask({ idSlug: "00000001", label: "draft-rfc", status: "open", createdAt: "2026-05-05T10:00:00.000Z" }),
      makeTask({ idSlug: "00000002", label: "review-pr", status: "in_progress", createdAt: "2026-05-05T11:00:00.000Z" }),
      makeTask({ idSlug: "00000003", label: "ship-doc", status: "open", createdAt: "2026-05-05T12:00:00.000Z" }),
    ];
    const taskLedger = listingTaskLedger(tasks);

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      taskLedger,
      identityId: asIdentityId("identity:vladimir"),
    });

    await contractor.classify(RAW_PROMPT);

    expect(captures).toHaveLength(1);
    const prompt = captures[0]!.prompt;
    expect(prompt.startsWith("<active_tasks>")).toBe(true);
    expect(prompt).toContain("</active_tasks>");
    expect(prompt.endsWith(RAW_PROMPT)).toBe(true);
    // The closing tag separates the block from the original prompt.
    const innerMatch = prompt.match(/^<active_tasks>(.*?)<\/active_tasks>/s);
    expect(innerMatch).not.toBeNull();
    const parsed = JSON.parse(innerMatch![1]!) as { tasks: Array<{ id: string; label: string }> };
    expect(parsed.tasks).toHaveLength(3);
    expect(prompt).toContain("draft-rfc");
    expect(prompt).toContain("review-pr");
    expect(prompt).toContain("ship-doc");
  });

  it("recall failure (mocked throw) → no <active_tasks> block, warning logged, contractor still returns valid SemanticIntent with task_recall_failed uncertainty tag", async () => {
    const captures: CapturedAdapterCall[] = [];
    const warnSpy = vi.fn<(message: string, payload?: Record<string, unknown>) => void>();
    const listSpy = vi.fn<(query: TaskListQuery) => void>();
    const taskLedger = failingTaskLedger(listSpy, new Error("sqlite locked"));

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      taskLedger,
      identityId: asIdentityId("identity:vladimir"),
      logger: { warn: warnSpy },
    });

    const result = await contractor.classify(RAW_PROMPT);

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(captures).toHaveLength(1);
    // Failure must NOT inject a block.
    expect(captures[0]!.prompt).toBe(RAW_PROMPT);
    expect(captures[0]!.prompt).not.toContain("<active_tasks>");
    // Warning must be logged.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArgs = warnSpy.mock.calls[0]!;
    const warnPayload = `${String(warnArgs[0] ?? "")} ${JSON.stringify(warnArgs[1] ?? {})}`;
    expect(warnPayload).toContain(TASK_RECALL_FAILED_UNCERTAINTY);
    // Contractor must still return a valid SemanticIntent (NEVER throws).
    expect(result.desiredEffectFamily).toBe(COMMUNICATION_EFFECT_FAMILY);
    expect(result.uncertainty).toContain(TASK_RECALL_FAILED_UNCERTAINTY);
  });

  it("recall failure does NOT throw into the contractor", async () => {
    const captures: CapturedAdapterCall[] = [];
    const warnSpy = vi.fn<(message: string, payload?: Record<string, unknown>) => void>();
    const taskLedger = failingTaskLedger(() => {}, new Error("ledger backend down"));

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      taskLedger,
      identityId: asIdentityId("identity:vladimir"),
      logger: { warn: warnSpy },
    });

    await expect(contractor.classify(RAW_PROMPT)).resolves.toMatchObject({
      desiredEffectFamily: COMMUNICATION_EFFECT_FAMILY,
    });
  });

  it("recall passes the resolved IdentityId AND a status filter narrowing to open + in_progress", async () => {
    const listSpy = vi.fn<(query: TaskListQuery) => void>();
    const identity = asIdentityId("identity:alice");
    const taskLedger = listingTaskLedger([], listSpy);

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter([]) },
      taskLedger,
      identityId: identity,
    });

    await contractor.classify(RAW_PROMPT);

    expect(listSpy).toHaveBeenCalledTimes(1);
    const query = listSpy.mock.calls[0]![0];
    expect(query.ownerIdentityId).toBe(identity);
    // Statuses, when supplied, MUST be a subset of {open, in_progress}.
    if (query.statuses !== undefined) {
      const allowed = new Set(["open", "in_progress"]);
      for (const status of query.statuses) {
        expect(allowed.has(status)).toBe(true);
      }
    }
  });

  it("recall query does NOT carry raw user text (invariant #5/#6)", async () => {
    const listSpy = vi.fn<(query: TaskListQuery) => void>();
    const taskLedger = listingTaskLedger([], listSpy);

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter([]) },
      taskLedger,
      identityId: asIdentityId("identity:vladimir"),
    });

    const adversarialPrompt = "DROP TABLE tasks; -- какие у меня задачи";
    await contractor.classify(adversarialPrompt);

    expect(listSpy).toHaveBeenCalledTimes(1);
    const query = listSpy.mock.calls[0]![0];
    // Walk the structured query and confirm no field contains raw text fragments.
    const flat = JSON.stringify(query);
    expect(flat).not.toContain("DROP TABLE");
    expect(flat).not.toContain("какие у меня задачи");
  });

  it("combined memory + tasks: contractor receives BOTH <active_tasks> AND <memory> blocks when both deps return non-empty", async () => {
    const captures: CapturedAdapterCall[] = [];
    const identity = asIdentityId("identity:vladimir");
    const tasks: ReadonlyArray<TaskRecord> = [
      makeTask({ idSlug: "00000001", label: "the-active-task", status: "open", createdAt: "2026-05-05T10:00:00.000Z" }),
    ];
    const memoryStore = recallingMemoryStore([
      makeSemanticEntry(identity, 0, "the-recalled-memory"),
    ]);
    const taskLedger = listingTaskLedger(tasks);

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore,
      taskLedger,
      identityId: identity,
    });

    await contractor.classify(RAW_PROMPT);

    expect(captures).toHaveLength(1);
    const prompt = captures[0]!.prompt;
    // BOTH blocks must appear.
    expect(prompt).toContain("<active_tasks>");
    expect(prompt).toContain("</active_tasks>");
    expect(prompt).toContain("<memory>");
    expect(prompt).toContain("</memory>");
    // Both inner contents are present.
    expect(prompt).toContain("the-active-task");
    expect(prompt).toContain("the-recalled-memory");
    // Original prompt is the trailing suffix.
    expect(prompt.endsWith(RAW_PROMPT)).toBe(true);
  });

  it("memoryStore-only (no taskLedger) keeps the slice E behaviour byte-identical (no <active_tasks>)", async () => {
    const captures: CapturedAdapterCall[] = [];
    const identity = asIdentityId("identity:vladimir");
    const memoryStore = recallingMemoryStore([
      makeSemanticEntry(identity, 0, "memory-only"),
    ]);

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      memoryStore,
      identityId: identity,
    });

    await contractor.classify(RAW_PROMPT);

    const prompt = captures[0]!.prompt;
    expect(prompt).toContain("<memory>");
    expect(prompt).not.toContain("<active_tasks>");
  });

  it("only-completed/-cancelled active list yields no block (filter inside formatter)", async () => {
    const captures: CapturedAdapterCall[] = [];
    const tasks: ReadonlyArray<TaskRecord> = [
      makeTask({ idSlug: "00000001", label: "done", status: "completed", createdAt: "2026-05-05T10:00:00.000Z" }),
      makeTask({ idSlug: "00000002", label: "stale", status: "cancelled", createdAt: "2026-05-05T11:00:00.000Z" }),
    ];
    const taskLedger = listingTaskLedger(tasks);

    const contractor = createIntentContractor({
      cfg: mockCfg(),
      adapterRegistry: { mock: makeCapturingAdapter(captures) },
      taskLedger,
      identityId: asIdentityId("identity:vladimir"),
    });

    await contractor.classify(RAW_PROMPT);

    const prompt = captures[0]!.prompt;
    expect(prompt).not.toContain("<active_tasks>");
    expect(prompt).toBe(RAW_PROMPT);
  });
});
