import { describe, expect, it } from "vitest";

import {
  type EffectFamilyId,
  type EffectId,
  type SessionId,
} from "../commitment/ids.js";
import { asIdentityId, type IdentityId } from "../identity/identity-id.js";
import { asMemoryEntryId, type MemoryEntryId } from "../memory/memory-entry-id.js";

import type { TaskLedger } from "./task-ledger.js";
import { asTaskId, type TaskId } from "./task-id.js";
import type { TaskCreateInput, TaskRecord, TaskUpdatePatch } from "./task-record.js";

/**
 * Type-level contract tests for `TaskLedger`. The bulk of the
 * assertions are `// @ts-expect-error` lines: if any of them stops
 * being an error, the file fails to compile and the suite fails
 * before any runtime code runs. This catches invariant #16
 * violations (brand collapse) at COMPILE time, which is stronger
 * than any runtime assertion.
 */

const VLADIMIR = asIdentityId("identity:vladimir");
const TASK_ID = asTaskId("task:contract-001");

const VALID_CREATE: TaskCreateInput = {
  ownerIdentityId: VLADIMIR,
  label: "x",
  summary: "y",
};

const VALID_RECORD: TaskRecord = {
  id: TASK_ID,
  ownerIdentityId: VLADIMIR,
  label: "x",
  status: "open",
  summary: "y",
  createdAt: "2026-05-05T12:00:00.000Z",
  updatedAt: "2026-05-05T12:00:00.000Z",
};

// A stub impl whose method bodies don't matter — the suite below only
// exercises the type-checker. The runtime smoke assertion at the end
// keeps vitest happy.
const stub: TaskLedger = {
  create: async (_input: TaskCreateInput): Promise<TaskRecord> => VALID_RECORD,
  list: async () => ({ tasks: [] }),
  get: async () => undefined,
  update: async () => ({ kind: "not_found" }),
  complete: async () => ({ kind: "not_found" }),
  cancel: async () => ({ kind: "not_found" }),
};

describe("TaskLedger.get — accepts ONLY (IdentityId, TaskId) at the type level", () => {
  it("rejects a raw string passed where a TaskId is required", () => {
    // @ts-expect-error - TaskId is brand-typed, raw strings are not assignable
    void stub.get(VLADIMIR, "task:contract-001");
    expect(typeof stub.get).toBe("function");
  });

  it("rejects an IdentityId passed where a TaskId is required", () => {
    // @ts-expect-error - IdentityId brand is distinct from TaskId brand
    void stub.get(VLADIMIR, VLADIMIR);
    expect(typeof stub.get).toBe("function");
  });

  it("rejects a MemoryEntryId passed where a TaskId is required", () => {
    const memId: MemoryEntryId = asMemoryEntryId("mem:0001");
    // @ts-expect-error - MemoryEntryId brand is distinct from TaskId brand
    void stub.get(VLADIMIR, memId);
    expect(typeof stub.get).toBe("function");
  });

  it("rejects a SessionId passed where a TaskId is required", () => {
    const sessionLike = "session:abc" as unknown as SessionId;
    // @ts-expect-error - SessionId brand is distinct from TaskId brand
    void stub.get(VLADIMIR, sessionLike);
    expect(typeof stub.get).toBe("function");
  });

  it("rejects an EffectId passed where a TaskId is required", () => {
    const effectLike = "effect:abc" as unknown as EffectId;
    // @ts-expect-error - EffectId brand is distinct from TaskId brand
    void stub.get(VLADIMIR, effectLike);
    expect(typeof stub.get).toBe("function");
  });

  it("rejects an EffectFamilyId passed where a TaskId is required", () => {
    const familyLike = "task" as unknown as EffectFamilyId;
    // @ts-expect-error - EffectFamilyId brand is distinct from TaskId brand
    void stub.get(VLADIMIR, familyLike);
    expect(typeof stub.get).toBe("function");
  });

  it("rejects a raw string passed where an IdentityId is required (first arg)", () => {
    // @ts-expect-error - IdentityId is brand-typed, raw strings are not assignable
    void stub.get("identity:vladimir", TASK_ID);
    expect(typeof stub.get).toBe("function");
  });

  it("rejects a TaskId passed where an IdentityId is required (first arg)", () => {
    // @ts-expect-error - TaskId brand is distinct from IdentityId brand
    void stub.get(TASK_ID, TASK_ID);
    expect(typeof stub.get).toBe("function");
  });

  it("accepts (IdentityId, TaskId) — the only valid signature", async () => {
    // No @ts-expect-error — this MUST type-check and resolve.
    await expect(stub.get(VLADIMIR, TASK_ID)).resolves.toBeUndefined();
  });
});

