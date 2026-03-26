import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp, formatDurationHuman } from "../format.ts";
import type { WhatsAppStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { formatChannelOptionalBool } from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderWhatsAppCard(params: {
  props: ChannelsProps;
  whatsapp?: WhatsAppStatus;
  accountCountLabel: unknown;
}) {
  const { props, whatsapp, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">WhatsApp</div>
      <div class="card-sub">${t("channels.cards.whatsappSubtitle")}</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">${t("channels.status.configured")}</span>
          <span>${formatChannelOptionalBool(whatsapp?.configured)}</span>
        </div>
        <div>
          <span class="label">${t("channels.status.linked")}</span>
          <span>${formatChannelOptionalBool(whatsapp?.linked)}</span>
        </div>
        <div>
          <span class="label">${t("channels.status.running")}</span>
          <span>${formatChannelOptionalBool(whatsapp?.running)}</span>
        </div>
        <div>
          <span class="label">${t("channels.status.connected")}</span>
          <span>${formatChannelOptionalBool(whatsapp?.connected)}</span>
        </div>
        <div>
          <span class="label">${t("channels.status.lastConnect")}</span>
          <span>
            ${whatsapp?.lastConnectedAt ? formatRelativeTimestamp(whatsapp.lastConnectedAt) : t("common.na")}
          </span>
        </div>
        <div>
          <span class="label">${t("channels.status.lastMessage")}</span>
          <span>
            ${whatsapp?.lastMessageAt ? formatRelativeTimestamp(whatsapp.lastMessageAt) : t("common.na")}
          </span>
        </div>
        <div>
          <span class="label">${t("channels.status.authAge")}</span>
          <span>
            ${whatsapp?.authAgeMs != null ? formatDurationHuman(whatsapp.authAgeMs) : t("common.na")}
          </span>
        </div>
      </div>

      ${
        whatsapp?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${whatsapp.lastError}
          </div>`
          : nothing
      }

      ${
        props.whatsappMessage
          ? html`<div class="callout" style="margin-top: 12px;">
            ${props.whatsappMessage}
          </div>`
          : nothing
      }

      ${
        props.whatsappQrDataUrl
          ? html`<div class="qr-wrap">
            <img src=${props.whatsappQrDataUrl} alt=${t("channels.qrAltWhatsApp")} />
          </div>`
          : nothing
      }

      <div class="row" style="margin-top: 14px; flex-wrap: wrap;">
        <button
          class="btn primary"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppStart(false)}
        >
          ${props.whatsappBusy ? t("channels.actions.working") : t("channels.actions.showQr")}
        </button>
        <button
          class="btn"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppStart(true)}
        >
          ${t("channels.actions.relink")}
        </button>
        <button
          class="btn"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppWait()}
        >
          ${t("channels.actions.waitForScan")}
        </button>
        <button
          class="btn danger"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppLogout()}
        >
          ${t("channels.actions.logout")}
        </button>
        <button class="btn" @click=${() => props.onRefresh(true)}>
          ${t("channels.actions.refresh")}
        </button>
      </div>

      ${renderChannelConfigSection({ channelId: "whatsapp", props })}
    </div>
  `;
}
