/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CRON_FORM } from "../app-defaults.ts";
import {
  buildCanonicalChatHref,
  buildCanonicalCronEditHref,
  buildCanonicalCronJobHref,
  buildCanonicalSessionsRuntimeHref,
  buildTabHref,
} from "../app-settings.ts";
import type { CronJob } from "../types.ts";
import { renderCron, type CronProps } from "./cron.ts";

function createJob(id: string): CronJob {
  return {
    id,
    name: "Daily ping",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "ping" },
  };
}

function createProps(overrides: Partial<CronProps> & { basePath?: string } = {}): CronProps {
  const { basePath = "", ...propOverrides } = overrides;
  return {
    buildJobHref: (jobId) =>
      buildTabHref({ basePath }, "cron", {
        cronRunsScope: "job",
        cronJob: jobId,
      }),
    buildEditHref: (jobId) =>
      buildTabHref({ basePath }, "cron", {
        cronEdit: jobId,
      }),
    buildCancelEditHref: () => buildTabHref({ basePath }, "cron"),
    buildRunChatHref: (sessionKey) =>
      buildCanonicalChatHref(
        {
          basePath,
          sessionKey: "main",
        } as never,
        {
          sessionKey,
        },
      ),
    buildRunRuntimeHref: (sessionKey) =>
      buildCanonicalSessionsRuntimeHref(
        {
          basePath,
          sessionKey: "main",
          runtimeSessionKey: null,
          runtimeRunId: null,
          runtimeSelectedCheckpointId: null,
          runtimeSelectedActionId: null,
          runtimeSelectedClosureRunId: null,
          sessionsFilterActive: "",
          sessionsFilterLimit: "120",
          sessionsIncludeGlobal: true,
          sessionsIncludeUnknown: false,
          sessionsSearchQuery: "",
          sessionsSortColumn: "updated",
          sessionsSortDir: "desc",
          sessionsPage: 0,
          sessionsPageSize: 25,
        } as never,
        {
          sessionKey,
          runId: null,
          checkpointId: null,
          actionId: null,
          closureRunId: null,
        },
      ),
    loading: false,
    jobsLoadingMore: false,
    status: null,
    jobs: [],
    jobsTotal: 0,
    jobsHasMore: false,
    jobsQuery: "",
    jobsEnabledFilter: "all",
    jobsScheduleKindFilter: "all",
    jobsLastStatusFilter: "all",
    jobsSortBy: "nextRunAtMs",
    jobsSortDir: "asc",
    error: null,
    busy: false,
    form: { ...DEFAULT_CRON_FORM },
    fieldErrors: {},
    canSubmit: true,
    editingJobId: null,
    channels: [],
    channelLabels: {},
    runsJobId: null,
    runs: [],
    runsTotal: 0,
    runsHasMore: false,
    runsLoadingMore: false,
    runsScope: "all",
    runsStatuses: [],
    runsDeliveryStatuses: [],
    runsStatusFilter: "all",
    runsQuery: "",
    runsSortDir: "desc",
    agentSuggestions: [],
    modelSuggestions: [],
    thinkingSuggestions: [],
    timezoneSuggestions: [],
    deliveryToSuggestions: [],
    accountSuggestions: [],
    onFormChange: () => undefined,
    onRefresh: () => undefined,
    onAdd: () => undefined,
    onEdit: () => undefined,
    onClone: () => undefined,
    onCancelEdit: () => undefined,
    onToggle: () => undefined,
    onRun: () => undefined,
    onRemove: () => undefined,
    onLoadRuns: () => undefined,
    onLoadMoreJobs: () => undefined,
    onJobsFiltersChange: () => undefined,
    onJobsFiltersReset: () => undefined,
    onLoadMoreRuns: () => undefined,
    onRunsFiltersChange: () => undefined,
    ...propOverrides,
  };
}

