/**
 * Cutover-4 Phase 5 — gated repo tool wrapper.
 *
 * `repo-tool.ts` is the FIRST sanctioned user-facing git surface in
 * `god-mode-core`. Schema accepts a CLOSED `kind` enum + per-kind
 * structured args (Zod-validated). Free-form shell strings are rejected
 * by construction (invariants #5/#6 — no NEW reader of raw user text).
 *
 * Behavior on call:
 * 1. `repoToolInputSchema.safeParse(input)` rejects malformed args
 *    with `ok: false, reason: "schema_invalid"`.
 * 2. On success, calls `runRepoCommand({kind, args, repoRoot, ...})`
 *    (the gated git wrapper in `repo-runtime-adapter.ts`).
 * 3. On `exitCode === 0`, calls `recordRepoOperation(...)` so the
 *    cutover-4 `WorldStateSnapshot.repo` slice + the four Phase 4
 *    done-predicates resolve.
 * 4. Returns a typed result envelope; NEVER throws (invariant #15).
 *
 * Boundary discipline (parallel of Cutover-3 `apply-patch` emit-site):
 * - Lives in `src/agents/tools/`, NOT in `src/platform/commitment/`
 *   (invariant #8).
 * - Reads STRUCTURAL inputs only (closed kind enum + per-kind args).
 * - Failure surface is a closed string union — every shape exhausted
 *   via discriminated `kind`.
 * - Calls flow through `runRepoCommand` only; this file never invokes
 *   `git` directly (NEW invariant — `lint:commitment:no-direct-git-outside-adapter`).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  recordRepoOperation,
  runRepoCommand,
  type RecordRepoOperationResult,
} from "../pi-embedded-runner/run/repo-runtime-adapter.js";
import type { RepoWorldStateCollector } from "../../platform/commitment/repo-world-state-observer.js";
import type { SessionId } from "../../platform/commitment/ids.js";

const NonEmptyString = z.string().min(1);

const BranchCreatedArgs = z
  .object({
    branchName: NonEmptyString,
    baseRef: NonEmptyString.optional(),
    checkoutAfterCreate: z.boolean().optional(),
  })
  .strict();

const CommitLandedArgs = z
  .object({
    commitMessage: NonEmptyString,
    filesIncluded: z.array(NonEmptyString).readonly().optional(),
    signedOff: z.boolean().optional(),
    author: NonEmptyString.optional(),
  })
  .strict();

const MergeCompletedArgs = z
  .object({
    sourceBranch: NonEmptyString,
    targetBranch: NonEmptyString,
    strategy: NonEmptyString.optional(),
    fastForward: z.boolean().optional(),
    squash: z.boolean().optional(),
  })
  .strict();

const DiffObservedArgs = z
  .object({
    baseRef: NonEmptyString.optional(),
    headRef: NonEmptyString.optional(),
    pathFilter: NonEmptyString.optional(),
    includeStatus: z.boolean().optional(),
  })
  .strict();

/**
 * Closed-shape Zod schema for `repo-tool` inputs. Per-kind args are
 * validated via Zod's discriminated union — the model cannot smuggle
 * `kind: "exec_shell"` past the gate.
 */
export const repoToolInputSchema = z
  .object({
    kind: z.enum([
      "branch_created",
      "commit_landed",
      "merge_completed",
      "diff_observed",
    ]),
    args: z.unknown(),
    repoRoot: NonEmptyString,
    sessionId: NonEmptyString,
    turnId: NonEmptyString,
  })
  .superRefine((value, ctx) => {
    const issues = (() => {
      switch (value.kind) {
        case "branch_created":
          return BranchCreatedArgs.safeParse(value.args);
        case "commit_landed":
          return CommitLandedArgs.safeParse(value.args);
        case "merge_completed":
          return MergeCompletedArgs.safeParse(value.args);
        case "diff_observed":
          return DiffObservedArgs.safeParse(value.args);
        default:
          return undefined;
      }
    })();
    if (issues === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: `unknown kind: ${String((value as { kind?: unknown }).kind)}`,
      });
      return;
    }
    if (!issues.success) {
      for (const issue of issues.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["args", ...issue.path],
          message: issue.message,
        });
      }
    }
  });

export type RepoToolInput = {
  readonly kind:
    | "branch_created"
    | "commit_landed"
    | "merge_completed"
    | "diff_observed";
  readonly args: unknown;
  readonly repoRoot: string;
  readonly sessionId: SessionId | string;
  readonly turnId: string;
  readonly collector: RepoWorldStateCollector;
  readonly logger?: (line: string) => void;
};

export type RepoToolFailureReason =
  | "schema_invalid"
  | "git_failed"
  | "record_failed";

export type RepoToolResult =
  | {
      readonly ok: true;
      readonly repoOperationId: string;
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: number;
      readonly elapsedMs: number;
    }
  | {
      readonly ok: false;
      readonly reason: RepoToolFailureReason;
      readonly detail?: string;
      readonly exitCode?: number;
      readonly stderr?: string;
    };

