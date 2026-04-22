import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { IntentLedger } from "./intent-ledger.js";
import {
  probeWorkspace,
  projectWorkspaceForPrompt,
  WORKSPACE_PROJECTION_DEFAULT_MAX_TOKENS,
  WORKSPACE_SNAPSHOT_TTL_MS_DEFAULT,
  type WorkspaceProbeDirent,
  type WorkspaceProbeFs,
  type WorkspaceRoot,
  type WorkspaceSnapshot,
} from "./workspace-probe.js";

function createFs(layout: Record<string, WorkspaceProbeDirent[] | "ENOENT">): WorkspaceProbeFs {
  return {
    async readdir(targetPath: string) {
      const hit = layout[targetPath];
      if (!hit || hit === "ENOENT") {
        const error = new Error(`missing ${targetPath}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return hit;
    },
    async realpath(targetPath: string) {
      return targetPath;
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("probeWorkspace", () => {
  it("captures cwd root even without git metadata", async () => {
    const cwd = path.resolve("workspace-probe-a");
    const fs = createFs({
      [cwd]: [{ name: "src", isDirectory: true }],
    });

    const snapshot = await probeWorkspace({ cwd, fs, extraRootsEnv: "" });
    expect(snapshot.defaultCwd).toBe(cwd);
    expect(snapshot.roots).toHaveLength(1);
    expect(snapshot.roots[0]?.hasGit).toBeUndefined();
    expect(snapshot.roots[0]?.marker).toBeUndefined();
  });

  it("captures git metadata and package marker when present", async () => {
    const cwd = path.resolve("workspace-probe-b");
    const fs = createFs({
      [cwd]: [
        { name: ".git", isDirectory: true },
        { name: "package.json", isDirectory: false },
        { name: "src", isDirectory: true },
      ],
    });

    const snapshot = await probeWorkspace({
      cwd,
      fs,
      extraRootsEnv: "",
      readGitInfo: async () => ({ remote: "git@github.com:openclaw/god-mode-core.git", branch: "dev" }),
    });

    expect(snapshot.roots[0]?.marker).toBe("package.json");
    expect(snapshot.roots[0]?.hasGit).toEqual({
      remote: "git@github.com:openclaw/god-mode-core.git",
      branch: "dev",
    });
  });

  it("merges env roots and deduplicates cwd duplicates", async () => {
    const cwd = path.resolve("workspace-probe-c-main");
    const second = path.resolve("workspace-probe-c-other");
    const fs = createFs({
      [cwd]: [{ name: "src", isDirectory: true }],
      [second]: [{ name: "app", isDirectory: true }],
    });

    const snapshot = await probeWorkspace({
      cwd,
      fs,
      extraRootsEnv: `${cwd};${second}`,
    });

    expect(snapshot.roots.map((entry) => entry.path)).toEqual([cwd, second]);
  });

  it("truncates top-level directories to twenty entries", async () => {
    const cwd = path.resolve("workspace-probe-d");
    const dirs: WorkspaceProbeDirent[] = Array.from({ length: 25 }, (_, index) => ({
      name: `dir-${String(index)}`,
      isDirectory: true,
    }));
    const fs = createFs({ [cwd]: dirs });

    const snapshot = await probeWorkspace({ cwd, fs, extraRootsEnv: "" });
    expect(snapshot.roots[0]?.topLevelDirs).toHaveLength(20);
    expect(snapshot.roots[0]?.truncated).toBe(true);
  });

  it("fails soft when git probing throws", async () => {
    const cwd = path.resolve("workspace-probe-e");
    const fs = createFs({
      [cwd]: [
        { name: ".git", isDirectory: true },
        { name: "src", isDirectory: true },
      ],
    });

    const snapshot = await probeWorkspace({
      cwd,
      fs,
      extraRootsEnv: "",
      readGitInfo: async () => {
        throw new Error("git timeout");
      },
    });
    expect(snapshot.roots).toHaveLength(1);
    expect(snapshot.roots[0]?.hasGit).toBeUndefined();
  });

  it("silently skips missing roots from env list", async () => {
    const cwd = path.resolve("workspace-probe-f-main");
    const missing = path.resolve("workspace-probe-f-missing");
    const fs = createFs({
      [cwd]: [{ name: "src", isDirectory: true }],
      [missing]: "ENOENT",
    });
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const ledger = new IntentLedger({ now: () => 1000 });

    const snapshot = await ledger.getOrProbeWorkspace("session-f", "telegram", {
      cwd,
      extraRootsEnv: `${missing};${cwd}`,
      fs,
    });

    expect(snapshot.skippedRoots).toBe(1);
    expect(snapshot.roots).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[workspace-probe]"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("skipped=1"));
  });
});

describe("IntentLedger workspace cache", () => {
  it("uses cached workspace within TTL and reprobes after invalidation", async () => {
    let now = 10_000;
    const readdir = vi.fn(async (_targetPath: string) => [{ name: "src", isDirectory: true }]);
    const fs: WorkspaceProbeFs = {
      readdir,
      realpath: async (value: string) => value,
    };
    const ledger = new IntentLedger({ now: () => now });
    const cwd = path.resolve("workspace-probe-cache");

    const first = await ledger.getOrProbeWorkspace("session-cache", "telegram", {
      cwd,
      extraRootsEnv: "",
      fs,
    });
    const second = await ledger.getOrProbeWorkspace("session-cache", "telegram", {
      cwd,
      extraRootsEnv: "",
      fs,
    });

    expect(first.roots).toHaveLength(1);
    expect(second.roots).toHaveLength(1);
    expect(readdir).toHaveBeenCalledTimes(1);

    const invalidated = ledger.invalidateWorkspace("session-cache", "telegram");
    expect(invalidated).toBe(true);
    await ledger.getOrProbeWorkspace("session-cache", "telegram", {
      cwd,
      extraRootsEnv: "",
      fs,
    });
    expect(readdir).toHaveBeenCalledTimes(2);
  });

  it("respects OPENCLAW_WORKSPACE_TTL_MS override", async () => {
    vi.stubEnv("OPENCLAW_WORKSPACE_TTL_MS", "5");
    let now = 50_000;
    const probe = vi.fn(async () => ({
      defaultCwd: "/tmp/work",
      roots: [],
      capturedAt: now,
      ttlMs: WORKSPACE_SNAPSHOT_TTL_MS_DEFAULT,
      skippedRoots: 0,
    }));
    const ledger = new IntentLedger({ now: () => now });

    await ledger.getOrProbeWorkspace("session-ttl", "telegram", { probe });
    now += 4;
    await ledger.getOrProbeWorkspace("session-ttl", "telegram", { probe });
    now += 2;
    await ledger.getOrProbeWorkspace("session-ttl", "telegram", { probe });

    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe("projectWorkspaceForPrompt", () => {
  function makeRoot(rootPath: string, overrides: Partial<WorkspaceRoot> = {}): WorkspaceRoot {
    return {
      path: rootPath,
      topLevelDirs: ["src"],
      ...overrides,
    };
  }

  function makeSnapshot(roots: WorkspaceRoot[], defaultCwd?: string): WorkspaceSnapshot {
    return {
      defaultCwd: defaultCwd ?? roots[0]?.path ?? "/tmp",
      roots,
      capturedAt: 1_000,
      ttlMs: WORKSPACE_SNAPSHOT_TTL_MS_DEFAULT,
      skippedRoots: 0,
    };
  }

  it("returns empty string when snapshot is undefined or has no roots", () => {
    expect(projectWorkspaceForPrompt(undefined)).toBe("");
    const empty = makeSnapshot([], "/tmp/empty");
    expect(projectWorkspaceForPrompt(empty)).toBe("");
  });

  it("emits default_cwd, git remote+branch, marker and top-level dirs", () => {
    const cwd = path.resolve("project-a");
    const snapshot = makeSnapshot([
      makeRoot(cwd, {
        marker: "package.json",
        topLevelDirs: ["src", "tests"],
        hasGit: { remote: "git@github.com:org/repo.git", branch: "dev" },
      }),
    ]);

    const text = projectWorkspaceForPrompt(snapshot);
    expect(text).toContain(`default_cwd: ${cwd}`);
    expect(text).toContain("roots:");
    expect(text).toContain(`- ${cwd}`);
    expect(text).toContain("git=git@github.com:org/repo.git@dev");
    expect(text).toContain("has=package.json,src,tests");
  });

  it("fits 3 roots × 20 top-level entries within the default 200-token budget", () => {
    const roots: WorkspaceRoot[] = Array.from({ length: 3 }, (_, idx) =>
      makeRoot(path.resolve(`/tmp/r${String(idx)}`), {
        marker: "package.json",
        truncated: true,
        topLevelDirs: Array.from({ length: 20 }, (_, dirIdx) => `dir-${String(dirIdx)}`),
      }),
    );
    const text = projectWorkspaceForPrompt(makeSnapshot(roots, roots[0]!.path));
    const tokens = text.split(/[\s,]+/).filter(Boolean).length;
    expect(tokens).toBeLessThanOrEqual(WORKSPACE_PROJECTION_DEFAULT_MAX_TOKENS);
    expect(text.split("\n").some((line) => line.startsWith("  - "))).toBe(true);
  });

  it("drops top-level dirs first when budget is tight, keeping closest root", () => {
    const roots: WorkspaceRoot[] = Array.from({ length: 3 }, (_, idx) =>
      makeRoot(path.resolve(`/tmp/r${String(idx)}`), {
        marker: "package.json",
        topLevelDirs: Array.from({ length: 20 }, (_, dirIdx) => `dir-${String(dirIdx)}`),
      }),
    );
    const text = projectWorkspaceForPrompt(makeSnapshot(roots, roots[0]!.path), { maxTokens: 25 });
    expect(text).toContain(roots[0]!.path);
    expect(text).not.toMatch(/dir-0,dir-1/);
  });

  it("keeps the closest root even when budget cannot fit all roots", () => {
    const roots: WorkspaceRoot[] = Array.from({ length: 5 }, (_, idx) =>
      makeRoot(path.resolve(`/tmp/${"x".repeat(40)}-${String(idx)}`), {
        marker: "package.json",
      }),
    );
    const text = projectWorkspaceForPrompt(makeSnapshot(roots, roots[0]!.path), { maxTokens: 8 });
    expect(text).toContain(roots[0]!.path);
    expect(text).not.toContain(roots[4]!.path);
  });
});
