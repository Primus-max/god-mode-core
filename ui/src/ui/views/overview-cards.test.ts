/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { buildTabHref } from "../app-settings.ts";
import { SKILL_FILTER_BLOCKED, SKILL_FILTER_MISSING } from "../skills-correlation.ts";
import { renderOverviewCards, type OverviewCardsProps } from "./overview-cards.ts";

function createProps(overrides: Partial<OverviewCardsProps> = {}): OverviewCardsProps {
  return {
    usageResult: {
      totals: { totalCost: 12.34, totalTokens: 456 },
      aggregates: { messages: { total: 7 } },
    } as OverviewCardsProps["usageResult"],
    sessionsResult: {
      count: 3,
      sessions: [],
    } as OverviewCardsProps["sessionsResult"],
    skillsReport: {
      skills: [],
    } as OverviewCardsProps["skillsReport"],
    cronJobs: [],
    cronStatus: { enabled: true, nextWakeAtMs: 1_700_000_000_000 } as OverviewCardsProps["cronStatus"],
    presenceCount: 0,
    buildHref: (tab, options) =>
      buildTabHref({ basePath: "/ui" }, tab, {
        session: "agent:main:main",
        skillFilter: options?.skillFilter,
      }),
    buildChatHref: (sessionKey) =>
      buildTabHref({ basePath: "/ui" }, "chat", {
        session: sessionKey,
      }),
    onNavigate: () => undefined,
    onNavigateToChat: () => undefined,
    ...overrides,
  };
}

describe("overview cards", () => {
  it("renders canonical hrefs for plain cards", async () => {
    const container = document.createElement("div");

    render(renderOverviewCards(createProps()), container);
    await Promise.resolve();

    const sessionsCard = container.querySelector<HTMLAnchorElement>('a.ov-card[data-kind="sessions"]');
    expect(sessionsCard).not.toBeNull();
    expect(sessionsCard?.getAttribute("href")).toBe(
      buildTabHref({ basePath: "/ui" }, "sessions", {
        session: "agent:main:main",
      }),
    );
  });

  it("renders blocked skills cards with the canonical blocked filter href", async () => {
    const container = document.createElement("div");

    render(
      renderOverviewCards(
        createProps({
          skillsReport: {
            skills: [
              {
                name: "Discord",
                disabled: false,
                blockedByAllowlist: true,
                missing: { bins: [], env: [], config: [], os: [] },
              },
            ],
          } as OverviewCardsProps["skillsReport"],
        }),
      ),
      container,
    );
    await Promise.resolve();

    const skillsCard = container.querySelector<HTMLAnchorElement>('a.ov-card[data-kind="skills"]');
    expect(skillsCard?.getAttribute("href")).toBe(
      buildTabHref({ basePath: "/ui" }, "skills", {
        session: "agent:main:main",
        skillFilter: SKILL_FILTER_BLOCKED,
      }),
    );
  });

  it("renders missing skills cards with the canonical missing filter href", async () => {
    const container = document.createElement("div");

    render(
      renderOverviewCards(
        createProps({
          skillsReport: {
            skills: [
              {
                name: "Local CLI",
                disabled: false,
                blockedByAllowlist: false,
                missing: { bins: ["claude"], env: [], config: [], os: [] },
              },
            ],
          } as OverviewCardsProps["skillsReport"],
        }),
      ),
      container,
    );
    await Promise.resolve();

    const skillsCard = container.querySelector<HTMLAnchorElement>('a.ov-card[data-kind="skills"]');
    expect(skillsCard?.getAttribute("href")).toBe(
      buildTabHref({ basePath: "/ui" }, "skills", {
        session: "agent:main:main",
        skillFilter: SKILL_FILTER_MISSING,
      }),
    );
  });

  it("keeps primary clicks on the in-app navigation callback", async () => {
    const container = document.createElement("div");
    const onNavigate = vi.fn();

    render(renderOverviewCards(createProps({ onNavigate })), container);
    await Promise.resolve();

    const sessionsCard = container.querySelector<HTMLAnchorElement>('a.ov-card[data-kind="sessions"]');
    expect(sessionsCard).not.toBeNull();

    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    const dispatchResult = sessionsCard!.dispatchEvent(event);

    expect(dispatchResult).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith("sessions", undefined);
  });

  it("lets modified clicks fall through to the browser href", async () => {
    const container = document.createElement("div");
    const onNavigate = vi.fn();

    render(renderOverviewCards(createProps({ onNavigate })), container);
    await Promise.resolve();

    const sessionsCard = container.querySelector<HTMLAnchorElement>('a.ov-card[data-kind="sessions"]');
    expect(sessionsCard).not.toBeNull();

    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    const dispatchResult = sessionsCard!.dispatchEvent(event);

    expect(dispatchResult).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("renders canonical chat hrefs for overview recent-session rows", async () => {
    const container = document.createElement("div");

    render(
      renderOverviewCards(
        createProps({
          sessionsResult: {
            count: 3,
            sessions: [
              {
                key: "agent:writer:main",
                displayName: "Writer Main",
                label: "Writer Main",
                model: "gpt-5",
                updatedAt: 1_700_000_000_000,
              },
            ],
          } as OverviewCardsProps["sessionsResult"],
        }),
      ),
      container,
    );
    await Promise.resolve();

    const recentLink = container.querySelector<HTMLAnchorElement>(
      'a.ov-recent__row[data-session-key="agent:writer:main"]',
    );
    expect(recentLink).not.toBeNull();
    expect(recentLink?.getAttribute("href")).toBe(
      buildTabHref({ basePath: "/ui" }, "chat", {
        session: "agent:writer:main",
      }),
    );
  });

  it("keeps recent-session primary clicks on the in-app chat handoff", async () => {
    const container = document.createElement("div");
    const onNavigateToChat = vi.fn();

    render(
      renderOverviewCards(
        createProps({
          sessionsResult: {
            count: 3,
            sessions: [
              {
                key: "agent:writer:main",
                displayName: "Writer Main",
                label: "Writer Main",
                model: "gpt-5",
                updatedAt: 1_700_000_000_000,
              },
            ],
          } as OverviewCardsProps["sessionsResult"],
          onNavigateToChat,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const recentLink = container.querySelector<HTMLAnchorElement>(
      'a.ov-recent__row[data-session-key="agent:writer:main"]',
    );
    expect(recentLink).not.toBeNull();

    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    const dispatchResult = recentLink!.dispatchEvent(event);

    expect(dispatchResult).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(onNavigateToChat).toHaveBeenCalledWith("agent:writer:main");
  });

  it("lets recent-session modified clicks fall through to the browser href", async () => {
    const container = document.createElement("div");
    const onNavigateToChat = vi.fn();

    render(
      renderOverviewCards(
        createProps({
          sessionsResult: {
            count: 3,
            sessions: [
              {
                key: "agent:writer:main",
                displayName: "Writer Main",
                label: "Writer Main",
                model: "gpt-5",
                updatedAt: 1_700_000_000_000,
              },
            ],
          } as OverviewCardsProps["sessionsResult"],
          onNavigateToChat,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const recentLink = container.querySelector<HTMLAnchorElement>(
      'a.ov-recent__row[data-session-key="agent:writer:main"]',
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
    expect(onNavigateToChat).not.toHaveBeenCalled();
  });
});
