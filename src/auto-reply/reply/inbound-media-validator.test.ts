/**
 * V1-CLOSE T5 — colocated tests for the inbound media validator.
 *
 * Charter §4 T5 acceptance cases:
 *   (a) traversal attempt rejected
 *   (b) missing file rejected
 *   (c) oversize file rejected (deterministic via `statSizeBytes` seam)
 *   (d) valid path passes
 *
 * Per AGENTS.md "Tests must catch real bugs":
 *   - No `vi.spyOn` on the function under test.
 *   - The traversal / missing / valid cases write real fixtures into a
 *     real `os.tmpdir()` subdirectory and let the validator hit
 *     `node:fs.existsSync` + `node:fs.statSync` for real.
 *   - The oversize case wires the documented `statSizeBytes` seam so
 *     a 25 MiB+ fixture does not need to land on disk during CI.
 *   - The "logger is invoked" assertions exercise the real telemetry
 *     emit path — the seam is the public `log` option, NOT a spy on
 *     the validator's internal logger.
 *
 * Pre-fix evidence (charter §1): the frozen resolver
 * `inbound-image-reference-precondition-resolver.ts:62` trusts any
 * string the channel adapter hands it. Without this validator a
 * forwarded filename like `safe/root/../../etc/passwd` would survive
 * straight through to `image_generate.image` injection — these tests
 * pin the regression so the trust gap stays closed.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InboundMediaSummary } from "./agent-runner-execution.js";
import {
  DEFAULT_INBOUND_MEDIA_MAX_BYTES,
  classifyAttachment,
  validateInboundMediaSummary,
} from "./inbound-media-validator.js";

let tmpRoot: string;
let validImagePath: string;
let emptyImagePath: string;

beforeAll(() => {
  // Real temp directory under `os.tmpdir()` so the default allowed-
  // roots list (which includes `os.tmpdir()`) admits the fixture.
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "openclaw-t5-validator-"));
  validImagePath = path.join(tmpRoot, "valid.jpg");
  writeFileSync(validImagePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  emptyImagePath = path.join(tmpRoot, "empty.jpg");
  writeFileSync(emptyImagePath, Buffer.alloc(0));
});

afterAll(() => {
  // Best-effort cleanup; do not let a Windows handle race fail the suite.
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeSummary(...paths: string[]): InboundMediaSummary {
  return {
    attachments: paths.map((p) => ({
      kind: "image" as const,
      path: p,
      mimeType: "image/jpeg",
    })),
  };
}

describe("validateInboundMediaSummary — charter T5 cases", () => {
  it("(a) traversal attempt rejected — `/safe/root/../../etc/passwd` does NOT escape allowed roots", () => {
    // The raw input is a path-traversal sequence. After `path.resolve`
    // the `..` segments collapse so the absolute form is well outside
    // both `~/.openclaw/` and `os.tmpdir()`. The validator must drop
    // the entry AND emit a `reason=traversal` telemetry line.
    const lines: string[] = [];
    const summary = makeSummary("/safe/root/../../etc/passwd");
    const result = validateInboundMediaSummary(summary, {
      log: (line) => lines.push(line),
    });
    expect(result).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[inbound-media\] event=validation_failed reason=traversal /);
  });

  it("(a2) traversal — even after resolution, paths outside allowed roots are rejected", () => {
    // Pure absolute path outside any allowed root — no `..` involved,
    // verifies the containment check is the gate (not a string-match
    // on `..`).
    const lines: string[] = [];
    const result = validateInboundMediaSummary(makeSummary("/etc/passwd"), {
      log: (line) => lines.push(line),
    });
    expect(result).toBeUndefined();
    expect(lines[0]).toMatch(/reason=traversal/);
  });

  it("(b) missing file rejected — non-existent path under an allowed root drops the entry", () => {
    // Path lives inside `os.tmpdir()` (allowed) but the file does not
    // exist on disk. Reason must be `absent`, not `traversal`.
    const lines: string[] = [];
    const ghostPath = path.join(tmpRoot, "does-not-exist.png");
    expect(existsSync(ghostPath)).toBe(false);
    const result = validateInboundMediaSummary(makeSummary(ghostPath), {
      log: (line) => lines.push(line),
    });
    expect(result).toBeUndefined();
    expect(lines[0]).toMatch(/reason=absent/);
  });

  it("(c) oversize rejected — file > maxBytes drops the entry with reason=oversize", () => {
    // Use the documented `statSizeBytes` seam to report 26 MiB without
    // writing a 26 MiB fixture. Default cap is 25 MiB
    // (`DEFAULT_INBOUND_MEDIA_MAX_BYTES`).
    const lines: string[] = [];
    const result = validateInboundMediaSummary(makeSummary(validImagePath), {
      log: (line) => lines.push(line),
      statSizeBytes: () => DEFAULT_INBOUND_MEDIA_MAX_BYTES + 1,
    });
    expect(result).toBeUndefined();
    expect(lines[0]).toMatch(/reason=oversize/);
  });

  it("(c2) oversize — custom maxBytes honoured", () => {
    // Caller-overridden cap: a 1 KiB fixture rejected when cap is 512 B.
    const lines: string[] = [];
    const result = validateInboundMediaSummary(makeSummary(validImagePath), {
      log: (line) => lines.push(line),
      statSizeBytes: () => 1024,
      maxBytes: 512,
    });
    expect(result).toBeUndefined();
    expect(lines[0]).toMatch(/reason=oversize/);
  });

  it("(c3) empty file rejected — size === 0 drops with reason=empty", () => {
    // A real on-disk empty file. Distinct reason from `absent` so ops
    // can tell whether the channel adapter wrote a zero-byte file vs.
    // never wrote one at all.
    const lines: string[] = [];
    const result = validateInboundMediaSummary(makeSummary(emptyImagePath), {
      log: (line) => lines.push(line),
    });
    expect(result).toBeUndefined();
    expect(lines[0]).toMatch(/reason=empty/);
  });

  it("(d) valid path passes — file exists, size > 0, size <= cap, inside allowed root", () => {
    // The happy path: real file in `os.tmpdir()` under the cap. The
    // validator must return the same shape and emit NO telemetry.
    const lines: string[] = [];
    const summary = makeSummary(validImagePath);
    const result = validateInboundMediaSummary(summary, {
      log: (line) => lines.push(line),
    });
    expect(result).toBeDefined();
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments[0]?.path).toBe(validImagePath);
    expect(lines).toHaveLength(0);
  });

  it("(d2) valid path under a custom extra allowed root", () => {
    // Production wiring threads the configured Telegram media cache
    // via `extraAllowedRoots`. Pin: a path under that root must pass
    // even when it lives outside `~/.openclaw/` and `os.tmpdir()`.
    const lines: string[] = [];
    const customRoot = mkdtempSync(path.join(os.tmpdir(), "openclaw-t5-extra-"));
    try {
      const filePath = path.join(customRoot, "in-extra.jpg");
      writeFileSync(filePath, Buffer.from([0x00, 0x01]));
      const result = validateInboundMediaSummary(makeSummary(filePath), {
        log: (line) => lines.push(line),
        extraAllowedRoots: [customRoot],
      });
      expect(result?.attachments[0]?.path).toBe(filePath);
      expect(lines).toHaveLength(0);
    } finally {
      try {
        rmSync(customRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("webchat entries (path === '') bypass validation and remain in summary", () => {
    // Charter §4 T5 spec: webchat structural entries carry no disk
    // path. The validator must NOT drop them — the resolver auto-skips
    // them via `path.length > 0`, but the modality filter still needs
    // to see `kind: "image"` so the model lookup happens.
    const summary: InboundMediaSummary = {
      attachments: [{ kind: "image", path: "", mimeType: "image/png" }],
    };
    const lines: string[] = [];
    const result = validateInboundMediaSummary(summary, {
      log: (line) => lines.push(line),
    });
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments[0]?.path).toBe("");
    expect(lines).toHaveLength(0);
  });

  it("mixed summary — valid + invalid: drops only the bad entry, emits one line", () => {
    // Cross-channel scenario: webchat `path:""` + good Telegram path +
    // bad traversal path. Webchat survives, good survives, bad dropped.
    const lines: string[] = [];
    const summary: InboundMediaSummary = {
      attachments: [
        { kind: "image", path: "", mimeType: "image/png" },
        { kind: "image", path: validImagePath, mimeType: "image/jpeg" },
        { kind: "image", path: "/etc/passwd", mimeType: "image/jpeg" },
      ],
    };
    const result = validateInboundMediaSummary(summary, {
      log: (line) => lines.push(line),
    });
    expect(result?.attachments).toHaveLength(2);
    expect(result?.attachments.map((a) => a.path)).toEqual(["", validImagePath]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/reason=traversal/);
  });

  it("undefined input passes through as undefined", () => {
    // Pre-validation contract — `buildInboundMediaSummaryForTurn`
    // returns `undefined` when no inbound media surfaced. The
    // validator must preserve that sentinel rather than synthesising
    // an empty-attachments summary.
    expect(validateInboundMediaSummary(undefined)).toBeUndefined();
  });

  it("empty-attachments input collapses to undefined", () => {
    // Same contract — defensive normalization so callers cannot leak
    // a zero-length `attachments` array (which would silently flip
    // resolver branches).
    expect(validateInboundMediaSummary({ attachments: [] })).toBeUndefined();
  });

  it("telemetry line — newlines in raw path are flattened so log greps don't break", () => {
    // Defensive: a forwarded filename containing a newline must not
    // produce a multi-line telemetry record (would break log parsers
    // looking for one event per line).
    const lines: string[] = [];
    validateInboundMediaSummary(makeSummary("/etc/pa\nsswd"), {
      log: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
  });
});

describe("classifyAttachment — branch coverage", () => {
  // The classifier is exported so each rejection branch can be
  // exercised independently of the summary-level orchestration. Tests
  // here pin the precise reason returned per input class.
  const allowedRoots = [path.resolve(os.tmpdir())];

  it("returns null for valid path", () => {
    const reason = classifyAttachment({
      rawPath: validImagePath,
      allowedRoots,
      existsFn: () => true,
      sizeFn: () => 1024,
      maxBytes: DEFAULT_INBOUND_MEDIA_MAX_BYTES,
    });
    expect(reason).toBeNull();
  });

  it("returns 'traversal' for outside-root path", () => {
    const reason = classifyAttachment({
      rawPath: "/etc/passwd",
      allowedRoots,
      existsFn: () => true,
      sizeFn: () => 1024,
      maxBytes: DEFAULT_INBOUND_MEDIA_MAX_BYTES,
    });
    expect(reason).toBe("traversal");
  });

  it("returns 'absent' for inside-root non-existent path", () => {
    const reason = classifyAttachment({
      rawPath: validImagePath,
      allowedRoots,
      existsFn: () => false,
      sizeFn: () => 1024,
      maxBytes: DEFAULT_INBOUND_MEDIA_MAX_BYTES,
    });
    expect(reason).toBe("absent");
  });

  it("returns 'empty' for size 0", () => {
    const reason = classifyAttachment({
      rawPath: validImagePath,
      allowedRoots,
      existsFn: () => true,
      sizeFn: () => 0,
      maxBytes: DEFAULT_INBOUND_MEDIA_MAX_BYTES,
    });
    expect(reason).toBe("empty");
  });

  it("returns 'empty' when size is undefined (stat failure)", () => {
    const reason = classifyAttachment({
      rawPath: validImagePath,
      allowedRoots,
      existsFn: () => true,
      sizeFn: () => undefined,
      maxBytes: DEFAULT_INBOUND_MEDIA_MAX_BYTES,
    });
    expect(reason).toBe("empty");
  });

  it("returns 'oversize' when size > maxBytes", () => {
    const reason = classifyAttachment({
      rawPath: validImagePath,
      allowedRoots,
      existsFn: () => true,
      sizeFn: () => DEFAULT_INBOUND_MEDIA_MAX_BYTES + 1,
      maxBytes: DEFAULT_INBOUND_MEDIA_MAX_BYTES,
    });
    expect(reason).toBe("oversize");
  });
});
