/**
 * Cutover-4 Phase 5 — repo runtime adapter.
 *
 * Sibling of Cutover-3 Phase 5 `artifact-runtime-adapter.ts` (PR-#198).
 * The adapter is the WRITE side of the cutover-4
 * `WorldStateSnapshot.repo` slice (Phase 3): it receives a structural
 * repo-operation descriptor produced by the gated `runRepoCommand`
 * wrapper (or, in tests, constructed directly), validates the kind /
 * branchName / collector availability, appends a `RepoOperationRecord`
 * to the injected `RepoWorldStateCollector`, and emits the matching
 * `ExpectedDelta.repo.added` so the four Phase 4 done-predicates can
 * resolve the `repoOperationId` on commitmentSatisfied.
 *
 * Boundary discipline:
 * - Lives in `src/agents/pi-embedded-runner/run/`, NOT in
 *   `src/platform/commitment/` — invariant #8.
 * - Reads STRUCTURAL inputs only (kind, branchName, sha, sessionId,
 *   turnId). Never reads raw user text — invariants #5, #6.
 * - Failure surface is a closed string union (`transport_error` /
 *   `repo_root_missing` / `kind_unsupported` / `observer_unavailable` /
 *   `git_binary_unavailable` / `branch_name_invalid`). The function
 *   NEVER throws — invariant #15. Repo tracking is observability, not
 *   gating; emit-site failure must not downgrade the calling commitment
 *   turn.
 *
 * `runRepoCommand` is the ONLY sanctioned path for user-facing `git`
 * invocation per the NEW invariant proposed in
 * `extensions/AUDIT-cutover4-repo-operation.md` §h. The closed `kind`
 * enum drives args composition — callers cannot supply free-form shell
 * strings (invariants #5/#6).
 */

import { spawnSync } from "node:child_process";

import {
  type RepoTurnKey,
  type RepoWorldStateCollector,
} from "../../../platform/commitment/repo-world-state-observer.js";
import type { SessionId } from "../../../platform/commitment/ids.js";
import type {
  ExpectedDelta,
  RepoExpectedDelta,
} from "../../../platform/commitment/expected-delta.js";
import type { ISO8601 } from "../../../platform/commitment/ids.js";
import type { RepoOperationRecord } from "../../../platform/commitment/world-state.js";

const SUPPORTED_KINDS: ReadonlySet<RepoOperationRecord["kind"]> = new Set([
  "branch_created",
  "commit_landed",
  "merge_completed",
  "diff_observed",
]);

/**
 * Closed regex matching valid git ref/branch names. Excludes whitespace,
 * leading/trailing dots, double dots, and shell metacharacters. Tighter
 * than `git check-ref-format` but safe-by-default for the gated tool
 * surface — the caller is the model, not a maintainer typing arbitrary
 * branches.
 */
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/\-]+$/u;

let monotonicCounter = 0;

function nextRepoOperationId(kind: RepoOperationRecord["kind"]): string {
  monotonicCounter += 1;
  return `repo:${kind}:${Date.now()}:${monotonicCounter}`;
}

function isValidBranchName(name: string | undefined): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name.startsWith(".") || name.endsWith(".")) return false;
  if (name.includes("..")) return false;
  return BRANCH_NAME_PATTERN.test(name);
}

export interface RecordRepoOperationInput {
  /**
   * Append-only collector backing `WorldStateSnapshot.repo`. In production
   * this is `getProcessRepoWorldStateCollector()` (the singleton wired
   * into `createDefaultMonitoredRuntime` in Phase 3); tests inject a
   * deterministic instance.
   */
  readonly collector: RepoWorldStateCollector;
  readonly sessionId: SessionId;
  readonly turnId: string;
  readonly kind: RepoOperationRecord["kind"];
  readonly branchName?: string;
  readonly commitSha?: string;
  readonly baseSha?: string;
  readonly mergeBaseSha?: string;
  readonly filesChanged?: number;
  readonly insertions?: number;
  readonly deletions?: number;
  readonly repoRoot?: string;
  /**
   * When omitted, the adapter mints a deterministic-ish id of the form
   * `repo:<kind>:<timestamp>:<counter>`. Production callers may forward
   * a tool-side id to keep traces JOIN-able.
   */
  readonly repoOperationId?: string;
  /**
   * Optional sink for the `[repo-runtime-adapter]` telemetry line.
   * Defaults to a no-op so tests do not pollute stdout; production
   * wiring (Phase 5+ caller in `repo-tool.ts`) injects the gateway
   * logger.
   */
  readonly logger?: (line: string) => void;
}

