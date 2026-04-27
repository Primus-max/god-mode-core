#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectTypeScriptFilesFromRoots,
  runAsScript,
  toLine,
} from "./lib/ts-guard-utils.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sourceRoots = [path.join(repoRoot, "src", "platform", "commitment")];

const DECISION_DIR_POSIX = "src/platform/decision";

function toPosix(value) {
  return value.replaceAll("\\", "/");
}

function isInsideDecisionDir(repoRelativePath) {
  const posix = toPosix(repoRelativePath);
  return (
    posix === DECISION_DIR_POSIX ||
    posix.startsWith(`${DECISION_DIR_POSIX}/`)
  );
}

/**
 * Resolves an import specifier to a repo-relative path when the specifier is a
 * relative path. Returns `null` for bare specifiers (`react`, `node:os`,
 * `openclaw/plugin-sdk`, etc.).
 *
 * @param {string} importingFileRepoRelative - Repo-relative path of the
 *   importing file (forward slashes).
 * @param {string} specifier - The string literal from the import statement.
 * @returns {string | null}
 */
function resolveRelativeSpecifier(importingFileRepoRelative, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return null;
  }
  const importerDir = path.posix.dirname(toPosix(importingFileRepoRelative));
  const resolved = path.posix.normalize(
    path.posix.join(importerDir, specifier),
  );
  return resolved.replace(/\.(?:js|ts|mjs|cjs|tsx|jsx)$/u, "");
}

/**
 * Scans a `src/platform/commitment/**` source for imports that point into
 * `src/platform/decision/`. Pure function: caller passes the repo-relative
 * path of the importing file so relative imports resolve correctly.
 *
 * @param {string} content - TypeScript source text.
 * @param {string} importingFileRepoRelative - Repo-relative path of the
 *   importing file using forward slashes (e.g. `src/platform/commitment/x.ts`).
 * @returns {Array<{ line: number, importedFrom: string, resolved: string }>}
 */
export function findDecisionImportsFromCommitment(
  content,
  importingFileRepoRelative,
) {
  const sourceFile = ts.createSourceFile(
    importingFileRepoRelative,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) &&
      !ts.isExportDeclaration(statement)
    ) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) {
      continue;
    }
    const importedFrom = moduleSpecifier.text;
    const resolved = resolveRelativeSpecifier(
      importingFileRepoRelative,
      importedFrom,
    );
    if (resolved === null) {
      continue;
    }
    if (!isInsideDecisionDir(resolved)) {
      continue;
    }
    violations.push({
      line: toLine(sourceFile, moduleSpecifier),
      importedFrom,
      resolved,
    });
  }
  return violations;
}

async function main() {
  const files = await collectTypeScriptFilesFromRoots(sourceRoots, {
    extraTestSuffixes: [".test.ts"],
  });
  const violations = [];
  for (const filePath of files) {
    const repoRelative = toPosix(path.relative(repoRoot, filePath));
    const content = await fs.readFile(filePath, "utf8");
    const fileViolations = findDecisionImportsFromCommitment(
      content,
      repoRelative,
    );
    for (const violation of fileViolations) {
      violations.push({ path: repoRelative, ...violation });
    }
  }

  if (violations.length === 0) {
    return;
  }

  console.error(
    "src/platform/commitment/** must not import from src/platform/decision/** (hard invariant #8).",
  );
  console.error(
    "Direction is enforced one-way: decision -> commitment is allowed (see DecisionTrace.shadowCommitment),",
  );
  console.error(
    "but commitment -> decision is forbidden so the new kernel never inherits legacy classifier semantics.",
  );
  for (const violation of violations) {
    console.error(
      `- ${violation.path}:${String(violation.line)} imports "${violation.importedFrom}" -> ${violation.resolved}`,
    );
  }
  process.exit(1);
}

runAsScript(import.meta.url, main);
