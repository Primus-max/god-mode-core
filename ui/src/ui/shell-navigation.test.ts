/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import "../styles.css";
import { titleForTab } from "./navigation.ts";
import { mountApp as mountTestApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

function mountApp(pathname: string) {
  return mountTestApp(pathname);
}

describe("shell navigation parity", () => {
  it("uses the same canonical destination contract for palette and sidebar navigation", async () => {
    const app = mountApp("/ui/chat?session=main");
    await app.updateComplete;

    const searchButton = app.querySelector<HTMLButtonElement>(".topbar-search");
    expect(searchButton).not.toBeNull();
    searchButton?.click();
    await app.updateComplete;

    const usageLabel = titleForTab("usage");
    const paletteLink = Array.from(app.querySelectorAll<HTMLAnchorElement>("a.cmd-palette__item")).find((item) =>
      item.textContent?.includes(usageLabel),
    );
    const sidebarLink = Array.from(app.querySelectorAll<HTMLAnchorElement>("a.nav-item")).find((item) =>
      item.getAttribute("title")?.includes(usageLabel),
    );

    expect(paletteLink).not.toBeUndefined();
    expect(sidebarLink).not.toBeUndefined();
    expect(paletteLink?.getAttribute("href")).toBe(sidebarLink?.getAttribute("href"));

    const expectedHref = paletteLink?.getAttribute("href");
    paletteLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await app.updateComplete;

    expect(app.tab).toBe("usage");
    expect(`${window.location.pathname}${window.location.search}`).toBe(expectedHref);
  });
});
