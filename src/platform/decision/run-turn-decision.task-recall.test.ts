import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  PERSISTENT_SESSION_EFFECT_FAMILY,
  type IntentContractorAdapter,
} from "../commitment/index.js";
import type { SemanticIntent } from "../commitment/semantic-intent.js";
import { asIdentityId } from "../identity/identity-id.js";
import { asTaskId } from "../task/task-id.js";
import type { TaskLedger, TaskNotFound } from "../task/task-ledger.js";
import type {
  TaskCreateInput,
  TaskListQuery,
  TaskListResult,
  TaskRecord,
} from "../task/task-record.js";
import { runTurnDecision } from "./run-turn-decision.js";
import type { TaskClassifierAdapter, TaskContract } from "./task-classifier.js";

const cfg = {
  agents: {
    defaults: {
      embeddedPi: {
        taskClassifier: { backend: "legacy-mock" },
        intentContractor: { backend: "intent-mock" },
      },
    },
  },
} as OpenClawConfig;

const legacyContract: TaskContract = {
  primaryOutcome: "answer",
  requiredCapabilities: [],
  interactionMode: "respond_only",
  confidence: 0.9,
  ambiguities: [],
};

function makeOpenTask(idSlug: string, label: string, createdAt: string): TaskRecord {
  return {
    id: asTaskId(`task:${idSlug}`),
    ownerIdentityId: asIdentityId("identity:vladimir"),
    label,
    status: "open",
    summary: `summary-${idSlug}`,
    createdAt,
    updatedAt: createdAt,
  };
}

function listingTaskLedger(tasks: readonly TaskRecord[]): TaskLedger {
  return {
    async create(_input: TaskCreateInput): Promise<TaskRecord> {
      throw new Error("create not used");
    },
    async list(_query: TaskListQuery): Promise<TaskListResult> {
      return { tasks };
    },
    async get(): Promise<TaskRecord | undefined> {
      throw new Error("get not used");
    },
    async update(): Promise<TaskRecord | TaskNotFound> {
      throw new Error("update not used");
    },
    async complete(): Promise<TaskRecord | TaskNotFound> {
      throw new Error("complete not used");
    },
    async cancel(): Promise<TaskRecord | TaskNotFound> {
      throw new Error("cancel not used");
    },
  };
}

describe("runTurnDecision — slice F Phase 6 taskLedger propagation", () => {
  it("threads taskLedger + identityId into createIntentContractor so the <active_tasks> block appears in the adapter's prompt", async () => {
    const legacyAdapter: TaskClassifierAdapter = {
      classify: vi.fn(async () => legacyContract),
    };
    const observedPrompts: string[] = [];
    const intentAdapter: IntentContractorAdapter = {
      classify: vi.fn(async (params): Promise<SemanticIntent> => {
        observedPrompts.push(params.prompt);
        return {
          desiredEffectFamily: PERSISTENT_SESSION_EFFECT_FAMILY,
          target: { kind: "session" },
          operation: { kind: "create" },
          constraints: {},
          uncertainty: [],
          confidence: 0.9,
        };
      }),
    };

    const tasks = [makeOpenTask("00000001", "the-active-task", "2026-05-05T10:00:00.000Z")];

    await runTurnDecision({
      prompt: "какая моя последняя задача?",
      cfg,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter },
      taskLedger: listingTaskLedger(tasks),
      identityId: asIdentityId("identity:vladimir"),
    });

    expect(observedPrompts).toHaveLength(1);
    const prompt = observedPrompts[0]!;
    expect(prompt).toContain("<active_tasks>");
    expect(prompt).toContain("</active_tasks>");
    expect(prompt).toContain("the-active-task");
    expect(prompt.endsWith("какая моя последняя задача?")).toBe(true);
  });

  it("byte-identical regression: omitting taskLedger leaves the prompt unchanged (no <active_tasks> tag)", async () => {
    const legacyAdapter: TaskClassifierAdapter = {
      classify: vi.fn(async () => legacyContract),
    };
    const observedPrompts: string[] = [];
    const intentAdapter: IntentContractorAdapter = {
      classify: vi.fn(async (params): Promise<SemanticIntent> => {
        observedPrompts.push(params.prompt);
        return {
          desiredEffectFamily: PERSISTENT_SESSION_EFFECT_FAMILY,
          target: { kind: "session" },
          operation: { kind: "create" },
          constraints: {},
          uncertainty: [],
          confidence: 0.9,
        };
      }),
    };

    await runTurnDecision({
      prompt: "hello",
      cfg,
      classifierAdapterRegistry: { "legacy-mock": legacyAdapter },
      intentContractorAdapterRegistry: { "intent-mock": intentAdapter },
      // taskLedger + identityId intentionally OMITTED.
    });

    expect(observedPrompts).toHaveLength(1);
    expect(observedPrompts[0]!).not.toContain("<active_tasks>");
  });
});
