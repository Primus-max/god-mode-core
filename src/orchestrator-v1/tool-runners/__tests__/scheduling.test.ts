/**
 * V1-CONTRACT-ONLY — S7 unit tests for scheduling runners.
 *
 * The runners are thin shape-translation wrappers around two injected
 * callbacks. Tests mock those callbacks at the module-boundary
 * `SchedulingRunnerDeps` interface — there is no production scheduler
 * import to spy on, by design (the runner cannot revive commitment-
 * kernel code if it never imports it in the first place).
 *
 * Real-symptom coverage per the slice spec:
 *
 *   - cron success/failure shape matches `reply-templates.ts`
 *     `cron:success` / `cron:failure` placeholders.
 *
 *   - persistent_worker_push: the runner MUST thread
 *     `message_template` through to the worker creator. If it doesn't,
 *     the worker pushes empty messages forever. Tests assert the mock
 *     was called with the full arg set — including `message_template`.
 *
 *   - target_chat: when omitted by Stage B, the runner forwards
 *     `undefined` (the wiring layer defaults to the originating chat).
 */

import { describe, expect, it, vi } from "vitest";

import {
  runCron,
  runPersistentWorkerPush,
  type CreatePersistentWorkerFn,
  type SchedulingRunnerDeps,
} from "../scheduling.js";

function makeDeps(overrides: Partial<SchedulingRunnerDeps> = {}): SchedulingRunnerDeps {
  return {
    scheduleCron: overrides.scheduleCron ?? vi.fn(async () => ({ id: "cron:test" })),
    createPersistentWorker:
      overrides.createPersistentWorker ?? vi.fn(async () => ({ id: "worker:test" })),
  };
}

describe("runCron", () => {
  it("returns ok with schedule echoed in output and forwards (schedule, prompt) to the scheduler", async () => {
    const scheduleCron = vi.fn(async () => ({ id: "cron:abc" }));
    const deps = makeDeps({ scheduleCron });

    const result = await runCron(
      { schedule: "0 9 * * *", prompt: "поздравь Васю" },
      deps,
    );

    expect(result).toEqual({
      ok: true,
      output: { schedule: "0 9 * * *" },
    });
    expect(scheduleCron).toHaveBeenCalledTimes(1);
    expect(scheduleCron).toHaveBeenCalledWith({
      schedule: "0 9 * * *",
      prompt: "поздравь Васю",
    });
  });

  it("returns ok:false with the error message when the underlying scheduler throws", async () => {
    const scheduleCron = vi.fn(async () => {
      throw new Error("invalid cron expression: 'banana'");
    });
    const deps = makeDeps({ scheduleCron });

    const result = await runCron({ schedule: "banana", prompt: "ping" }, deps);

    expect(result.ok).toBe(false);
    expect(result).toEqual({
      ok: false,
      error: "invalid cron expression: 'banana'",
    });
  });

  it("coerces non-Error throws into a string error", async () => {
    const scheduleCron = vi.fn(async () => {
      // intentionally a string, not Error — covers the `String(err)` branch
      throw "scheduler offline";
    });
    const deps = makeDeps({ scheduleCron });

    const result = await runCron({ schedule: "* * * * *", prompt: "ping" }, deps);

    expect(result).toEqual({ ok: false, error: "scheduler offline" });
  });
});

describe("runPersistentWorkerPush", () => {
  it("returns ok with worker_name + schedule in output and forwards all 4 fields including target_chat", async () => {
    const createPersistentWorker = vi.fn(async () => ({ id: "worker:42" }));
    const deps = makeDeps({ createPersistentWorker });

    const result = await runPersistentWorkerPush(
      {
        worker_name: "daily-news",
        schedule: "0 8 * * *",
        message_template: "Доброе утро! Сегодня: {summary}",
        target_chat: "telegram:6533456892",
      },
      deps,
    );

    expect(result).toEqual({
      ok: true,
      output: {
        worker_name: "daily-news",
        schedule: "0 8 * * *",
      },
    });
    expect(createPersistentWorker).toHaveBeenCalledTimes(1);
    expect(createPersistentWorker).toHaveBeenCalledWith({
      worker_name: "daily-news",
      schedule: "0 8 * * *",
      message_template: "Доброе утро! Сегодня: {summary}",
      target_chat: "telegram:6533456892",
    });
  });

  it("REGRESSION GUARD: threads message_template through (otherwise worker would push empty forever)", async () => {
    // This is the explicit "real symptom" the slice spec calls out.
    // If the runner ever drops `message_template` from the forwarded
    // args (e.g. via a typo or a broken refactor), this assertion fails
    // with a clear "received: { message_template: undefined }" diff.
    const createPersistentWorker: CreatePersistentWorkerFn = vi.fn(async () => undefined);
    const deps = makeDeps({ createPersistentWorker });

    await runPersistentWorkerPush(
      {
        worker_name: "w",
        schedule: "* * * * *",
        message_template: "non-empty body",
      },
      deps,
    );

    expect(createPersistentWorker).toHaveBeenCalledWith(
      expect.objectContaining({ message_template: "non-empty body" }),
    );
  });

  it("forwards target_chat as undefined when Stage B omitted it", async () => {
    const createPersistentWorker = vi.fn(async () => undefined);
    const deps = makeDeps({ createPersistentWorker });

    const result = await runPersistentWorkerPush(
      {
        worker_name: "weekly-digest",
        schedule: "0 10 * * MON",
        message_template: "summary: {x}",
        // target_chat intentionally omitted
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(createPersistentWorker).toHaveBeenCalledWith({
      worker_name: "weekly-digest",
      schedule: "0 10 * * MON",
      message_template: "summary: {x}",
      target_chat: undefined,
    });
  });

  it("returns ok:false when the worker creator rejects (invalid schedule)", async () => {
    const createPersistentWorker = vi.fn(async () => {
      throw new Error("invalid schedule: 'every fortnight'");
    });
    const deps = makeDeps({ createPersistentWorker });

    const result = await runPersistentWorkerPush(
      {
        worker_name: "broken",
        schedule: "every fortnight",
        message_template: "hi",
      },
      deps,
    );

    expect(result).toEqual({
      ok: false,
      error: "invalid schedule: 'every fortnight'",
    });
  });

  it("output never leaks message_template (templates render schedule + worker_name only)", async () => {
    // reply-templates.ts `persistent_worker_push:success` is
    // "Создал воркера «{worker_name}» с расписанием «{schedule}»." —
    // it has no {message_template} placeholder. If the runner started
    // putting message_template in the output it'd be silently dropped
    // by renderTemplate, but that's still a leak risk for future
    // template changes. Lock the output shape down.
    const deps = makeDeps();

    const result = await runPersistentWorkerPush(
      {
        worker_name: "w",
        schedule: "* * * * *",
        message_template: "secret-ish content",
        target_chat: "chan",
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.output).sort()).toEqual(["schedule", "worker_name"]);
      expect(JSON.stringify(result.output)).not.toContain("secret-ish content");
    }
  });
});
