/**
 * V1-CONTRACT-ONLY — Scheduling tool runners (S7).
 *
 * Thin wrappers around the production scheduler primitives so the
 * orchestrator-v1 dispatcher can fire `cron` and `persistent_worker_push`
 * tool actions. Both runners follow the dispatcher's `ToolRunResult`
 * contract (see `../dispatcher.ts`):
 *
 *   - success → `{ ok: true, output }` where `output` carries the
 *     placeholder values the matching `reply-templates.ts` entry expects:
 *       cron:success                    → { schedule }
 *       persistent_worker_push:success  → { worker_name, schedule }
 *
 *   - failure → `{ ok: false, error }` — the dispatcher renders the
 *     `*:failure` template (which references `{error}` plus the original
 *     args).
 *
 * Per V1-CUTOVER plan §S7 ("DO NOT revive any commitment-kernel code")
 * and the active V1-CONTRACT-ONLY charter, the scheduling primitives
 * are passed in as INJECTED CALLBACKS. Those callbacks are wired by S8
 * (tool-runner registry) / S9 (Telegram bot dispatch) to whatever
 * production scheduler the rest of the codebase already operates —
 * `src/cron/service.ts` for cron, the persistent-worker bootstrap for
 * worker push. This module imports zero scheduler code directly so it
 * cannot drag in the commitment-kernel dependencies that
 * `src/agents/tools/record-reminder-tool.ts` and
 * `src/platform/persistent-worker/**` carry.
 *
 * Stage B has already validated `schedule` is a non-empty string
 * (`tool-arg-schemas.ts`). The underlying scheduler validates the
 * expression itself — we only translate exceptions into the closed
 * `{ ok: false, error }` envelope.
 */

import type { ToolRunResult } from "../dispatcher.js";

/**
 * Inject point for cron job creation. Stays narrow — the runner only
 * needs to know the schedule + the prompt that fires when the timer
 * elapses. The wiring layer (S9) is responsible for translating the
 * `(schedule, prompt)` pair into a full `CronJobCreate` and calling
 * `CronService.add`.
 */
export type ScheduleCronFn = (args: {
  readonly schedule: string;
  readonly prompt: string;
}) => Promise<unknown>;

/**
 * Inject point for persistent-worker creation. Stays narrow — the
 * runner threads the four user-supplied fields through unchanged.
 * `target_chat` is intentionally `undefined`-able: the worker layer
 * defaults to the originating chat when it's omitted (semantics owned
 * by the wiring layer, not this runner).
 */
export type CreatePersistentWorkerFn = (args: {
  readonly worker_name: string;
  readonly schedule: string;
  readonly message_template: string;
  readonly target_chat: string | undefined;
}) => Promise<unknown>;

export type SchedulingRunnerDeps = {
  readonly scheduleCron: ScheduleCronFn;
  readonly createPersistentWorker: CreatePersistentWorkerFn;
};

/**
 * `runCron({ schedule, prompt })` — queues a future LLM-driven turn.
 * At the scheduled tick the production cron runtime fires `prompt` as
 * if a user sent it; the originating chat receives the orchestrator's
 * reply. Schedule semantics (one-shot vs recurring) are owned by the
 * underlying scheduler — this runner is shape-only.
 */
export async function runCron(
  args: { readonly schedule: string; readonly prompt: string },
  deps: SchedulingRunnerDeps,
): Promise<ToolRunResult> {
  try {
    await deps.scheduleCron({ schedule: args.schedule, prompt: args.prompt });
    return {
      ok: true,
      output: { schedule: args.schedule },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * `runPersistentWorkerPush({ worker_name, schedule, message_template, target_chat? })`
 * — sets up a recurring push. At each scheduled tick the worker layer
 * formats `message_template` (placeholder substitution belongs to the
 * worker, NOT this runner) and pushes to `target_chat` (or the
 * originating chat when omitted).
 *
 * Critical: all four args (including `message_template`) must reach
 * the worker, otherwise the worker would push empty messages forever.
 * The unit tests assert the mock was called with the full set.
 */
export async function runPersistentWorkerPush(
  args: {
    readonly worker_name: string;
    readonly schedule: string;
    readonly message_template: string;
    readonly target_chat?: string;
  },
  deps: SchedulingRunnerDeps,
): Promise<ToolRunResult> {
  try {
    await deps.createPersistentWorker({
      worker_name: args.worker_name,
      schedule: args.schedule,
      message_template: args.message_template,
      target_chat: args.target_chat,
    });
    return {
      ok: true,
      output: {
        worker_name: args.worker_name,
        schedule: args.schedule,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
