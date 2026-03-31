/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { ChannelsStatusSnapshot } from "../types.ts";
import { createNostrProfileFormState } from "./channels.nostr-profile-form.ts";
import { renderChannels } from "./channels.ts";
import type { ChannelsProps } from "./channels.types.ts";

function buildSnapshot(overrides: Partial<ChannelsStatusSnapshot> = {}): ChannelsStatusSnapshot {
  return {
    ts: Date.now(),
    channelOrder: ["slack"],
    channelLabels: {},
    channels: { slack: {} },
    channelAccounts: {},
    channelDefaultAccountId: {},
    ...overrides,
  };
}

function buildProps(overrides: Partial<ChannelsProps> = {}): ChannelsProps {
  return {
    connected: true,
    loading: false,
    snapshot: buildSnapshot(),
    selectedChannelKey: null,
    lastError: null,
    lastSuccessAt: null,
    whatsappMessage: null,
    whatsappQrDataUrl: null,
    whatsappConnected: null,
    whatsappBusy: false,
    configSchema: null,
    configSchemaLoading: false,
    configForm: null,
    configUiHints: {},
    configSaving: false,
    configFormDirty: false,
    nostrProfileFormState: null,
    nostrProfileAccountId: null,
    onRefresh: vi.fn(),
    onSelectChannel: vi.fn(),
    onWhatsAppStart: vi.fn(),
    onWhatsAppWait: vi.fn(),
    onWhatsAppLogout: vi.fn(),
    onConfigPatch: vi.fn(),
    onConfigSave: vi.fn(),
    onConfigReload: vi.fn(),
    onNostrProfileEdit: vi.fn(),
    onNostrProfileCancel: vi.fn(),
    onNostrProfileFieldChange: vi.fn(),
    onNostrProfileSave: vi.fn(),
    onNostrProfileImport: vi.fn(),
    onNostrProfileToggleAdvanced: vi.fn(),
    ...overrides,
  };
}

describe("channels view", () => {
  it("renders localized Slack probe control in Russian", async () => {
    const container = document.createElement("div");
    await i18n.setLocale("ru");

    render(renderChannels(buildProps()), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Проверить");

    await i18n.setLocale("en");
  });

  it("renders Nostr profile form with localized title in Russian", async () => {
    const container = document.createElement("div");
    await i18n.setLocale("ru");

    const snapshot = buildSnapshot({
      channelOrder: ["nostr"],
      channels: { nostr: { configured: true, running: false } },
      channelAccounts: {
        nostr: [{ accountId: "default", configured: true, running: false }],
      },
    });

    render(
      renderChannels(
        buildProps({
          snapshot,
          nostrProfileAccountId: "default",
          nostrProfileFormState: createNostrProfileFormState(undefined),
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Редактировать профиль");

    await i18n.setLocale("en");
  });

  it("marks the selected channel shell and notifies when another channel is selected", async () => {
    const container = document.createElement("div");
    const onSelectChannel = vi.fn();

    render(
      renderChannels(
        buildProps({
          snapshot: buildSnapshot({
            channelOrder: ["slack", "telegram"],
            channelLabels: { slack: "Slack", telegram: "Telegram" },
            channels: { slack: {}, telegram: {} },
          }),
          selectedChannelKey: "slack",
          onSelectChannel,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const selected = container.querySelector('[data-channel-key="slack"]');
    const other = container.querySelector('[data-channel-key="telegram"]');

    expect(selected?.className).toContain("is-selected");
    expect(other?.className).not.toContain("is-selected");

    other?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelectChannel).toHaveBeenCalledWith("telegram");
  });
});
