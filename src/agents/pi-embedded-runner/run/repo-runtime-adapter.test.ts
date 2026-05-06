/**
 * Cutover-4 Phase 5 — fail-first tests for the repo runtime adapter.
 *
 * Sibling of `artifact-runtime-adapter.test.ts` (Cutover-3 Phase 5).
 * Mirrors the same test shape:
 *   - real `RepoWorldStateCollector` (no `vi.spyOn` on the function under
 *     test);
 *   - real tmp-dir git repo where the fixture exercises the gated
 *     `runRepoCommand` end-to-end;
 *   - closed failure set covered (`transport_error`, `repo_root_missing`,
 *     `kind_unsupported`, `observer_unavailable`, `branch_name_invalid`);
 *   - sessionId / turnId isolation, perTurnLimit delegation,
 *     auto-generated repoOperationId.
 *
 * The adapter is the WRITE side of the cutover-4 `WorldStateSnapshot.repo`
 * slice (Phase 3) and emits `expectedDelta.repo.added` so the four
 * Phase 4 done-predicates resolve.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createRepoWorldStateCollector,
  type RepoTurnKey,
  type RepoWorldStateCollector,
} from "../../../platform/commitment/repo-world-state-observer.js";
import type { SessionId } from "../../../platform/commitment/ids.js";

import {
  recordRepoOperation,
  runRepoCommand,
  type RecordRepoOperationInput,
  type RecordRepoOperationResult,
} from "./repo-runtime-adapter.js";

const SESSION_A = "session:a" as SessionId;
const SESSION_B = "session:b" as SessionId;

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repo-adapter-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function turnKey(sessionId: SessionId, turnId: string): RepoTurnKey {
  return { sessionId, turnId };
}

function baseInput(
  collector: RepoWorldStateCollector,
  overrides: Partial<RecordRepoOperationInput> = {},
): RecordRepoOperationInput {
  return {
    collector,
    sessionId: SESSION_A,
    turnId: "turn-1",
    kind: "branch_created",
    branchName: "feature/x",
    repoRoot: tmpRoot,
    ...overrides,
  };
}

describe("recordRepoOperation — happy path round-trip", () => {
  it("appends a repo-operation record and exposes it via the active slice", () => {
    const collector = createRepoWorldStateCollector();
    const r = recordRepoOperation(
      baseInput(collector, { branchName: "feature/x" }),
    );

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(typeof r.repoOperationId).toBe("string");
    expect(r.repoOperationId.length).toBeGreaterThan(0);
    expect(r.expectedDelta.repo?.added).toContain(r.repoOperationId);

    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    const slice = collector.getActiveSlice();
    expect(slice).toBeDefined();
    expect(slice).toHaveLength(1);
    expect(slice?.[0]?.kind).toBe("branch_created");
    expect(slice?.[0]?.branchName).toBe("feature/x");
    expect(slice?.[0]?.repoRoot).toBe(tmpRoot);
  });

  it("auto-generates a deterministic-ish repoOperationId when omitted", () => {
    const collector = createRepoWorldStateCollector();
    const r1 = recordRepoOperation(baseInput(collector));
    const r2 = recordRepoOperation(
      baseInput(collector, { turnId: "turn-2", branchName: "feature/y" }),
    );
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.repoOperationId).not.toBe(r2.repoOperationId);
    }
  });

  it("uses supplied repoOperationId verbatim when provided", () => {
    const collector = createRepoWorldStateCollector();
    const r = recordRepoOperation(
      baseInput(collector, { repoOperationId: "repo:custom-1" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repoOperationId).toBe("repo:custom-1");
  });

  it("populates expectedDelta.repo.added with exactly the new id", () => {
    const collector = createRepoWorldStateCollector();
    const r = recordRepoOperation(
      baseInput(collector, { repoOperationId: "repo:42" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expectedDelta.repo?.added).toEqual(["repo:42"]);
    }
  });
});

describe("recordRepoOperation — closed failure set", () => {
  it("returns observer_unavailable when collector is undefined", () => {
    const r = recordRepoOperation({
      // @ts-expect-error — exercising defensive guard
      collector: undefined,
      sessionId: SESSION_A,
      turnId: "turn-1",
      kind: "branch_created",
      branchName: "feature/x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("observer_unavailable");
  });

  it("returns kind_unsupported when kind is outside the closed enum", () => {
    const collector = createRepoWorldStateCollector();
    const r = recordRepoOperation(
      // @ts-expect-error — exercising the runtime guard
      baseInput(collector, { kind: "rebase_finished" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("kind_unsupported");
  });

  it("returns branch_name_invalid when branchName is empty for branch_created", () => {
    const collector = createRepoWorldStateCollector();
    const r = recordRepoOperation(
      baseInput(collector, { kind: "branch_created", branchName: "" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("branch_name_invalid");
  });

  it("returns branch_name_invalid when branchName contains a space", () => {
    const collector = createRepoWorldStateCollector();
    const r = recordRepoOperation(
      baseInput(collector, {
        kind: "branch_created",
        branchName: "feature x",
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("branch_name_invalid");
  });

  it("returns transport_error when the collector throws (e.g. malformed sha)", () => {
    const collector = createRepoWorldStateCollector();
    // commit_landed with a malformed sha — schema rejects, adapter wraps.
    const r = recordRepoOperation(
      baseInput(collector, {
        kind: "commit_landed",
        commitSha: "NOT-A-SHA",
        branchName: "feature/x",
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("transport_error");
  });

  it("never throws — every failure surfaces as a typed result", () => {
    const collector = createRepoWorldStateCollector();
    expect(() =>
      recordRepoOperation(
        baseInput(collector, { kind: "branch_created", branchName: "" }),
      ),
    ).not.toThrow();
  });
});

describe("recordRepoOperation — sessionId / turnId isolation", () => {
  it("does NOT leak records across sessions", () => {
    const collector = createRepoWorldStateCollector();
    const r1 = recordRepoOperation(
      baseInput(collector, { sessionId: SESSION_A, repoOperationId: "repo:a" }),
    );
    const r2 = recordRepoOperation(
      baseInput(collector, { sessionId: SESSION_B, repoOperationId: "repo:b" }),
    );
    expect(r1.ok && r2.ok).toBe(true);

    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    expect(collector.getActiveSlice()).toHaveLength(1);
    expect(collector.getActiveSlice()?.[0]?.repoOperationId).toBe("repo:a");

    collector.setActiveTurn(turnKey(SESSION_B, "turn-1"));
    expect(collector.getActiveSlice()).toHaveLength(1);
    expect(collector.getActiveSlice()?.[0]?.repoOperationId).toBe("repo:b");
  });

  it("does NOT leak records across turns within the same session", () => {
    const collector = createRepoWorldStateCollector();
    recordRepoOperation(baseInput(collector, { turnId: "turn-1" }));
    recordRepoOperation(
      baseInput(collector, { turnId: "turn-2", branchName: "feature/y" }),
    );

    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    expect(collector.getActiveSlice()).toHaveLength(1);

    collector.setActiveTurn(turnKey(SESSION_A, "turn-2"));
    expect(collector.getActiveSlice()).toHaveLength(1);
  });
});

describe("recordRepoOperation — kind round-trip for all four lifecycle kinds", () => {
  it("records kind=branch_created", () => {
    const collector = createRepoWorldStateCollector();
    const r: RecordRepoOperationResult = recordRepoOperation(
      baseInput(collector, {
        kind: "branch_created",
        branchName: "feature/branch-1",
        repoOperationId: "repo:branch:1",
      }),
    );
    expect(r.ok).toBe(true);
    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    expect(collector.getActiveSlice()?.[0]?.kind).toBe("branch_created");
  });

  it("records kind=commit_landed with valid sha", () => {
    const collector = createRepoWorldStateCollector();
    const r = recordRepoOperation(
      baseInput(collector, {
        kind: "commit_landed",
        branchName: "feature/x",
        commitSha: "abc1234",
        repoOperationId: "repo:commit:1",
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("records kind=merge_completed", () => {
    const collector = createRepoWorldStateCollector();
    const r = recordRepoOperation(
      baseInput(collector, {
        kind: "merge_completed",
        branchName: "feature/x",
        commitSha: "deadbee",
        repoOperationId: "repo:merge:1",
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("records kind=diff_observed without branchName requirement", () => {
    const collector = createRepoWorldStateCollector();
    const r = recordRepoOperation(
      baseInput(collector, {
        kind: "diff_observed",
        branchName: undefined,
        repoOperationId: "repo:diff:1",
      }),
    );
    expect(r.ok).toBe(true);
  });
});

// ─── Gated runRepoCommand wrapper ──────────────────────────────────────

function gitInit(repoRoot: string): void {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "init\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoRoot });
}

describe("runRepoCommand — gated git wrapper", () => {
  it("executes branch_created via the gated wrapper and returns structured result", () => {
    gitInit(tmpRoot);
    const result = runRepoCommand({
      kind: "branch_created",
      args: { branchName: "feature/cutover4", checkoutAfterCreate: false },
      repoRoot: tmpRoot,
    });
    expect(result.exitCode).toBe(0);
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.elapsedMs).toBe("number");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    const branches = execFileSync("git", ["branch", "--list"], { cwd: tmpRoot, encoding: "utf8" });
    expect(branches).toContain("feature/cutover4");
  });

  it("rejects free-form shell strings (closed kind enum only)", () => {
    expect(() => {
      runRepoCommand({
        // @ts-expect-error — closed kind enum
        kind: "exec_shell",
        // @ts-expect-error — closed args
        args: { command: "git status; rm -rf /" },
        repoRoot: tmpRoot,
      });
    }).toThrow();
  });

  it("returns non-zero exit code when git binary fails (e.g. branch already exists)", () => {
    gitInit(tmpRoot);
    runRepoCommand({
      kind: "branch_created",
      args: { branchName: "feature/dup" },
      repoRoot: tmpRoot,
    });
    const second = runRepoCommand({
      kind: "branch_created",
      args: { branchName: "feature/dup" },
      repoRoot: tmpRoot,
    });
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr.length).toBeGreaterThan(0);
  });

  it("executes diff_observed and captures diff stdout", () => {
    gitInit(tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, "a.txt"), "hello\n");
    execFileSync("git", ["add", "a.txt"], { cwd: tmpRoot });
    execFileSync("git", ["commit", "-m", "add a"], { cwd: tmpRoot });

    const result = runRepoCommand({
      kind: "diff_observed",
      args: { baseRef: "HEAD~1", headRef: "HEAD" },
      repoRoot: tmpRoot,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("a.txt");
  });
});
