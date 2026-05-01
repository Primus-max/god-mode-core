#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectTypeScriptFilesFromRoots,
  runAsScript,
} from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sourceRoots = [
  path.join(repoRoot, "src", "platform", "decision"),
  path.join(repoRoot, "src", "platform", "commitment", "intent-contractor-impl.ts"),
  path.join(repoRoot, "src", "platform", "planner"),
  path.join(repoRoot, "src", "platform", "recipe"),
  path.join(repoRoot, "src", "platform", "runtime"),
  path.join(repoRoot, "src", "agents", "tools"),
].map((absolute) => absolute);

const forbiddenPatterns = [
  {
    id: "format-word-regex-union",
    description:
      "regex literal unions over deliverable format keywords (pdf|docx|xlsx|csv|html|zip|site) indicate parsing of user input",
    regex:
      /\/(?:[^/\n\\]|\\.)*\b(?:pdf|docx|xlsx|csv|html|zip|site|word|excel|эксель|ворд|сайт|таблиц|документ|картинк|файл)[^/\n]*\|(?:[^/\n\\]|\\.)*\/[gimsuy]*/i,
  },
  {
    id: "cyrillic-keyword-regex",
    description:
      "regex literal containing Cyrillic request keywords means we are parsing user prompt text",
    regex: /\/(?:[^/\n\\]|\\.)*[\u0400-\u04FF]{3,}(?:[^/\n\\]|\\.)*\/[gimsuy]*/,
  },
  {
    id: "format-keyword-array",
    description:
      "array of deliverable/format keyword strings used as a matching dictionary",
    regex:
      /\[(?:\s*["'`](?:pdf|docx|xlsx|csv|html|zip|site|word|excel|эксель|ворд|сайт|документ|картинк|файл)[a-zа-я]*["'`]\s*,\s*){2,}["'`][^"'`]+["'`]\s*\]/i,
  },
];

const allowedFiles = new Set(
  [
    "src/platform/decision/resolution-contract.ts",
    "src/platform/decision/route-preflight.ts",
    "src/agents/tools/image-generate-tool.ts",
    "src/agents/tools/image-tool.ts",
    "src/agents/tools/pdf-tool.ts",
  ].map((relative) => path.join(repoRoot, relative.replaceAll("/", path.sep))),
);

function shouldSkip(filePath) {
  if (allowedFiles.has(filePath)) {
    return true;
  }
  if (/\.(test|spec)\.ts$/.test(filePath)) {
    return true;
  }
  if (/\btest-utils\.ts$/.test(filePath)) {
    return true;
  }
  return false;
}

function stripCommentsAndStrings(content) {
  let out = "";
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];
    if (ch === "/" && next === "/") {
      while (i < content.length && content[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) {
        out += content[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < content.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function scanContent(content) {
  const sanitized = stripCommentsAndStrings(content);
  const lines = sanitized.split(/\r?\n/);
  const violations = [];
  lines.forEach((line, idx) => {
    for (const rule of forbiddenPatterns) {
      if (rule.regex.test(line)) {
        violations.push({
          line: idx + 1,
          reason: `${rule.id}: ${rule.description}`,
          snippet: line.trim().slice(0, 200),
        });
      }
    }
  });
  return violations;
}

async function main() {
  const files = await collectTypeScriptFilesFromRoots(sourceRoots, {
    extraTestSuffixes: [".test.ts"],
  });
  const violations = [];
  for (const filePath of files) {
    if (shouldSkip(filePath)) continue;
    const content = await fs.readFile(filePath, "utf8");
    const fileViolations = scanContent(content);
    for (const v of fileViolations) {
      violations.push({ path: path.relative(repoRoot, filePath), ...v });
    }
  }

  if (violations.length === 0) {
    return;
  }

  console.error(
    "Detected prompt-parsing heuristics in routing-critical code (decision/planner/recipe/runtime/tools).",
  );
  console.error(
    "User intent must be resolved by the LLM classifier into DeliverableSpec — never by regex or keyword dictionaries.",
  );
  for (const v of violations) {
    console.error(`- ${v.path}:${v.line} ${v.reason}`);
    console.error(`    ${v.snippet}`);
  }
  process.exit(1);
}

runAsScript(import.meta.url, main);
