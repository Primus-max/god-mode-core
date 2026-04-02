/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { renderUsageTab } from "./app-render-usage-tab.ts";
import type { AppViewState } from "./app-view-state.ts";

const baseUsage = {
  totalTokens: 1000,
  totalCost: 1.5,
  input: 300,
  output: 400,
  cacheRead: 200,
  cacheWrite: 100,
  inputCost: 0.3,
  outputCost: 0.6,
  cacheReadCost: 0.4,
  cacheWriteCost: 0.2,
  durationMs: 60_000,
  firstActivity: Date.UTC(2026, 2, 12, 9, 0, 0),
  lastActivity: Date.UTC(2026, 2, 12, 9, 30, 0),
  missingCostEntries: 0,
  activityDates: ["2026-03-12"],
  messageCounts: {
    total: 10,
    user: 5,
    assistant: 5,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
  },
};

function setTestWindowUrl(url: string) {
  window.history.replaceState({}, "", url);
}

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    tab: "usage",
    basePath: "/ui",
    sessionKey: "agent:main:main",
    usageLoading: false,
    usageResult: {
      sessions: [
        {
          key: "agent:writer:main",
          label: "Writer Main",
          updatedAt: Date.UTC(2026, 2, 12, 9, 30, 0),
          agentId: "writer",
          channel: "cli",
          model: "gpt-5",
          modelProvider: "openai",
          usage: baseUsage,
        },
      ],
      totals: baseUsage,
      aggregates: null,
    } as AppViewState["usageResult"],
    usageCostSummary: {
      daily: [
        {
          date: "2026-03-12",
          totalTokens: 1000,
          totalCost: 1.5,
          input: 300,
          output: 400,
          cacheRead: 200,
          cacheWrite: 100,
          inputCost: 0.3,
          outputCost: 0.6,
          cacheReadCost: 0.4,
          cacheWriteCost: 0.2,
        },
      ],
    } as AppViewState["usageCostSummary"],
    usageError: null,
    usageStartDate: "2026-03-01",
    usageEndDate: "2026-03-31",
    usageSelectedSessions: [],
    usageSelectedDays: [],
    usageSelectedHours: [],
    usageChartMode: "tokens",
    usageDailyChartMode: "by-type",
    usageTimeSeriesMode: "cumulative",
    usageTimeSeriesBreakdownMode: "total",
    usageTimeSeries: null,
    usageTimeSeriesLoading: false,
    usageTimeSeriesCursorStart: null,
    usageTimeSeriesCursorEnd: null,
    usageSessionLogs: null,
    usageSessionLogsLoading: false,
    usageSessionLogsExpanded: false,
    usageQuery: "writer",
    usageQueryDraft: "writer",
    usageQueryDebounceTimer: null,
    usageSessionSort: "recent",
    usageSessionSortDir: "desc",
    usageRecentSessions: ["agent:writer:main"],
    usageTimeZone: "utc",
    usageContextExpanded: false,
    usageHeaderPinned: false,
    usageSessionsTab: "all",
    usageVisibleColumns: [],
    usageLogFilterRoles: [],
    usageLogFilterTools: [],
    usageLogFilterHasTools: false,
    usageLogFilterQuery: "",
    ...overrides,
  } as AppViewState;
}

afterEach(() => {
  document.body.innerHTML = "";
  setTestWindowUrl("/ui/usage");
});

describe("renderUsageTab drilldown sync", () => {
  it("syncs selected days and hours into the canonical usage URL", async () => {
    setTestWindowUrl(
      "/ui/usage?session=agent%3Amain%3Amain&usageFrom=2026-03-01&usageTo=2026-03-31&usageTz=utc&usageQ=writer",
    );
    const container = document.createElement("div");
    const state = createState();

    render(renderUsageTab(state), container);
    await Promise.resolve();

    const dayBar = container.querySelector<HTMLDivElement>(".daily-bar-wrapper");
    const hourCell = container.querySelectorAll<HTMLDivElement>(".usage-hour-cell")[9];
    expect(dayBar).not.toBeNull();
    expect(hourCell).not.toBeUndefined();

    dayBar!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    hourCell.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(state.usageSelectedDays).toEqual(["2026-03-12"]);
    expect(state.usageSelectedHours).toEqual([9]);
    expect(window.location.search).toContain("usageDays=2026-03-12");
    expect(window.location.search).toContain("usageHours=9");
  });

  it("removes day and hour drilldown params when the restored chips are cleared", async () => {
    setTestWindowUrl(
      "/ui/usage?session=agent%3Amain%3Amain&usageFrom=2026-03-01&usageTo=2026-03-31&usageTz=utc&usageDays=2026-03-12&usageHours=9&usageQ=writer",
    );
    const container = document.createElement("div");
    const state = createState({
      usageSelectedDays: ["2026-03-12"],
      usageSelectedHours: [9],
    });

    render(renderUsageTab(state), container);
    await Promise.resolve();

    const clearButtons = Array.from(container.querySelectorAll<HTMLButtonElement>(".filter-chip-remove"));
    expect(clearButtons).toHaveLength(2);

    clearButtons[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(state.usageSelectedDays).toEqual([]);
    expect(window.location.search).not.toContain("usageDays=");
    expect(window.location.search).toContain("usageHours=9");

    clearButtons[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(state.usageSelectedHours).toEqual([]);
    expect(window.location.search).not.toContain("usageHours=");
  });
});
