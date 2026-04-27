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

const sourceRoots = [
  path.join(repoRoot, "src"),
  path.join(repoRoot, "extensions"),
  path.join(repoRoot, "scripts"),
];

export const FORBIDDEN_SYMBOLS = new Set([
  "UserPrompt",
  "RawUserTurn",
  "RawUserText",
]);

const whitelistRelative = [
  "src/platform/commitment/raw-user-turn.ts",
  "src/platform/commitment/intent-contractor.ts",
];

export const WHITELIST_RELATIVE = new Set(whitelistRelative);

const whitelistAbsolute = new Set(
  whitelistRelative.map((relative) =>
    path.join(repoRoot, relative.replaceAll("/", path.sep)),
  ),
);

function shouldSkipFile(filePath) {
  if (/\.(test|spec)\.ts$/.test(filePath)) {
    return true;
  }
  if (/\btest-utils\.ts$/.test(filePath)) {
    return true;
  }
  return false;
}

/**
 * Scans TypeScript source for forbidden imports of `UserPrompt` /
 * `RawUserTurn` / `RawUserText`. Aliased imports
 * (`import { RawUserTurn as X }`) are caught via `propertyName`.
 *
 * Pure function: does not consult the whitelist. Whitelist enforcement is the
 * caller's responsibility (see `main`). This separation lets tests assert the
 * detection logic independently of the file-path policy.
 *
 * @param {string} content - TypeScript source text.
 * @param {string} [fileName] - Synthetic name for AST diagnostics.
 * @returns {Array<{ line: number, symbol: string, importedFrom: string, alias: string | null }>}
 */
export function findRawUserTextImports(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const importedFrom = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) {
      continue;
    }
    if (clause.name && FORBIDDEN_SYMBOLS.has(clause.name.text)) {
      violations.push({
        line: toLine(sourceFile, clause.name),
        symbol: clause.name.text,
        importedFrom,
        alias: null,
      });
    }
    const bindings = clause.namedBindings;
    if (!bindings) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      continue;
    }
    for (const element of bindings.elements) {
      const propertyName = element.propertyName?.text ?? element.name.text;
      if (!FORBIDDEN_SYMBOLS.has(propertyName)) {
        continue;
      }
      const alias = element.propertyName ? element.name.text : null;
      violations.push({
        line: toLine(sourceFile, element),
        symbol: propertyName,
        importedFrom,
        alias,
      });
    }
  }
  return violations;
}

/**
 * Returns true when the absolute file path belongs to the small whitelist of
 * sites permitted to import `UserPrompt` / `RawUserTurn` / `RawUserText`.
 *
 * @param {string} absoluteFilePath - Absolute path to a `.ts` file.
 * @returns {boolean}
 */
export function isWhitelistedRawUserTextFile(absoluteFilePath) {
  return whitelistAbsolute.has(absoluteFilePath);
}

async function main() {
  const files = await collectTypeScriptFilesFromRoots(sourceRoots, {
    extraTestSuffixes: [".test.ts"],
  });
  const violations = [];
  for (const filePath of files) {
    if (shouldSkipFile(filePath)) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    const imports = findRawUserTextImports(content, filePath);
    if (imports.length === 0) {
      continue;
    }
    if (isWhitelistedRawUserTextFile(filePath)) {
      continue;
    }
    for (const violation of imports) {
      violations.push({
        path: path.relative(repoRoot, filePath),
        ...violation,
      });
    }
  }

  if (violations.length === 0) {
    return;
  }

  console.error(
    "Forbidden import of UserPrompt / RawUserTurn / RawUserText outside the whitelist.",
  );
  console.error(
    "Hard invariants #5 and #6: only the IntentContractor (src/platform/commitment/intent-contractor.ts)",
  );
  console.error(
    "and the type definition file (src/platform/commitment/raw-user-turn.ts) may import these symbols.",
  );
  for (const violation of violations) {
    const aliasNote = violation.alias ? ` as ${violation.alias}` : "";
    console.error(
      `- ${violation.path}:${String(violation.line)} imports { ${violation.symbol}${aliasNote} } from "${violation.importedFrom}"`,
    );
  }
  process.exit(1);
}

runAsScript(import.meta.url, main);
