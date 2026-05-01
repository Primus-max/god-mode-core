/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { buildTabHref } from "../app-settings.ts";
import type { ThemeMode, ThemeName } from "../theme.ts";
import { renderConfig } from "./config.ts";

describe("config view i18n", () => {
  const baseProps = () => ({
    raw: "{\n}\n",
    originalRaw: "{\n}\n",
    valid: true,
    issues: [],
    loading: false,
    saving: false,
    applying: false,
    updating: false,
    connected: true,
    schema: {
      type: "object",
      properties: {
        gateway: { type: "object", properties: {} },
      },
    },
    schemaLoading: false,
    uiHints: {},
    formMode: "form" as const,
    showModeToggle: true,
    formValue: {},
    originalValue: {},
    searchQuery: "",
    activeSection: null,
    activeSubsection: null,
    buildSectionHref: (section: string | null) =>
      buildTabHref({ basePath: "" }, "config", {
        configMode: "form",
        configSection: section,
      }),
    buildModeHref: (mode: "form" | "raw") =>
      buildTabHref({ basePath: "" }, "config", {
        configMode: mode,
      }),
    onRawChange: vi.fn(),
    onFormModeChange: vi.fn(),
    onFormPatch: vi.fn(),
    onSearchChange: vi.fn(),
    onSectionChange: vi.fn(),
    onReload: vi.fn(),
    onSave: vi.fn(),
    onApply: vi.fn(),
    onUpdate: vi.fn(),
    onSubsectionChange: vi.fn(),
    version: "2026.3.11",
    theme: "claw" as ThemeName,
    themeMode: "system" as ThemeMode,
    setTheme: vi.fn(),
    setThemeMode: vi.fn(),
    borderRadius: 50,
    setBorderRadius: vi.fn(),
    gatewayUrl: "",
    assistantName: "OpenClaw",
  });

  it("renders localized root settings tab in Russian", async () => {
    const container = document.createElement("div");
    await i18n.setLocale("ru");

    render(renderConfig(baseProps()), container);

    const tabs = Array.from(container.querySelectorAll(".config-top-tabs__tab")).map((tab) =>
      tab.textContent?.trim(),
    );
    expect(tabs).toContain("Настройки");

    await i18n.setLocale("en");
  });
});
