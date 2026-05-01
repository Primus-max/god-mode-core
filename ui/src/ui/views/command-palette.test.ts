/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { TAB_GROUPS, titleForTab, type Tab } from "../navigation.ts";
import { getPaletteItems, renderCommandPalette } from "./command-palette.ts";

describe("command palette navigation", () => {
  it("covers the same tabs as the shared navigation groups", () => {
    const paletteTabs = getPaletteItems()
      .filter((item) => item.action.startsWith("nav:"))
      .map((item) => item.action.slice(4))
      .sort();
    const groupedTabs = TAB_GROUPS.flatMap((group) => [...group.tabs]).sort();

    expect(paletteTabs).toEqual(groupedTabs);
  });

  it("routes navigation items through onNavigate with the selected tab", async () => {
    const container = document.createElement("div");
    const onNavigate = vi.fn();
    const onToggle = vi.fn();
    const onSlashCommand = vi.fn();
    const usageLabel = titleForTab("usage");

    render(
      renderCommandPalette({
        open: true,
        query: usageLabel,
        activeIndex: 0,
        onToggle,
        onQueryChange: () => undefined,
        onActiveIndexChange: () => undefined,
        buildNavigationHref: (tab) => `/ui/${tab}`,
        onNavigate,
        onSlashCommand,
      }),
      container,
    );
    await Promise.resolve();

    const usageItem = Array.from(container.querySelectorAll<HTMLElement>(".cmd-palette__item")).find((item) =>
      item.textContent?.includes(usageLabel),
    );
    expect(usageItem).not.toBeUndefined();

    usageItem!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onNavigate).toHaveBeenCalledWith("usage" satisfies Tab);
    expect(onToggle).toHaveBeenCalled();
    expect(onSlashCommand).not.toHaveBeenCalled();
  });

  it("renders canonical hrefs for navigation items", async () => {
    const container = document.createElement("div");
    const usageLabel = titleForTab("usage");

    render(
      renderCommandPalette({
        open: true,
        query: usageLabel,
        activeIndex: 0,
        onToggle: () => undefined,
        onQueryChange: () => undefined,
        onActiveIndexChange: () => undefined,
        buildNavigationHref: (tab) => `/ui/${tab}?session=main`,
        onNavigate: () => undefined,
        onSlashCommand: () => undefined,
      }),
      container,
    );
    await Promise.resolve();

    const usageLink = Array.from(container.querySelectorAll<HTMLAnchorElement>("a.cmd-palette__item")).find(
      (item) => item.textContent?.includes(usageLabel),
    );
    expect(usageLink?.getAttribute("href")).toBe("/ui/usage?session=main");
  });

  it("lets modified clicks fall through for navigation items", async () => {
    const container = document.createElement("div");
    const onNavigate = vi.fn();
    const onToggle = vi.fn();
    const usageLabel = titleForTab("usage");

    render(
      renderCommandPalette({
        open: true,
        query: usageLabel,
        activeIndex: 0,
        onToggle,
        onQueryChange: () => undefined,
        onActiveIndexChange: () => undefined,
        buildNavigationHref: (tab) => `/ui/${tab}`,
        onNavigate,
        onSlashCommand: () => undefined,
      }),
      container,
    );
    await Promise.resolve();

    const usageLink = Array.from(container.querySelectorAll<HTMLAnchorElement>("a.cmd-palette__item")).find(
      (item) => item.textContent?.includes(usageLabel),
    );
    expect(usageLink).not.toBeUndefined();

    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    usageLink!.dispatchEvent(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });
});
