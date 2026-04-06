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
            integrity: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            downloadUrl: "https://openclaw.ai/bootstrap/playwright-pdf-renderer-1.0.0.tgz",
            archiveKind: "tar",
          },
          source: "catalog",
        },
      },
    },
    runtimeCheckpoints: [],
    buildRequestHref: (requestId) => `/ui/bootstrap?bootstrapRequest=${encodeURIComponent(requestId)}`,
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

  it("forwards filter input changes", async () => {
    const onFilterChange = vi.fn();
    const container = document.createElement("div");

    render(renderBootstrap(createProps({ onFilterChange })), container);
    await Promise.resolve();

    const filterInput = container.querySelector('input[type="search"]');
    expect(filterInput).toBeTruthy();
    Object.defineProperty(filterInput, "value", { value: "renderer", configurable: true });
    filterInput?.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onFilterChange).toHaveBeenLastCalledWith("renderer");
  });

  it("renders canonical hrefs for bootstrap list rows", async () => {
    const container = document.createElement("div");

    render(
      renderBootstrap(
        createProps({
          filterQuery: "renderer",
          buildRequestHref: (requestId) =>
            `/ui/bootstrap?bootstrapQ=renderer&bootstrapRequest=${encodeURIComponent(requestId)}`,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const rowLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("pdf-renderer"),
    ) as HTMLAnchorElement | undefined;
    expect(rowLink?.getAttribute("href")).toBe(
      "/ui/bootstrap?bootstrapQ=renderer&bootstrapRequest=bootstrap-1",
    );
  });

  it("uses JS handoff for primary clicks on bootstrap list rows", async () => {
    const onSelect = vi.fn();
    const container = document.createElement("div");

    render(
      renderBootstrap(
        createProps({
          onSelect,
          buildRequestHref: () => "/ui/bootstrap?bootstrapRequest=bootstrap-1",
        }),
      ),
      container,
    );
    await Promise.resolve();

    const rowLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("pdf-renderer"),
    ) as HTMLAnchorElement | undefined;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    rowLink?.dispatchEvent(event);

    expect(onSelect).toHaveBeenCalledWith("bootstrap-1");
    expect(event.defaultPrevented).toBe(true);
  });

  it("shows routing context, blocked resume, lifecycle path, and record state hint", async () => {
    const base = createProps();
    const request = {
      ...base.detail!.request,
      executionContext: {
        profileId: "profile-office",
        recipeId: "doc_ingest",
        readinessStatus: "bootstrap_required" as const,
        readinessReasons: ["renderer_unavailable"],
        intent: "document" as const,
        policyAutonomy: "assist" as const,
        unattendedBoundary: "bootstrap" as const,
        bootstrapRequiredCapabilities: ["pdf-renderer"],
        requestedToolNames: ["attachments.read"],
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-20250514",
        plannerReasoning: "Document path requires PDF renderer.",
      },
      blockedRunResume: {
        blockedRunId: "run-blocked-1",
        sessionKey: "agent:main:main",
        queueKey: "queue-main",
        settings: { mode: "followup" as const },
        sourceRun: {
          prompt: "Please summarize the attached PDF.",
          summaryLine: "PDF summary",
          enqueuedAt: 1,
          run: {
            agentId: "agent",
            agentDir: "/tmp/agent",
            sessionId: "session",
            sessionFile: "/tmp/session.json",
            workspaceDir: "/tmp/workspace",
            config: {},
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            timeoutMs: 30_000,
            blockReplyBreak: "message_end" as const,
          },
        },
      },
    };
    const policy = {
      allowCapabilityBootstrap: true,
      allowPrivilegedTools: false,
      requireExplicitApproval: true,
      reasons: [] as string[],
      deniedReasons: [] as string[],
    };
    const lifecycle = {
      capabilityId: request.capabilityId,
      installMethod: request.installMethod,
      verificationStatus: "passed" as const,
      rollbackStatus: "not_needed" as const,
      status: "available" as const,
      transitions: ["requested", "approved", "installing", "verifying", "available"] as const,
    };
    const container = document.createElement("div");
    render(
      renderBootstrap(
        createProps({
          detail: {
            ...base.detail!,
            state: "available",
            request,
            result: {
              capabilityId: request.capabilityId,
              status: "available",
              request,
              policy,
              lifecycle,
            },
          },
          requests: [
            {
              ...base.requests[0],
              state: "available",
              hasResult: true,
              lastResultStatus: "available",
            },
          ],
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Routing & planning context");
    expect(container.textContent).toContain("profile-office");
    expect(container.textContent).toContain("run-blocked-1");
    expect(container.textContent).toContain("Lifecycle path");
    expect(container.textContent).toContain("requested → approved → installing → verifying → available");
    expect(container.textContent).toContain("request available");
  });

  it("surfaces pending approval, run bootstrap after approve, then completed lifecycle in sequence", async () => {
    const pending = createProps();
    const approved = createProps({
      requests: [{ ...pending.requests[0], state: "approved" }],
      detail: { ...pending.detail!, state: "approved" },
    });
    const request = pending.detail!.request;
    const available = createProps({
      requests: [{ ...pending.requests[0], state: "available", hasResult: true, lastResultStatus: "available" }],
      detail: {
        ...pending.detail!,
        state: "available",
        result: {
          capabilityId: request.capabilityId,
          status: "available",
          request,
          policy: {
            allowCapabilityBootstrap: true,
            allowPrivilegedTools: false,
            requireExplicitApproval: true,
            reasons: [],
            deniedReasons: [],
          },
          lifecycle: {
            capabilityId: request.capabilityId,
            installMethod: request.installMethod,
            verificationStatus: "passed",
            rollbackStatus: "not_needed",
            status: "available",
            transitions: ["requested", "approved", "installing", "available"],
          },
        },
      },
    });

    const pendingHost = document.createElement("div");
    render(renderBootstrap(pending), pendingHost);
    await Promise.resolve();
    expect(pendingHost.textContent).toContain("Approve");

    const approvedHost = document.createElement("div");
    render(renderBootstrap(approved), approvedHost);
    await Promise.resolve();
    expect(approvedHost.textContent).toContain("Run bootstrap");

    const doneHost = document.createElement("div");
    render(renderBootstrap(available), doneHost);
    await Promise.resolve();
    expect(doneHost.textContent).toMatch(/installing|available/);
  });

  it("lets modified clicks fall through to the browser href for bootstrap list rows", async () => {
    const onSelect = vi.fn();
    const container = document.createElement("div");

    render(
      renderBootstrap(
        createProps({
          onSelect,
          buildRequestHref: () => "/ui/bootstrap?bootstrapRequest=bootstrap-1",
        }),
      ),
      container,
    );
    await Promise.resolve();

    const rowLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("pdf-renderer"),
    ) as HTMLAnchorElement | undefined;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    rowLink?.dispatchEvent(event);

    expect(onSelect).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
