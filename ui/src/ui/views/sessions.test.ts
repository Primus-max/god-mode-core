/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
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
    basePath: "",
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
    onRefresh: () => undefined,
    onInspectRuntimeSession: () => undefined,
    onSelectRuntimeCheckpoint: () => undefined,
    onSelectRuntimeAction: () => undefined,
    onSelectRuntimeClosure: () => undefined,
    onClearRuntimeScope: () => undefined,
    onExecuteRuntimeRecoveryAction: () => undefined,
    onPatch: () => undefined,
    onToggleSelect: () => undefined,
    onSelectPage: () => undefined,
    onDeselectPage: () => undefined,
    onDeselectAll: () => undefined,
    onDeleteSelected: () => undefined,
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

    const inspectButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Inspect runtime"),
    );
    inspectButton?.dispatchEvent(new Event("click"));
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
              reasonCode: "completed_with_output",
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

    const inspectButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Inspect runtime"),
    );
    inspectButton?.dispatchEvent(new Event("click"));

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
              reasonCode: "completed_with_output",
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

    const inspectButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Inspect runtime"),
    );
    inspectButton?.dispatchEvent(new Event("click"));

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

  it("renders contextual links to linked bootstrap and artifact records", async () => {
    const container = document.createElement("div");

    render(
      renderSessions({
        ...buildProps(buildResult(buildSession())),
        basePath: "/ui",
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

    const links = Array.from(container.querySelectorAll("a")).map((link) => link.getAttribute("href"));
    expect(links).toContain("/ui/bootstrap?session=agent%3Amain%3Amain&bootstrapRequest=bootstrap-1");
    expect(links).toContain("/ui/artifacts?session=agent%3Amain%3Amain&artifact=artifact-1");
  });
});