describe("cron view", () => {
  it("shows all-job history mode by default", () => {
    const container = document.createElement("div");
    render(renderCron(createProps()), container);

    expect(container.textContent).toContain("Latest runs across all jobs.");
    expect(container.textContent).toContain("Status");
    expect(container.textContent).toContain("All statuses");
    expect(container.textContent).toContain("Delivery");
    expect(container.textContent).toContain("All delivery");
    expect(container.textContent).not.toContain("multi-select");
  });

  it("toggles run status filter via dropdown checkboxes", () => {
    const container = document.createElement("div");
    const onRunsFiltersChange = vi.fn();
    render(
      renderCron(
        createProps({
          onRunsFiltersChange,
        }),
      ),
      container,
    );

    const statusOk = container.querySelector(
      '.cron-filter-dropdown[data-filter="status"] input[value="ok"]',
    );
    expect(statusOk).not.toBeNull();
    if (!(statusOk instanceof HTMLInputElement)) {
      return;
    }
    statusOk.checked = true;
    statusOk.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onRunsFiltersChange).toHaveBeenCalledWith({ cronRunsStatuses: ["ok"] });
  });

  it("loads run history when clicking a job row", () => {
    const container = document.createElement("div");
    const onLoadRuns = vi.fn();
    const job = createJob("job-1");
    render(
      renderCron(
        createProps({
          jobs: [job],
          onLoadRuns,
        }),
      ),
      container,
    );

    const rowLink = container.querySelector("a.cron-job-link-overlay");
    expect(rowLink).not.toBeNull();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    rowLink?.dispatchEvent(click);

    expect(onLoadRuns).toHaveBeenCalledWith("job-1");
    expect(click.defaultPrevented).toBe(true);
  });

  it("renders canonical cron job hrefs for job rows", () => {
    const container = document.createElement("div");
    const job = createJob("job-1");
    render(
      renderCron(
        createProps({
          basePath: "/ui",
          jobs: [job],
          jobsQuery: "nightly",
          jobsEnabledFilter: "enabled",
          jobsScheduleKindFilter: "cron",
          jobsLastStatusFilter: "error",
          jobsSortBy: "updatedAtMs",
          jobsSortDir: "desc",
          runsJobId: "job-old",
          runsScope: "job",
          runsQuery: "timeout",
          runsSortDir: "asc",
          runsStatuses: ["error"],
          runsDeliveryStatuses: ["not-delivered"],
          buildJobHref: (jobId) =>
            buildCanonicalCronJobHref(
              {
                basePath: "/ui",
                sessionKey: "main",
                cronJobsQuery: "nightly",
                cronJobsEnabledFilter: "enabled",
                cronJobsScheduleKindFilter: "cron",
                cronJobsLastStatusFilter: "error",
                cronJobsSortBy: "updatedAtMs",
                cronJobsSortDir: "desc",
                cronRunsScope: "job",
                cronRunsJobId: "job-old",
                cronRunsQuery: "timeout",
                cronRunsSortDir: "asc",
                cronRunsStatuses: ["error"],
                cronRunsDeliveryStatuses: ["not-delivered"],
              } as Parameters<typeof buildCanonicalCronJobHref>[0],
              jobId,
            ),
        }),
      ),
      container,
    );

    const rowLink = container.querySelector("a.cron-job-link-overlay");
    expect(rowLink).not.toBeNull();
    expect(rowLink?.getAttribute("href")).toBe(
      "/ui/cron?session=main&cronQ=nightly&cronEnabled=enabled&cronSchedule=cron&cronStatus=error&cronSort=updatedAtMs&cronDir=desc&cronRunsScope=job&cronJob=job-1&cronRunsQ=timeout&cronRunsSort=asc&cronRunsStatus=error&cronRunsDelivery=not-delivered",
    );
  });

  it("lets modified clicks fall through to the browser href for job rows", () => {
    const container = document.createElement("div");
    const onLoadRuns = vi.fn();
    const job = createJob("job-1");
    render(
      renderCron(
        createProps({
          basePath: "/ui",
          jobs: [job],
          onLoadRuns,
        }),
      ),
      container,
    );

    const rowLink = container.querySelector("a.cron-job-link-overlay");
    expect(rowLink).not.toBeNull();
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    rowLink?.dispatchEvent(click);

    expect(onLoadRuns).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(false);
  });

  it("marks the selected job and keeps History button to a single call", () => {
    const container = document.createElement("div");
    const onLoadRuns = vi.fn();
    const job = createJob("job-1");
    render(
      renderCron(
        createProps({
          jobs: [job],
          runsJobId: "job-1",
          runsScope: "job",
          onLoadRuns,
        }),
      ),
      container,
    );

    const selected = container.querySelector(".list-item-selected");
    expect(selected).not.toBeNull();

    const historyButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "History",
    );
    expect(historyButton).not.toBeUndefined();
    historyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onLoadRuns).toHaveBeenCalledTimes(1);
    expect(onLoadRuns).toHaveBeenCalledWith("job-1");
  });

  it("renders run chat links when session keys are present", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          basePath: "/ui",
          runsJobId: "job-1",
          runs: [
            {
              ts: Date.now(),
              jobId: "job-1",
              status: "ok",
              summary: "done",
              sessionKey: "agent:main:cron:job-1:run:abc",
            },
          ],
        }),
      ),
      container,
    );

    const link = container.querySelector("a.session-link");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe(
      buildCanonicalChatHref(
        {
          basePath: "/ui",
          sessionKey: "main",
        } as never,
        {
          sessionKey: "agent:main:cron:job-1:run:abc",
        },
      ),
    );
  });

  it("renders runtime inspector links when session keys are present", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          basePath: "/ui",
          runsJobId: "job-1",
          runs: [
            {
              ts: Date.now(),
              jobId: "job-1",
              status: "ok",
              summary: "done",
              sessionKey: "agent:main:cron:job-1:run:abc",
            },
          ],
        }),
      ),
      container,
    );

    const links = Array.from(container.querySelectorAll("a.session-link")).map((link) =>
      link.getAttribute("href"),
    );
    expect(links).toContain(
      buildCanonicalSessionsRuntimeHref(
        {
          basePath: "/ui",
          sessionKey: "main",
          runtimeSessionKey: null,
          runtimeRunId: null,
          runtimeSelectedCheckpointId: null,
          runtimeSelectedActionId: null,
          runtimeSelectedClosureRunId: null,
          sessionsFilterActive: "",
          sessionsFilterLimit: "120",
          sessionsIncludeGlobal: true,
          sessionsIncludeUnknown: false,
          sessionsSearchQuery: "",
          sessionsSortColumn: "updated",
          sessionsSortDir: "desc",
          sessionsPage: 0,
          sessionsPageSize: 25,
        } as never,
        {
          sessionKey: "agent:main:cron:job-1:run:abc",
          runId: null,
          checkpointId: null,
          actionId: null,
          closureRunId: null,
        },
      ),
    );
  });

  it("delegates runtime navigation through callback when opening a cron run session", () => {
    const container = document.createElement("div");
    const onNavigateToRuntime = vi.fn();
    render(
      renderCron(
        createProps({
          runsJobId: "job-1",
          runs: [
            {
              ts: Date.now(),
              jobId: "job-1",
              status: "ok",
              summary: "done",
              sessionKey: "agent:main:cron:job-1:run:abc",
            },
          ],
          onNavigateToRuntime,
          buildRunRuntimeHref: (sessionKey) =>
            buildCanonicalSessionsRuntimeHref(
              {
                basePath: "/ui",
                sessionKey: "main",
                runtimeSessionKey: null,
                runtimeRunId: null,
                runtimeSelectedCheckpointId: null,
                runtimeSelectedActionId: null,
                runtimeSelectedClosureRunId: null,
                sessionsFilterActive: "",
                sessionsFilterLimit: "120",
                sessionsIncludeGlobal: true,
                sessionsIncludeUnknown: false,
                sessionsSearchQuery: "",
                sessionsSortColumn: "updated",
                sessionsSortDir: "desc",
                sessionsPage: 0,
                sessionsPageSize: 25,
              } as never,
              {
                sessionKey,
                runId: null,
                checkpointId: null,
                actionId: null,
                closureRunId: null,
              },
            ),
        }),
      ),
      container,
    );

    const runtimeLink = Array.from(container.querySelectorAll("a.session-link")).find((link) =>
      link.textContent?.includes("Open runtime"),
    );
    runtimeLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));

    expect(onNavigateToRuntime).toHaveBeenCalledWith(
      buildCanonicalSessionsRuntimeHref(
        {
          basePath: "/ui",
          sessionKey: "main",
          runtimeSessionKey: null,
          runtimeRunId: null,
          runtimeSelectedCheckpointId: null,
          runtimeSelectedActionId: null,
          runtimeSelectedClosureRunId: null,
          sessionsFilterActive: "",
          sessionsFilterLimit: "120",
          sessionsIncludeGlobal: true,
          sessionsIncludeUnknown: false,
          sessionsSearchQuery: "",
          sessionsSortColumn: "updated",
          sessionsSortDir: "desc",
          sessionsPage: 0,
          sessionsPageSize: 25,
        } as never,
        {
          sessionKey: "agent:main:cron:job-1:run:abc",
          runId: null,
          checkpointId: null,
          actionId: null,
          closureRunId: null,
        },
      ),
    );
  });

  it("keeps primary clicks on cron run chat links in the in-app callback", () => {
    const container = document.createElement("div");
    const onNavigateToChat = vi.fn();
    render(
      renderCron(
        createProps({
          runsJobId: "job-1",
          runs: [
            {
              ts: Date.now(),
              jobId: "job-1",
              status: "ok",
              summary: "done",
              sessionKey: "agent:main:cron:job-1:run:abc",
            },
          ],
          onNavigateToChat,
        }),
      ),
      container,
    );

    const chatLink = Array.from(container.querySelectorAll("a.session-link")).find((link) =>
      link.textContent?.includes("Open run chat"),
    );
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    const dispatchResult = chatLink?.dispatchEvent(click);

    expect(dispatchResult).toBe(false);
    expect(click.defaultPrevented).toBe(true);
    expect(onNavigateToChat).toHaveBeenCalledWith("agent:main:cron:job-1:run:abc");
  });

  it("lets modified clicks fall through to the browser href for cron run links", () => {
    const container = document.createElement("div");
    const onNavigateToChat = vi.fn();
    const onNavigateToRuntime = vi.fn();
    render(
      renderCron(
        createProps({
          runsJobId: "job-1",
          runs: [
            {
              ts: Date.now(),
              jobId: "job-1",
              status: "ok",
              summary: "done",
              sessionKey: "agent:main:cron:job-1:run:abc",
            },
          ],
          onNavigateToChat,
          onNavigateToRuntime,
        }),
      ),
      container,
    );

    const chatLink = Array.from(container.querySelectorAll("a.session-link")).find((link) =>
      link.textContent?.includes("Open run chat"),
    );
    const runtimeLink = Array.from(container.querySelectorAll("a.session-link")).find((link) =>
      link.textContent?.includes("Open runtime"),
    );
    const chatClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    const runtimeClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });

    expect(chatLink?.dispatchEvent(chatClick)).toBe(true);
    expect(runtimeLink?.dispatchEvent(runtimeClick)).toBe(true);
    expect(chatClick.defaultPrevented).toBe(false);
    expect(runtimeClick.defaultPrevented).toBe(false);
    expect(onNavigateToChat).not.toHaveBeenCalled();
    expect(onNavigateToRuntime).not.toHaveBeenCalled();
  });

  it("shows selected job name and sorts run history newest first", () => {
    const container = document.createElement("div");
    const job = createJob("job-1");
    render(
      renderCron(
        createProps({
          jobs: [job],
          runsJobId: "job-1",
          runsScope: "job",
          runs: [
            { ts: 1, jobId: "job-1", status: "ok", summary: "older run" },
            { ts: 2, jobId: "job-1", status: "ok", summary: "newer run" },
          ],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Latest runs for Daily ping.");

    const cards = Array.from(container.querySelectorAll(".card"));
    const runHistoryCard = cards.find(
      (card) => card.querySelector(".card-title")?.textContent?.trim() === "Run history",
    );
    expect(runHistoryCard).not.toBeUndefined();

    const summaries = Array.from(
      runHistoryCard?.querySelectorAll(".list-item .list-sub") ?? [],
    ).map((el) => (el.textContent ?? "").trim());
    expect(summaries[0]).toBe("newer run");
    expect(summaries[1]).toBe("older run");
  });

  it("labels past nextRunAtMs as due instead of next", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          runsScope: "all",
          runs: [
            {
              ts: Date.now(),
              jobId: "job-1",
              status: "ok",
              summary: "done",
              nextRunAtMs: Date.now() - 13 * 60_000,
            },
          ],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Due");
    expect(container.textContent).not.toContain("Next 13");
  });

  it("calls onJobsFiltersChange when schedule filter changes", () => {
    const container = document.createElement("div");
    const onJobsFiltersChange = vi.fn();
    render(renderCron(createProps({ onJobsFiltersChange })), container);

    const select = container.querySelector('select[data-test-id="cron-jobs-schedule-filter"]');
    expect(select).not.toBeNull();
    if (!(select instanceof HTMLSelectElement)) {
      return;
    }
    select.value = "cron";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsScheduleKindFilter: "cron" });
  });

  it("calls onJobsFiltersChange when last-run filter changes", () => {
    const container = document.createElement("div");
    const onJobsFiltersChange = vi.fn();
    render(renderCron(createProps({ onJobsFiltersChange })), container);

    const select = container.querySelector('select[data-test-id="cron-jobs-last-status-filter"]');
    expect(select).not.toBeNull();
    if (!(select instanceof HTMLSelectElement)) {
      return;
    }
    select.value = "error";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsLastStatusFilter: "error" });
  });

  it("calls onJobsFiltersReset when reset button is clicked", () => {
    const container = document.createElement("div");
    const onJobsFiltersReset = vi.fn();
    render(
      renderCron(
        createProps({
          jobsQuery: "digest",
          onJobsFiltersReset,
        }),
      ),
      container,
    );

    const reset = container.querySelector('button[data-test-id="cron-jobs-filters-reset"]');
    expect(reset).not.toBeNull();
    reset?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onJobsFiltersReset).toHaveBeenCalledTimes(1);
  });

  it("shows webhook delivery option in the form", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          form: { ...DEFAULT_CRON_FORM, payloadKind: "agentTurn" },
        }),
      ),
      container,
    );

    const options = Array.from(container.querySelectorAll("option")).map((opt) =>
      (opt.textContent ?? "").trim(),
    );
    expect(options).toContain("Webhook POST");
  });

  it("normalizes stale announce selection in the form when unsupported", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          form: {
            ...DEFAULT_CRON_FORM,
            sessionTarget: "main",
            payloadKind: "systemEvent",
            deliveryMode: "announce",
          },
        }),
      ),
      container,
    );

    const options = Array.from(container.querySelectorAll("option")).map((opt) =>
      (opt.textContent ?? "").trim(),
    );
    expect(options).not.toContain("Announce summary (default)");
    expect(options).toContain("Webhook POST");
    expect(options).toContain("None (internal)");
    expect(container.querySelector('input[placeholder="https://example.com/cron"]')).toBeNull();
  });

  it("shows webhook delivery details for jobs", () => {
    const container = document.createElement("div");
    const job = {
      ...createJob("job-2"),
      sessionTarget: "isolated" as const,
      payload: { kind: "agentTurn" as const, message: "do it" },
      delivery: { mode: "webhook" as const, to: "https://example.invalid/cron" },
    };
    render(
      renderCron(
        createProps({
          jobs: [job],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Delivery");
    expect(container.textContent).toContain("webhook");
    expect(container.textContent).toContain("https://example.invalid/cron");
  });

  it("wires the Edit action and shows save/cancel controls when editing", () => {
    const container = document.createElement("div");
    const onEdit = vi.fn();
    const onLoadRuns = vi.fn();
    const onCancelEdit = vi.fn();
    const job = createJob("job-3");

    render(
      renderCron(
        createProps({
          jobs: [job],
          editingJobId: "job-3",
          onEdit,
          onLoadRuns,
          onCancelEdit,
        }),
      ),
      container,
    );

    const editLink = Array.from(container.querySelectorAll("a")).find(
      (link) => link.textContent?.trim() === "Edit",
    );
    expect(editLink).not.toBeUndefined();
    const editClick = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    editLink?.dispatchEvent(editClick);
    expect(onEdit).toHaveBeenCalledWith(job);
    expect(onLoadRuns).toHaveBeenCalledWith("job-3");
    expect(editClick.defaultPrevented).toBe(true);

    expect(container.textContent).toContain("Edit Job");
    expect(container.textContent).toContain("Save changes");

    const cancelLink = Array.from(container.querySelectorAll("a")).find(
      (link) => link.textContent?.trim() === "Cancel",
    );
    expect(cancelLink).not.toBeUndefined();
    const cancelClick = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    cancelLink?.dispatchEvent(cancelClick);
    expect(onCancelEdit).toHaveBeenCalledTimes(1);
    expect(cancelClick.defaultPrevented).toBe(true);
  });

  it("renders canonical cron edit hrefs for edit and cancel controls", () => {
    const container = document.createElement("div");
    const job = createJob("job-3");

    render(
      renderCron(
        createProps({
          basePath: "/ui",
          jobs: [job],
          editingJobId: "job-3",
          jobsQuery: "nightly",
          jobsEnabledFilter: "enabled",
          jobsScheduleKindFilter: "cron",
          jobsLastStatusFilter: "error",
          jobsSortBy: "updatedAtMs",
          jobsSortDir: "desc",
          runsScope: "job",
          runsJobId: "job-9",
          runsQuery: "timeout",
          runsSortDir: "asc",
          runsStatuses: ["error"],
          runsDeliveryStatuses: ["not-delivered"],
          buildEditHref: (jobId) =>
            buildCanonicalCronEditHref(
              {
                basePath: "/ui",
                sessionKey: "main",
                cronJobsQuery: "nightly",
                cronJobsEnabledFilter: "enabled",
                cronJobsScheduleKindFilter: "cron",
                cronJobsLastStatusFilter: "error",
                cronJobsSortBy: "updatedAtMs",
                cronJobsSortDir: "desc",
                cronEditingJobId: "job-3",
                cronRunsScope: "job",
                cronRunsJobId: "job-9",
                cronRunsQuery: "timeout",
                cronRunsSortDir: "asc",
                cronRunsStatuses: ["error"],
                cronRunsStatusFilter: "error",
                cronRunsDeliveryStatuses: ["not-delivered"],
              } as Parameters<typeof buildCanonicalCronEditHref>[0],
              jobId,
            ),
          buildCancelEditHref: () =>
            buildCanonicalCronEditHref(
              {
                basePath: "/ui",
                sessionKey: "main",
                cronJobsQuery: "nightly",
                cronJobsEnabledFilter: "enabled",
                cronJobsScheduleKindFilter: "cron",
                cronJobsLastStatusFilter: "error",
                cronJobsSortBy: "updatedAtMs",
                cronJobsSortDir: "desc",
                cronEditingJobId: "job-3",
                cronRunsScope: "job",
                cronRunsJobId: "job-9",
                cronRunsQuery: "timeout",
                cronRunsSortDir: "asc",
                cronRunsStatuses: ["error"],
                cronRunsStatusFilter: "error",
                cronRunsDeliveryStatuses: ["not-delivered"],
              } as Parameters<typeof buildCanonicalCronEditHref>[0],
              null,
            ),
        }),
      ),
      container,
    );

    const editLink = Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find(
      (link) => link.textContent?.trim() === "Edit",
    );
    const cancelLink = Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find(
      (link) => link.textContent?.trim() === "Cancel",
    );

    expect(editLink?.getAttribute("href")).toBe(
      "/ui/cron?session=main&cronQ=nightly&cronEnabled=enabled&cronSchedule=cron&cronStatus=error&cronSort=updatedAtMs&cronDir=desc&cronEdit=job-3&cronRunsScope=job&cronJob=job-9&cronRunsQ=timeout&cronRunsSort=asc&cronRunsStatus=error&cronRunsDelivery=not-delivered",
    );
    expect(editLink?.getAttribute("aria-current")).toBe("page");
    expect(cancelLink?.getAttribute("href")).toBe(
      "/ui/cron?session=main&cronQ=nightly&cronEnabled=enabled&cronSchedule=cron&cronStatus=error&cronSort=updatedAtMs&cronDir=desc&cronRunsScope=job&cronJob=job-9&cronRunsQ=timeout&cronRunsSort=asc&cronRunsStatus=error&cronRunsDelivery=not-delivered",
    );
  });

  it("lets modified clicks fall through to the browser href for cron edit links", () => {
    const container = document.createElement("div");
    const onEdit = vi.fn();
    const onLoadRuns = vi.fn();
    const job = createJob("job-3");

    render(
      renderCron(
        createProps({
          jobs: [job],
          onEdit,
          onLoadRuns,
        }),
      ),
      container,
    );

    const editLink = Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find(
      (link) => link.textContent?.trim() === "Edit",
    );
    expect(editLink).not.toBeUndefined();

    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    editLink?.dispatchEvent(click);

    expect(onEdit).not.toHaveBeenCalled();
    expect(onLoadRuns).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(false);
  });

  it("renders advanced controls for cron + agent payload + delivery", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          form: {
            ...DEFAULT_CRON_FORM,
            scheduleKind: "cron",
            payloadKind: "agentTurn",
            deliveryMode: "announce",
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Advanced");
    expect(container.textContent).toContain("Exact timing (no stagger)");
    expect(container.textContent).toContain("Stagger window");
    expect(container.textContent).toContain("Light context");
    expect(container.textContent).toContain("Model");
    expect(container.textContent).toContain("Thinking");
    expect(container.textContent).toContain("Best effort delivery");
  });

  it("groups stagger window and unit inside the same stagger row", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          form: {
            ...DEFAULT_CRON_FORM,
            scheduleKind: "cron",
            payloadKind: "agentTurn",
          },
        }),
      ),
      container,
    );

    const staggerGroup = container.querySelector(".cron-stagger-group");
    expect(staggerGroup).not.toBeNull();
    expect(staggerGroup?.textContent).toContain("Stagger window");
    expect(staggerGroup?.textContent).toContain("Stagger unit");
  });

  it("explains timeout blank behavior and shows cron jitter hint", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          form: {
            ...DEFAULT_CRON_FORM,
            scheduleKind: "cron",
            payloadKind: "agentTurn",
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain(
      "Optional. Leave blank to use the gateway default timeout behavior for this run.",
    );
    expect(container.textContent).toContain("Need jitter? Use Advanced");
  });

  it("disables Agent ID when clear-agent is enabled", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          form: {
            ...DEFAULT_CRON_FORM,
            clearAgent: true,
          },
        }),
      ),
      container,
    );

    const agentInput = container.querySelector('input[placeholder="main or ops"]');
    expect(agentInput).not.toBeNull();
    expect(agentInput instanceof HTMLInputElement).toBe(true);
    expect(agentInput instanceof HTMLInputElement ? agentInput.disabled : false).toBe(true);
  });

  it("renders sectioned cron form layout", () => {
    const container = document.createElement("div");
    render(renderCron(createProps()), container);
    expect(container.textContent).toContain("Enabled");
    expect(container.textContent).toContain("Jobs");
    expect(container.textContent).toContain("Next wake");
    expect(container.textContent).toContain("Basics");
    expect(container.textContent).toContain("Schedule");
    expect(container.textContent).toContain("Execution");
    expect(container.textContent).toContain("Delivery");
    expect(container.textContent).toContain("Advanced");
  });

  it("renders checkbox fields with input first for alignment", () => {
    const container = document.createElement("div");
    render(renderCron(createProps()), container);
    const checkboxLabel = container.querySelector(".cron-checkbox");
    expect(checkboxLabel).not.toBeNull();
    const firstElement = checkboxLabel?.firstElementChild;
    expect(firstElement?.tagName.toLowerCase()).toBe("input");
  });

  it("hides cron-only advanced controls for non-cron schedules", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          form: {
            ...DEFAULT_CRON_FORM,
            scheduleKind: "every",
            payloadKind: "systemEvent",
            deliveryMode: "none",
          },
        }),
      ),
      container,
    );
    expect(container.textContent).not.toContain("Exact timing (no stagger)");
    expect(container.textContent).not.toContain("Stagger window");
    expect(container.textContent).not.toContain("Model");
    expect(container.textContent).not.toContain("Best effort delivery");
  });

  it("renders inline validation errors and disables submit when invalid", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          form: {
            ...DEFAULT_CRON_FORM,
            name: "",
            scheduleKind: "cron",
            cronExpr: "",
            payloadText: "",
          },
          fieldErrors: {
            name: "cron.errors.nameRequired",
            cronExpr: "cron.errors.cronExprRequired",
            payloadText: "cron.errors.agentMessageRequired",
          },
          canSubmit: false,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Name is required.");
    expect(container.textContent).toContain("Cron expression is required.");
    expect(container.textContent).toContain("Agent message is required.");
    expect(container.textContent).toContain("Can't add job yet");
    expect(container.textContent).toContain("Fix 3 fields to continue.");

    const saveButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      ["Add job", "Save changes"].includes(btn.textContent?.trim() ?? ""),
    );
    expect(saveButton).not.toBeUndefined();
    expect(saveButton?.disabled).toBe(true);
  });

  it("shows required legend and aria bindings for invalid required fields", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          form: {
            ...DEFAULT_CRON_FORM,
            scheduleKind: "every",
            name: "",
            everyAmount: "",
            payloadText: "",
          },
          fieldErrors: {
            name: "cron.errors.nameRequired",
            everyAmount: "cron.errors.everyAmountInvalid",
            payloadText: "cron.errors.agentMessageRequired",
          },
          canSubmit: false,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("* Required");

    const nameInput = container.querySelector("#cron-name");
    expect(nameInput?.getAttribute("aria-invalid")).toBe("true");
    expect(nameInput?.getAttribute("aria-describedby")).toBe("cron-error-name");
    expect(container.querySelector("#cron-error-name")?.textContent).toContain("Name is required.");

    const everyInput = container.querySelector("#cron-every-amount");
    expect(everyInput?.getAttribute("aria-invalid")).toBe("true");
    expect(everyInput?.getAttribute("aria-describedby")).toBe("cron-error-everyAmount");
    expect(container.querySelector("#cron-error-everyAmount")?.textContent).toContain(
      "Interval must be greater than 0.",
    );
  });

  it("wires the Clone action from job rows", () => {
    const container = document.createElement("div");
    const onClone = vi.fn();
    const onLoadRuns = vi.fn();
    const job = createJob("job-clone");
    render(
      renderCron(
        createProps({
          jobs: [job],
          onClone,
          onLoadRuns,
        }),
      ),
      container,
    );

    const cloneButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Clone",
    );
    expect(cloneButton).not.toBeUndefined();
    cloneButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClone).toHaveBeenCalledWith(job);
    expect(onLoadRuns).toHaveBeenCalledWith("job-clone");
  });

  it("selects row when clicking Enable/Disable, Run, and Remove actions", () => {
    const container = document.createElement("div");
    const onToggle = vi.fn();
    const onRun = vi.fn();
    const onRemove = vi.fn();
    const onLoadRuns = vi.fn();
    const job = createJob("job-actions");
    render(
      renderCron(
        createProps({
          jobs: [job],
          onToggle,
          onRun,
          onRemove,
          onLoadRuns,
        }),
      ),
      container,
    );

    const enableButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Disable",
    );
    expect(enableButton).not.toBeUndefined();
    enableButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const runButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Run",
    );
    expect(runButton).not.toBeUndefined();
    runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const removeButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Remove",
    );
    expect(removeButton).not.toBeUndefined();
    removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onToggle).toHaveBeenCalledWith(job, false);
    expect(onRun).toHaveBeenCalledWith(job, "force");
    expect(onRemove).toHaveBeenCalledWith(job);
    expect(onLoadRuns).toHaveBeenCalledTimes(3);
    expect(onLoadRuns).toHaveBeenNthCalledWith(1, "job-actions");
    expect(onLoadRuns).toHaveBeenNthCalledWith(2, "job-actions");
    expect(onLoadRuns).toHaveBeenNthCalledWith(3, "job-actions");
  });

  it("wires Run if due action with due mode", () => {
    const container = document.createElement("div");
    const onRun = vi.fn();
    const onLoadRuns = vi.fn();
    const job = createJob("job-due");
    render(
      renderCron(
        createProps({
          jobs: [job],
          onRun,
          onLoadRuns,
        }),
      ),
      container,
    );

    const runDueButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Run if due",
    );
    expect(runDueButton).not.toBeUndefined();
    runDueButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onRun).toHaveBeenCalledWith(job, "due");
  });

  it("renders suggestion datalists for agent/model/thinking/timezone", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          form: { ...DEFAULT_CRON_FORM, scheduleKind: "cron", payloadKind: "agentTurn" },
          agentSuggestions: ["main"],
          modelSuggestions: ["openai/gpt-5.2"],
          thinkingSuggestions: ["low"],
          timezoneSuggestions: ["UTC"],
          deliveryToSuggestions: ["+15551234567"],
          accountSuggestions: ["default"],
        }),
      ),
      container,
    );

    expect(container.querySelector("datalist#cron-agent-suggestions")).not.toBeNull();
    expect(container.querySelector("datalist#cron-model-suggestions")).not.toBeNull();
    expect(container.querySelector("datalist#cron-thinking-suggestions")).not.toBeNull();
    expect(container.querySelector("datalist#cron-tz-suggestions")).not.toBeNull();
    expect(container.querySelector("datalist#cron-delivery-to-suggestions")).not.toBeNull();
    expect(container.querySelector("datalist#cron-delivery-account-suggestions")).not.toBeNull();
    expect(container.querySelector('input[list="cron-agent-suggestions"]')).not.toBeNull();
    expect(container.querySelector('input[list="cron-model-suggestions"]')).not.toBeNull();
    expect(container.querySelector('input[list="cron-thinking-suggestions"]')).not.toBeNull();
    expect(container.querySelector('input[list="cron-tz-suggestions"]')).not.toBeNull();
    expect(container.querySelector('input[list="cron-delivery-to-suggestions"]')).not.toBeNull();
    expect(
      container.querySelector('input[list="cron-delivery-account-suggestions"]'),
    ).not.toBeNull();
  });
});
