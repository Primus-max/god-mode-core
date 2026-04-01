/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderArtifacts, type ArtifactsProps } from "./artifacts.ts";

function createProps(overrides: Partial<ArtifactsProps> = {}): ArtifactsProps {
  return {
    loading: false,
    detailLoading: false,
    actionBusy: false,
    error: null,
    detailError: null,
    filterQuery: "",
    selectedId: "artifact-1",
    artifacts: [
      {
        id: "artifact-1",
        kind: "document",
        label: "Invoice Report",
        lifecycle: "preview",
        artifactType: "report",
        previewAvailable: true,
        contentAvailable: true,
        hasMaterialization: true,
        updatedAt: new Date().toISOString(),
      },
    ],
    detail: {
      descriptor: {
        id: "artifact-1",
        kind: "document",
        label: "Invoice Report",
        lifecycle: "preview",
        sourceRecipeId: "doc_ingest",
        updatedAt: new Date().toISOString(),
      },
      artifactType: "report",
      previewAvailable: true,
      contentAvailable: true,
      previewUrl: "http://example.test/preview",
      contentUrl: "http://example.test/content",
    },
    onRefresh: () => undefined,
    onSelect: () => undefined,
    onFilterChange: () => undefined,
    onTransition: () => undefined,
    ...overrides,
  };
}

describe("artifacts view", () => {
  it("renders preview/content links and lifecycle actions", async () => {
    const onTransition = vi.fn();
    const container = document.createElement("div");

    render(renderArtifacts(createProps({ onTransition })), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Open preview");
    expect(container.textContent).toContain("Open content");
    expect(container.textContent).toContain("Approve");
    expect(container.textContent).toContain("Publish");

    const approveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Approve",
    );
    expect(approveButton).toBeTruthy();
    approveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onTransition).toHaveBeenCalledWith("artifact-1", "approve");
  });

  it("filters artifacts by query text", async () => {
    const container = document.createElement("div");

    render(
      renderArtifacts(
        createProps({
          filterQuery: "missing",
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("No artifacts yet.");
  });

  it("renders localized Russian copy for artifact actions", async () => {
    const container = document.createElement("div");
    await i18n.setLocale("ru");

    render(renderArtifacts(createProps()), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Артефакты");
    expect(container.textContent).toContain("Открыть превью");
    expect(container.textContent).toContain("Одобрить");

    await i18n.setLocale("en");
  });

  it("forwards filter input changes", async () => {
    const onFilterChange = vi.fn();
    const container = document.createElement("div");

    render(renderArtifacts(createProps({ onFilterChange })), container);
    await Promise.resolve();

    const filterInput = container.querySelector('input[type="search"]');
    expect(filterInput).toBeTruthy();
    Object.defineProperty(filterInput, "value", { value: "invoice", configurable: true });
    filterInput?.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onFilterChange).toHaveBeenLastCalledWith("invoice");
  });
});
