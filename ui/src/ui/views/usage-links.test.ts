/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { buildCanonicalUsageHref, buildCanonicalUsageSessionHref } from "../app-settings.ts";
import { renderUsage } from "./usage.ts";
import type { UsageProps } from "./usageTypes.ts";

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
  firstActivity: 1_700_000_000_000,
  lastActivity: 1_700_000_060_000,
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

const expectedUsageHref =
  "/ui/usage?session=agent%3Amain%3Amain&usageFrom=2026-03-01&usageTo=2026-03-31&usageTz=utc&usageSession=agent%3Awriter%3Amain&usageQ=writer";

function createUsageHost() {
  return {
    basePath: "/ui",
    sessionKey: "agent:main:main",
    usageStartDate: "2026-03-01",
    usageEndDate: "2026-03-31",
    usageTimeZone: "utc",
    usageSelectedSessions: ["agent:main:main"],
    usageQuery: "writer",
    usageChartMode: "tokens" as const,
    usageDailyChartMode: "by-type" as const,
    usageSessionSort: "recent" as const,
    usageSessionSortDir: "desc" as const,
    usageSessionsTab: "all" as const,
  };
}

function createProps(overrides: Partial<UsageProps> = {}): UsageProps {
  const usageHost = createUsageHost();
  return {
    buildSessionHref: (key) =>
      buildCanonicalUsageSessionHref(usageHost as never, key),
    buildChartModeHref: (mode) => buildCanonicalUsageHref(usageHost as never, { chartMode: mode }),
    buildDailyChartModeHref: (mode) =>
      buildCanonicalUsageHref(usageHost as never, { dailyChartMode: mode }),
    buildSessionsTabHref: (tab) => buildCanonicalUsageHref(usageHost as never, { sessionsTab: tab }),
    buildSessionSortDirHref: (dir) =>
      buildCanonicalUsageHref(usageHost as never, { sessionSortDir: dir }),
    data: {
      loading: false,
      error: null,
      sessions: [
        {
          key: "agent:writer:main",
          label: "Writer Main",
          updatedAt: 1_700_000_060_000,
          agentId: "writer",
          channel: "cli",
          model: "gpt-5",
          modelProvider: "openai",
          usage: baseUsage,
        },
      ],
      sessionsLimitReached: false,
      totals: baseUsage,
      aggregates: null,
      costDaily: [
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
    } as unknown as UsageProps["data"],
    filters: {
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      selectedSessions: [],
      selectedDays: [],
      selectedHours: [],
      query: "writer",
      queryDraft: "writer",
      timeZone: "utc",
    },
    display: {
      chartMode: "tokens",
      dailyChartMode: "by-type",
      sessionSort: "recent",
      sessionSortDir: "desc",
      recentSessions: ["agent:writer:main"],
      sessionsTab: "all",
      visibleColumns: [],
      contextExpanded: false,
      headerPinned: false,
    },
    detail: {
      timeSeriesMode: "cumulative",
      timeSeriesBreakdownMode: "total",
      timeSeries: null,
      timeSeriesLoading: false,
      timeSeriesCursorStart: null,
      timeSeriesCursorEnd: null,
      sessionLogs: null,
      sessionLogsLoading: false,
      sessionLogsExpanded: false,
      logFilters: {
        roles: [],
        tools: [],
        hasTools: false,
        query: "",
      },
    },
    callbacks: {
      filters: {
        onStartDateChange: () => undefined,
        onEndDateChange: () => undefined,
        onRefresh: () => undefined,
        onTimeZoneChange: () => undefined,
        onToggleHeaderPinned: () => undefined,
        onSelectDay: () => undefined,
        onSelectHour: () => undefined,
        onClearDays: () => undefined,
        onClearHours: () => undefined,
        onClearSessions: () => undefined,
        onClearFilters: () => undefined,
        onQueryDraftChange: () => undefined,
        onApplyQuery: () => undefined,
        onClearQuery: () => undefined,
      },
      display: {
        onChartModeChange: () => undefined,
        onDailyChartModeChange: () => undefined,
        onSessionSortChange: () => undefined,
        onSessionSortDirChange: () => undefined,
        onSessionsTabChange: () => undefined,
        onToggleColumn: () => undefined,
      },
      details: {
        onToggleContextExpanded: () => undefined,
        onToggleSessionLogsExpanded: () => undefined,
        onLogFilterRolesChange: () => undefined,
        onLogFilterToolsChange: () => undefined,
        onLogFilterHasToolsChange: () => undefined,
        onLogFilterQueryChange: () => undefined,
        onLogFilterClear: () => undefined,
        onSelectSession: () => undefined,
        onTimeSeriesModeChange: () => undefined,
        onTimeSeriesBreakdownChange: () => undefined,
        onTimeSeriesCursorRangeChange: () => undefined,
      },
    },
    ...overrides,
  };
}

describe("usage session links", () => {
  it("renders canonical hrefs for usage session rows", async () => {
    const container = document.createElement("div");

    render(renderUsage(createProps()), container);
    await Promise.resolve();

    const sessionLink = container.querySelector<HTMLAnchorElement>(
      'a.session-bar-link[data-session-key="agent:writer:main"]',
    );
    expect(sessionLink?.getAttribute("href")).toBe(expectedUsageHref);
  });

  it("keeps primary clicks on the in-app usage handoff", async () => {
    const container = document.createElement("div");
    const onSelectSession = vi.fn();

    render(
      renderUsage(
        createProps({
          callbacks: {
            ...createProps().callbacks,
            details: {
              ...createProps().callbacks.details,
              onSelectSession,
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const sessionLink = container.querySelector<HTMLAnchorElement>(
      'a.session-bar-link[data-session-key="agent:writer:main"]',
    );
    expect(sessionLink).not.toBeNull();

    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    const dispatchResult = sessionLink!.dispatchEvent(event);

    expect(dispatchResult).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(onSelectSession).toHaveBeenCalledWith("agent:writer:main", false);
  });

  it("lets ctrl-click fall through to the browser href", async () => {
    const container = document.createElement("div");
    const onSelectSession = vi.fn();

    render(
      renderUsage(
        createProps({
          callbacks: {
            ...createProps().callbacks,
            details: {
              ...createProps().callbacks.details,
              onSelectSession,
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const sessionLink = container.querySelector<HTMLAnchorElement>(
      'a.session-bar-link[data-session-key="agent:writer:main"]',
    );
    expect(sessionLink).not.toBeNull();

    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    const dispatchResult = sessionLink!.dispatchEvent(event);

    expect(dispatchResult).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("keeps shift-click on the JS multi-select handoff", async () => {
    const container = document.createElement("div");
    const onSelectSession = vi.fn();

    render(
      renderUsage(
        createProps({
          callbacks: {
            ...createProps().callbacks,
            details: {
              ...createProps().callbacks.details,
              onSelectSession,
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const sessionLink = container.querySelector<HTMLAnchorElement>(
      'a.session-bar-link[data-session-key="agent:writer:main"]',
    );
    expect(sessionLink).not.toBeNull();

    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      shiftKey: true,
    });
    const dispatchResult = sessionLink!.dispatchEvent(event);

    expect(dispatchResult).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(onSelectSession).toHaveBeenCalledWith("agent:writer:main", true);
  });

  it("renders canonical hrefs for representative usage overview toggles", async () => {
    const container = document.createElement("div");

    render(renderUsage(createProps()), container);
    await Promise.resolve();

    const toggleLinks = Array.from(container.querySelectorAll<HTMLAnchorElement>("a.toggle-btn"));
    const chartCostLink = toggleLinks.find((link) => link.getAttribute("href")?.includes("usageChart=cost"));
    const dailyTotalLink = toggleLinks.find((link) => link.getAttribute("href")?.includes("usageDaily=total"));
    const sessionsRecentLink = toggleLinks.find((link) =>
      link.getAttribute("href")?.includes("usageSessions=recent"),
    );
    const sortDirLink = container.querySelector<HTMLAnchorElement>("a.sessions-action-btn.icon");

    expect(chartCostLink?.getAttribute("href")).toBe(
      "/ui/usage?session=agent%3Amain%3Amain&usageFrom=2026-03-01&usageTo=2026-03-31&usageTz=utc&usageSession=agent%3Amain%3Amain&usageQ=writer&usageChart=cost",
    );
    expect(dailyTotalLink?.getAttribute("href")).toBe(
      "/ui/usage?session=agent%3Amain%3Amain&usageFrom=2026-03-01&usageTo=2026-03-31&usageTz=utc&usageSession=agent%3Amain%3Amain&usageQ=writer&usageDaily=total",
    );
    expect(sessionsRecentLink?.getAttribute("href")).toBe(
      "/ui/usage?session=agent%3Amain%3Amain&usageFrom=2026-03-01&usageTo=2026-03-31&usageTz=utc&usageSession=agent%3Amain%3Amain&usageQ=writer&usageSessions=recent",
    );
    expect(sortDirLink?.getAttribute("href")).toBe(
      "/ui/usage?session=agent%3Amain%3Amain&usageFrom=2026-03-01&usageTo=2026-03-31&usageTz=utc&usageSession=agent%3Amain%3Amain&usageQ=writer&usageSortDir=asc",
    );
  });

  it("uses JS handoff for primary clicks on usage overview toggles", async () => {
    const container = document.createElement("div");
    const onChartModeChange = vi.fn();

    render(
      renderUsage(
        createProps({
          callbacks: {
            ...createProps().callbacks,
            display: {
              ...createProps().callbacks.display,
              onChartModeChange,
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const costLink = Array.from(container.querySelectorAll<HTMLAnchorElement>("a.toggle-btn")).find(
      (link) => link.textContent?.trim() === "Cost",
    );
    expect(costLink).not.toBeNull();

    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    const dispatchResult = costLink!.dispatchEvent(event);

    expect(dispatchResult).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(onChartModeChange).toHaveBeenCalledWith("cost");
  });

  it("lets modified clicks fall through on usage overview toggles", async () => {
    const container = document.createElement("div");
    const onSessionsTabChange = vi.fn();

    render(
      renderUsage(
        createProps({
          callbacks: {
            ...createProps().callbacks,
            display: {
              ...createProps().callbacks.display,
              onSessionsTabChange,
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const recentLink = Array.from(container.querySelectorAll<HTMLAnchorElement>("a.toggle-btn")).find(
      (link) => link.getAttribute("href")?.includes("usageSessions=recent"),
    );
    expect(recentLink).not.toBeNull();

    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    const dispatchResult = recentLink!.dispatchEvent(event);

    expect(dispatchResult).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(onSessionsTabChange).not.toHaveBeenCalled();
  });

  it("renders the restored usage overview presentation from display state", async () => {
    const container = document.createElement("div");

    render(
      renderUsage(
        createProps({
          display: {
            ...createProps().display,
            chartMode: "cost",
            dailyChartMode: "total",
            sessionsTab: "recent",
            sessionSort: "errors",
            sessionSortDir: "asc",
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const toggleLinks = Array.from(container.querySelectorAll<HTMLAnchorElement>("a.toggle-btn"));
    const activeLabels = toggleLinks
      .filter((link) => link.getAttribute("aria-current") === "page")
      .map((link) => link.textContent?.trim());
    const sortSelect = container.querySelector<HTMLSelectElement>(".sessions-sort select");
    const sortDirLink = container.querySelector<HTMLAnchorElement>("a.sessions-action-btn.icon");

    expect(activeLabels).toContain("Cost");
    expect(activeLabels).toContain("Total");
    expect(activeLabels).toContain("Recently viewed");
    expect(sortSelect?.value).toBe("errors");
    expect(sortDirLink?.textContent?.trim()).toBe("↑");
  });
});
