import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";

function formatRemaining(ms: number): string {
  const remaining = Math.max(0, ms);
  const totalSeconds = Math.floor(remaining / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function renderMetaRow(label: string, value?: string | null) {
  if (!value) {
    return nothing;
  }
  return html`<div class="exec-approval-meta-row"><span>${label}</span><span>${value}</span></div>`;
}

function formatTimestamp(ts?: number | null): string | null {
  return typeof ts === "number" && ts > 0 ? new Date(ts).toISOString() : null;
}

export function renderExecApprovalPrompt(state: AppViewState) {
  const active = state.execApprovalQueue[0];
  if (!active) {
    return nothing;
  }
  const request = active.request;
  const remainingMs = active.expiresAtMs - Date.now();
  const remaining = remainingMs > 0 ? `expires in ${formatRemaining(remainingMs)}` : "expired";
  const queueCount = state.execApprovalQueue.length;
  const machineControl = request.machineControl?.required === true;
  const boundary =
    typeof request.runtimeBoundary === "string" && request.runtimeBoundary.trim()
      ? request.runtimeBoundary.replaceAll("_", " ")
      : null;
  return html`
    <div class="exec-approval-overlay" role="dialog" aria-live="polite">
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">Exec approval needed</div>
            <div class="exec-approval-sub">
              ${remaining}${machineControl ? " · machine control" : ""}
            </div>
          </div>
          ${
            queueCount > 1
              ? html`<div class="exec-approval-queue">${queueCount} pending</div>`
              : nothing
          }
        </div>
        <div class="exec-approval-command mono">${request.command}</div>
        <div class="exec-approval-meta">
          ${machineControl ? renderMetaRow("Machine", "explicitly linked device") : nothing}
          ${machineControl ? renderMetaRow("Device", request.machineControl?.requestedByDeviceId ?? null) : nothing}
          ${machineControl ? renderMetaRow("Linked at", formatTimestamp(request.machineControl?.linkedAtMs)) : nothing}
          ${renderMetaRow("Host", request.host)}
          ${renderMetaRow("Boundary", boundary)}
          ${renderMetaRow("Node", request.nodeId)}
          ${renderMetaRow("Env", request.envKeys?.join(", ") ?? null)}
          ${renderMetaRow("Agent", request.agentId)}
          ${renderMetaRow("Session", request.sessionKey)}
          ${renderMetaRow("CWD", request.cwd)}
          ${renderMetaRow("Resolved", request.resolvedPath)}
          ${renderMetaRow("Security", request.security)}
          ${renderMetaRow("Ask", request.ask)}
          ${renderMetaRow("Reason", request.blockedReason)}
        </div>
        ${
          state.execApprovalError
            ? html`<div class="exec-approval-error">${state.execApprovalError}</div>`
            : nothing
        }
        <div class="exec-approval-actions">
          <button
            class="btn primary"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("allow-once")}
          >
            Allow once
          </button>
          <button
            class="btn"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("allow-always")}
          >
            Always allow
          </button>
          <button
            class="btn danger"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("deny")}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  `;
}