export type RecordRepoOperationFailureReason =
  | "transport_error"
  | "repo_root_missing"
  | "kind_unsupported"
  | "observer_unavailable"
  | "git_binary_unavailable"
  | "branch_name_invalid";

export type RecordRepoOperationResult =
  | {
      readonly ok: true;
      readonly repoOperationId: string;
      readonly expectedDelta: ExpectedDelta;
    }
  | {
      readonly ok: false;
      readonly reason: RecordRepoOperationFailureReason;
      readonly detail?: string;
    };

/**
 * Records a repo-operation emit on the active turn. Returns a typed
 * result — never throws.
 *
 * The closed failure set is exhaustive:
 * - `observer_unavailable` — collector dependency missing (defensive
 *   guard for production wiring before the singleton is initialized);
 * - `kind_unsupported` — kind outside the closed enum
 *   `branch_created | commit_landed | merge_completed | diff_observed`;
 * - `branch_name_invalid` — branchName empty or contains forbidden
 *   characters (the closed regex `BRANCH_NAME_PATTERN` rejects spaces,
 *   shell metacharacters, leading/trailing dots, and `..`);
 * - `repo_root_missing` — repoRoot not supplied when required by
 *   downstream consumers (currently informational; reserved for the
 *   `runRepoCommand` integration path);
 * - `git_binary_unavailable` — git binary not resolvable at the time of
 *   record (reserved for future probe; not exercised by the in-memory
 *   record path);
 * - `transport_error` — collector throws (Zod schema rejection on
 *   malformed sha, etc.).
 *
 * The `expectedDelta` returned on success carries `repo.added:
 * [repoOperationId]`. Callers MERGE this into the commitment-runtime
 * `expectedDelta` before invoking `monitoredRuntime.run(...)` so the
 * Phase 4 done-predicates resolve the repoOperationId.
 */
