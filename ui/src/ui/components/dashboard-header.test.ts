/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { DashboardHeader } from "./dashboard-header.ts";

describe("dashboard-header", () => {
  it("renders a canonical overview href for the home breadcrumb", async () => {
    const container = document.createElement("div");
    const header = new DashboardHeader();
    header.tab = "sessions";
    header.homeHref = "/ui/overview?session=main";

    render(header.render(), container);
    await Promise.resolve();

    const link = container.querySelector<HTMLAnchorElement>("a.dashboard-header__breadcrumb-link");
    expect(link?.getAttribute("href")).toBe("/ui/overview?session=main");
    expect(link?.textContent?.trim()).toBe("OpenClaw");
  });

  it("uses SPA handoff for primary clicks on the home breadcrumb", async () => {
    const container = document.createElement("div");
    const onNavigate = vi.fn();
    const header = new DashboardHeader();
    header.tab = "usage";
    header.homeHref = "/ui/overview?session=main";

    render(header.render(), container);
    await Promise.resolve();

    const link = container.querySelector<HTMLAnchorElement>("a.dashboard-header__breadcrumb-link");
    header?.addEventListener("navigate", (event) => {
      onNavigate((event as CustomEvent<string>).detail);
    });

    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    const dispatchResult = link!.dispatchEvent(click);

    expect(dispatchResult).toBe(false);
    expect(click.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith("overview");
  });

  it("lets modified clicks fall through to the breadcrumb href", async () => {
    const container = document.createElement("div");
    const onNavigate = vi.fn();
    const header = new DashboardHeader();
    header.tab = "usage";
    header.homeHref = "/ui/overview?session=main";

    render(header.render(), container);
    await Promise.resolve();

    const link = container.querySelector<HTMLAnchorElement>("a.dashboard-header__breadcrumb-link");
    header?.addEventListener("navigate", (event) => {
      onNavigate((event as CustomEvent<string>).detail);
    });

    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    const dispatchResult = link!.dispatchEvent(click);

    expect(dispatchResult).toBe(true);
    expect(click.defaultPrevented).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
