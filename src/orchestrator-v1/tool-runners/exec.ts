/**
 * V1-CONTRACT-ONLY — exec tool runner (S2).
 *
 * Thin wrapper around the production shell-exec implementation
 * (`runCommandWithTimeout` from `src/process/exec.ts`) so the
 * orchestrator-v1 dispatcher can dispatch `exec` actions.
 *
 * Contract:
 *   - Input  : { command: string; cwd?: string }    (Stage-B–validated)
 *   - Output : ToolRunResult — `{ ok: true, output: { command, output } }`
 *              on exit code 0, otherwise `{ ok: false, error }` with a
 *              message containing the exit code + stderr tail.
 *
 * Hard invariants:
 *   - No reply text rendered here; templates own that (`reply-templates.ts`).
 *   - The deny-list matches the trimmed `args.command` string (validated
 *     argv from the contract), NEVER the raw user message. Stage-A/B own
 *     parsing.
 *   - Thin wrapper: command execution, timeout, stdio capture, signal
 *     handling all delegated to the production helper.
 */

import { getShellConfig } from "../../agents/shell-utils.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { ToolRunResult } from "../dispatcher.js";

/** Hard upper-bound on captured stdout/stderr returned to dispatcher. */
const OUTPUT_TRUNCATION_BYTES = 4 * 1024;
/** Default per-command timeout (ms). */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Minimal deny-list of obviously destructive patterns. Matched against the
 * trimmed args.command. The production exec helper does not gate
 * destructive shell strings; this gate is the orchestrator's last line of
 * defence before a chat-driven command reaches the user's machine.
 */
const DENY_PATTERNS: RegExp[] = [
  // recursive force-remove of root or home (covers rm -rf /, rm -fr /, rm -rf ~, etc.)
  /\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+|--recursive\s+|--force\s+){1,}\s*(?:\/|~|\$HOME)(?:\s|$|\/)/i,
  // mkfs on any device
  /\bmkfs(?:\.[a-z0-9]+)?\b/i,
  // dd writing to a device
  /\bdd\s+.*\bof=\s*\/dev\//i,
  // redirecting into raw block devices
  />\s*\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|xvd[a-z])/i,
  // classic bash fork bomb
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  // chmod / chown blasting the entire root
  /\bchmod\s+-R\s+\S+\s+\/(?:\s|$)/i,
  /\bchown\s+-R\s+\S+\s+\/(?:\s|$)/i,
  // shutdown / halt / reboot — not appropriate from chat
  /\b(?:shutdown|halt|reboot|poweroff)\b/i,
  // Windows equivalents: format / del-recurse-quiet of a root-ish path
  /\bformat\s+[a-z]:\b/i,
  /\bdel\s+\/[a-z]\s+\/[a-z]?\s*[a-z]:\\?(?:\s|$)/i,
];

function isCommandBlocked(command: string): { blocked: true; pattern: string } | { blocked: false } {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { blocked: true, pattern: "<empty>" };
  }
  for (const pat of DENY_PATTERNS) {
    if (pat.test(trimmed)) {
      return { blocked: true, pattern: pat.source };
    }
  }
  return { blocked: false };
}

function truncateTail(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  // Keep the tail — most useful for diagnosing what happened at the end.
  return "…[truncated]…\n" + text.slice(text.length - maxBytes);
}

function buildOutputBlob(stdout: string, stderr: string): string {
  const out = stdout.trimEnd();
  const err = stderr.trimEnd();
  if (out.length > 0 && err.length > 0) {
    return `${out}\n[stderr]\n${err}`;
  }
  if (out.length > 0) return out;
  if (err.length > 0) return `[stderr]\n${err}`;
  return "";
}

function formatExitError(params: {
  code: number | null;
  signal: NodeJS.Signals | null;
  termination: string;
  stderrTail: string;
}): string {
  const { code, signal, termination, stderrTail } = params;
  const parts: string[] = [];
  if (termination === "timeout" || termination === "no-output-timeout") {
    parts.push(`timed out (${termination})`);
  } else if (signal) {
    parts.push(`terminated by signal ${signal}`);
  } else {
    parts.push(`exit code ${code ?? "?"}`);
  }
  if (stderrTail.length > 0) {
    parts.push(`stderr: ${stderrTail}`);
  }
  return parts.join("; ");
}

export type ExecArgs = {
  command: string;
  cwd?: string;
};

/**
 * Dispatcher entry point. Always resolves; thrown errors from the
 * underlying spawn are caught and surfaced via `{ ok: false, error }`.
 */
export async function runExec(args: ExecArgs): Promise<ToolRunResult> {
  const command = args.command;
  if (typeof command !== "string") {
    return { ok: false, error: "exec: command must be a string" };
  }

  const denied = isCommandBlocked(command);
  if (denied.blocked) {
    return {
      ok: false,
      error: `exec blocked: command matches deny-list (${denied.pattern})`,
    };
  }

  const { shell, args: shellArgs } = getShellConfig();
  const argv = [shell, ...shellArgs, command];

  try {
    const result = await runCommandWithTimeout(argv, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      cwd: args.cwd,
    });

    const blob = buildOutputBlob(result.stdout, result.stderr);
    const truncated = truncateTail(blob, OUTPUT_TRUNCATION_BYTES);

    if (result.code === 0 && result.termination === "exit") {
      return {
        ok: true,
        output: {
          command,
          output: truncated,
        },
      };
    }

    const stderrTail = truncateTail(result.stderr.trimEnd(), 512);
    return {
      ok: false,
      error: formatExitError({
        code: result.code,
        signal: result.signal,
        termination: result.termination,
        stderrTail,
      }),
    };
  } catch (err) {
    return { ok: false, error: `exec spawn failed: ${(err as Error).message}` };
  }
}
