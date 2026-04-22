import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const WORKSPACE_SNAPSHOT_TTL_MS_DEFAULT = 5 * 60 * 1000;
export const WORKSPACE_PROJECTION_DEFAULT_MAX_TOKENS = 200;
const GIT_TIMEOUT_MS = 1_000;
const MAX_TOP_LEVEL_DIRS = 20;

type WorkspaceMarker = "package.json" | "pyproject.toml" | "Cargo.toml" | "openclaw";

export type WorkspaceRoot = {
  path: string;
  hasGit?: {
    remote?: string;
    branch?: string;
  };
  marker?: WorkspaceMarker;
  topLevelDirs: string[];
  truncated?: boolean;
};

export type WorkspaceSnapshot = {
  defaultCwd: string;
  roots: WorkspaceRoot[];
  capturedAt: number;
  ttlMs: number;
  skippedRoots: number;
};

export type WorkspaceProbeDirent = {
  name: string;
  isDirectory: boolean;
};

export type WorkspaceProbeFs = {
  readdir: (targetPath: string) => Promise<WorkspaceProbeDirent[]>;
  realpath?: (targetPath: string) => Promise<string>;
};

export type ProbeWorkspaceOptions = {
  extraRootsEnv?: string;
  cwd?: string;
  fs?: WorkspaceProbeFs;
  ttlMs?: number;
  readGitInfo?: (rootPath: string) => Promise<{ remote?: string; branch?: string } | undefined>;
};

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeForKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function parseRootList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(/[;,]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function markerFromEntries(entryNames: Set<string>): WorkspaceMarker | undefined {
  if (entryNames.has("package.json")) {
    return "package.json";
  }
  if (entryNames.has("pyproject.toml")) {
    return "pyproject.toml";
  }
  if (entryNames.has("Cargo.toml")) {
    return "Cargo.toml";
  }
  if (entryNames.has(".openclaw")) {
    return "openclaw";
  }
  return undefined;
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      ((error as { code?: unknown }).code === "ENOENT" ||
        (error as { code?: unknown }).code === "ENOTDIR"),
  );
}

async function resolveGitInfo(rootPath: string): Promise<{ remote?: string; branch?: string } | undefined> {
  try {
    const remote = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: rootPath,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
    });
    const branch = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: rootPath,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
    });
    const normalizedRemote = remote.stdout.trim();
    const normalizedBranch = branch.stdout.trim();
    if (!normalizedRemote && !normalizedBranch) {
      return undefined;
    }
    return {
      ...(normalizedRemote ? { remote: normalizedRemote } : {}),
      ...(normalizedBranch ? { branch: normalizedBranch } : {}),
    };
  } catch {
    return undefined;
  }
}

const DEFAULT_FS: WorkspaceProbeFs = {
  async readdir(targetPath: string) {
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  },
  realpath: (targetPath: string) => fs.realpath(targetPath),
};

async function resolveCandidateRoots(params: {
  defaultCwd: string;
  extraRootsEnv?: string;
  fs: WorkspaceProbeFs;
}): Promise<string[]> {
  const candidates = [
    params.defaultCwd,
    ...parseRootList(params.extraRootsEnv).map((entry) =>
      path.isAbsolute(entry) ? entry : path.resolve(params.defaultCwd, entry),
    ),
  ];
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const absoluteCandidate = path.resolve(candidate);
    const realPath = params.fs.realpath
      ? await params.fs
          .realpath(absoluteCandidate)
          .catch(() => absoluteCandidate)
      : absoluteCandidate;
    const dedupeKey = normalizeForKey(realPath);
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    resolved.push(realPath);
  }
  return resolved;
}

