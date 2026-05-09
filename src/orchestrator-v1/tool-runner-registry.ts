/**
 * V1-CUTOVER S8 — tool-runner registry.
 *
 * Single wiring point that builds the dispatcher's `RunToolFn` callback by
 * binding every TOOL_NAME to its concrete runner from
 * `src/orchestrator-v1/tool-runners/*`. The dispatcher stays
 * infrastructure-agnostic; this module is where the orchestrator meets
 * production transports + schedulers.
 *
 * Why a `Record<ToolName, ...>` literal: a missing entry is a TypeScript
 * error. If a future slice adds a new TOOL_NAME to `contract.ts` and
 * forgets to wire a runner, the build fails here — not at runtime when a
 * user prompt accidentally triggers the unwired tool.
 *
 * Telemetry contract (per V1-CUTOVER plan §"Telemetry to keep"):
 *   `[tool-runner] tool=X started`
 *   `[tool-runner] tool=X completed ok=Y duration=Zms`
 *
 * The lines are emitted in ONE place (the dispatch wrapper) so individual
 * runner files don't have to add logging — keeping the runners thin per
 * the plan's "no new layers" invariant.
 *
 * Hard invariants (V1-CUTOVER):
 *   - No commitment-kernel imports; this module is a wiring layer only.
 *   - No regex parsing of user input; args have already been Zod-validated
 *     by Stage B before reaching the dispatcher.
 *   - No new abstraction; the registry is the wiring point itself, not a
 *     new "tool framework".
 *   - Reply text comes from `reply-templates.ts` via the dispatcher; the
 *     registry forwards `{ ok, output }` from runners as-is.
 */

import type { ToolName, TurnAction } from "./contract.js";
import type { RunToolFn, ToolRunResult } from "./dispatcher.js";
import { runEdit, runRead, runWrite } from "./tool-runners/fs.js";
import { runExec } from "./tool-runners/exec.js";
import { runImageGenerate } from "./tool-runners/image.js";
import { runPdf } from "./tool-runners/pdf.js";
import {
  runCron,
  runPersistentWorkerPush,
  type SchedulingRunnerDeps,
} from "./tool-runners/scheduling.js";
import { runSessionsSend, type SessionsSendFn } from "./tool-runners/sessions.js";
import { runWebFetch, runWebSearch, type WebRunnerDeps } from "./tool-runners/web.js";
import type { ToolArgsByName } from "./tool-arg-schemas.js";

/**
 * Production wiring required by the registry. Every callback that a
 * runner needs externally lives here so the eventual S9 caller MUST pass
 * a real implementation — there is no silent default that could
 * accidentally route to a stub in production.
 *
 * Discovered from the runner files:
 *   - sessions_send → `SessionsSendFn` (channel, text) for outbound delivery
 *   - cron / persistent_worker_push → `SchedulingRunnerDeps` (scheduleCron,
 *     createPersistentWorker)
 *
 * fs / exec / image runners read their config / use their own
 * lazy-loaded deps and need no injection. web runners accept optional
 * deps for tests; production callers leave them undefined to fall through
 * to the real backends.
 */
export type RegistryDeps = {
  /** Outbound transport for `sessions_send`. Must throw on failure. */
  send: SessionsSendFn;
  /** Schedule callbacks for `cron` + `persistent_worker_push`. */
  scheduling: SchedulingRunnerDeps;
  /**
   * Optional overrides for the web runners. Production leaves these
   * undefined so the runners load `OpenClawConfig` themselves and call
   * the real search/fetch backends. Tests inject stubs to avoid the
   * network.
   */
  web?: WebRunnerDeps;
};

/**
 * Logger sink. Defaults to `process.stderr.write` to match the
 * `[orch-v1-debug]` lines already emitted by `diagnostic.ts`. Tests
 * inject a stub to assert the started/completed lines fire.
 */
export type ToolRunnerLogger = (line: string) => void;

const defaultLogger: ToolRunnerLogger = (line) => {
  process.stderr.write(line);
};

