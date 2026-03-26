import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { ChannelAccountSnapshot } from "../types.ts";
import type { ChannelKey, ChannelsProps } from "./channels.types.ts";

const RECENT_ACTIVITY_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export function hasRecentChannelActivity(account: ChannelAccountSnapshot): boolean {
  if (!account.lastInboundAt) {
    return false;
  }
  return Date.now() - account.lastInboundAt < RECENT_ACTIVITY_THRESHOLD_MS;
}

export function formatChannelBool(value: boolean): string {
  return value ? t("channels.status.yes") : t("channels.status.no");
}

export function formatChannelOptionalBool(value: boolean | null | undefined): string {
  if (value === true) {
    return t("channels.status.yes");
  }
  if (value === false) {
    return t("channels.status.no");
  }
  return t("common.na");
}

export type ChannelRunDisplay = "yes" | "no" | "active";

export function deriveChannelRunningState(account: ChannelAccountSnapshot): ChannelRunDisplay {
  if (account.running) {
    return "yes";
  }
  if (hasRecentChannelActivity(account)) {
    return "active";
  }
  return "no";
}

export function formatChannelRunDisplay(state: ChannelRunDisplay): string {
  switch (state) {
    case "yes":
      return t("channels.status.yes");
    case "active":
      return t("channels.status.active");
    default:
      return t("channels.status.no");
  }
}

export type ChannelConnectedDisplay = "yes" | "no" | "active" | "na";

export function deriveChannelConnectedState(
  account: ChannelAccountSnapshot,
): ChannelConnectedDisplay {
  if (account.connected === true) {
    return "yes";
  }
  if (account.connected === false) {
    return "no";
  }
  if (hasRecentChannelActivity(account)) {
    return "active";
  }
  return "na";
}

export function formatChannelConnectedDisplay(state: ChannelConnectedDisplay): string {
  switch (state) {
    case "yes":
      return t("channels.status.yes");
    case "no":
      return t("channels.status.no");
    case "active":
      return t("channels.status.active");
    default:
      return t("common.na");
  }
}

export function channelProbeSummary(ok: boolean): string {
  return ok ? t("channels.status.probeOk") : t("channels.status.probeFailed");
}

export function channelEnabled(key: ChannelKey, props: ChannelsProps) {
  const snapshot = props.snapshot;
  const channels = snapshot?.channels as Record<string, unknown> | null;
  if (!snapshot || !channels) {
    return false;
  }
  const channelStatus = channels[key] as Record<string, unknown> | undefined;
  const configured = typeof channelStatus?.configured === "boolean" && channelStatus.configured;
  const running = typeof channelStatus?.running === "boolean" && channelStatus.running;
  const connected = typeof channelStatus?.connected === "boolean" && channelStatus.connected;
  const accounts = snapshot.channelAccounts?.[key] ?? [];
  const accountActive = accounts.some(
    (account) => account.configured || account.running || account.connected,
  );
  return configured || running || connected || accountActive;
}

export function getChannelAccountCount(
  key: ChannelKey,
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null,
): number {
  return channelAccounts?.[key]?.length ?? 0;
}

export function renderChannelAccountCount(
  key: ChannelKey,
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null,
) {
  const count = getChannelAccountCount(key, channelAccounts);
  if (count < 2) {
    return nothing;
  }
  return html`<div class="account-count">${t("channels.accountCount", { count: String(count) })}</div>`;
}