export function recordRepoOperation(
  input: RecordRepoOperationInput,
): RecordRepoOperationResult {
  if (!input.collector || typeof input.collector.record !== "function") {
    return { ok: false, reason: "observer_unavailable" };
  }

  if (!SUPPORTED_KINDS.has(input.kind as RepoOperationRecord["kind"])) {
    return { ok: false, reason: "kind_unsupported", detail: String(input.kind) };
  }

  // branchName is mandatory for branch_created / merge_completed; for
  // commit_landed and diff_observed it is informational. When supplied,
  // it MUST conform to BRANCH_NAME_PATTERN to keep gated surfaces safe.
  const branchRequired =
    input.kind === "branch_created" || input.kind === "merge_completed";
  if (branchRequired && !isValidBranchName(input.branchName)) {
    return {
      ok: false,
      reason: "branch_name_invalid",
      detail: input.branchName,
    };
  }
  if (
    !branchRequired &&
    input.branchName !== undefined &&
    !isValidBranchName(input.branchName)
  ) {
    return {
      ok: false,
      reason: "branch_name_invalid",
      detail: input.branchName,
    };
  }

  const repoOperationId = input.repoOperationId ?? nextRepoOperationId(input.kind);
  const observedAt = new Date().toISOString();

  const record: RepoOperationRecord = {
    repoOperationId,
    kind: input.kind,
    ...(input.branchName !== undefined ? { branchName: input.branchName } : {}),
    ...(input.commitSha !== undefined ? { commitSha: input.commitSha } : {}),
    ...(input.baseSha !== undefined ? { baseSha: input.baseSha } : {}),
    ...(input.mergeBaseSha !== undefined ? { mergeBaseSha: input.mergeBaseSha } : {}),
    ...(input.filesChanged !== undefined ? { filesChanged: input.filesChanged } : {}),
    ...(input.insertions !== undefined ? { insertions: input.insertions } : {}),
    ...(input.deletions !== undefined ? { deletions: input.deletions } : {}),
    ...(input.repoRoot !== undefined ? { repoRoot: input.repoRoot } : {}),
    observedAt: observedAt as ISO8601,
  };

  const turnKey: RepoTurnKey = {
    sessionId: input.sessionId,
    turnId: input.turnId,
  };

  try {
    input.collector.record(record, turnKey);
  } catch (err) {
    return {
      ok: false,
      reason: "transport_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  input.logger?.(
    `[repo-runtime-adapter] recordRepoOperation kind=${input.kind} path=${
      input.repoRoot ?? "(unset)"
    } sessionId=${input.sessionId} turnId=${input.turnId} repoOperationId=${repoOperationId}`,
  );

  const repoDelta: RepoExpectedDelta = {
    added: Object.freeze([repoOperationId]),
  };
  const expectedDelta: ExpectedDelta = { repo: repoDelta };

  return { ok: true, repoOperationId, expectedDelta };
}

// ─── Gated git wrapper (NEW invariant — closed kind enum) ────────────

const DEFAULT_GIT_TIMEOUT_MS = 60_000;

/**
 * Closed per-kind args contract. The gated wrapper composes argv from
 * these structured fields — never from a free-form shell string. This
 * is the structural enforcement of the NEW invariant proposed in
 * `extensions/AUDIT-cutover4-repo-operation.md` §h:
 *
 * > Direct `execFile('git', …)` outside this wrapper is forbidden.
 * > Every user-driven git invocation MUST flow through
 * > `runRepoCommand(...)`, which composes argv from a closed kind enum
 * > + per-kind structured args.
 */
export type RunRepoCommandArgs =
  | {
      readonly kind: "branch_created";
      readonly args: {
        readonly branchName: string;
        readonly baseRef?: string;
        readonly checkoutAfterCreate?: boolean;
      };
    }
  | {
      readonly kind: "commit_landed";
      readonly args: {
        readonly commitMessage: string;
        readonly filesIncluded?: readonly string[];
        readonly signedOff?: boolean;
        readonly author?: string;
      };
    }
  | {
      readonly kind: "merge_completed";
      readonly args: {
        readonly sourceBranch: string;
        readonly targetBranch: string;
        readonly strategy?: string;
        readonly fastForward?: boolean;
        readonly squash?: boolean;
      };
    }
  | {
      readonly kind: "diff_observed";
      readonly args: {
        readonly baseRef?: string;
        readonly headRef?: string;
        readonly pathFilter?: string;
        readonly includeStatus?: boolean;
      };
    };

export type RunRepoCommandInput = RunRepoCommandArgs & {
  readonly repoRoot: string;
  readonly timeoutMs?: number;
  readonly logger?: (line: string) => void;
};

export type RunRepoCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
};

/**
 * Composes the git argv for a given `kind` + per-kind structured args.
 * Throws when `kind` is outside the closed enum (defense in depth — the
 * Zod schema in `repo-tool.ts` is the primary gate, but this is the
 * second line).
 */
function composeArgv(input: RunRepoCommandArgs): string[] {
  switch (input.kind) {
    case "branch_created": {
      const { branchName, baseRef, checkoutAfterCreate } = input.args;
      if (!isValidBranchName(branchName)) {
        throw new Error(`runRepoCommand: branch_name_invalid (${branchName})`);
      }
      if (checkoutAfterCreate === true) {
        return baseRef
          ? ["checkout", "-b", branchName, baseRef]
          : ["checkout", "-b", branchName];
      }
      return baseRef
        ? ["branch", branchName, baseRef]
        : ["branch", branchName];
    }
    case "commit_landed": {
      const { commitMessage, signedOff, author } = input.args;
      // `filesIncluded` is consumed in the upstream staging phase
      // (`git add --`) — by the time `git commit` runs, the desired
      // files are already in the index.
      const argv: string[] = ["commit", "-m", commitMessage];
      if (signedOff === true) argv.splice(1, 0, "--signoff");
      if (typeof author === "string" && author.length > 0) {
        argv.splice(1, 0, `--author=${author}`);
      }
      return argv;
    }
    case "merge_completed": {
      const { sourceBranch, targetBranch, strategy, fastForward, squash } = input.args;
      if (!isValidBranchName(sourceBranch)) {
        throw new Error(
          `runRepoCommand: branch_name_invalid (sourceBranch=${sourceBranch})`,
        );
      }
      if (!isValidBranchName(targetBranch)) {
        throw new Error(
          `runRepoCommand: branch_name_invalid (targetBranch=${targetBranch})`,
        );
      }
      const argv: string[] = ["merge"];
      if (fastForward === true) argv.push("--ff-only");
      if (fastForward === false) argv.push("--no-ff");
      if (squash === true) argv.push("--squash");
      if (typeof strategy === "string" && strategy.length > 0) {
        argv.push("--strategy", strategy);
      }
      argv.push(sourceBranch);
      // Caller has switched to targetBranch via runtime convention; the
      // structural arg is carried for record-keeping in the
      // RepoOperationRecord but NOT for in-place checkout.
      void targetBranch;
      return argv;
    }
    case "diff_observed": {
      const { baseRef, headRef, pathFilter, includeStatus } = input.args;
      const argv: string[] = ["diff"];
      if (includeStatus === true) argv.push("--stat");
      if (baseRef && headRef) argv.push(`${baseRef}..${headRef}`);
      else if (baseRef) argv.push(baseRef);
      if (pathFilter && pathFilter.length > 0) argv.push("--", pathFilter);
      return argv;
    }
    default: {
      // Defensive — exhaustive switch over the closed enum.
      const exhaustive: never = input;
      throw new Error(
        `runRepoCommand: kind_unsupported (${JSON.stringify(exhaustive)})`,
      );
    }
  }
}

