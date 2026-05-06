/**
 * Cutover-4 Phase 5 — fail-first tests for the repo tool wrapper.
 *
 * `repo-tool.ts` is the FIRST sanctioned user-facing git surface. Schema
 * accepts a CLOSED `kind` enum + per-kind structured args (Zod-validated).
 * Free-form shell strings are rejected by construction (invariants
 * #5/#6). On success the wrapper:
 *
 *   1. calls `runRepoCommand({kind, args, ...})` (gated execFile),
 *   2. on `exitCode === 0` calls `recordRepoOperation(...)` so the
 *      cutover-4 `WorldStateSnapshot.repo` slice + the Phase 4 done-
 *      predicates resolve.
 *
 * Tests use a real tmp-dir git repo per case so the path stays
 * end-to-end; spies are limited to dependency objects (collector,
 * logger), never the function under test.
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
} from "../../platform/commitment/repo-world-state-observer.js";
import type { SessionId } from "../../platform/commitment/ids.js";

import { repoTool, repoToolInputSchema } from "./repo-tool.js";

const SESSION_A = "session:a" as SessionId;

let tmpRoot: string;

function turnKey(sessionId: SessionId, turnId: string): RepoTurnKey {
  return { sessionId, turnId };
}

function gitInit(repoRoot: string): void {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "init\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoRoot });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repo-tool-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("repoToolInputSchema — closed kind enum + per-kind structured args", () => {
  it("accepts kind=branch_created with branchName + optional baseRef", () => {
    const parsed = repoToolInputSchema.safeParse({
      kind: "branch_created",
      args: { branchName: "feature/x", baseRef: "main", checkoutAfterCreate: true },
      repoRoot: "/tmp/foo",
      sessionId: SESSION_A,
      turnId: "turn-1",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts kind=commit_landed with commitMessage + optional filesIncluded", () => {
    const parsed = repoToolInputSchema.safeParse({
      kind: "commit_landed",
      args: {
        commitMessage: "fix bug",
        filesIncluded: ["a.txt", "b.txt"],
        signedOff: false,
      },
      repoRoot: "/tmp/foo",
      sessionId: SESSION_A,
      turnId: "turn-1",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts kind=merge_completed with sourceBranch + targetBranch", () => {
    const parsed = repoToolInputSchema.safeParse({
      kind: "merge_completed",
      args: { sourceBranch: "feature/x", targetBranch: "main", fastForward: true },
      repoRoot: "/tmp/foo",
      sessionId: SESSION_A,
      turnId: "turn-1",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts kind=diff_observed with all-optional args", () => {
    const parsed = repoToolInputSchema.safeParse({
      kind: "diff_observed",
      args: {},
      repoRoot: "/tmp/foo",
      sessionId: SESSION_A,
      turnId: "turn-1",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects free-form shell strings (kind outside closed enum)", () => {
    const parsed = repoToolInputSchema.safeParse({
      kind: "exec_shell",
      args: { command: "git status; rm -rf /" },
      repoRoot: "/tmp/foo",
      sessionId: SESSION_A,
      turnId: "turn-1",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects branch_created without a branchName arg", () => {
    const parsed = repoToolInputSchema.safeParse({
      kind: "branch_created",
      args: {},
      repoRoot: "/tmp/foo",
      sessionId: SESSION_A,
      turnId: "turn-1",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects commit_landed without a commitMessage", () => {
    const parsed = repoToolInputSchema.safeParse({
      kind: "commit_landed",
      args: { signedOff: true },
      repoRoot: "/tmp/foo",
      sessionId: SESSION_A,
      turnId: "turn-1",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects merge_completed without sourceBranch or targetBranch", () => {
    const parsed = repoToolInputSchema.safeParse({
      kind: "merge_completed",
      args: { sourceBranch: "feature/x" },
      repoRoot: "/tmp/foo",
      sessionId: SESSION_A,
      turnId: "turn-1",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("repoTool — per-kind execution against tmp-dir git repo", () => {
  it("kind=branch_created creates the branch + records the operation", async () => {
    gitInit(tmpRoot);
    const collector = createRepoWorldStateCollector();
    const result = await repoTool({
      kind: "branch_created",
      args: { branchName: "feature/cutover4", baseRef: "main" },
      repoRoot: tmpRoot,
      sessionId: SESSION_A,
      turnId: "turn-1",
      collector,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);

    const branches = execFileSync("git", ["branch", "--list"], { cwd: tmpRoot, encoding: "utf8" });
    expect(branches).toContain("feature/cutover4");

    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    const slice = collector.getActiveSlice();
    expect(slice).toHaveLength(1);
    expect(slice?.[0]?.kind).toBe("branch_created");
    expect(slice?.[0]?.branchName).toBe("feature/cutover4");
  });

  it("kind=commit_landed stages + commits files + records sha", async () => {
    gitInit(tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, "x.txt"), "hello\n");
    fs.writeFileSync(path.join(tmpRoot, "y.txt"), "world\n");
    const collector = createRepoWorldStateCollector();

    const result = await repoTool({
      kind: "commit_landed",
      args: {
        commitMessage: "cutover-4 live verify",
        filesIncluded: ["x.txt", "y.txt"],
      },
      repoRoot: tmpRoot,
      sessionId: SESSION_A,
      turnId: "turn-1",
      collector,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);

    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    const slice = collector.getActiveSlice();
    expect(slice).toHaveLength(1);
    expect(slice?.[0]?.kind).toBe("commit_landed");
    expect(typeof slice?.[0]?.commitSha).toBe("string");
    expect(slice?.[0]?.commitSha?.length ?? 0).toBeGreaterThanOrEqual(7);

    const log = execFileSync("git", ["log", "--oneline"], { cwd: tmpRoot, encoding: "utf8" });
    expect(log).toContain("cutover-4 live verify");
  });

  it("kind=merge_completed performs fast-forward merge + records the operation", async () => {
    gitInit(tmpRoot);
    // create feature branch with a commit
    execFileSync("git", ["checkout", "-b", "feature/mergeme"], { cwd: tmpRoot });
    fs.writeFileSync(path.join(tmpRoot, "ff.txt"), "ff\n");
    execFileSync("git", ["add", "ff.txt"], { cwd: tmpRoot });
    execFileSync("git", ["commit", "-m", "ff commit"], { cwd: tmpRoot });
    execFileSync("git", ["checkout", "main"], { cwd: tmpRoot });

    const collector = createRepoWorldStateCollector();
    const result = await repoTool({
      kind: "merge_completed",
      args: {
        sourceBranch: "feature/mergeme",
        targetBranch: "main",
        fastForward: true,
      },
      repoRoot: tmpRoot,
      sessionId: SESSION_A,
      turnId: "turn-1",
      collector,
    });
    expect(result.ok).toBe(true);

    const log = execFileSync("git", ["log", "--oneline"], { cwd: tmpRoot, encoding: "utf8" });
    expect(log).toContain("ff commit");

    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    const slice = collector.getActiveSlice();
    expect(slice).toHaveLength(1);
    expect(slice?.[0]?.kind).toBe("merge_completed");
  });

  it("kind=diff_observed captures diff between two SHAs without mutating repo", async () => {
    gitInit(tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, "z.txt"), "before\n");
    execFileSync("git", ["add", "z.txt"], { cwd: tmpRoot });
    execFileSync("git", ["commit", "-m", "add z"], { cwd: tmpRoot });

    const collector = createRepoWorldStateCollector();
    const result = await repoTool({
      kind: "diff_observed",
      args: { baseRef: "HEAD~1", headRef: "HEAD" },
      repoRoot: tmpRoot,
      sessionId: SESSION_A,
      turnId: "turn-1",
      collector,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.stdout).toContain("z.txt");

    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    const slice = collector.getActiveSlice();
    expect(slice).toHaveLength(1);
    expect(slice?.[0]?.kind).toBe("diff_observed");
  });
});

describe("repoTool — failure surfaces", () => {
  it("returns ok=false with reason=schema_invalid on malformed input", async () => {
    const collector = createRepoWorldStateCollector();
    const result = await repoTool({
      // @ts-expect-error — exercise schema rejection
      kind: "exec_shell",
      args: { command: "rm -rf /" },
      repoRoot: tmpRoot,
      sessionId: SESSION_A,
      turnId: "turn-1",
      collector,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("schema_invalid");
  });

  it("returns ok=false with reason=git_failed when git binary fails (duplicate branch)", async () => {
    gitInit(tmpRoot);
    const collector = createRepoWorldStateCollector();
    await repoTool({
      kind: "branch_created",
      args: { branchName: "feature/dup" },
      repoRoot: tmpRoot,
      sessionId: SESSION_A,
      turnId: "turn-1",
      collector,
    });
    const second = await repoTool({
      kind: "branch_created",
      args: { branchName: "feature/dup" },
      repoRoot: tmpRoot,
      sessionId: SESSION_A,
      turnId: "turn-1",
      collector,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("git_failed");
  });

  it("does NOT record an operation when git fails", async () => {
    gitInit(tmpRoot);
    const collector = createRepoWorldStateCollector();
    await repoTool({
      kind: "branch_created",
      args: { branchName: "feature/dup2" },
      repoRoot: tmpRoot,
      sessionId: SESSION_A,
      turnId: "turn-1",
      collector,
    });
    await repoTool({
      kind: "branch_created",
      args: { branchName: "feature/dup2" },
      repoRoot: tmpRoot,
      sessionId: SESSION_A,
      turnId: "turn-1",
      collector,
    });
    collector.setActiveTurn(turnKey(SESSION_A, "turn-1"));
    // Only the first (successful) call recorded; second was a git failure.
    expect(collector.getActiveSlice()).toHaveLength(1);
  });

  it("never throws — every failure surfaces as a typed result", async () => {
    const collector = createRepoWorldStateCollector();
    let thrown: unknown;
    let result: Awaited<ReturnType<typeof repoTool>> | undefined;
    try {
      result = await repoTool({
        kind: "branch_created",
        args: { branchName: "feature/x" },
        repoRoot: path.join(tmpRoot, "does-not-exist"),
        sessionId: SESSION_A,
        turnId: "turn-1",
        collector,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeUndefined();
    expect(result).toBeDefined();
    expect(result?.ok).toBe(false);
  });
});