describe("TaskLedger.update / complete / cancel — return-shape carries `not_found` for unknown ids", () => {
  it("update returns `TaskRecord | { kind: 'not_found' }` (typed)", async () => {
    const result = await stub.update(VLADIMIR, TASK_ID, { status: "in_progress" });
    if ("kind" in result && result.kind === "not_found") {
      expect(result.kind).toBe("not_found");
    } else {
      // type narrowing: it's a TaskRecord at this branch
      expect((result as TaskRecord).id).toBeDefined();
    }
  });

  it("complete returns `TaskRecord | { kind: 'not_found' }` (typed)", async () => {
    const result = await stub.complete(VLADIMIR, TASK_ID);
    expect("kind" in result || "id" in result).toBe(true);
  });

  it("cancel returns `TaskRecord | { kind: 'not_found' }` (typed)", async () => {
    const result = await stub.cancel(VLADIMIR, TASK_ID);
    expect("kind" in result || "id" in result).toBe(true);
  });

  it("update accepts a typed TaskUpdatePatch", async () => {
    const patch: TaskUpdatePatch = { status: "in_progress" };
    const result = await stub.update(VLADIMIR, TASK_ID, patch);
    expect(result).toBeDefined();
  });
});

describe("TaskLedger.create — accepts a TaskCreateInput", () => {
  // Structural typing: a `TaskRecord` is technically assignable to
  // `TaskCreateInput` because excess fields are allowed in non-literal
  // positions. The runtime guard is `TaskCreateInputSchema.parse(...)`
  // which is `.strict()` and rejects unknown keys (covered in
  // `task-record.test.ts`). At the interface level here we only assert
  // that the happy path type-checks and resolves.
  it("accepts a TaskCreateInput — the happy-path call type-checks", async () => {
    const result = await stub.create(VALID_CREATE);
    expect(result.id).toBe(TASK_ID);
  });

  it("rejects a raw string passed where a TaskCreateInput is required", () => {
    // @ts-expect-error - TaskCreateInput is a structured object, not a string
    void stub.create("just a label");
    expect(typeof stub.create).toBe("function");
  });
});

describe("TaskLedger — invariant #5/#6 (no raw user text on the API surface)", () => {
  it("the create input fields are structured types — no `RawUserTurn` / `UserPrompt` accepted", () => {
    // The reverse-test is a structural one: TaskCreateInput's fields
    // are ALL typed as `IdentityId` / branded strings / plain
    // structured strings. There is no field whose declared type is
    // `RawUserTurn` or `UserPrompt`. If a future contributor widens
    // any field to those types, this assertion (and the call sites
    // in slices F Phase 5+) will fail to compile.
    const probe: TaskCreateInput = VALID_CREATE;
    expect(typeof probe.label).toBe("string");
    expect(typeof probe.summary).toBe("string");
    expect(probe.ownerIdentityId).toBe(VLADIMIR);
  });
});

describe("TaskLedger — runtime smoke (no impl wired)", () => {
  it("stub list returns the empty contract `{ tasks: [] }` with a readonly tasks array", async () => {
    const result = await stub.list({ ownerIdentityId: VLADIMIR });
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(result.tasks).toHaveLength(0);
  });

  it("stub list accepts an IdentityId-only query without filters", async () => {
    const result = await stub.list({ ownerIdentityId: VLADIMIR });
    expect(result.tasks).toEqual([]);
  });

  it("the only valid IdentityId carrier is the brand — raw string rejected on list", () => {
    // @ts-expect-error - IdentityId brand required; raw string is rejected
    void stub.list({ ownerIdentityId: "identity:vladimir" });
    expect(typeof stub.list).toBe("function");
  });
});

// Reverse-test for invariant #8: this file imports ONLY from
// `src/platform/identity/`, `src/platform/memory/`, `src/platform/commitment/ids`,
// Zod, stdlib, and the new `src/platform/task/` module. It does NOT import
// from `src/platform/decision/` or any decision-layer adapter. If a future
// contributor reaches into the decision layer, the import boundary is
// broken and downstream `import-boundary` linters / typecheck will surface it.
//
// (The `commitment/ids` import here is for brand-discipline reverse-tests
// only — `SessionId` / `EffectId` / `EffectFamilyId` are TYPE imports;
// no runtime values from `commitment/` are touched.)
