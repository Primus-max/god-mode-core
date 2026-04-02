/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, it, expect, vi } from "vitest";
import { buildCanonicalUsageHref } from "../app-settings.ts";
import {
  computeFilteredUsage,
  CHART_BAR_WIDTH_RATIO,
  CHART_MAX_BAR_WIDTH,
  renderTimeSeriesCompact,
} from "./usage-render-details.ts";
import type { TimeSeriesPoint, UsageSessionEntry } from "./usageTypes.ts";

function makePoint(overrides: Partial<TimeSeriesPoint> = {}): TimeSeriesPoint {
  return {
    timestamp: 1000,
    totalTokens: 100,
    cost: 0.01,
    input: 30,
    output: 40,
    cacheRead: 20,
    cacheWrite: 10,
    cumulativeTokens: 0,
    cumulativeCost: 0,
    ...overrides,
  };
}

const baseUsage = {
  totalTokens: 1000,
  totalCost: 1.0,
  input: 300,
  output: 400,
  cacheRead: 200,
  cacheWrite: 100,
  inputCost: 0.3,
  outputCost: 0.4,
  cacheReadCost: 0.2,
  cacheWriteCost: 0.1,
  durationMs: 60000,
  firstActivity: 0,
  lastActivity: 60000,
  missingCostEntries: 0,
  messageCounts: {
    total: 10,
    user: 5,
    assistant: 5,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
  },
} satisfies NonNullable<UsageSessionEntry["usage"]>;

function createUsageHost() {
  return {
    basePath: "/ui",
    sessionKey: "agent:main:main",
    usageStartDate: "2026-03-01",
    usageEndDate: "2026-03-31",
    usageTimeZone: "utc" as const,
    usageSelectedSessions: ["agent:main:main"],
    usageQuery: "cost spike",
    usageChartMode: "cost" as const,
    usageDailyChartMode: "total" as const,
    usageSessionsTab: "recent" as const,
    usageSessionSort: "messages" as const,
    usageSessionSortDir: "asc" as const,
    usageTimeSeriesMode: "per-turn" as const,
    usageTimeSeriesBreakdownMode: "by-type" as const,
  };
}

function makeTimeSeries() {
  return {
    points: [
      makePoint({ timestamp: Date.parse("2026-03-12T10:00:00Z"), totalTokens: 100 }),
      makePoint({ timestamp: Date.parse("2026-03-12T11:00:00Z"), totalTokens: 200 }),
      makePoint({ timestamp: Date.parse("2026-03-12T12:00:00Z"), totalTokens: 300 }),
    ],
  };
}

describe("computeFilteredUsage", () => {
  it("returns undefined when no points match the range", () => {
    const points = [makePoint({ timestamp: 1000 }), makePoint({ timestamp: 2000 })];
    const result = computeFilteredUsage(baseUsage, points, 3000, 4000);
    expect(result).toBeUndefined();
  });

  it("aggregates tokens and cost for points within range", () => {
    const points = [
      makePoint({ timestamp: 1000, totalTokens: 100, cost: 0.1 }),
      makePoint({ timestamp: 2000, totalTokens: 200, cost: 0.2 }),
      makePoint({ timestamp: 3000, totalTokens: 300, cost: 0.3 }),
    ];
    const result = computeFilteredUsage(baseUsage, points, 1000, 2000);
    expect(result).toBeDefined();
    expect(result!.totalTokens).toBe(300); // 100 + 200
    expect(result!.totalCost).toBeCloseTo(0.3); // 0.1 + 0.2
  });

  it("handles reversed range (end < start)", () => {
    const points = [
      makePoint({ timestamp: 1000, totalTokens: 50 }),
      makePoint({ timestamp: 2000, totalTokens: 75 }),
    ];
    const result = computeFilteredUsage(baseUsage, points, 2000, 1000);
    expect(result).toBeDefined();
    expect(result!.totalTokens).toBe(125);
  });

  it("counts message types based on input/output presence", () => {
    const points = [
      makePoint({ timestamp: 1000, input: 10, output: 0 }),
      makePoint({ timestamp: 2000, input: 0, output: 20 }),
      makePoint({ timestamp: 3000, input: 5, output: 15 }),
    ];
    const result = computeFilteredUsage(baseUsage, points, 1000, 3000);
    expect(result!.messageCounts!.user).toBe(2); // points with input > 0
    expect(result!.messageCounts!.assistant).toBe(2); // points with output > 0
    expect(result!.messageCounts!.total).toBe(3);
  });

  it("computes duration from first to last filtered point", () => {
    const points = [makePoint({ timestamp: 1000 }), makePoint({ timestamp: 5000 })];
    const result = computeFilteredUsage(baseUsage, points, 1000, 5000);
    expect(result!.durationMs).toBe(4000);
    expect(result!.firstActivity).toBe(1000);
    expect(result!.lastActivity).toBe(5000);
  });

  it("aggregates token types (input, output, cacheRead, cacheWrite)", () => {
    const points = [
      makePoint({ timestamp: 1000, input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }),
      makePoint({ timestamp: 2000, input: 5, output: 15, cacheRead: 25, cacheWrite: 35 }),
    ];
    const result = computeFilteredUsage(baseUsage, points, 1000, 2000);
    expect(result!.input).toBe(15);
    expect(result!.output).toBe(35);
    expect(result!.cacheRead).toBe(55);
    expect(result!.cacheWrite).toBe(75);
  });
});

