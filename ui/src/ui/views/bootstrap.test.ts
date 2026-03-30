/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderBootstrap, type BootstrapProps } from "./bootstrap.ts";

function createProps(overrides: Partial<BootstrapProps> = {}): BootstrapProps {
  return {
    loading: false,
    detailLoading: false,
    actionBusy: false,
    runtimeLoading: false,
    error: null,
    detailError: null,
    runtimeError: null,
    requests: [
      {
        id: "bootstrap-1",
        capabilityId: "pdf-renderer",
        installMethod: "download",
        reason: "renderer_unavailable",
        sourceDomain: "document",
        sourceRecipeId: "doc_ingest",
        state: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        hasResult: false,
      },
    ],
    pendingCount: 1,
    filterQuery: "",
    selectedId: "bootstrap-1",
    detail: {
      id: "bootstrap-1",
      state: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      request: {
        capabilityId: "pdf-renderer",
        installMethod: "download",
        reason: "renderer_unavailable",
        sourceDomain: "document",
        sourceRecipeId: "doc_ingest",
        approvalMode: "explicit",
        catalogEntry: {
          capability: {
            id: "pdf-renderer",
            label: "PDF Renderer",
            version: "1.0.0",
            status: "missing",
            trusted: true,
          },
          install: {
            method: "download",
            packageRef: "playwright-pdf-renderer@1.0.0",
            integrity:
              "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            downloadUrl: "https://openclaw.ai/bootstrap/playwright-pdf-renderer-1.0.0.tgz",
            archiveKind: "tar",
          },
          source: "catalog",
        },
      },
    },
    runtimeCheckpoints: [],
    onRefresh: () => undefined,
    onSelect: () => undefined,
    onFilterChange: () => undefined,
    onResolve: () => undefined,
    onRun: () => undefined,
    ...overrides,
  };
}

describe("bootstrap view", () => {
  it("renders approval actions for pending requests", async () => {
    const onResolve = vi.fn();
    const container = document.createElement("div");

    render(renderBootstrap(createProps({ onResolve })), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Capability Installs");
    expect(container.textContent).toContain("Approve");
    expect(container.textContent).toContain("Deny");

    const approveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Approve",
    );
    expect(approveButton).toBeTruthy();
    approveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onResolve).toHaveBeenCalledWith("bootstrap-1", "approve");
  });

  it("renders run action for approved requests", async () => {
    const onRun = vi.fn();
    const container = document.createElement("div");

    render(
      renderBootstrap(
        createProps({
          requests: [
            {
              ...createProps().requests[0],
              state: "approved",
            },
          ],
          detail: {
            ...createProps().detail!,
            state: "approved",
          },
          onRun,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const runButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Run bootstrap",
    );
    expect(runButton).toBeTruthy();
    runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRun).toHaveBeenCalledWith("bootstrap-1");
  });

  it("renders linked runtime checkpoint details when available", async () => {
    const container = document.createElement("div");

    render(
      renderBootstrap(
        createProps({
          runtimeCheckpoints: [
            {
              id: "checkpoint-1",
              runId: "run-1",
              boundary: "bootstrap",
              status: "blocked",
              createdAtMs: 1,
              updatedAtMs: 2,
              target: { bootstrapRequestId: "bootstrap-1", operation: "bootstrap.run" },
              operatorHint: "Awaiting operator approval to resume messaging recovery.",
            },
          ],
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Runtime checkpoint");
    expect(container.textContent).toContain("Awaiting operator approval");
  });

  it("renders localized Russian bootstrap controls", async () => {
    const container = document.createElement("div");
    await i18n.setLocale("ru");

    render(renderBootstrap(createProps()), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Установка возможностей");
    expect(container.textContent).toContain("Одобрить");
    expect(container.textContent).toContain("Отклонить");

    await i18n.setLocale("en");
  });
});