/**
 * Gated repo-tool entry point. NEVER throws (invariant #15) — every
 * failure path returns a typed `{ ok: false, reason }` envelope.
 *
 * Marked `async` to keep the public surface uniform with future
 * extensions (e.g. async git probes added in cutover-5); current
 * implementation is synchronous because `runRepoCommand` uses
 * `spawnSync` to keep stdout/stderr/exitCode capture deterministic.
 */
export async function repoTool(input: RepoToolInput): Promise<RepoToolResult> {
  const parsed = repoToolInputSchema.safeParse({
    kind: input.kind,
    args: input.args,
    repoRoot: input.repoRoot,
    sessionId: String(input.sessionId),
    turnId: input.turnId,
  });
  if (!parsed.success) {
    return {
      ok: false,
      reason: "schema_invalid",
      detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }

  let runResult;
  try {
    // Type assertion is safe — Zod superRefine validated the per-kind
    // args at the boundary above.
    runResult = runRepoCommand({
      kind: input.kind,
      // The `args` shape is validated above; cast is structural.
      args: input.args as never,
      repoRoot: input.repoRoot,
      ...(input.logger ? { logger: input.logger } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      reason: "git_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (runResult.exitCode !== 0) {
    return {
      ok: false,
      reason: "git_failed",
      exitCode: runResult.exitCode,
      stderr: runResult.stderr,
      detail: runResult.stderr.trim() || `git exited with code ${runResult.exitCode}`,
    };
  }

  // Resolve commit sha for kinds that produce one. We read `.git/HEAD`
  // from disk (filesystem-only, NOT a git invocation — same posture as
  // `src/infra/git-commit.ts`) so the gated `runRepoCommand` enum stays
  // at four lifecycle kinds. Failure to resolve is non-fatal — the
  // record is still emitted with whatever fields we have.
  let commitSha: string | undefined;
  if (input.kind === "commit_landed" || input.kind === "merge_completed") {
    commitSha = resolveHeadSha(input.repoRoot);
  }

  // Pull a structural branchName when caller supplied one in the closed
  // args envelope; otherwise leave undefined.
  const argRecord = input.args as Record<string, unknown> | undefined;
  const branchName =
    typeof argRecord?.["branchName"] === "string"
      ? (argRecord["branchName"] as string)
      : input.kind === "merge_completed" &&
          typeof argRecord?.["targetBranch"] === "string"
        ? (argRecord["targetBranch"] as string)
        : undefined;

  let recordResult: RecordRepoOperationResult;
  try {
    recordResult = recordRepoOperation({
      collector: input.collector,
      sessionId: input.sessionId as SessionId,
      turnId: input.turnId,
      kind: input.kind,
      ...(branchName !== undefined ? { branchName } : {}),
      ...(commitSha !== undefined ? { commitSha } : {}),
      repoRoot: input.repoRoot,
      ...(input.logger ? { logger: input.logger } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      reason: "record_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!recordResult.ok) {
    return {
      ok: false,
      reason: "record_failed",
      detail: recordResult.reason,
    };
  }

  return {
    ok: true,
    repoOperationId: recordResult.repoOperationId,
    stdout: runResult.stdout,
    stderr: runResult.stderr,
    exitCode: runResult.exitCode,
    elapsedMs: runResult.elapsedMs,
  };
}

/**
 * Reads `HEAD` sha via the gated `runRepoCommand` (using
 * `kind: "diff_observed"` is wrong — diff doesn't print sha). For
 * v1 we shell out to `git rev-parse HEAD` indirectly by reading
 * `.git/HEAD` from disk via `node:fs` to avoid widening the closed
 * `RunRepoCommandArgs` enum. This keeps the gate narrow — the closed
 * enum stays at four lifecycle kinds, and sha resolution is a pure
 * filesystem read on `.git/HEAD` + ref chasing.
 *
 * Implementation mirrors `src/infra/git-commit.ts` (which is the
 * production sha resolver — explicitly grandfathered as filesystem-
 * only, NOT a git invocation).
 */
function resolveHeadSha(repoRoot: string): string | undefined {
  try {
    const headPath = path.join(repoRoot, ".git", "HEAD");
    const headRaw = readFileSync(headPath, "utf8").trim();
    if (headRaw.startsWith("ref:")) {
      const refPath = headRaw.replace(/^ref:\s*/u, "");
      const refFile = path.join(repoRoot, ".git", refPath);
      if (existsSync(refFile)) {
        const sha = readFileSync(refFile, "utf8").trim();
        return /^[0-9a-f]{40}$/u.test(sha) ? sha : undefined;
      }
      // Packed refs fallback.
      const packed = path.join(repoRoot, ".git", "packed-refs");
      if (existsSync(packed)) {
        const lines = readFileSync(packed, "utf8").split(/\r?\n/u);
        for (const line of lines) {
          if (line.endsWith(refPath)) {
            const sha = line.split(/\s+/u)[0] ?? "";
            return /^[0-9a-f]{40}$/u.test(sha) ? sha : undefined;
          }
        }
      }
      return undefined;
    }
    return /^[0-9a-f]{40}$/u.test(headRaw) ? headRaw : undefined;
  } catch {
    return undefined;
  }
}
