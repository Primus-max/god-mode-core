/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
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
});
