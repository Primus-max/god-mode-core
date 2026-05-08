/**
 * V1-CLOSE T5 — Inbound media validation seam.
 *
 * Sits between the structural `buildInboundMediaSummaryForTurn` helper
 * (`agent-runner-execution.ts`) and the frozen-layer
 * `INBOUND_IMAGE_REFERENCE_AVAILABLE_PRECONDITION` resolver
 * (`src/platform/commitment/inbound-image-reference-precondition-resolver.ts`).
 *
 * Why this module exists (production trace context):
 *   - `MsgContext.MediaPath` strings flow in from each non-webchat channel
 *     adapter (Telegram, Signal, WhatsApp, Discord, …) without any
 *     pre-validation. The frozen resolver trusts the input — it just
 *     copies `path` strings into the precondition value, which the
 *     runtime adapter then injects onto `image_generate.image` for
 *     img2img turns.
 *   - That trust meant: (a) a path-traversal sequence in a forwarded
 *     filename could in principle reach into `~/.ssh` or similar; (b)
 *     a stale or empty file silently downgraded img2img to text-to-image
 *     with no observable telemetry — exactly the failure class the
 *     V1-CLOSE charter §1 calls out.
 *
 * The validator runs on the structural summary and:
 *   1. Resolves each `path` to an absolute, normalized form (Windows-
 *      and POSIX-aware via `node:path`).
 *   2. Asserts containment in an allowed-roots list (default: the
 *      user's `~/.openclaw/` tree and the OS temp directory; callers
 *      may extend with the configured Telegram media cache).
 *   3. Asserts the file exists, has size > 0, and size <= configured
 *      cap (default 25 MiB).
 *   4. Drops failing attachments from the summary AND emits a
 *      `[inbound-media] event=validation_failed reason=<...>` log line
 *      so absence is observable downstream.
 *
 * Webchat structural entries (`path === ""`) are passed through
 * unchanged — they carry no disk path and the resolver already skips
 * them via its `path.length > 0` guard, so validation is a no-op for
 * the webchat row.
 *
 * Per AGENTS.md "Tests must catch real bugs" the colocated test file
 * exercises the real `node:path` + `node:fs` code path against
 * temporary directories — no `vi.spyOn` on the function under test.
 *
 * Boundary discipline:
 *   - Lives under `src/auto-reply/` so it inherits invariant #8 — no
 *     imports from `src/platform/commitment/`. The validator depends
 *     only on the structural shape of the summary (declared in
 *     `agent-runner-execution.ts`), not on any frozen-layer type.
 *   - Pure data transform; no global state.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRuntime } from "../../runtime.js";
import type { InboundMediaSummary } from "./agent-runner-execution.js";

/**
 * Default size cap for any single inbound media attachment. 25 MiB
 * mirrors Telegram's standard inbound photo/document upper bound; the
 * cap is parameterized via `validateInboundMediaSummary({ maxBytes })`
 * so per-channel callers can override without forking the validator.
 */
export const DEFAULT_INBOUND_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Closed-shape rejection reason. Mirrors the four failure classes the
 * charter §4 T5 spec calls out so the emitted telemetry is grep-able
 * by ops and the test suite can pin the exact reason per case.
 */
export type InboundMediaValidationRejectionReason = "absent" | "oversize" | "traversal" | "empty";

/**
 * Optional knobs for the validator. Default behaviour matches the
 * production wiring at the `agent-runner-execution.ts:693` call site:
 *   - allowed roots = `~/.openclaw/` + `os.tmpdir()`
 *   - max bytes = 25 MiB
 *   - logger = `defaultRuntime.log` (same channel as `[broker]` /
 *     `[outbound-coalescer]` telemetry).
 *
 * Tests inject a synchronous `statSizeBytes` resolver to exercise the
 * oversize branch deterministically without writing GiB-scale fixtures.
 */