export async function probeWorkspace(options: ProbeWorkspaceOptions = {}): Promise<WorkspaceSnapshot> {
  const now = Date.now();
  const fsAdapter = options.fs ?? DEFAULT_FS;
  const defaultCwd = path.resolve(options.cwd ?? process.cwd());
  const readGitInfo = options.readGitInfo ?? resolveGitInfo;
  const ttlMs =
    options.ttlMs ??
    resolvePositiveInt(process.env.OPENCLAW_WORKSPACE_TTL_MS, WORKSPACE_SNAPSHOT_TTL_MS_DEFAULT);

  const roots = await resolveCandidateRoots({
    defaultCwd,
    extraRootsEnv: options.extraRootsEnv ?? process.env.OPENCLAW_WORKSPACE_ROOTS,
    fs: fsAdapter,
  });

  const snapshotRoots: WorkspaceRoot[] = [];
  let skippedRoots = 0;
  for (const rootPath of roots) {
    let rootEntries: WorkspaceProbeDirent[];
    try {
      rootEntries = await fsAdapter.readdir(rootPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        skippedRoots += 1;
        continue;
      }
      throw error;
    }
    const topLevelDirsAll = rootEntries
      .filter((entry) => entry.isDirectory && !entry.name.startsWith("."))
      .map((entry) => entry.name);
    const topLevelDirs = topLevelDirsAll.slice(0, MAX_TOP_LEVEL_DIRS);
    const truncated = topLevelDirsAll.length > MAX_TOP_LEVEL_DIRS;
    const entryNames = new Set(rootEntries.map((entry) => entry.name));
    const marker = markerFromEntries(entryNames);
    let gitInfo: { remote?: string; branch?: string } | undefined;
    if (entryNames.has(".git")) {
      try {
        gitInfo = await readGitInfo(rootPath);
      } catch {
        gitInfo = undefined;
      }
    }

    snapshotRoots.push({
      path: rootPath,
      ...(marker ? { marker } : {}),
      ...(gitInfo ? { hasGit: gitInfo } : {}),
      topLevelDirs,
      ...(truncated ? { truncated: true } : {}),
    });
  }

  return {
    defaultCwd,
    roots: snapshotRoots,
    capturedAt: now,
    ttlMs,
    skippedRoots,
  };
}

export type ProjectWorkspaceForPromptOptions = {
  maxTokens?: number;
};

function countApproxTokens(text: string): number {
  return text.split(/[\s,]+/).filter(Boolean).length;
}

function formatRootLine(root: WorkspaceRoot, includeTopLevel: boolean): string {
  const features: string[] = [];
  if (root.hasGit) {
    const remote = root.hasGit.remote?.trim() ?? "";
    const branch = root.hasGit.branch?.trim() ?? "";
    if (remote || branch) {
      const gitValue = branch ? `${remote}${remote ? "@" : ""}${branch}` : remote;
      features.push(`git=${gitValue}`);
    }
  }
  const has: string[] = [];
  if (root.marker) {
    has.push(root.marker);
  }
  if (includeTopLevel && root.topLevelDirs.length > 0) {
    has.push(...root.topLevelDirs);
  }
  if (has.length > 0) {
    features.push(`has=${has.join(",")}`);
  }
  const featureSuffix = features.length > 0 ? ` [${features.join("] [")}]` : "";
  return `  - ${root.path}${featureSuffix}`;
}

function buildWorkspaceProjection(
  snapshot: WorkspaceSnapshot,
  roots: WorkspaceRoot[],
  includeTopLevel: boolean,
): string {
  const lines: string[] = [`default_cwd: ${snapshot.defaultCwd}`, "roots:"];
  for (const root of roots) {
    lines.push(formatRootLine(root, includeTopLevel));
  }
  return lines.join("\n");
}

/**
 * Renders a workspace snapshot as a compact prompt block. Returns an empty string when the
 * snapshot is missing or has no roots — the caller should not emit `<workspace></workspace>`
 * around an empty body. The projection trims top-level dirs first, then drops far roots until
 * the budget fits, so the closest root always survives.
 */
export function projectWorkspaceForPrompt(
  snapshot: WorkspaceSnapshot | undefined,
  options: ProjectWorkspaceForPromptOptions = {},
): string {
  if (!snapshot || snapshot.roots.length === 0) {
    return "";
  }
  const maxTokens = options.maxTokens ?? WORKSPACE_PROJECTION_DEFAULT_MAX_TOKENS;
  const fullText = buildWorkspaceProjection(snapshot, snapshot.roots, true);
  if (countApproxTokens(fullText) <= maxTokens) {
    return fullText;
  }
  const slimText = buildWorkspaceProjection(snapshot, snapshot.roots, false);
  if (countApproxTokens(slimText) <= maxTokens) {
    return slimText;
  }
  let trimmedRoots = snapshot.roots.slice(0, snapshot.roots.length);
  while (trimmedRoots.length > 1) {
    trimmedRoots = trimmedRoots.slice(0, -1);
    const text = buildWorkspaceProjection(snapshot, trimmedRoots, false);
    if (countApproxTokens(text) <= maxTokens) {
      return text;
    }
  }
  return buildWorkspaceProjection(snapshot, trimmedRoots, false);
}
