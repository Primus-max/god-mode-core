/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderLogs, type LogsProps } from "./logs.ts";

function buildProps(overrides: Partial<LogsProps> = {}): LogsProps {
  return {
    loading: false,
    error: null,
    file: null,
    entries: [],
    filterText: "",
    levelFilters: {
      trace: true,
      debug: true,
      info: true,
      warn: true,
      error: true,
      fatal: true,
    },
    autoFollow: true,
    truncated: false,
    onFilterTextChange: vi.fn(),
    onLevelToggle: vi.fn(),
    buildLevelHref: (level, enabled) => `/ui/logs?level=${level}&enabled=${String(enabled)}`,
    onToggleAutoFollow: vi.fn(),
    onRefresh: vi.fn(),
    onExport: vi.fn(),
    onScroll: vi.fn(),
    ...overrides,
  };
}

describe("logs view", () => {
  it("renders the preselected filter text from deep-link state", () => {
    const container = document.createElement("div");

    render(
      renderLogs(
        buildProps({
          filterText: "timeout error",
          entries: [
            {
              raw: '{"message":"timeout error"}',
              message: "timeout error",
              subsystem: "gateway",
              level: "error",
            },
          ],
        }),
      ),
      container,
    );

    const input = container.querySelector("input[placeholder='Search logs']");
    expect(input).toBeInstanceOf(HTMLInputElement);
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("expected search logs input");
    }
    expect(input.value).toBe("timeout error");
    expect(container.textContent).toContain("timeout error");
  });

  it("renders canonical hrefs for representative severity chips", () => {
    const container = document.createElement("div");

    render(
      renderLogs(
        buildProps({
          filterText: "timeout",
          levelFilters: {
            trace: false,
            debug: false,
            info: false,
            warn: true,
            error: true,
            fatal: false,
          },
          buildLevelHref: (level, enabled) => {
            if (level === "debug" && enabled) {
              return "/ui/logs?session=main&logQ=timeout&logLevels=debug,warn,error";
            }
            if (level === "error" && !enabled) {
              return "/ui/logs?session=main&logQ=timeout&logLevels=warn";
            }
            return "/ui/logs?session=main&logQ=timeout";
          },
        }),
      ),
      container,
    );

    const links = Array.from(container.querySelectorAll("a.log-chip"));
    const debugLink = links.find((link) => link.textContent?.includes("debug"));
    const errorLink = links.find((link) => link.textContent?.includes("error"));
    expect(debugLink?.getAttribute("href")).toBe(
      "/ui/logs?session=main&logQ=timeout&logLevels=debug,warn,error",
    );
    expect(errorLink?.getAttribute("href")).toBe("/ui/logs?session=main&logQ=timeout&logLevels=warn");
  });

  it("uses JS handoff for primary clicks on severity chips", () => {
    const container = document.createElement("div");
    const onLevelToggle = vi.fn();

    render(
      renderLogs(
        buildProps({
          onLevelToggle,
        }),
      ),
      container,
    );

    const errorLink = Array.from(container.querySelectorAll("a.log-chip")).find((link) =>
      link.textContent?.includes("error"),
    );
    expect(errorLink).toBeTruthy();
    if (!(errorLink instanceof HTMLAnchorElement)) {
      throw new Error("expected error severity link");
    }

    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    errorLink.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onLevelToggle).toHaveBeenCalledWith("error", false);
  });

  it("lets modified clicks fall through to the browser href for severity chips", () => {
    const container = document.createElement("div");
    const onLevelToggle = vi.fn();

    render(
      renderLogs(
        buildProps({
          onLevelToggle,
        }),
      ),
      container,
    );

    const warnLink = Array.from(container.querySelectorAll("a.log-chip")).find((link) =>
      link.textContent?.includes("warn"),
    );
    expect(warnLink).toBeTruthy();
    if (!(warnLink instanceof HTMLAnchorElement)) {
      throw new Error("expected warn severity link");
    }

    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    warnLink.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onLevelToggle).not.toHaveBeenCalled();
  });

  it("restores the same filtered log set from text and severity deep-link state", () => {
    const container = document.createElement("div");

    render(
      renderLogs(
        buildProps({
          filterText: "gateway",
          levelFilters: {
            trace: false,
            debug: false,
            info: false,
            warn: false,
            error: true,
            fatal: false,
          },
          entries: [
            {
              raw: '{"message":"gateway ok"}',
              message: "gateway ok",
              subsystem: "gateway",
              level: "info",
            },
            {
              raw: '{"message":"gateway failed"}',
              message: "gateway failed",
              subsystem: "gateway",
              level: "error",
            },
          ],
        }),
      ),
      container,
    );

    const rows = Array.from(container.querySelectorAll(".log-row"));
    expect(rows).toHaveLength(1);
    expect(container.textContent).toContain("gateway failed");
    expect(container.textContent).not.toContain("gateway ok");
  });
});