export type InboundMediaValidatorOptions = {
  /**
   * Additional roots to accept beyond `~/.openclaw/` and `os.tmpdir()`.
   * Each entry is normalized + resolved to absolute before containment
   * comparison. Use this to whitelist a per-channel media cache (e.g.
   * a configured Telegram download directory).
   */
  readonly extraAllowedRoots?: readonly string[];
  /** Override the per-attachment size ceiling. Default: 25 MiB. */
  readonly maxBytes?: number;
  /** Test seam — override the size source for deterministic tests. */
  readonly statSizeBytes?: (absolutePath: string) => number | undefined;
  /** Test seam — override the existence check. Defaults to `fs.existsSync`. */
  readonly existsSync?: (absolutePath: string) => boolean;
  /** Test seam — override the user-home lookup. Defaults to `os.homedir`. */
  readonly homedir?: () => string;
  /** Test seam — override the OS temp directory lookup. Defaults to `os.tmpdir`. */
  readonly tmpdir?: () => string;
  /** Test seam — override the logger sink. Defaults to `defaultRuntime.log`. */
  readonly log?: (line: string) => void;
};

/**
 * Validates a structural inbound-media summary in place: each
 * `attachments[]` entry whose `path` is non-empty is resolved to
 * absolute form, checked for containment under an allowed root, and
 * checked for existence + size. Failing entries are dropped from the
 * returned summary and a `[inbound-media] event=validation_failed`
 * line is emitted via the logger with the closed-loop reason.
 *
 * Returns `undefined` when the original summary was undefined OR when
 * the post-validation `attachments[]` array is empty. This matches the
 * pre-validation contract (`buildInboundMediaSummaryForTurn` itself
 * returns `undefined` rather than an empty-array summary), so the
 * downstream `deriveTurnModalityRequirements` and resolver branches
 * stay byte-identical for the no-attachment case.
 *
 * Webchat entries (`path === ""`) bypass validation — they carry no
 * disk file and the resolver already skips them via its
 * `path.length > 0` guard, so they remain in the returned summary
 * with `path: ""` preserved.
 */
export function validateInboundMediaSummary(
  summary: InboundMediaSummary | undefined,
  options: InboundMediaValidatorOptions = {},
): InboundMediaSummary | undefined {
  if (!summary || summary.attachments.length === 0) {
    return undefined;
  }
  const maxBytes = options.maxBytes ?? DEFAULT_INBOUND_MEDIA_MAX_BYTES;
  const homedirFn = options.homedir ?? os.homedir;
  const tmpdirFn = options.tmpdir ?? os.tmpdir;
  const existsFn = options.existsSync ?? fs.existsSync;
  const sizeFn =
    options.statSizeBytes ??
    ((absolutePath: string): number | undefined => {
      try {
        const stat = fs.statSync(absolutePath);
        return stat.size;
      } catch {
        return undefined;
      }
    });
  const log = options.log ?? ((line: string) => defaultRuntime.log(line));

  const allowedRoots = collectAllowedRoots({
    homedir: homedirFn,
    tmpdir: tmpdirFn,
    extras: options.extraAllowedRoots ?? [],
  });

  const kept: InboundMediaSummary["attachments"][number][] = [];
  for (const attachment of summary.attachments) {
    // Webchat entries (`path === ""`) carry the modality marker only;
    // skip validation and preserve as-is so the modality filter still
    // sees `kind: "image"` on webchat-only turns.
    if (attachment.path.length === 0) {
      kept.push(attachment);
      continue;
    }
    const reason = classifyAttachment({
      rawPath: attachment.path,
      allowedRoots,
      existsFn,
      sizeFn,
      maxBytes,
    });
    if (reason !== null) {
      log(formatRejectionLine(reason, attachment.path));
      continue;
    }
    kept.push(attachment);
  }

  if (kept.length === 0) {
    return undefined;
  }
  return { attachments: kept };
}

/**
 * Pure classifier — returns the rejection reason or `null` when the
 * attachment passes all four checks. Exported for the test suite so
 * each branch can be exercised against the real `node:fs` + `node:path`
 * code path with deterministic fixtures.
 */