function runOne(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync("git", [...argv], {
    cwd,
    timeout: timeoutMs,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdoutStr = typeof result.stdout === "string" ? result.stdout : "";
  const stderrStr = typeof result.stderr === "string" ? result.stderr : "";
  let exitCode: number;
  if (result.error) {
    exitCode = -1;
  } else if (typeof result.status === "number") {
    exitCode = result.status;
  } else {
    exitCode = -1;
  }
  return {
    exitCode,
    stdout: stdoutStr,
    stderr: stderrStr || (result.error ? result.error.message : ""),
  };
}

/**
 * The ONLY sanctioned path for user-facing `git` invocation per the
 * NEW invariant proposed in `extensions/AUDIT-cutover4-repo-operation.md`
 * §h. Returns a typed result `{ exitCode, stdout, stderr, elapsedMs }`.
 *
 * Uses `node:child_process.spawnSync` with `windowsHide: true` so the
 * gateway never spawns a visible terminal window on Windows hosts.
 * `spawnSync` is chosen over `execFile` because it returns a structured
 * synchronous result (status / stdout / stderr / signal) without
 * requiring callbacks — keeping `repo-tool.ts` and the runtime adapter
 * test path simple. The closed `kind` enum + per-kind structured args
 * means callers cannot inject free-form shell — invariants #5/#6.
 *
 * Non-zero exit codes are RETURNED, not thrown. The caller
 * (`repo-tool.ts`) decides whether to record the operation. Failures
 * to even spawn the binary (e.g. missing `git`) are surfaced as
 * `exitCode === -1` so the caller can map them to the closed reason
 * `git_failed`.
 *
 * `commit_landed` is composite: stages `filesIncluded` via `git add --`
 * before `git commit -m ...`. Both invocations flow through this gate
 * (one process per phase) so the lint rule remains satisfied. Failures
 * in the staging phase short-circuit and surface the staging stderr.
 */
export function runRepoCommand(input: RunRepoCommandInput): RunRepoCommandResult {
  const timeoutMs = input.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const startedAt = Date.now();

  // commit_landed needs `git add` before `git commit`; the staging
  // phase still flows through this gate (same allowlisted file).
  if (input.kind === "commit_landed") {
    const filesIncluded = input.args.filesIncluded;
    if (filesIncluded && filesIncluded.length > 0) {
      const stage = runOne(
        ["add", "--", ...filesIncluded],
        input.repoRoot,
        timeoutMs,
      );
      if (stage.exitCode !== 0) {
        const elapsedMs = Date.now() - startedAt;
        input.logger?.(
          `[repo-runtime-adapter] runRepoCommand kind=commit_landed phase=stage repoRoot=${input.repoRoot} exitCode=${stage.exitCode} elapsedMs=${elapsedMs}`,
        );
        return {
          exitCode: stage.exitCode,
          stdout: stage.stdout,
          stderr: stage.stderr,
          elapsedMs,
        };
      }
    }
  }

  const argv = composeArgv(input);
  const main = runOne(argv, input.repoRoot, timeoutMs);
  const elapsedMs = Date.now() - startedAt;
  input.logger?.(
    `[repo-runtime-adapter] runRepoCommand kind=${input.kind} repoRoot=${input.repoRoot} exitCode=${main.exitCode} elapsedMs=${elapsedMs}`,
  );
  return { ...main, elapsedMs };
}
