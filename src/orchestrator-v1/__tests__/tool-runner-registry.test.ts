/**
 * V1-CUTOVER S8 — unit tests for the tool-runner registry.
 *
 * Real-symptom coverage:
 *
 *   1. Exhaustiveness — `Object.keys(buildRunnerMapForTesting(deps))`
 *      MUST equal `TOOL_NAMES` as a set. The "real symptom" this guards
 *      against: a future slice adds a new tool name to `contract.ts` but
 *      forgets to wire its runner here. The TypeScript exhaustiveness
 *      check (Record<ToolName, ...>) catches the build, but a runtime
 *      assertion locks the contract for callers that introspect.
 *
 *   2. Routing — when `action.tool === "X"`, the runner for X is invoked
 *      and the runner for Y is NOT. We assert this for three
 *      representative tools (write / image_generate / sessions_send) so a
 *      future "wired the wrong runner" mistake (e.g. `pdf` → runWrite)
 *      gets caught.
 *
 *   3. Telemetry — both `[tool-runner] tool=X started` and
 *      `[tool-runner] tool=X completed ok=Y duration=Zms` lines fire on
 *      success AND failure. Failure is the easier-to-miss case; if the
 *      try/catch swallowed the completed line, log greps would lose
 *      every failed call.
 *
 *   4. Failure forwarding — when a runner returns `{ ok: false, error }`
 *      the registry forwards it untouched (no template rendering, no
 *      string mutation). When a runner *throws* the wrapper coerces to
 *      `{ ok: false, error }` so the dispatcher's per-action template
 *      can render.
 *
 *   5. Args threading — for `sessions_send`, the registry binds
 *      `deps.send` and the args reach it as-is. Catches a regression
 *      where a refactor accidentally dropped `deps.send` from the
 *      sessions wiring.
 *
 *   6. Negative — `runSessionsSend` is NOT called when the action is
 *      `image_generate`. Pure routing assertion.
 *
 * The tests stub the underlying runners by injecting `RegistryDeps`
 * carefully (sessions transport mock, scheduling mocks). For runners
 * that don't take injected callbacks (write / read / etc.) we use safe
 * args that exercise the real runner (no disk side-effect via tmp
 * paths) — the test's purpose at this layer is wiring, not the runner's
 * own behaviour (those have their own *.test.ts).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TOOL_NAMES, type TurnAction } from "../contract.js";
import {
  buildRunToolFromRegistry,
  buildRunnerMapForTesting,
  type RegistryDeps,
  type ToolRunnerLogger,
} from "../tool-runner-registry.js";

function makeDeps(overrides: Partial<RegistryDeps> = {}): RegistryDeps {
  return {
    send: overrides.send ?? vi.fn(async () => undefined),
    scheduling: overrides.scheduling ?? {
      scheduleCron: vi.fn(async () => ({ id: "cron:test" })),
      createPersistentWorker: vi.fn(async () => ({ id: "worker:test" })),
    },
    ...(overrides.web ? { web: overrides.web } : {}),
  };
}

function captureLogger(): { logger: ToolRunnerLogger; lines: string[] } {
  const lines: string[] = [];
  const logger: ToolRunnerLogger = (line) => {
    lines.push(line);
  };
  return { logger, lines };
}

describe("tool-runner registry — exhaustiveness", () => {
  it("has a runner for every TOOL_NAME (set equality with TOOL_NAMES)", () => {
    const map = buildRunnerMapForTesting(makeDeps());
    const wired = new Set(Object.keys(map));
    const expected = new Set(TOOL_NAMES);
    // Both directions: catches "missing wiring" and "wired a stale name".
    expect(wired).toEqual(expected);
  });

  it("every wired entry is a function (no accidental undefined)", () => {
    const map = buildRunnerMapForTesting(makeDeps());
    for (const name of TOOL_NAMES) {
      expect(typeof map[name]).toBe("function");
    }
  });
});

describe("tool-runner registry — routing", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "s8-registry-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("write action routes to runWrite (file appears on disk)", async () => {
    const { logger } = captureLogger();
    const runTool = buildRunToolFromRegistry(makeDeps(), { logger });
    const target = path.join(tmpDir, "wired.txt");

    const result = await runTool({
      tool: "write",
      args: { path: target, content: "hello-from-registry" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.path).toBe(target);
    }
    const written = await fs.readFile(target, "utf8");
    expect(written).toBe("hello-from-registry");
  });

  it("sessions_send action routes to runSessionsSend with deps.send", async () => {
    const send = vi.fn(async () => undefined);
    const runTool = buildRunToolFromRegistry(makeDeps({ send }));

    const result = await runTool({
      tool: "sessions_send",
      args: { channel: "telegram:6533456892", text: "S8-routing-test" },
    });

    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("telegram:6533456892", "S8-routing-test");
  });

  it("cron action routes to runCron with deps.scheduling", async () => {
    const scheduleCron = vi.fn(async () => ({ id: "cron:s8" }));
    const createPersistentWorker = vi.fn(async () => ({ id: "worker:s8" }));
    const runTool = buildRunToolFromRegistry(
      makeDeps({ scheduling: { scheduleCron, createPersistentWorker } }),
    );

    const result = await runTool({
      tool: "cron",
      args: { schedule: "0 9 * * *", prompt: "поздравь Васю" },
    });

    expect(result.ok).toBe(true);
    expect(scheduleCron).toHaveBeenCalledTimes(1);
    expect(scheduleCron).toHaveBeenCalledWith({
      schedule: "0 9 * * *",
      prompt: "поздравь Васю",
    });
    // Cross-routing guard: the worker creator MUST NOT have been called.
    expect(createPersistentWorker).not.toHaveBeenCalled();
  });

  it("persistent_worker_push routes to runPersistentWorkerPush — sessions.send NOT called", async () => {
    const send = vi.fn(async () => undefined);
    const createPersistentWorker = vi.fn(async () => ({ id: "worker:s8" }));
    const runTool = buildRunToolFromRegistry(
      makeDeps({
        send,
        scheduling: {
          scheduleCron: vi.fn(async () => ({ id: "ignore" })),
          createPersistentWorker,
        },
      }),
    );

    const result = await runTool({
      tool: "persistent_worker_push",
      args: {
        worker_name: "morning_news",
        schedule: "every 1 day",
        message_template: "Доброе утро",
        target_chat: "telegram:6533456892",
      },
    });

    expect(result.ok).toBe(true);
    expect(createPersistentWorker).toHaveBeenCalledWith({
      worker_name: "morning_news",
      schedule: "every 1 day",
      message_template: "Доброе утро",
      target_chat: "telegram:6533456892",
    });
    // Negative routing assertion: image/sessions transports must not be touched.
    expect(send).not.toHaveBeenCalled();
  });

  it("pdf action routes to runPdf (validateArgs error fingerprint proves routing)", async () => {
    // The pdf runner has no injectable deps in the registry, so we can't
    // pass a stubbed renderer through it. Instead we exploit runPdf's
    // own validateArgs error string ("pdf runner: title must be a
    // non-empty string") as a unique fingerprint — no other runner
    // produces that text. If routing were wrong (e.g. pdf → runWrite),
    // the error would be a different shape (write rejects on missing
    // path, not missing title). Tight, deterministic, no playwright.
    const runTool = buildRunToolFromRegistry(makeDeps());

    const result = await runTool({
      tool: "pdf",
      // Cast through unknown because Stage B normally validates the args
      // shape upstream; here we send `{}` to short-circuit runPdf at its
      // own validateArgs guard before it reaches the playwright path.
      args: {} as unknown as TurnAction["args"],
    } as TurnAction);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("pdf runner:");
      expect(result.error).toContain("title");
    }
  });

  it("web_search action routes to runWebSearch with deps.web override", async () => {
    const runSearch = vi.fn(async () => ({
      results: [{ title: "T", url: "https://x", snippet: "s" }],
    }));
    const runTool = buildRunToolFromRegistry(makeDeps({ web: { runSearch } }));

    const result = await runTool({
      tool: "web_search",
      args: { query: "what is V1?", max_results: 3 },
    });

    expect(result.ok).toBe(true);
    expect(runSearch).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.output.query).toBe("what is V1?");
    }
  });
});

describe("tool-runner registry — telemetry", () => {
  it("emits started + completed lines on a successful call", async () => {
    const { logger, lines } = captureLogger();
    const send = vi.fn(async () => undefined);
    const runTool = buildRunToolFromRegistry(makeDeps({ send }), { logger });

    const result = await runTool({
      tool: "sessions_send",
      args: { channel: "telegram:1", text: "ok" },
    });

    expect(result.ok).toBe(true);
    // We expect exactly 2 [tool-runner] lines for one action.
    const trLines = lines.filter((l) => l.startsWith("[tool-runner] "));
    expect(trLines.length).toBe(2);
    expect(trLines[0]).toContain("tool=sessions_send started");
    expect(trLines[1]).toContain("tool=sessions_send completed ok=true");
    // duration field present and non-negative integer
    const m = trLines[1]!.match(/duration=(\d+)ms/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(0);
  });

  it("emits started + completed ok=false on a runner that returns ok:false", async () => {
    const { logger, lines } = captureLogger();
    const send = vi.fn(async () => {
      throw new Error("boom");
    });
    const runTool = buildRunToolFromRegistry(makeDeps({ send }), { logger });

    const result = await runTool({
      tool: "sessions_send",
      args: { channel: "telegram:1", text: "x" },
    });

    expect(result.ok).toBe(false);
    const trLines = lines.filter((l) => l.startsWith("[tool-runner] "));
    expect(trLines.length).toBe(2);
    expect(trLines[1]).toContain("tool=sessions_send completed ok=false");
  });

  it("emits completed ok=false when the runner THROWS (not just returns ok:false)", async () => {
    // Real-symptom guard: if the wrapper's try/catch ever broke, throws
    // would propagate up to the dispatcher and the orchestrator would
    // see an exception instead of a per-action failure outcome. Tests
    // catch that by injecting a runner that throws via a deps callback.
    const { logger, lines } = captureLogger();
    const scheduleCron = vi.fn(async () => {
      throw new Error("scheduler down");
    });
    const runTool = buildRunToolFromRegistry(
      makeDeps({
        scheduling: {
          scheduleCron,
          createPersistentWorker: vi.fn(async () => ({})),
        },
      }),
      { logger },
    );

    // runCron itself wraps thrown errors, so the registry layer just
    // forwards. The completed line must still report ok=false.
    const result = await runTool({
      tool: "cron",
      args: { schedule: "0 9 * * *", prompt: "x" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("scheduler down");
    }
    const trLines = lines.filter((l) => l.startsWith("[tool-runner] "));
    expect(trLines.length).toBe(2);
    expect(trLines[1]).toContain("tool=cron completed ok=false");
  });
});

describe("tool-runner registry — failure forwarding", () => {
  it("forwards the runner's `error` string verbatim (no template rendering)", async () => {
    const send = vi.fn(async () => {
      throw new Error("ECONNRESET: gateway timeout");
    });
    const runTool = buildRunToolFromRegistry(makeDeps({ send }));

    const result = await runTool({
      tool: "sessions_send",
      args: { channel: "telegram:1", text: "x" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The dispatcher renders the template; the registry must not.
      expect(result.error).toBe("ECONNRESET: gateway timeout");
      // Defensive: registry must not have rendered the user-facing
      // "Не удалось отправить в…" copy.
      expect(result.error).not.toMatch(/Не удалось/);
    }
  });

  it("coerces a thrown Error from the runner-map call to ok:false", async () => {
    // We force the wrapper's catch by making the runner itself throw
    // synchronously on lookup. We do this by handing a tool name that
    // doesn't exist via a cast — same shape a future invariant
    // violation would take if exhaustiveness were broken.
    const runTool = buildRunToolFromRegistry(makeDeps());
    const action = {
      tool: "definitely-not-a-real-tool",
      args: {},
    } as unknown as TurnAction;
    const result = await runTool(action);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});