export function classifyAttachment(input: {
  readonly rawPath: string;
  readonly allowedRoots: readonly string[];
  readonly existsFn: (absolutePath: string) => boolean;
  readonly sizeFn: (absolutePath: string) => number | undefined;
  readonly maxBytes: number;
}): InboundMediaValidationRejectionReason | null {
  // Resolve to absolute, normalized form. `path.resolve` collapses
  // `..` segments and normalizes separators on Windows so a string
  // like `/safe/root/../../etc/passwd` becomes `/etc/passwd` before
  // the containment check runs. The traversal class is therefore
  // detected as "post-resolution outside any allowed root", not by
  // string-matching `..` (which would false-positive on legitimate
  // paths whose filenames contain `..`).
  const resolved = path.resolve(input.rawPath);
  const contained = isContainedInAnyAllowedRoot(resolved, input.allowedRoots);
  if (!contained) {
    return "traversal";
  }
  if (!input.existsFn(resolved)) {
    return "absent";
  }
  const size = input.sizeFn(resolved);
  if (size === undefined || size <= 0) {
    return "empty";
  }
  if (size > input.maxBytes) {
    return "oversize";
  }
  return null;
}

/**
 * Containment check — `child` is inside `root` iff
 * `path.relative(root, child)` does NOT start with `..` and is NOT
 * absolute. The filesystem-level check works correctly on both POSIX
 * and Windows because `path.relative` is platform-aware.
 *
 * Comparison is case-insensitive on Windows, case-sensitive on POSIX
 * — matching the underlying filesystem semantics. On Windows
 * `path.relative('C:\\Users\\foo', 'c:\\users\\foo\\bar.jpg')`
 * already normalizes case before producing the relative form, so we
 * do not need an explicit `.toLowerCase()` here.
 */
function isContainedInAnyAllowedRoot(
  absolutePath: string,
  allowedRoots: readonly string[],
): boolean {
  for (const root of allowedRoots) {
    const relative = path.relative(root, absolutePath);
    if (relative === "") {
      // The path IS the root — accept (root itself is "inside" itself).
      return true;
    }
    if (relative.startsWith("..")) {
      continue;
    }
    if (path.isAbsolute(relative)) {
      // On Windows, `path.relative` returns an absolute path when the
      // two arguments live on different drives — that is definitively
      // NOT containment.
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Builds the canonical allowed-roots list for the current process.
 * Always includes `<homedir>/.openclaw` (sessions, agents, media) and
 * the OS temp dir (where channel adapters frequently spool downloads
 * before relaying them to the auto-reply pipeline). Caller-supplied
 * extras are normalized to absolute form.
 */
function collectAllowedRoots(input: {
  readonly homedir: () => string;
  readonly tmpdir: () => string;
  readonly extras: readonly string[];
}): readonly string[] {
  const roots: string[] = [];
  const home = input.homedir();
  if (home && home.length > 0) {
    roots.push(path.resolve(path.join(home, ".openclaw")));
  }
  const tmp = input.tmpdir();
  if (tmp && tmp.length > 0) {
    roots.push(path.resolve(tmp));
  }
  for (const extra of input.extras) {
    const trimmed = extra?.trim();
    if (trimmed && trimmed.length > 0) {
      roots.push(path.resolve(trimmed));
    }
  }
  return roots;
}

/**
 * Formats the closed-shape telemetry line. The `path=` segment is
 * intentionally the RAW path the channel adapter handed us — that is
 * the value an operator needs to correlate with the upstream channel
 * log; the post-resolution form is internal-only.
 */
function formatRejectionLine(
  reason: InboundMediaValidationRejectionReason,
  rawPath: string,
): string {
  const sanitizedPath = rawPath.replaceAll(/[\r\n]/g, " ");
  return `[inbound-media] event=validation_failed reason=${reason} path=${sanitizedPath}`;
}
