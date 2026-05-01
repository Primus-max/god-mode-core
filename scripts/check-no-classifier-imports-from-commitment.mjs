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
const CLASSIFIER_PATH = "src/platform/decision/task-classifier";

function toPosix(value) {
  return value.replaceAll("\\", "/");
}

function resolveRelativeSpecifier(importingFileRepoRelative, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return null;
  }
  const importerDir = path.posix.dirname(toPosix(importingFileRepoRelative));
  return path.posix
    .normalize(path.posix.join(importerDir, specifier))
    .replace(/\.(?:js|ts|mjs|cjs|tsx|jsx)$/u, "");
}

/**
 * Finds imports from commitment code into the legacy task classifier.
 *
 * @param {string} content - TypeScript source text.
 * @param {string} importingFileRepoRelative - Repo-relative importer path.
 * @returns {Array<{ line: number, importedFrom: string, resolved: string }>}
 */
export function findClassifierImportsFromCommitment(content, importingFileRepoRelative) {
  const sourceFile = ts.createSourceFile(
    importingFileRepoRelative,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) {
      continue;
    }
    const importedFrom = moduleSpecifier.text;
    const resolved = resolveRelativeSpecifier(importingFileRepoRelative, importedFrom);
    if (resolved !== CLASSIFIER_PATH) {
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
    for (const violation of findClassifierImportsFromCommitment(content, repoRelative)) {
      violations.push({ path: repoRelative, ...violation });
    }
  }

  if (violations.length === 0) {
    return;
  }

  console.error(
    "src/platform/commitment/** must not import legacy task-classifier output.",
  );
  console.error(
    "Hard invariant #1/#16: commitment resolution must flow through SemanticIntent and affordance candidates.",
  );
  for (const violation of violations) {
    console.error(
      `- ${violation.path}:${String(violation.line)} imports "${violation.importedFrom}" -> ${violation.resolved}`,
    );
  }
  process.exit(1);
}

runAsScript(import.meta.url, main);