describe("chart bar sizing", () => {
  it("bar width ratio and max are reasonable", () => {
    expect(CHART_BAR_WIDTH_RATIO).toBeGreaterThan(0);
    expect(CHART_BAR_WIDTH_RATIO).toBeLessThan(1);
    expect(CHART_MAX_BAR_WIDTH).toBeGreaterThan(0);
  });

  it("bars fit within chart width for typical point counts", () => {
    const chartWidth = 366; // typical: 400 - padding.left(30) - padding.right(4)
    // For reasonable point counts (up to ~300), bars should fit
    for (const n of [1, 2, 10, 50, 100, 200]) {
      const slotWidth = chartWidth / n;
      const barWidth = Math.min(
        CHART_MAX_BAR_WIDTH,
        Math.max(1, slotWidth * CHART_BAR_WIDTH_RATIO),
      );
      const barGap = slotWidth - barWidth;
      // Slot-based sizing guarantees total = n * slotWidth = chartWidth
      expect(n * slotWidth).toBeCloseTo(chartWidth);
      // Bar gap is non-negative when slotWidth >= 1 / CHART_BAR_WIDTH_RATIO
      if (slotWidth >= 1 / CHART_BAR_WIDTH_RATIO) {
        expect(barGap).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("usage detail links", () => {
  it("renders canonical hrefs for representative detail toggles", async () => {
    const host = createUsageHost();
    const container = document.createElement("div");

    render(
      renderTimeSeriesCompact(
        makeTimeSeries(),
        false,
        "per-turn",
        (mode) => buildCanonicalUsageHref(host as never, { timeSeriesMode: mode }),
        () => undefined,
        "by-type",
        (mode) => buildCanonicalUsageHref(host as never, { timeSeriesBreakdownMode: mode }),
        () => undefined,
      ),
      container,
    );
    await Promise.resolve();

    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("a.toggle-btn"));
    const cumulativeLink = links.find((link) => link.getAttribute("href")?.includes("usageTsMode=cumulative"));
    const totalLink = links.find((link) => link.getAttribute("href")?.includes("usageTsBreakdown=total"));

    expect(cumulativeLink?.getAttribute("href")).toBe(
      "/ui/usage?session=agent%3Amain%3Amain&usageFrom=2026-03-01&usageTo=2026-03-31&usageTz=utc&usageSession=agent%3Amain%3Amain&usageQ=cost+spike&usageChart=cost&usageDaily=total&usageSessions=recent&usageSort=messages&usageSortDir=asc&usageTsMode=cumulative",
    );
    expect(totalLink?.getAttribute("href")).toBe(
      "/ui/usage?session=agent%3Amain%3Amain&usageFrom=2026-03-01&usageTo=2026-03-31&usageTz=utc&usageSession=agent%3Amain%3Amain&usageQ=cost+spike&usageChart=cost&usageDaily=total&usageSessions=recent&usageSort=messages&usageSortDir=asc&usageTsBreakdown=total",
    );
  });

  it("uses JS handoff for primary clicks on detail toggles", async () => {
    const host = createUsageHost();
    const container = document.createElement("div");
    const onModeChange = vi.fn();

    render(
      renderTimeSeriesCompact(
        makeTimeSeries(),
        false,
        "per-turn",
        (mode) => buildCanonicalUsageHref(host as never, { timeSeriesMode: mode }),
        onModeChange,
        "by-type",
        (mode) => buildCanonicalUsageHref(host as never, { timeSeriesBreakdownMode: mode }),
        () => undefined,
      ),
      container,
    );
    await Promise.resolve();

    const cumulativeLink = Array.from(container.querySelectorAll<HTMLAnchorElement>("a.toggle-btn")).find(
      (link) => link.getAttribute("href")?.includes("usageTsMode=cumulative"),
    );
    expect(cumulativeLink).not.toBeNull();

    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    const dispatchResult = cumulativeLink!.dispatchEvent(event);

    expect(dispatchResult).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(onModeChange).toHaveBeenCalledWith("cumulative");
  });

  it("lets modified clicks fall through to the browser href for detail toggles", async () => {
    const host = createUsageHost();
    const container = document.createElement("div");
    const onBreakdownChange = vi.fn();

    render(
      renderTimeSeriesCompact(
        makeTimeSeries(),
        false,
        "per-turn",
        (mode) => buildCanonicalUsageHref(host as never, { timeSeriesMode: mode }),
        () => undefined,
        "by-type",
        (mode) => buildCanonicalUsageHref(host as never, { timeSeriesBreakdownMode: mode }),
        onBreakdownChange,
      ),
      container,
    );
    await Promise.resolve();

    const totalLink = Array.from(container.querySelectorAll<HTMLAnchorElement>("a.toggle-btn")).find(
      (link) => link.getAttribute("href")?.includes("usageTsBreakdown=total"),
    );
    expect(totalLink).not.toBeNull();

    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    const dispatchResult = totalLink!.dispatchEvent(event);

    expect(dispatchResult).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(onBreakdownChange).not.toHaveBeenCalled();
  });

  it("renders the restored detail presentation from usage time-series state", async () => {
    const host = createUsageHost();
    const container = document.createElement("div");

    render(
      renderTimeSeriesCompact(
        makeTimeSeries(),
        false,
        "per-turn",
        (mode) => buildCanonicalUsageHref(host as never, { timeSeriesMode: mode }),
        () => undefined,
        "total",
        (mode) => buildCanonicalUsageHref(host as never, { timeSeriesBreakdownMode: mode }),
        () => undefined,
      ),
      container,
    );
    await Promise.resolve();

    const activeLabels = Array.from(container.querySelectorAll<HTMLAnchorElement>("a.toggle-btn"))
      .filter((link) => link.getAttribute("aria-current") === "page")
      .map((link) => link.textContent?.trim());

    expect(activeLabels).toContain("Per Turn");
    expect(activeLabels).toContain("Total");
  });
});
