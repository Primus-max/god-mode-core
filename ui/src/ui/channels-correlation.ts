import type { ChannelAccountSnapshot, ChannelsStatusSnapshot } from "./types.ts";

export type ChannelAttentionTarget = {
  key: string;
  label: string;
  error: string;
};

function resolveChannelKeys(snapshot: ChannelsStatusSnapshot): string[] {
  if (snapshot.channelMeta?.length) {
    return snapshot.channelMeta.map((entry) => entry.id);
  }
  if (snapshot.channelOrder.length > 0) {
    return snapshot.channelOrder;
  }
  return Object.keys(snapshot.channels ?? {});
}

function resolveChannelLabel(snapshot: ChannelsStatusSnapshot, key: string): string {
  return (
    snapshot.channelMeta?.find((entry) => entry.id === key)?.label ??
    snapshot.channelLabels[key] ??
    key
  );
}

function resolveAccountError(accounts: ChannelAccountSnapshot[] | undefined): string | null {
  return (
    accounts?.find((account) => typeof account.lastError === "string" && account.lastError.trim().length > 0)
      ?.lastError ?? null
  );
}

export function collectChannelAttentionTargets(
  snapshot: ChannelsStatusSnapshot | null | undefined,
): ChannelAttentionTarget[] {
  if (!snapshot) {
    return [];
  }
  return resolveChannelKeys(snapshot)
    .map((key) => {
      const status = snapshot.channels[key] as { lastError?: unknown } | undefined;
      const topLevelError =
        typeof status?.lastError === "string" && status.lastError.trim().length > 0
          ? status.lastError
          : null;
      const accountError = resolveAccountError(snapshot.channelAccounts[key]);
      const error = topLevelError ?? accountError;
      if (!error) {
        return null;
      }
      return {
        key,
        label: resolveChannelLabel(snapshot, key),
        error,
      };
    })
    .filter((entry): entry is ChannelAttentionTarget => entry != null);
}
