/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderOverviewAttention } from "./overview-attention.ts";

describe("overview attention", () => {
  it("renders action links for operator attention items", async () => {
    const container = document.createElement("div");

    render(
      renderOverviewAttention({
        items: [
          {
            severity: "warning",
            icon: "shield",
            title: "Recovery needs review",
            description: "Awaiting operator approval.",
            href: "/ui/sessions?session=agent%3Amain%3Amain&runtimeSession=agent%3Amain%3Amain",
            actionLabel: "Review",
          },
        ],
      }),
      container,
    );
    await Promise.resolve();

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(
      "/ui/sessions?session=agent%3Amain%3Amain&runtimeSession=agent%3Amain%3Amain",
    );
    expect(link?.textContent).toContain("Review");
  });

  it("intercepts primary clicks for internal attention links", async () => {
    const container = document.createElement("div");
    const onNavigate = vi.fn();

    render(
      renderOverviewAttention({
        items: [
          {
            severity: "warning",
            icon: "shield",
            title: "Recovery needs review",
            description: "Awaiting operator approval.",
            href: "/ui/sessions?session=agent%3Amain%3Amain&runtimeSession=agent%3Amain%3Amain",
            actionLabel: "Review",
          },
        ],
        onNavigate,
      }),
      container,
    );
    await Promise.resolve();

    const link = container.querySelector("a");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith(
      "/ui/sessions?session=agent%3Amain%3Amain&runtimeSession=agent%3Amain%3Amain",
    );
  });

  it("lets modified and external attention links fall through", async () => {
    const container = document.createElement("div");
    const onNavigate = vi.fn();

    render(
      renderOverviewAttention({
        items: [
          {
            severity: "warning",
            icon: "shield",
            title: "Recovery needs review",
            description: "Awaiting operator approval.",
            href: "/ui/sessions?session=agent%3Amain%3Amain&runtimeSession=agent%3Amain%3Amain",
            actionLabel: "Review",
          },
          {
            severity: "warning",
            icon: "key",
            title: "Missing operator.read scope",
            description: "Open the docs.",
            href: "https://docs.openclaw.ai/web/dashboard",
            external: true,
          },
        ],
        onNavigate,
      }),
      container,
    );
    await Promise.resolve();

    const [internalLink, externalLink] = Array.from(container.querySelectorAll("a"));
    const modifiedClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    internalLink?.dispatchEvent(modifiedClick);

    const externalClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    externalLink?.dispatchEvent(externalClick);

    expect(modifiedClick.defaultPrevented).toBe(false);
    expect(externalClick.defaultPrevented).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
