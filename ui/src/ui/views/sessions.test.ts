/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import {
  buildCanonicalArtifactsHref,
  buildCanonicalBootstrapHref,
  buildCanonicalChatHref,
  buildTabHref,
} from "../app-settings.ts";
import type { SessionsListResult } from "../types.ts";
import { renderSessions, type SessionsProps } from "./sessions.ts";

function buildResult(session: SessionsListResult["sessions"][number]): SessionsListResult {
  return {
    ts: Date.now(),
    path: "(multiple)",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [session],
  };
}

function buildMultiResult(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: Date.now(),
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function buildSession(
  overrides: Partial<SessionsListResult["sessions"][number]> = {},
): SessionsListResult["sessions"][number] {
  return {
    key: "agent:main:main",
    kind: "direct",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function buildProps(result: SessionsListResult): SessionsProps {
  return {
    loading: false,
    runtimeLoading: false,
    runtimeDetailLoading: false,
    runtimeActionBusy: false,
    result,
    error: null,
    runtimeError: null,
    activeMinutes: "",
    limit: "120",
    includeGlobal: false,
    includeUnknown: false,
    searchQuery: "",
    sortColumn: "updated",
    sortDir: "desc",
    page: 0,
    pageSize: 10,
    selectedKeys: new Set<string>(),
    runtimeSessionKey: null,
    runtimeRunId: null,
    runtimeCheckpoints: [],
    runtimeSelectedCheckpointId: null,
    runtimeCheckpointDetail: null,
    runtimeActions: [],
    runtimeSelectedActionId: null,
    runtimeActionDetail: null,
    runtimeClosures: [],
    runtimeSelectedClosureRunId: null,
    runtimeClosureDetail: null,
    onFiltersChange: () => undefined,
    onSearchChange: () => undefined,
    onSortChange: () => undefined,
    onPageChange: () => undefined,
    onPageSizeChange: () => undefined,
    buildSortHref: (column, dir) =>
      buildTabHref({ basePath: "" }, "sessions", {
        sessionsSort: column,
        sessionsDir: dir,
      }),
    buildPageHref: (page) =>
      buildTabHref({ basePath: "" }, "sessions", {
        sessionsPage: String(page),
      }),
    onRefresh: () => undefined,
    onInspectRuntimeSession: () => undefined,
    buildRuntimeInspectHref: (sessionKey, runId) =>
      buildTabHref({ basePath: "" }, "sessions", {
        runtimeSession: sessionKey,
        runtimeRun: runId ?? null,
      }),
    buildRuntimeCheckpointHref: (checkpoint) =>
      buildTabHref({ basePath: "" }, "sessions", {
        checkpoint: checkpoint.id,
      }),
    buildRuntimeBootstrapHref: (sessionKey, requestId) =>
      buildCanonicalBootstrapHref(
        {
          basePath: "",
          sessionKey,
          bootstrapFilterQuery: null,
          bootstrapSelectedId: null,
        } as never,
        {
          sessionKey,
          requestId,
        },
      ),
    buildRuntimeArtifactHref: (sessionKey, artifactId) =>
      buildCanonicalArtifactsHref(
        {
          basePath: "",
          sessionKey,
          artifactsFilterQuery: null,
          artifactsSelectedId: null,
        } as never,
        {
          sessionKey,
          artifactId,
        },
      ),
    onSelectRuntimeCheckpoint: () => undefined,
    buildRuntimeActionHref: (actionId) =>
      buildTabHref({ basePath: "" }, "sessions", {
        runtimeAction: actionId,
      }),
    onSelectRuntimeAction: () => undefined,
    buildRuntimeClosureHref: (runId) =>
      buildTabHref({ basePath: "" }, "sessions", {
        runtimeClosure: runId,
      }),
    onSelectRuntimeClosure: () => undefined,
    onClearRuntimeScope: () => undefined,
    onExecuteRuntimeRecoveryAction: () => undefined,
    onPatch: () => undefined,
    onToggleSelect: () => undefined,
    onSelectPage: () => undefined,
    onDeselectPage: () => undefined,
    onDeselectAll: () => undefined,
    onDeleteSelected: () => undefined,
    buildChatHref: (sessionKey) =>
      buildCanonicalChatHref(
        {
          basePath: "",
          sessionKey: "main",
        } as never,
        {
          sessionKey,
        },
      ),
    onNavigateRuntimeLinkedRecord: () => undefined,
  };
}

describe("sessions view", () => {
  it("renders verbose=full without falling back to inherit", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            verboseLevel: "full",
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const selects = container.querySelectorAll("select");
    const verbose = selects[2] as HTMLSelectElement | undefined;
    expect(verbose?.value).toBe("full");
    expect(Array.from(verbose?.options ?? []).some((option) => option.value === "full")).toBe(true);
  });

  it("keeps unknown stored values selectable instead of forcing inherit", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            reasoningLevel: "custom-mode",
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const selects = container.querySelectorAll("select");
    const reasoning = selects[3] as HTMLSelectElement | undefined;
    expect(reasoning?.value).toBe("custom-mode");
    expect(
      Array.from(reasoning?.options ?? []).some((option) => option.value === "custom-mode"),
    ).toBe(true);
  });

  it("renders explicit fast mode without falling back to inherit", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            fastMode: true,
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const selects = container.querySelectorAll("select");
    const fast = selects[1] as HTMLSelectElement | undefined;
    expect(fast?.value).toBe("on");
  });

  it("deselects only the current page from the header checkbox", async () => {
    const onSelectPage = vi.fn();
    const onDeselectPage = vi.fn();
    const onDeselectAll = vi.fn();
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            {
              key: "page-0",
              kind: "direct",
              updatedAt: 20,
            },
            {
              key: "page-1",
              kind: "direct",
              updatedAt: 10,
            },
          ]),
        ),
        pageSize: 1,
        selectedKeys: new Set(["page-0", "off-page"]),
        onSelectPage,
        onDeselectPage,
        onDeselectAll,
      }),
      container,
    );
    await Promise.resolve();

    const headerCheckbox = container.querySelector("thead input[type=checkbox]");
    headerCheckbox?.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onDeselectPage).toHaveBeenCalledWith(["page-0"]);
    expect(onDeselectAll).not.toHaveBeenCalled();
    expect(onSelectPage).not.toHaveBeenCalled();
  });

  it("renders localized page title in Russian", async () => {
    const container = document.createElement("div");
    await i18n.setLocale("ru");

    render(renderSessions(buildProps(buildResult(buildSession()))), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Сессионные настройки");

    await i18n.setLocale("en");
  });

  it("renders recovery hints and runtime inspector panel", async () => {
    const onInspectRuntimeSession = vi.fn();
    const container = document.createElement("div");

    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            recoveryStatus: "blocked",
            recoveryOperatorHint: "Awaiting operator approval to resume messaging recovery.",
          }),
        ),
        runtimeCheckpoints: [
          {
            id: "cp-1",
            runId: "run-1",
            sessionKey: "agent:main:main",
            boundary: "exec_approval",
            status: "blocked",
            createdAtMs: 1,
            updatedAtMs: 2,
            operatorHint: "Awaiting operator approval to resume messaging recovery.",
          },
        ],
        runtimeSelectedCheckpointId: "cp-1",
        runtimeCheckpointDetail: {
          id: "cp-1",
          runId: "run-1",
          sessionKey: "agent:main:main",
          boundary: "exec_approval",
          status: "blocked",
          createdAtMs: 1,
          updatedAtMs: 2,
          operatorHint: "Awaiting operator approval to resume messaging recovery.",
        },
        onInspectRuntimeSession,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Awaiting operator approval");
    expect(container.textContent).toContain("Runtime Inspector");
    expect(container.textContent).toContain("exec_approval");

    const inspectLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Inspect runtime"),
    );
    inspectLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onInspectRuntimeSession).toHaveBeenCalledWith("agent:main:main", undefined);
  });

  it("prefers recovery handoff truth over stale closure history when inspecting runtime", async () => {
    const onInspectRuntimeSession = vi.fn();
    const container = document.createElement("div");

    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            handoffTruthSource: "recovery",
            handoffRequestRunId: "request-run",
            handoffRunId: "recovery-run",
            runClosureSummary: {
              runId: "closure-run",
              updatedAtMs: 10,
              outcomeStatus: "completed",
              verificationStatus: "verified",
              acceptanceStatus: "satisfied",
              action: "close",
              remediation: "none",
              reasonCode: "verified_execution",
              reasons: ["ok"],
            },
          }),
        ),
        onInspectRuntimeSession,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Handoff truth: recovery");
    expect(container.textContent).toContain("Current target recovery-run");
    expect(container.textContent).toContain("Request anchor request-run");
    expect(container.textContent).toContain("Closure history closure-run");

    const inspectLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Inspect runtime"),
    );
    inspectLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onInspectRuntimeSession).toHaveBeenCalledWith("agent:main:main", "recovery-run");
  });

  it("keeps closure-aligned runtime inspect path when handoff truth is closure", async () => {
    const onInspectRuntimeSession = vi.fn();
    const container = document.createElement("div");

    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            handoffTruthSource: "closure",
            handoffRequestRunId: "request-run",
            handoffRunId: "closure-run",
            runClosureSummary: {
              runId: "closure-run",
              updatedAtMs: 10,
              outcomeStatus: "completed",
              verificationStatus: "verified",
              acceptanceStatus: "satisfied",
              action: "close",
              remediation: "none",
              reasonCode: "verified_execution",
              reasons: ["ok"],
            },
          }),
        ),
        onInspectRuntimeSession,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Handoff truth: closure");
    expect(container.textContent).toContain("Current target closure-run");
    expect(container.textContent).toContain("Request anchor request-run");
    expect(container.textContent).not.toContain("Closure history closure-run");

    const inspectLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Inspect runtime"),
    );
    inspectLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onInspectRuntimeSession).toHaveBeenCalledWith("agent:main:main", "closure-run");
  });

  it("turns runtime next actions into operator controls", async () => {
    const onExecuteRuntimeRecoveryAction = vi.fn();
    const container = document.createElement("div");

    render(
      renderSessions({
        ...buildProps(buildResult(buildSession())),
        runtimeSelectedCheckpointId: "cp-1",
        runtimeCheckpointDetail: {
          id: "cp-1",
          runId: "run-1",
          sessionKey: "agent:main:main",
          boundary: "exec_approval",
          status: "blocked",
          createdAtMs: 1,
          updatedAtMs: 2,
          operatorHint: "Awaiting operator approval to resume messaging recovery.",
          nextActions: [
            {
              method: "exec.approval.resolve",
              label: "Approve or deny closure recovery",
              phase: "approve",
            },
          ],
          target: {
            approvalId: "approval-1",
            operation: "closure.recovery",
          },
          continuation: {
            kind: "closure_recovery",
            state: "idle",
            attempts: 0,
          },
        },
        runtimeCheckpoints: [
          {
            id: "cp-1",
            runId: "run-1",
            sessionKey: "agent:main:main",
            boundary: "exec_approval",
            status: "blocked",
            createdAtMs: 1,
            updatedAtMs: 2,
          },
        ],
        onExecuteRuntimeRecoveryAction,
      }),
      container,
    );
    await Promise.resolve();

    const approveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Approve recovery"),
    );
    approveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onExecuteRuntimeRecoveryAction).toHaveBeenCalledWith({
      kind: "exec-approval-resolve",
      checkpointId: "cp-1",
      approvalId: "approval-1",
      decision: "allow-once",
    });
  });

  it("requires confirmation before high-risk recovery actions", async () => {
    const onExecuteRuntimeRecoveryAction = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const container = document.createElement("div");

    render(
      renderSessions({
        ...buildProps(buildResult(buildSession())),
        runtimeSelectedCheckpointId: "cp-1",
        runtimeCheckpointDetail: {
          id: "cp-1",
          runId: "run-1",
          sessionKey: "agent:main:main",
          boundary: "exec_approval",
          status: "blocked",
          createdAtMs: 1,
          updatedAtMs: 2,
          operatorHint: "Awaiting operator approval to resume messaging recovery.",
          nextActions: [
            {
              method: "exec.approval.resolve",
              label: "Approve or deny closure recovery",
              phase: "approve",
            },
          ],
          target: {
            approvalId: "approval-1",
            operation: "closure.recovery",
          },
        },
        runtimeCheckpoints: [
          {
            id: "cp-1",
            runId: "run-1",
            sessionKey: "agent:main:main",
            boundary: "exec_approval",
            status: "blocked",
            createdAtMs: 1,
            updatedAtMs: 2,
          },
        ],
        onExecuteRuntimeRecoveryAction,
      }),
      container,
    );
    await Promise.resolve();

    const denyButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Deny recovery"),
    );
    denyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(onExecuteRuntimeRecoveryAction).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("renders operator decision audit context for checkpoints and actions", async () => {
    const container = document.createElement("div");

    render(
      renderSessions({
        ...buildProps(buildResult(buildSession())),
        runtimeSelectedCheckpointId: "cp-1",
        runtimeSelectedActionId: "action-1",
        runtimeCheckpointDetail: {
          id: "cp-1",
          runId: "run-1",
          sessionKey: "agent:main:main",
          boundary: "bootstrap",
          status: "resumed",
          createdAtMs: 1,
          updatedAtMs: 2,
          lastOperatorDecision: {
            action: "approve",
            atMs: 3,
            actor: {
              displayName: "Operator Tanya",
            },
            source: "platform.bootstrap.resolve",
          },
        },
        runtimeCheckpoints: [
          {
            id: "cp-1",
            runId: "run-1",
            sessionKey: "agent:main:main",
            boundary: "bootstrap",
            status: "resumed",
            createdAtMs: 1,
            updatedAtMs: 2,
          },
        ],
        runtimeActions: [
          {
            actionId: "action-1",
            runId: "run-1",
            kind: "bootstrap",
            state: "attempted",
            attemptCount: 1,
            createdAtMs: 1,
            updatedAtMs: 2,
          },
        ],
        runtimeActionDetail: {
          actionId: "action-1",
          runId: "run-1",
          kind: "bootstrap",
          state: "attempted",
          attemptCount: 1,
          createdAtMs: 1,
          updatedAtMs: 2,
          receipt: {
            operatorDecision: {
              action: "run",
              atMs: 4,
              actor: {
                displayName: "Operator Tanya",
              },
              source: "platform.bootstrap.run",
            },
          },
        },
      }),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Last operator decision");
    expect(container.textContent).toContain("Operator Tanya");
    expect(container.textContent).toContain("approve");
    expect(container.textContent).toContain("run");
  });

  it("renders canonical hrefs for linked bootstrap and artifact records", async () => {
    const container = document.createElement("div");

    render(
      renderSessions({
        ...buildProps(buildResult(buildSession())),
        buildRuntimeBootstrapHref: (sessionKey, requestId) =>
          buildCanonicalBootstrapHref(
            {
              basePath: "/ui",
              sessionKey,
              bootstrapFilterQuery: "renderer",
              bootstrapSelectedId: "bootstrap-0",
            } as never,
            {
              sessionKey,
              requestId,
            },
          ),
        buildRuntimeArtifactHref: (sessionKey, artifactId) =>
          buildCanonicalArtifactsHref(
            {
              basePath: "/ui",
              sessionKey,
              artifactsFilterQuery: "invoice",
              artifactsSelectedId: "artifact-0",
            } as never,
            {
              sessionKey,
              artifactId,
            },
          ),
        runtimeSelectedCheckpointId: "cp-1",
        runtimeCheckpointDetail: {
          id: "cp-1",
          runId: "run-1",
          sessionKey: "agent:main:main",
          boundary: "bootstrap",
          status: "blocked",
          createdAtMs: 1,
          updatedAtMs: 2,
          target: {
            bootstrapRequestId: "bootstrap-1",
            artifactId: "artifact-1",
            operation: "bootstrap.run",
          },
        },
        runtimeCheckpoints: [
          {
            id: "cp-1",
            runId: "run-1",
            sessionKey: "agent:main:main",
            boundary: "bootstrap",
            status: "blocked",
            createdAtMs: 1,
            updatedAtMs: 2,
          },
        ],
      }),
      container,
    );
    await Promise.resolve();

    const links = Array.from(container.querySelectorAll("a")).map((link) =>
      link.getAttribute("href"),
    );
    expect(links).toContain(
      buildCanonicalBootstrapHref(
        {
          basePath: "/ui",
          sessionKey: "agent:main:main",
          bootstrapFilterQuery: "renderer",
          bootstrapSelectedId: "bootstrap-0",
        } as never,
        {
          sessionKey: "agent:main:main",
          requestId: "bootstrap-1",
        },
      ),
    );
    expect(links).toContain(
      buildCanonicalArtifactsHref(
        {
          basePath: "/ui",
          sessionKey: "agent:main:main",
          artifactsFilterQuery: "invoice",
          artifactsSelectedId: "artifact-0",
        } as never,
        {
          sessionKey: "agent:main:main",
          artifactId: "artifact-1",
        },
      ),
    );
  });

  it("uses JS handoff for primary clicks on linked bootstrap and artifact records", async () => {
    const onNavigateRuntimeLinkedRecord = vi.fn();
    const container = document.createElement("div");

    render(
      renderSessions({
        ...buildProps(buildResult(buildSession())),
        onNavigateRuntimeLinkedRecord,
        buildRuntimeBootstrapHref: () => "/ui/bootstrap?session=agent%3Amain%3Amain&bootstrapRequest=bootstrap-1",
        buildRuntimeArtifactHref: () => "/ui/artifacts?session=agent%3Amain%3Amain&artifact=artifact-1",
        runtimeSelectedCheckpointId: "cp-1",
        runtimeCheckpointDetail: {
          id: "cp-1",
          runId: "run-1",
          sessionKey: "agent:main:main",
          boundary: "bootstrap",
          status: "blocked",
          createdAtMs: 1,
          updatedAtMs: 2,
          target: {
            bootstrapRequestId: "bootstrap-1",
            artifactId: "artifact-1",
            operation: "bootstrap.run",
          },
        },
        runtimeCheckpoints: [
          {
            id: "cp-1",
            runId: "run-1",
            sessionKey: "agent:main:main",
            boundary: "bootstrap",
            status: "blocked",
            createdAtMs: 1,
            updatedAtMs: 2,
          },
        ],
      }),
      container,
    );
    await Promise.resolve();

    const bootstrapLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Open bootstrap"),
    ) as HTMLAnchorElement | undefined;
    const artifactLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Open artifact"),
    ) as HTMLAnchorElement | undefined;

    const bootstrapEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    bootstrapLink?.dispatchEvent(bootstrapEvent);
    const artifactEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    artifactLink?.dispatchEvent(artifactEvent);

    expect(onNavigateRuntimeLinkedRecord).toHaveBeenNthCalledWith(
      1,
      "/ui/bootstrap?session=agent%3Amain%3Amain&bootstrapRequest=bootstrap-1",
    );
    expect(onNavigateRuntimeLinkedRecord).toHaveBeenNthCalledWith(
      2,
      "/ui/artifacts?session=agent%3Amain%3Amain&artifact=artifact-1",
    );
    expect(bootstrapEvent.defaultPrevented).toBe(true);
    expect(artifactEvent.defaultPrevented).toBe(true);
  });

  it("lets modified clicks fall through for linked bootstrap and artifact records", async () => {
    const onNavigateRuntimeLinkedRecord = vi.fn();
    const container = document.createElement("div");

    render(
      renderSessions({
        ...buildProps(buildResult(buildSession())),
        onNavigateRuntimeLinkedRecord,
        buildRuntimeBootstrapHref: () => "/ui/bootstrap?session=agent%3Amain%3Amain&bootstrapRequest=bootstrap-1",
        buildRuntimeArtifactHref: () => "/ui/artifacts?session=agent%3Amain%3Amain&artifact=artifact-1",
        runtimeSelectedCheckpointId: "cp-1",
        runtimeCheckpointDetail: {
          id: "cp-1",
          runId: "run-1",
          sessionKey: "agent:main:main",
          boundary: "bootstrap",
          status: "blocked",
          createdAtMs: 1,
          updatedAtMs: 2,
          target: {
            bootstrapRequestId: "bootstrap-1",
            artifactId: "artifact-1",
            operation: "bootstrap.run",
          },
        },
        runtimeCheckpoints: [
          {
            id: "cp-1",
            runId: "run-1",
            sessionKey: "agent:main:main",
            boundary: "bootstrap",
            status: "blocked",
            createdAtMs: 1,
            updatedAtMs: 2,
          },
        ],
      }),
      container,
    );
    await Promise.resolve();

    const bootstrapLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Open bootstrap"),
    ) as HTMLAnchorElement | undefined;
    const artifactLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Open artifact"),
    ) as HTMLAnchorElement | undefined;

    const bootstrapEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    bootstrapLink?.dispatchEvent(bootstrapEvent);
    const artifactEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    artifactLink?.dispatchEvent(artifactEvent);

    expect(onNavigateRuntimeLinkedRecord).not.toHaveBeenCalled();
    expect(bootstrapEvent.defaultPrevented).toBe(false);
    expect(artifactEvent.defaultPrevented).toBe(false);
  });

  it("renders canonical chat links for session rows", async () => {
    const container = document.createElement("div");

    render(
      renderSessions({
        ...buildProps(
          buildResult(
            buildSession({
              key: "agent:main:linked",
            }),
          ),
        ),
        buildChatHref: (sessionKey) =>
          buildCanonicalChatHref(
            {
              basePath: "/ui",
              sessionKey: "main",
            } as never,
            {
              sessionKey,
            },
          ),
      }),
      container,
    );
    await Promise.resolve();

    const link = container.querySelector("a.session-link");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe(
      buildCanonicalChatHref(
        {
          basePath: "/ui",
          sessionKey: "main",
        } as never,
        {
          sessionKey: "agent:main:linked",
        },
      ),
    );
  });

  it("renders canonical hrefs for sessions list chrome controls", async () => {
    const container = document.createElement("div");

    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            buildSession({ key: "agent:main:linked-1", updatedAt: 30 }),
            buildSession({ key: "agent:main:linked-2", updatedAt: 20 }),
            buildSession({ key: "agent:main:linked-3", updatedAt: 10 }),
          ]),
        ),
        page: 1,
        pageSize: 1,
        runtimeSessionKey: "agent:main:linked-2",
        runtimeRunId: "run-1",
        buildSortHref: (column, dir) =>
          `/ui/sessions?runtimeSession=agent%3Amain%3Alinked-2&runtimeRun=run-1&sessionsSort=${column}&sessionsDir=${dir}&sessionsPage=0`,
        buildPageHref: (page) =>
          `/ui/sessions?runtimeSession=agent%3Amain%3Alinked-2&runtimeRun=run-1&sessionsPage=${page}`,
      }),
      container,
    );
    await Promise.resolve();

    const keySortLink = Array.from(container.querySelectorAll("a.data-table-sort-link")).find((link) =>
      link.textContent?.includes("Key"),
    );
    const previousPageLink = Array.from(
      container.querySelectorAll("a.data-table-pagination__link"),
    ).find((link) => link.textContent?.includes("Previous"));
    const nextPageLink = Array.from(container.querySelectorAll("a.data-table-pagination__link")).find(
      (link) => link.textContent?.includes("Next"),
    );

    expect(keySortLink).not.toBeNull();
    expect(keySortLink?.getAttribute("href")).toBe(
      "/ui/sessions?runtimeSession=agent%3Amain%3Alinked-2&runtimeRun=run-1&sessionsSort=key&sessionsDir=desc&sessionsPage=0",
    );
    expect(previousPageLink?.getAttribute("href")).toBe(
      "/ui/sessions?runtimeSession=agent%3Amain%3Alinked-2&runtimeRun=run-1&sessionsPage=0",
    );
    expect(nextPageLink?.getAttribute("href")).toBe(
      "/ui/sessions?runtimeSession=agent%3Amain%3Alinked-2&runtimeRun=run-1&sessionsPage=2",
    );
  });

  it("uses JS handoff for primary clicks on sessions list chrome links", async () => {
    const onSortChange = vi.fn();
    const onPageChange = vi.fn();
    const container = document.createElement("div");

    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            buildSession({ key: "agent:main:linked-1", updatedAt: 30 }),
            buildSession({ key: "agent:main:linked-2", updatedAt: 20 }),
            buildSession({ key: "agent:main:linked-3", updatedAt: 10 }),
          ]),
        ),
        page: 1,
        pageSize: 1,
        onSortChange,
        onPageChange,
        buildSortHref: () => "/ui/sessions?sort=key",
        buildPageHref: (page) => `/ui/sessions?page=${page}`,
      }),
      container,
    );
    await Promise.resolve();

    const sortLink = container.querySelector(
      'a.data-table-sort-link[href="/ui/sessions?sort=key"]',
    ) as HTMLAnchorElement | null;
    const nextPageLink = container.querySelector(
      'a.data-table-pagination__link[href="/ui/sessions?page=2"]',
    ) as HTMLAnchorElement | null;

    const sortEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    sortLink?.dispatchEvent(sortEvent);
    const pageEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    nextPageLink?.dispatchEvent(pageEvent);

    expect(onSortChange).toHaveBeenCalledWith("key", "desc");
    expect(onPageChange).toHaveBeenCalledWith(2);
    expect(sortEvent.defaultPrevented).toBe(true);
    expect(pageEvent.defaultPrevented).toBe(true);
  });

  it("lets modified clicks fall through to the browser href for sessions list chrome links", async () => {
    const onSortChange = vi.fn();
    const onPageChange = vi.fn();
    const container = document.createElement("div");

    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            buildSession({ key: "agent:main:linked-1", updatedAt: 30 }),
            buildSession({ key: "agent:main:linked-2", updatedAt: 20 }),
            buildSession({ key: "agent:main:linked-3", updatedAt: 10 }),
          ]),
        ),
        page: 1,
        pageSize: 1,
        onSortChange,
        onPageChange,
        buildSortHref: () => "/ui/sessions?sort=key",
        buildPageHref: (page) => `/ui/sessions?page=${page}`,
      }),
      container,
    );
    await Promise.resolve();

    const sortLink = container.querySelector(
      'a.data-table-sort-link[href="/ui/sessions?sort=key"]',
    ) as HTMLAnchorElement | null;
    const nextPageLink = container.querySelector(
      'a.data-table-pagination__link[href="/ui/sessions?page=2"]',
    ) as HTMLAnchorElement | null;

    const sortEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    sortLink?.dispatchEvent(sortEvent);
    const pageEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    nextPageLink?.dispatchEvent(pageEvent);

    expect(onSortChange).not.toHaveBeenCalled();
    expect(onPageChange).not.toHaveBeenCalled();
    expect(sortEvent.defaultPrevented).toBe(false);
    expect(pageEvent.defaultPrevented).toBe(false);
  });

  it("renders canonical hrefs for inspect and runtime drill-down controls", async () => {
    const container = document.createElement("div");

    render(
      renderSessions({
        ...buildProps(
          buildResult(
            buildSession({
              key: "agent:main:linked",
              runClosureSummary: {
                runId: "run-1",
                updatedAtMs: 10,
                outcomeStatus: "completed",
                verificationStatus: "verified",
                acceptanceStatus: "satisfied",
                action: "close",
                remediation: "none",
                reasonCode: "verified_execution",
                reasons: ["ok"],
              },
            }),
          ),
        ),
        buildRuntimeInspectHref: (sessionKey, runId) =>
          `/ui/sessions?runtimeSession=${encodeURIComponent(sessionKey)}&runtimeRun=${runId ?? ""}`,
        buildRuntimeCheckpointHref: (checkpoint) => `/ui/sessions?checkpoint=${checkpoint.id}`,
        buildRuntimeActionHref: (actionId) => `/ui/sessions?runtimeAction=${actionId}`,
        buildRuntimeClosureHref: (runId) => `/ui/sessions?runtimeClosure=${runId}`,
        runtimeSelectedCheckpointId: "cp-1",
        runtimeCheckpointDetail: {
          id: "cp-1",
          runId: "run-1",
          sessionKey: "agent:main:linked",
          boundary: "bootstrap",
          status: "blocked",
          createdAtMs: 1,
          updatedAtMs: 2,
        },
        runtimeCheckpoints: [
          {
            id: "cp-1",
            runId: "run-1",
            sessionKey: "agent:main:linked",
            boundary: "bootstrap",
            status: "blocked",
            createdAtMs: 1,
            updatedAtMs: 2,
          },
        ],
        runtimeActions: [
          {
            actionId: "action-1",
            runId: "run-1",
            kind: "bootstrap",
            state: "attempted",
            attemptCount: 1,
            createdAtMs: 1,
            updatedAtMs: 2,
          },
        ],
        runtimeSelectedActionId: "action-1",
        runtimeClosures: [
          {
            runId: "closure-1",
            updatedAtMs: 3,
            outcomeStatus: "completed",
            verificationStatus: "verified",
            acceptanceStatus: "satisfied",
            action: "close",
            remediation: "none",
            reasonCode: "verified_execution",
            reasons: ["ok"],
          },
        ],
        runtimeSelectedClosureRunId: "closure-1",
      }),
      container,
    );
    await Promise.resolve();

    const inspectLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Inspect runtime"),
    );
    const checkpointLink = container.querySelector('a[href="/ui/sessions?checkpoint=cp-1"]');
    const actionLink = container.querySelector('a[href="/ui/sessions?runtimeAction=action-1"]');
    const closureLink = container.querySelector('a[href="/ui/sessions?runtimeClosure=closure-1"]');

    expect(inspectLink?.getAttribute("href")).toBe(
      "/ui/sessions?runtimeSession=agent%3Amain%3Alinked&runtimeRun=run-1",
    );
    expect(checkpointLink).not.toBeNull();
    expect(actionLink).not.toBeNull();
    expect(closureLink).not.toBeNull();
  });

  it("uses JS handoff for primary clicks on runtime links", async () => {
    const onInspectRuntimeSession = vi.fn();
    const onSelectRuntimeCheckpoint = vi.fn();
    const onSelectRuntimeAction = vi.fn();
    const onSelectRuntimeClosure = vi.fn();
    const container = document.createElement("div");

    render(
      renderSessions({
        ...buildProps(
          buildResult(
            buildSession({
              key: "agent:main:linked",
              runClosureSummary: {
                runId: "run-1",
                updatedAtMs: 10,
                outcomeStatus: "completed",
                verificationStatus: "verified",
                acceptanceStatus: "satisfied",
                action: "close",
                remediation: "none",
                reasonCode: "verified_execution",
                reasons: ["ok"],
              },
            }),
          ),
        ),
        onInspectRuntimeSession,
        onSelectRuntimeCheckpoint,
        onSelectRuntimeAction,
        onSelectRuntimeClosure,
        buildRuntimeInspectHref: () => "/ui/sessions?inspect=1",
        buildRuntimeCheckpointHref: () => "/ui/sessions?checkpoint=cp-1",
        buildRuntimeActionHref: () => "/ui/sessions?runtimeAction=action-1",
        buildRuntimeClosureHref: () => "/ui/sessions?runtimeClosure=closure-1",
        runtimeSelectedCheckpointId: "cp-1",
        runtimeCheckpointDetail: {
          id: "cp-1",
          runId: "run-1",
          sessionKey: "agent:main:linked",
          boundary: "bootstrap",
          status: "blocked",
          createdAtMs: 1,
          updatedAtMs: 2,
        },
        runtimeCheckpoints: [
          {
            id: "cp-1",
            runId: "run-1",
            sessionKey: "agent:main:linked",
            boundary: "bootstrap",
            status: "blocked",
            createdAtMs: 1,
            updatedAtMs: 2,
          },
        ],
        runtimeActions: [
          {
            actionId: "action-1",
            runId: "run-1",
            kind: "bootstrap",
            state: "attempted",
            attemptCount: 1,
            createdAtMs: 1,
            updatedAtMs: 2,
          },
        ],
        runtimeClosures: [
          {
            runId: "closure-1",
            updatedAtMs: 3,
            outcomeStatus: "completed",
            verificationStatus: "verified",
            acceptanceStatus: "satisfied",
            action: "close",
            remediation: "none",
            reasonCode: "verified_execution",
            reasons: ["ok"],
          },
        ],
      }),
      container,
    );
    await Promise.resolve();

    const inspectLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Inspect runtime"),
    ) as HTMLAnchorElement | undefined;
    const checkpointLink = container.querySelector(
      'a[href="/ui/sessions?checkpoint=cp-1"]',
    ) as HTMLAnchorElement | null;
    const actionLink = container.querySelector(
      'a[href="/ui/sessions?runtimeAction=action-1"]',
    ) as HTMLAnchorElement | null;
    const closureLink = container.querySelector(
      'a[href="/ui/sessions?runtimeClosure=closure-1"]',
    ) as HTMLAnchorElement | null;

    const inspectEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    inspectLink?.dispatchEvent(inspectEvent);
    const checkpointEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    checkpointLink?.dispatchEvent(checkpointEvent);
    const actionEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    actionLink?.dispatchEvent(actionEvent);
    const closureEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    closureLink?.dispatchEvent(closureEvent);

    expect(onInspectRuntimeSession).toHaveBeenCalledWith("agent:main:linked", "run-1");
    expect(onSelectRuntimeCheckpoint).toHaveBeenCalledWith("cp-1");
    expect(onSelectRuntimeAction).toHaveBeenCalledWith("action-1");
    expect(onSelectRuntimeClosure).toHaveBeenCalledWith("closure-1");
    expect(inspectEvent.defaultPrevented).toBe(true);
    expect(checkpointEvent.defaultPrevented).toBe(true);
    expect(actionEvent.defaultPrevented).toBe(true);
    expect(closureEvent.defaultPrevented).toBe(true);
  });

  it("lets modified clicks fall through to the browser href for runtime links", async () => {
    const onInspectRuntimeSession = vi.fn();
    const onSelectRuntimeCheckpoint = vi.fn();
    const onSelectRuntimeAction = vi.fn();
    const onSelectRuntimeClosure = vi.fn();
    const container = document.createElement("div");

    render(
      renderSessions({
        ...buildProps(
          buildResult(
            buildSession({
              key: "agent:main:linked",
              runClosureSummary: {
                runId: "run-1",
                updatedAtMs: 10,
                outcomeStatus: "completed",
                verificationStatus: "verified",
                acceptanceStatus: "satisfied",
                action: "close",
                remediation: "none",
                reasonCode: "verified_execution",
                reasons: ["ok"],
              },
            }),
          ),
        ),
        onInspectRuntimeSession,
        onSelectRuntimeCheckpoint,
        onSelectRuntimeAction,
        onSelectRuntimeClosure,
        buildRuntimeInspectHref: () => "/ui/sessions?inspect=1",
        buildRuntimeCheckpointHref: () => "/ui/sessions?checkpoint=cp-1",
        buildRuntimeActionHref: () => "/ui/sessions?runtimeAction=action-1",
        buildRuntimeClosureHref: () => "/ui/sessions?runtimeClosure=closure-1",
        runtimeSelectedCheckpointId: "cp-1",
        runtimeCheckpointDetail: {
          id: "cp-1",
          runId: "run-1",
          sessionKey: "agent:main:linked",
          boundary: "bootstrap",
          status: "blocked",
          createdAtMs: 1,
          updatedAtMs: 2,
        },
        runtimeCheckpoints: [
          {
            id: "cp-1",
            runId: "run-1",
            sessionKey: "agent:main:linked",
            boundary: "bootstrap",
            status: "blocked",
            createdAtMs: 1,
            updatedAtMs: 2,
          },
        ],
        runtimeActions: [
          {
            actionId: "action-1",
            runId: "run-1",
            kind: "bootstrap",
            state: "attempted",
            attemptCount: 1,
            createdAtMs: 1,
            updatedAtMs: 2,
          },
        ],
        runtimeClosures: [
          {
            runId: "closure-1",
            updatedAtMs: 3,
            outcomeStatus: "completed",
            verificationStatus: "verified",
            acceptanceStatus: "satisfied",
            action: "close",
            remediation: "none",
            reasonCode: "verified_execution",
            reasons: ["ok"],
          },
        ],
      }),
      container,
    );
    await Promise.resolve();

    const inspectLink = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Inspect runtime"),
    ) as HTMLAnchorElement | undefined;
    const checkpointLink = container.querySelector(
      'a[href="/ui/sessions?checkpoint=cp-1"]',
    ) as HTMLAnchorElement | null;
    const actionLink = container.querySelector(
      'a[href="/ui/sessions?runtimeAction=action-1"]',
    ) as HTMLAnchorElement | null;
    const closureLink = container.querySelector(
      'a[href="/ui/sessions?runtimeClosure=closure-1"]',
    ) as HTMLAnchorElement | null;

    const inspectEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    inspectLink?.dispatchEvent(inspectEvent);
    const checkpointEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    checkpointLink?.dispatchEvent(checkpointEvent);
    const actionEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    actionLink?.dispatchEvent(actionEvent);
    const closureEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    closureLink?.dispatchEvent(closureEvent);

    expect(onInspectRuntimeSession).not.toHaveBeenCalled();
    expect(onSelectRuntimeCheckpoint).not.toHaveBeenCalled();
    expect(onSelectRuntimeAction).not.toHaveBeenCalled();
    expect(onSelectRuntimeClosure).not.toHaveBeenCalled();
    expect(inspectEvent.defaultPrevented).toBe(false);
    expect(checkpointEvent.defaultPrevented).toBe(false);
    expect(actionEvent.defaultPrevented).toBe(false);
    expect(closureEvent.defaultPrevented).toBe(false);
  });
});
