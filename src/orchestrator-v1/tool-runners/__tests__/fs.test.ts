/**
 * Tests for S1 — write/edit/read runners.
 *
 * Per V1-CUTOVER hard invariant #5 (tests catch real symptoms):
 *   - "write said ok:true but file is not on disk" → asserted via real
 *     `fs.readFile` after the runner returns.
 *   - "edit said ok:true but file unchanged" → asserted via real read +
 *     content compare; old_string-not-present must return ok:false.
 *   - All tests use real tmpdirs (`os.tmpdir()` + uuid suffix), cleaned
 *     up in afterEach. No mocks of the FS layer.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runEdit, runRead, runWrite } from "../fs.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `orch-v1-fs-runner-${randomUUID()}`);
  await fs.mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  if (existsSync(tmpRoot)) {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

describe("runWrite", () => {
  it("creates a file in an existing directory and returns args.path on success", async () => {
    const target = path.join(tmpRoot, "hello.txt");
    const content = "привет\nworld\n";

    const result = await runWrite({ path: target, content });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // dispatcher merges args+output; both must agree on path.
      expect(result.output.path).toBe(target);
    }
    // Real symptom: bot says ok:true but file is not on disk.
    expect(existsSync(target)).toBe(true);
    const onDisk = await fs.readFile(target, "utf8");
    expect(onDisk).toBe(content);
  });

  it("overwrites an existing file (write semantics, not append)", async () => {
    const target = path.join(tmpRoot, "exists.txt");
    await fs.writeFile(target, "OLD", "utf8");

    const result = await runWrite({ path: target, content: "NEW" });

    expect(result.ok).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("NEW");
  });

  it("creates parent directories that do not exist (recursive mkdir)", async () => {
    // Documented behaviour: runner creates parents, so this MUST succeed.
    // If the runner were ever changed to not-create-parents, this test
    // would fail and force a doc update.
    const target = path.join(tmpRoot, "deep", "nested", "dir", "file.txt");
    expect(existsSync(path.dirname(target))).toBe(false);

    const result = await runWrite({ path: target, content: "x" });

    expect(result.ok).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("x");
  });

  it("returns ok:false with non-empty error when path is a directory", async () => {
    // Cannot write a file when path resolves to an existing directory.
    const result = await runWrite({ path: tmpRoot, content: "x" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("supports empty content", async () => {
    const target = path.join(tmpRoot, "empty.txt");
    const result = await runWrite({ path: target, content: "" });
    expect(result.ok).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("");
  });
});

describe("runEdit", () => {
  it("replaces old_string with new_string and writes the file back", async () => {
    const target = path.join(tmpRoot, "edit.txt");
    await fs.writeFile(target, "alpha BETA gamma", "utf8");

    const result = await runEdit({
      path: target,
      old_string: "BETA",
      new_string: "delta",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.path).toBe(target);
    }
    // Real symptom: ok:true but file unchanged.
    const onDisk = await fs.readFile(target, "utf8");
    expect(onDisk).toBe("alpha delta gamma");
    expect(onDisk).not.toContain("BETA");
  });

  it("only replaces the first occurrence of old_string", async () => {
    const target = path.join(tmpRoot, "edit-first.txt");
    await fs.writeFile(target, "x x x", "utf8");

    const result = await runEdit({
      path: target,
      old_string: "x",
      new_string: "Y",
    });

    expect(result.ok).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("Y x x");
  });

  it("returns ok:false with error mentioning the missing string when old_string is not present", async () => {
    const target = path.join(tmpRoot, "edit-missing.txt");
    const original = "alpha beta gamma";
    await fs.writeFile(target, original, "utf8");

    const result = await runEdit({
      path: target,
      old_string: "ZETA-not-here",
      new_string: "X",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("old_string");
    }
    // Real symptom: returned ok:false but file changed anyway.
    expect(await fs.readFile(target, "utf8")).toBe(original);
  });

  it("returns ok:false when target file does not exist", async () => {
    const result = await runEdit({
      path: path.join(tmpRoot, "does-not-exist.txt"),
      old_string: "x",
      new_string: "y",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });

  it("supports replacing with empty new_string (deletion of substring)", async () => {
    const target = path.join(tmpRoot, "edit-delete.txt");
    await fs.writeFile(target, "keep [DROP] keep", "utf8");

    const result = await runEdit({
      path: target,
      old_string: " [DROP]",
      new_string: "",
    });

    expect(result.ok).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("keep keep");
  });

  it("preserves multi-line content around the replacement", async () => {
    const target = path.join(tmpRoot, "edit-multiline.txt");
    const original = "line 1\nline 2 OLD\nline 3\n";
    await fs.writeFile(target, original, "utf8");

    const result = await runEdit({
      path: target,
      old_string: "OLD",
      new_string: "NEW",
    });

    expect(result.ok).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe(
      "line 1\nline 2 NEW\nline 3\n",
    );
  });
});

describe("runRead", () => {
  it("returns ok:true and output.content matching the bytes on disk", async () => {
    const target = path.join(tmpRoot, "read.txt");
    const bytes = "hello\nworld\nкириллица\n";
    await fs.writeFile(target, bytes, "utf8");

    const result = await runRead({ path: target });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.content).toBe(bytes);
    }
  });

  it("returns ok:true with empty content for an empty file", async () => {
    const target = path.join(tmpRoot, "empty-read.txt");
    await fs.writeFile(target, "", "utf8");

    const result = await runRead({ path: target });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.content).toBe("");
    }
  });

  it("returns ok:false with non-empty error when the file does not exist", async () => {
    const result = await runRead({
      path: path.join(tmpRoot, "missing.txt"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("returns ok:false when path is a directory, not a file", async () => {
    const result = await runRead({ path: tmpRoot });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });
});

describe("write -> read -> edit -> read round trip", () => {
  it("produces consistent on-disk state across all three runners", async () => {
    const target = path.join(tmpRoot, "round-trip.md");

    const w = await runWrite({ path: target, content: "# Title\n\nbody-OLD\n" });
    expect(w.ok).toBe(true);

    const r1 = await runRead({ path: target });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.output.content).toBe("# Title\n\nbody-OLD\n");
    }

    const e = await runEdit({
      path: target,
      old_string: "body-OLD",
      new_string: "body-NEW",
    });
    expect(e.ok).toBe(true);

    const r2 = await runRead({ path: target });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.output.content).toBe("# Title\n\nbody-NEW\n");
    }
  });
});