/**
 * Map of TOOL_NAME → runner function. Each entry returns
 * `Promise<ToolRunResult>`; the dispatch wrapper adds telemetry.
 *
 * Args are typed via `ToolArgsByName[K]` — Stage B validates against
 * `TOOL_ARG_SCHEMAS[K]` before the action reaches the dispatcher, so the
 * cast at the type-erasure boundary (the `args` field on `TurnAction`
 * is `Record<string, unknown>`) is sound.
 */
export type ToolRunnerMap = {
  [K in ToolName]: (action: TurnAction & { tool: K }) => Promise<ToolRunResult>;
};

function buildRunnerMap(deps: RegistryDeps): ToolRunnerMap {
  const map: ToolRunnerMap = {
    write: (action) => runWrite(action.args as ToolArgsByName["write"]),
    edit: (action) => runEdit(action.args as ToolArgsByName["edit"]),
    read: (action) => runRead(action.args as ToolArgsByName["read"]),
    exec: (action) => runExec(action.args as ToolArgsByName["exec"]),
    web_search: (action) =>
      runWebSearch(action.args as ToolArgsByName["web_search"], deps.web ?? {}),
    web_fetch: (action) =>
      runWebFetch(action.args as ToolArgsByName["web_fetch"], deps.web ?? {}),
    image_generate: (action) =>
      // image runner takes the FULL action shape (not just args) so its
      // own discriminator narrows correctly. We re-shape here.
      runImageGenerate({
        tool: "image_generate",
        args: action.args as ToolArgsByName["image_generate"],
      }),
    pdf: (action) => runPdf(action.args as ToolArgsByName["pdf"]),
    sessions_send: (action) =>
      runSessionsSend(action.args as ToolArgsByName["sessions_send"], { send: deps.send }),
    persistent_worker_push: (action) =>
      runPersistentWorkerPush(
        action.args as ToolArgsByName["persistent_worker_push"],
        deps.scheduling,
      ),
    cron: (action) => runCron(action.args as ToolArgsByName["cron"], deps.scheduling),
  };
  return map;
}

/**
 * Build the production `RunToolFn` callback from injected deps.
 *
 * The returned function:
 *   1. Looks up `action.tool` in the runner map (typed-exhaustive).
 *   2. Logs `[tool-runner] tool=X started`.
 *   3. Awaits the runner.
 *   4. Logs `[tool-runner] tool=X completed ok=Y duration=Zms`.
 *   5. Returns the ToolRunResult unchanged.
 *
 * On a thrown runner (which the runners themselves try to avoid), the
 * wrapper catches and surfaces the failure as `{ ok: false, error }` so
 * the dispatcher's per-action template renders rather than the whole
 * turn aborting.
 */
export function buildRunToolFromRegistry(
  deps: RegistryDeps,
  options: { logger?: ToolRunnerLogger } = {},
): RunToolFn {
  const map = buildRunnerMap(deps);
  const logger = options.logger ?? defaultLogger;
  return async (action) => {
    const start = Date.now();
    logger(`[tool-runner] tool=${action.tool} started\n`);
    let result: ToolRunResult;
    try {
      const runner = map[action.tool] as (a: TurnAction) => Promise<ToolRunResult>;
      result = await runner(action);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const duration = Date.now() - start;
    logger(
      `[tool-runner] tool=${action.tool} completed ok=${result.ok} duration=${duration}ms\n`,
    );
    return result;
  };
}

/**
 * Convenience export for tests + introspection: peek at the runner map
 * directly without going through the dispatch wrapper. Useful for the
 * exhaustiveness assertion (`Object.keys(buildRunnerMapForTesting(deps))
 * === TOOL_NAMES`).
 *
 * Production code should call `buildRunToolFromRegistry` instead — it
 * adds the telemetry envelope that the operator log greps rely on.
 */
export function buildRunnerMapForTesting(deps: RegistryDeps): ToolRunnerMap {
  return buildRunnerMap(deps);
}
