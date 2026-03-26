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
        <div>
          <strong>${link.deviceId}</strong>
          ${isCurrent ? html` <span>(${t("machine.currentBadge")})</span>` : nothing}
        </div>
        <div style="opacity:0.75;">
          ${t("machine.linkedSince", { time: formatRelativeTimestamp(link.updatedAtMs) })}
        </div>
      </div>
      <button class="btn danger" type="button" ?disabled=${actionBusy} @click=${() => onUnlink(link.deviceId)}>
        ${t("machine.unlink")}
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
          <div style="opacity:0.75;">${t("machine.subtitle")}</div>
        </div>
        <button class="btn" type="button" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${t("common.refresh")}
        </button>
      </div>

      ${
        props.error
          ? html`<p role="alert" style="color:var(--color-danger, #d44); margin-top:12px;">${props.error}</p>`
          : nothing
      }

      <div
        style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:16px; margin-top:16px;"
      >
        <div class="card" style="padding:16px;">
          <h3 style="margin-top:0;">${t("machine.currentDeviceTitle")}</h3>
          ${
            currentDevice
              ? html`
                <dl style="display:grid; grid-template-columns:max-content 1fr; gap:8px 16px; margin:0;">
                  <dt>${t("machine.fields.device")}</dt>
                  <dd>${currentDevice.deviceId}</dd>
                  <dt>${t("machine.fields.access")}</dt>
                  <dd>${currentDevice.access.code}</dd>
                  <dt>${t("machine.fields.status")}</dt>
                  <dd>${currentDevice.access.message}</dd>
                </dl>
                <div class="row" style="gap:8px; flex-wrap:wrap; margin-top:16px;">
                  ${
                    currentLinked
                      ? html`
                        <button
                          class="btn danger"
                          type="button"
                          ?disabled=${props.actionBusy}
                          @click=${() => props.onUnlink(currentDevice.deviceId)}
                        >
                          ${t("machine.unlinkCurrentDevice")}
                        </button>
                      `
                      : html`
                        <button
                          class="btn primary"
                          type="button"
                          ?disabled=${props.actionBusy || killSwitchEnabled}
                          @click=${props.onLinkCurrentDevice}
                        >
                          ${t("machine.linkCurrentDevice")}
                        </button>
                      `
                  }
                </div>
              `
              : html`<div style="opacity:0.75;">${t("machine.noCurrentDevice")}</div>`
          }
        </div>

        <div class="card" style="padding:16px;">
          <h3 style="margin-top:0;">${t("machine.killSwitchTitle")}</h3>
          <div style="opacity:0.75;">
            ${killSwitchEnabled ? t("machine.killSwitchEnabled") : t("machine.killSwitchDisabled")}
          </div>
          <div class="row" style="gap:8px; flex-wrap:wrap; margin-top:16px;">
            <button
              class="btn ${killSwitchEnabled ? "" : "danger"}"
              type="button"
              ?disabled=${props.actionBusy || killSwitchEnabled}
              @click=${() => props.onSetKillSwitch(true)}
            >
              ${t("machine.enableKillSwitch")}
            </button>
            <button
              class="btn ${killSwitchEnabled ? "primary" : ""}"
              type="button"
              ?disabled=${props.actionBusy || !killSwitchEnabled}
              @click=${() => props.onSetKillSwitch(false)}
            >
              ${t("machine.clearKillSwitch")}
            </button>
          </div>
          ${
            status?.killSwitch.updatedAtMs
              ? html`
                <div style="margin-top:12px; opacity:0.75;">
                  ${t("machine.updated", {
                    time: formatRelativeTimestamp(status.killSwitch.updatedAtMs),
                  })}
                </div>
              `
              : nothing
          }
        </div>
      </div>

      <div class="card" style="padding:16px; margin-top:16px;">
        <h3 style="margin-top:0;">${t("machine.linkedDevicesTitle")}</h3>
        ${
          props.loading
            ? html`<div>${t("machine.loading")}</div>`
            : status?.linkedDevices.length
              ? html`
                <div style="display:flex; flex-direction:column; gap:8px;">
                  ${status.linkedDevices.map((link) =>
                    renderLinkItem(link, currentDeviceId, props.actionBusy, props.onUnlink),
                  )}
                </div>
              `
              : html`<div style="opacity:0.75;">${t("machine.empty")}</div>`
        }
      </div>
    </section>
  `;
}
