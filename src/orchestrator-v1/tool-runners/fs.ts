/**
 * V1-CUTOVER S1 — write/edit/read tool runners.
 *
 * Thin wrappers around `node:fs/promises` that match the dispatcher's
 * `RunToolFn` contract: `Promise<ToolRunResult>`. Args have already been
 * Zod-validated by Stage B (see `tool-arg-schemas.ts`); these runners
 * perform the side-effect and report `{ ok, output | error }`.
 *
 * Why direct `fs/promises` (not `apply-patch.ts` / `fs-safe.ts`):
 *   - `apply-patch.ts` parses the *** Begin Patch *** envelope; our args
 *     arrive as plain `{path, content}` / `{path, old_string, new_string}`.
 *   - `fs-safe.ts` enforces a workspace root + sandbox; v1 dispatcher has
 *     no workspace context yet (Stage B validates strings only). When
 *     sandboxing is added, swap the implementation here in one place.
 *   - `apply-patch.ts` itself falls through to `fs.writeFile(..., "utf8")`
 *     when not workspace-scoped — same primitive, no extra layer.
 *
 * Per the V1-CUTOVER hard invariants:
 *   - Runners NEVER produce user-facing strings — only `{ok, output}`.
 *     The dispatcher renders text from `reply-templates.ts`.
 *   - No regex parsing of user input here; args are already typed.
 *   - No new abstraction layer; one async function per tool.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { ToolRunResult } from "../dispatcher.js";

/**
 * Create or overwrite a file at `args.path` with `args.content`.
 *
 * Behaviour: parents are created with `mkdir { recursive: true }` before
 * writing. Rationale: a write that fails purely because an intermediate
 * directory does not exist is a poor UX, and `apply-patch.ts` already
 * `ensureDir`s for the same reason.
 */
export async function runWrite(args: {
  path: string;
  content: string;
}): Promise<ToolRunResult> {
  try {
    const parent = path.dirname(args.path);
    if (parent && parent !== "." && parent !== args.path) {
      await fs.mkdir(parent, { recursive: true });
    }
    await fs.writeFile(args.path, args.content, "utf8");
    return { ok: true, output: { path: args.path } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Replace the first occurrence of `args.old_string` with `args.new_string`
 * in the file at `args.path`. Fails if the file does not exist or the
 * string is not present.
 *
 * Why "first occurrence" not "all": parity with the team's existing edit
 * tooling (Claude Code `Edit` tool, codex `apply_patch` update hunks),
 * which require the old_string to be uniquely identifying. Multi-match
 * is the caller's responsibility.
 */
export async function runEdit(args: {
  path: string;
  old_string: string;
  new_string: string;
}): Promise<ToolRunResult> {
  try {
    const before = await fs.readFile(args.path, "utf8");
    const idx = before.indexOf(args.old_string);
    if (idx === -1) {
      return {
        ok: false,
        error: `old_string not found in ${args.path}`,
      };
    }
    const after =
      before.slice(0, idx) +
      args.new_string +
      before.slice(idx + args.old_string.length);
    await fs.writeFile(args.path, after, "utf8");
    return { ok: true, output: { path: args.path } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Read the file at `args.path` and return its UTF-8 contents in `output.content`.
 * The dispatcher's `read:success` template substitutes `{path}` from args
 * and `{content}` from output.
 */
export async function runRead(args: { path: string }): Promise<ToolRunResult> {
  try {
    const content = await fs.readFile(args.path, "utf8");
    return { ok: true, output: { content } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
