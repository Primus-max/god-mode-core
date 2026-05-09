/**
 * Direct-git allowlist guardrail (V1-CUTOVER S14 narrowed).
 *
 * Originally landed as Cutover-4 Phase 5
 * `lint:commitment:no-direct-git-outside-adapter`. The Cutover-4
 * gated wrapper (`repo-runtime-adapter.ts runRepoCommand`) was deleted
 * in V1-CUTOVER S14 (no production caller routed through it; legacy
 * fallback `agentCommandInternal` does not invoke git). The guardrail
 * itself is preserved because the THREE legacy direct-git sites
 * (`workspace-probe.ts`, `update-runner.ts`, runtime-source guardrail
 * scanner) MUST stay enumerated so a future contributor cannot quietly
 * add a fourth.
 *
 * The rule is a static-analysis vitest scan rather than an ESLint plugin
 * — same posture as `acp-binding-architecture.guardrail.test.ts` and
 * `runtime-source-guardrail-scan.ts`. Two assertions per run:
 *
 * 1. **Reverse-test (allowlist enumerated exactly).** Every production
 *    file under `src/**` (excluding `**\/*.test.ts`, `src/test-utils/**`,
 *    `**\/__tests__/**`) that contains `execFile('git'`, `execFileSync('git'`,
 *    or `spawn('git'` MUST be on the allowlist defined in the audit
 *    deliverable §h.
 * 2. **Forward-test (allowlist files present).** Every entry in the
 *    allowlist MUST exist on disk — prevents allowlist drift if a
 *    grandfathered file is later renamed/deleted.
 *
 * Failure messages cite the audit doc so future contributors can find
 * the rationale.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(process.cwd());

/**
 * Files allowed to invoke `git` directly via `node:child_process`.
 *
 * This list MUST stay in lock-step with `extensions/AUDIT-cutover4-repo-operation.md`
 * §h. Adding a new entry requires (1) a sub-plan amendment, (2) maintainer
 * signoff, and (3) updating the audit allowlist.
 */
const ALLOWED_DIRECT_GIT_FILES: ReadonlyArray<string> = [
  // §a.1 — orchestrator-internal git probe (predates kernel).
  "src/platform/session/workspace-probe.ts",
  // §a.2 — orchestrator self-update (predates kernel).
  "src/infra/update-runner.ts",
  // §a.5 — runtime-source guardrail scanner (test-only utility, but lives
  // outside `**\/*.test.ts` so listed explicitly).
  "src/test-utils/runtime-source-guardrail-scan.ts",
  // V1-CUTOVER S14: Cutover-4 Phase 5 gated git wrapper
  // (`repo-runtime-adapter.ts runRepoCommand`) deleted as orphan. No
  // production code routed through it; legacy fallback path does not
  // invoke git from agent code.
];

const SKIP_PATTERNS: ReadonlyArray<RegExp> = [
  /\.test\.tsx?$/,
  /\.test-helpers\.tsx?$/,
  /\.test-utils\.tsx?$/,
  /[\\/]__tests__[\\/]/,
  /[\\/]test-utils[\\/]/,
  /\.d\.ts$/,
];

/**
 * Pattern matching `execFile("git"`, `execFileSync("git"`, or
 * `spawn("git"` (single OR double quotes, optional whitespace). Does NOT
 * match `'mode: "git"'` discriminator strings or other non-argv-0 uses
 * because the literal must appear immediately after the call site's open
 * paren.
 */
const FORBIDDEN_DIRECT_GIT =
  /\b(?:execFile|execFileSync|spawn|spawnSync|exec)\s*\(\s*["']git["']/g;

function* walk(dir: string): Generator<string> {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      // Skip node_modules / dist explicitly — performance + correctness.
      if (entry === "node_modules" || entry === "dist" || entry === ".git") {
        continue;
      }
      yield* walk(full);
    } else if (stat.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      yield full;
    }
  }
}

function isSkipped(relPath: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(relPath));
}

function findOffenders(): string[] {
  const offenders: string[] = [];
  const allowedSet = new Set(ALLOWED_DIRECT_GIT_FILES.map((p) => p.replaceAll("\\", "/")));
  const srcRoot = path.join(REPO_ROOT, "src");
  for (const abs of walk(srcRoot)) {
    const rel = path.relative(REPO_ROOT, abs).replaceAll("\\", "/");
    if (isSkipped(rel)) continue;
    const text = readFileSync(abs, "utf8");
    if (!FORBIDDEN_DIRECT_GIT.test(text)) continue;
    // Reset `.lastIndex` so the global regex stays usable on next file.
    FORBIDDEN_DIRECT_GIT.lastIndex = 0;
    if (!allowedSet.has(rel)) {
      offenders.push(rel);
    }
  }
  return offenders;
}

describe("lint:commitment:no-direct-git-outside-adapter", () => {
  it("rejects direct git invocation outside the allowlist (Phase 5 invariant)", () => {
    const offenders = findOffenders();
    if (offenders.length > 0) {
      throw new Error(
        `Direct git invocation forbidden outside the allowlist. ` +
          `New direct-git sites require a sub-plan amendment + maintainer ` +
          `signoff (V1-CUTOVER S14 deleted the Cutover-4 gated wrapper as ` +
          `orphan; the three remaining sites are grandfathered). ` +
          `Allowlist sites are documented in ` +
          `extensions/AUDIT-cutover4-repo-operation.md §h.\n\n` +
          `Offending files:\n${offenders.map((f) => `  - ${f}`).join("\n")}`,
      );
    }
  });

  it("forward-test: every allowlist entry exists on disk (no drift)", () => {
    for (const rel of ALLOWED_DIRECT_GIT_FILES) {
      const abs = path.join(REPO_ROOT, rel);
      const stat = statSync(abs);
      expect(stat.isFile()).toBe(true);
    }
  });

  it("allowlist enumerates EXACTLY the three grandfathered direct-git sites", () => {
    // Locks the cardinality so future PRs cannot silently widen the
    // allowlist without amending this test (i.e. without updating the
    // audit doc and bumping the count here). Was 4 before V1-CUTOVER
    // S14 — the Cutover-4 gated wrapper (`repo-runtime-adapter.ts`)
    // was deleted as orphan because no production caller routed
    // through it.
    expect(ALLOWED_DIRECT_GIT_FILES).toHaveLength(3);
  });
});
