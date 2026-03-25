import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { MachineControlLinkRecord, MachineControlStatus } from "../types.ts";

export type MachineProps = {
  loading: boolean;
  actionBusy: boolean;
  error: string | null;
  status: MachineControlStatus | null;
  onRefresh: () => void | Promise<void>;
  onLinkCurrentDevice: () => void | Promise<void>;
  onUnlink: (deviceId: string) => void | Promise<void>;
  onSetKillSwitch: (enabled: boolean) => void | Promise<void>;
};

function renderLinkItem(
  link: MachineControlLinkRecord,
  currentDeviceId: string | null,
  actionBusy: boolean,
  onUnlink: (deviceId: string) => void | Promise<void>,
) {
  const isCurrent = link.deviceId === currentDeviceId;
  return html`
    <div
      class="card"
      style="padding:12px; display:flex; justify-content:space-between; align-items:flex-start; gap:12px;"
    >
      <div>
        <div><strong>${link.deviceId}</strong>${isCurrent ? html` <span>(current)</span>` : nothing}</div>
        <div style="opacity:0.75;">Linked ${formatRelativeTimestamp(link.updatedAtMs)}</div>
      </div>
      <button class="btn danger" type="button" ?disabled=${actionBusy} @click=${() => onUnlink(link.deviceId)}>
        Unlink
      </button>
    </div>
  `;
}

export function renderMachine(props: MachineProps) {
  const status = props.status;
  const currentDevice = status?.currentDevice;
  const accessCode = currentDevice?.access.code ?? null;
  const currentLinked = accessCode === "allowed";
  const killSwitchEnabled = status?.killSwitch.enabled === true;
  const currentDeviceId = currentDevice?.deviceId ?? null;

  return html`
    <section class="card">
      <div class="row" style="justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
        <div>
          <h2 style="margin:0;">${t("tabs.machine")}</h2>
          <div style="opacity:0.75;">
            Explicit device binding and kill-switch controls for machine-scoped execution.
          </div>
        </div>
        <button class="btn" type="button" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${t("common.refresh")}
        </button>
      </div>

      ${props.error
        ? html`<p role="alert" style="color:var(--color-danger, #d44); margin-top:12px;">${props.error}</p>`
        : nothing}

      <div
        style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:16px; margin-top:16px;"
      >
        <div class="card" style="padding:16px;">
          <h3 style="margin-top:0;">Current device</h3>
          ${currentDevice
            ? html`
                <dl style="display:grid; grid-template-columns:max-content 1fr; gap:8px 16px; margin:0;">
                  <dt>Device</dt>
                  <dd>${currentDevice.deviceId}</dd>
                  <dt>Access</dt>
                  <dd>${currentDevice.access.code}</dd>
                  <dt>Status</dt>
                  <dd>${currentDevice.access.message}</dd>
                </dl>
                <div class="row" style="gap:8px; flex-wrap:wrap; margin-top:16px;">
                  ${currentLinked
                    ? html`
                        <button
                          class="btn danger"
                          type="button"
                          ?disabled=${props.actionBusy}
                          @click=${() => props.onUnlink(currentDevice.deviceId)}
                        >
                          Unlink current device
                        </button>
                      `
                    : html`
                        <button
                          class="btn primary"
                          type="button"
                          ?disabled=${props.actionBusy || killSwitchEnabled}
                          @click=${props.onLinkCurrentDevice}
                        >
                          Link current device
                        </button>
                      `}
                </div>
              `
            : html`<div style="opacity:0.75;">No authenticated device identity is available in this browser.</div>`}
        </div>

        <div class="card" style="padding:16px;">
          <h3 style="margin-top:0;">Kill switch</h3>
          <div style="opacity:0.75;">
            ${killSwitchEnabled
              ? "Machine control is currently disabled for all linked devices."
              : "Machine control can run only for linked devices and still requires per-run approval."}
          </div>
          <div class="row" style="gap:8px; flex-wrap:wrap; margin-top:16px;">
            <button
              class="btn ${killSwitchEnabled ? "" : "danger"}"
              type="button"
              ?disabled=${props.actionBusy || killSwitchEnabled}
              @click=${() => props.onSetKillSwitch(true)}
            >
              Enable kill switch
            </button>
            <button
              class="btn ${killSwitchEnabled ? "primary" : ""}"
              type="button"
              ?disabled=${props.actionBusy || !killSwitchEnabled}
              @click=${() => props.onSetKillSwitch(false)}
            >
              Clear kill switch
            </button>
          </div>
          ${status?.killSwitch.updatedAtMs
            ? html`
                <div style="margin-top:12px; opacity:0.75;">
                  Updated ${formatRelativeTimestamp(status.killSwitch.updatedAtMs)}
                </div>
              `
            : nothing}
        </div>
      </div>

      <div class="card" style="padding:16px; margin-top:16px;">
        <h3 style="margin-top:0;">Linked devices</h3>
        ${props.loading
          ? html`<div>Loading machine-control status…</div>`
          : status?.linkedDevices.length
            ? html`
                <div style="display:flex; flex-direction:column; gap:8px;">
                  ${status.linkedDevices.map((link) =>
                    renderLinkItem(link, currentDeviceId, props.actionBusy, props.onUnlink),
                  )}
                </div>
              `
            : html`<div style="opacity:0.75;">No devices are linked for machine control yet.</div>`}
      </div>
    </section>
  `;
}
