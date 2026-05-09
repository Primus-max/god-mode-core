/**
 * V1-CONTRACT-ONLY — exec runner tests (S2).
 *
 * Real-symptom coverage: spawns Node via the platform shell and verifies
 *   - success path  → ok:true + captured stdout
 *   - non-zero exit → ok:false + exit code in error
 *   - cwd honoured  → command sees the cwd we set
 *   - deny-list     → blocked commands never spawn
 *   - truncation    → oversized stdout returns ≤ threshold + tail marker
 *
 * Cross-platform strategy: we write each JS snippet to a tmp file and
 * invoke `node <file>` so we avoid the cmd.exe / PowerShell quoting hell
 * that surrounds `node -e "<expr>"`.
 */

import fsSync from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runExec } from "../exec.js";

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "exec-runner-test-"));
});

afterAll(() => {
  try {
    fsSync.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

/** Quote a path/string for the active shell as a literal value. */
function quoteForShell(value: string): string {
  if (process.platform === "win32") {
    // PowerShell: single-quoted strings are literal; escape ' as ''.
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Write `jsSource` to a tmp .js file and return a shell command that runs
 * `node <file>` and propagates node's exit code.
 */
async function nodeRun(jsSource: string): Promise<string> {
  const file = path.join(tmpRoot, `snippet-${Math.random().toString(36).slice(2)}.js`);
  await writeFile(file, jsSource, "utf8");
  const exe = quoteForShell(process.execPath);
  const arg = quoteForShell(file);
  if (process.platform === "win32") {
    // PS strips one quote layer when calling external EXEs and does NOT
    // propagate the EXE's exit code to its own exit code, so we surface it
    // explicitly.
    return `& ${exe} ${arg} ; exit $LASTEXITCODE`;
  }
  return `${exe} ${arg}`;
}

describe("orchestrator-v1 / runExec", () => {
  it("returns ok:true with captured stdout for a successful command", async () => {
    const cmd = await nodeRun(`console.log("hello-from-node");`);
    const result = await runExec({ command: cmd });
    if (!result.ok) {
      throw new Error(`expected ok:true, got error: ${result.error}`);
    }
    expect(result.output.command).toBe(cmd);
    expect(String(result.output.output)).toContain("hello-from-node");
  });

  it("returns ok:false with exit code in error on non-zero exit", async () => {
    const cmd = await nodeRun(`process.exit(2);`);
    const result = await runExec({ command: cmd });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/exit code 2/);
    }
  });

  it("honours cwd — command sees the directory we set", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "exec-runner-cwd-"));
    const cmd = await nodeRun(`process.stdout.write(process.cwd());`);
    const result = await runExec({ command: cmd, cwd: tmp });
    if (!result.ok) {
      throw new Error(`expected ok:true, got error: ${result.error}`);
    }
    const printed = String(result.output.output).trim();
    const resolvedPrinted = path.resolve(printed).toLowerCase();
    const resolvedTmp = path.resolve(tmp).toLowerCase();
    expect(resolvedPrinted).toBe(resolvedTmp);
  });

  it("blocks `rm -rf /` via the deny-list without spawning", async () => {
    const result = await runExec({ command: "rm -rf /" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/blocked/i);
  });

  it("blocks `rm -rf ~` via the deny-list", async () => {
    const result = await runExec({ command: "rm -rf ~" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/blocked/i);
  });

  it("blocks `mkfs.ext4 /dev/sda1` via the deny-list", async () => {
    const result = await runExec({ command: "mkfs.ext4 /dev/sda1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/blocked/i);
  });

  it("blocks `dd if=/dev/zero of=/dev/sda` via the deny-list", async () => {
    const result = await runExec({ command: "dd if=/dev/zero of=/dev/sda bs=1M" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/blocked/i);
  });

  it("blocks the classic fork bomb via the deny-list", async () => {
    const result = await runExec({ command: ":(){ :|:& };:" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/blocked/i);
  });

  it("blocks an empty / whitespace-only command", async () => {
    const result = await runExec({ command: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/blocked|empty/i);
  });

  it("does NOT block a benign command — sanity-check the gate", async () => {
    const cmd = await nodeRun(`console.log("benign-ok");`);
    const result = await runExec({ command: cmd });
    if (!result.ok) {
      throw new Error(`expected ok:true, got error: ${result.error}`);
    }
    expect(String(result.output.output)).toContain("benign-ok");
  });

  it("truncates oversized stdout and keeps the tail marker", async () => {
    // 10 KB → expect ≤ 4 KB returned + truncation marker.
    const cmd = await nodeRun(`process.stdout.write("x".repeat(10000));`);
    const result = await runExec({ command: cmd });
    if (!result.ok) {
      throw new Error(`expected ok:true, got error: ${result.error}`);
    }
    const out = String(result.output.output);
    expect(out.length).toBeLessThanOrEqual(4 * 1024 + 64);
    expect(out).toMatch(/truncated/);
    expect(out.endsWith("x")).toBe(true);
  });
});
