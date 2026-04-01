/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { buildCanonicalUsageSessionHref } from "../app-settings.ts";
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

function createProps(overrides: Partial<UsageProps> = {}): UsageProps {
  return {
    buildSessionHref: (key) =>
      buildCanonicalUsageSessionHref(
        {
          basePath: "/ui",
          sessionKey: "agent:main:main",
          usageStartDate: "2026-03-01",
          usageEndDate: "2026-03-31",
          usageTimeZone: "utc",
          usageSelectedSessions: ["agent:main:main"],
          usageQuery: "writer",
        } as never,
        key,
      ),
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
      costDaily: [],
    } as UsageProps["data"],
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
      chartMode: "cost",
      dailyChartMode: "total",
      sessionSort: "cost",
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
});
