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
});
