#!/usr/bin/env node
/**
 * Cross-platform A2UI bundle (replaces bundle-a2ui.sh for Windows / no-bash environments).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const HASH_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/.bundle.hash");
const OUTPUT_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/a2ui.bundle.js");
const A2UI_RENDERER_DIR = path.join(ROOT_DIR, "vendor/a2ui/renderers/lit");
const A2UI_APP_DIR = path.join(ROOT_DIR, "apps/shared/OpenClawKit/Tools/CanvasA2UI");

function onError() {
  console.error("A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle");
  console.error("If this persists, verify pnpm deps and try again.");
}

/** @param {string} entryPath @param {string[]} files */
async function walk(entryPath, files) {
  const st = await fs.stat(entryPath);
  if (st.isDirectory()) {
    const entries = await fs.readdir(entryPath);
    for (const entry of entries) {
      await walk(path.join(entryPath, entry), files);
    }
    return;
  }
  files.push(entryPath);
}

/** @param {string} p */
function normalize(p) {
  return p.split(path.sep).join("/");
}

/** @param {string[]} inputPaths */
async function computeHash(inputPaths) {
  const files = [];
  for (const input of inputPaths) {
    await walk(input, files);
  }
  files.sort((a, b) => normalize(a).localeCompare(normalize(b)));
  const hash = createHash("sha256");
  for (const filePath of files) {
    const rel = normalize(path.relative(ROOT_DIR, filePath));
    hash.update(rel);
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function findRolldownCli() {
  const flat = path.join(ROOT_DIR, "node_modules/.pnpm/node_modules/rolldown/bin/cli.mjs");
  if (fsSync.existsSync(flat)) {
    return flat;
  }
  const pnpmDir = path.join(ROOT_DIR, "node_modules/.pnpm");
  if (!fsSync.existsSync(pnpmDir)) {
    return null;
  }
  for (const entry of fsSync.readdirSync(pnpmDir)) {
    if (!entry.startsWith("rolldown@")) {
      continue;
    }
    const cli = path.join(pnpmDir, entry, "node_modules/rolldown/bin/cli.mjs");
    if (fsSync.existsSync(cli)) {
      return cli;
    }
  }
  return null;
}

/**
 * @param {string} cmd
 * @param {string[]} args
 */
function run(cmd, args) {
  const shell = process.platform === "win32";
  const r = spawnSync(cmd, args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    shell,
    env: process.env,
  });
  return r.status ?? 1;
}

/**
 * @param {string} configPath
 */
function runRolldown(configPath) {
  if (run("rolldown", ["-c", configPath]) === 0) {
    return 0;
  }
  const cli = findRolldownCli();
  if (cli) {
    if (run(process.execPath, [cli, "-c", configPath]) === 0) {
      return 0;
    }
  }
  if (run("pnpm", ["-s", "exec", "rolldown", "-c", configPath]) === 0) {
    return 0;
  }
  return run("pnpm", ["-s", "dlx", "rolldown", "-c", configPath]);
}

async function main() {
  const rendererExists = fsSync.existsSync(A2UI_RENDERER_DIR);
  const appExists = fsSync.existsSync(A2UI_APP_DIR);
  if (!rendererExists || !appExists) {
    if (fsSync.existsSync(OUTPUT_FILE)) {
      console.log("A2UI sources missing; keeping prebuilt bundle.");
      return;
    }
    console.error(`A2UI sources missing and no prebuilt bundle found at: ${OUTPUT_FILE}`);
    process.exit(1);
  }

  const inputPaths = [
    path.join(ROOT_DIR, "package.json"),
    path.join(ROOT_DIR, "pnpm-lock.yaml"),
    A2UI_RENDERER_DIR,
    A2UI_APP_DIR,
  ];

  const currentHash = await computeHash(inputPaths);
  if (fsSync.existsSync(HASH_FILE)) {
    const previousHash = fsSync.readFileSync(HASH_FILE, "utf8").trim();
    if (previousHash === currentHash && fsSync.existsSync(OUTPUT_FILE)) {
      console.log("A2UI bundle up to date; skipping.");
      return;
    }
  }

  const tsconfig = path.join(A2UI_RENDERER_DIR, "tsconfig.json");
  let code = run("pnpm", ["-s", "exec", "tsc", "-p", tsconfig]);
  if (code !== 0) {
    onError();
    process.exit(code);
  }

  const configPath = path.join(A2UI_APP_DIR, "rolldown.config.mjs");
  code = runRolldown(configPath);
  if (code !== 0) {
    onError();
    process.exit(code);
  }

  fsSync.writeFileSync(HASH_FILE, `${currentHash}\n`);
}

main().catch((err) => {
  onError();
  console.error(err);
  process.exit(1);
});
