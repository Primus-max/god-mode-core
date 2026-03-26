/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { SpecialistRuntimeSnapshot } from "../types.ts";
import { renderChat, type ChatProps } from "./chat.ts";
import { renderOverview, type OverviewProps } from "./overview.ts";

function createSnapshot(): SpecialistRuntimeSnapshot {
  return {
    sessionKey: "main",
    availableProfiles: [
      { id: "builder", label: "Builder" },
      { id: "developer", label: "Developer" },
      { id: "general", label: "General" },
      { id: "integrator", label: "Integrator" },
      { id: "operator", label: "Operator" },
      { id: "media_creator", label: "Media Creator" },
    ],
    selectedProfileId: "developer",
    selectedProfileLabel: "Developer",
    activeProfileId: "developer",
    activeProfileLabel: "Developer",
    activeProfileDescription: "Code-first specialist for repositories and release workflows.",
    baseProfileId: "general",
    sessionProfileId: "developer",
    taskOverlayId: "publish_release",
    taskOverlayLabel: "Publish Release",
    recipeId: "code_build_publish",
    recipePurpose: "Build, test, and publish code artifacts",
    recipeSummary: "Work repo-first and validate changes before publish when possible.",
    reasoningSummary: "Recipe code_build_publish selected for profile developer.",
    requiredCapabilities: ["node", "git"],
    bootstrapRequiredCapabilities: ["node", "git"],
    capabilityRequirements: [
      {
        id: "node",
        label: "node",
        status: "unknown",
        requiresBootstrap: false,
        reasons: ["no trusted catalog entry found for capability node"],
      },
      {
        id: "git",
        label: "git",
        status: "unknown",
        requiresBootstrap: false,
        reasons: ["no trusted catalog entry found for capability git"],
      },
    ],
    policyAutonomy: "guarded",
    requiresExplicitApproval: true,
    allowArtifactPersistence: true,
    allowPublish: false,
    allowCapabilityBootstrap: false,
    allowPrivilegedTools: false,
    policyReasons: ["artifact persistence enabled for document/publish intent"],
    policyDeniedReasons: ["publishing requires explicit approval and an explicit target"],
    bootstrapContinuationMode: "frozen",
    confidence: 0.82,
    preferredTools: ["read", "edit", "exec"],
    publishTargets: ["github", "npm"],
    providerOverride: "openai",
    modelOverride: "gpt-5.4",
    timeoutSeconds: 420,
    draftApplied: true,
    signals: [
      {
        source: "dialogue",
        profileId: "developer",
        profileLabel: "Developer",
        weight: 0.8,
        reason: "The draft asked for repository work and a release flow.",
      },
    ],
    override: {
      supported: true,
      mode: "auto",
      note: "Automatic specialist selection stays policy-safe and can still react to task signals.",
    },
  };
}

function createChatProps(overrides: Partial<ChatProps> = {}): ChatProps {
  return {
    sessionKey: "main",
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: false,
    showToolCalls: true,
    loading: false,
    sending: false,
    canAbort: false,
    compactionStatus: null,
    fallbackStatus: null,
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    assistantAvatarUrl: null,
    draft: "",
    queue: [],
    connected: true,
    canSend: true,
    disabledReason: null,
    error: null,
    specialistLoading: false,
    specialistError: null,
    specialistSnapshot: null,
    sessions: {
      ts: 0,
      path: "",
      count: 0,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [],
    },
    focusMode: false,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    onRefresh: () => undefined,
    onToggleFocusMode: () => undefined,
    onDraftChange: () => undefined,
    onSend: () => undefined,
    onQueueRemove: () => undefined,
    onNewSession: () => undefined,
    agentsList: null,
    currentAgentId: "main",
    onAgentChange: () => undefined,
    ...overrides,
  };
}

function createOverviewProps(overrides: Partial<OverviewProps> = {}): OverviewProps {
  return {
    connected: true,
    hello: null,
    settings: {
      gatewayUrl: "",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 50,
      locale: "en",
    },
    password: "",
    lastError: null,
    lastErrorCode: null,
    presenceCount: 0,
    sessionsCount: null,
    cronEnabled: null,
    cronNext: null,
    lastChannelsRefresh: null,
    usageResult: null,
    sessionsResult: null,
    skillsReport: null,
    cronJobs: [],
    cronStatus: null,
    attentionItems: [],
    eventLog: [],
    overviewLogLines: [],
    specialistLoading: false,
    specialistSaving: false,
    specialistError: null,
    specialistSnapshot: null,
    showGatewayToken: false,
    showGatewayPassword: false,
    onSettingsChange: () => undefined,
    onPasswordChange: () => undefined,
    onSessionKeyChange: () => undefined,
    onToggleGatewayTokenVisibility: () => undefined,
    onToggleGatewayPasswordVisibility: () => undefined,
    onConnect: () => undefined,
    onRefresh: () => undefined,
    onNavigate: () => undefined,
    onRefreshLogs: () => undefined,
    onSpecialistOverrideChange: () => undefined,
    ...overrides,
  };
}

describe("specialist context views", () => {
  it("renders chat specialist strip from the runtime snapshot", async () => {
    const container = document.createElement("div");

    render(renderChat(createChatProps({ specialistSnapshot: createSnapshot() })), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Current specialist context");
    expect(container.textContent).toContain("Developer");
    expect(container.textContent).toContain("code_build_publish");
    expect(container.textContent).toContain("Operational posture");
  });

  it("renders the overview specialist panel in Russian", async () => {
    const container = document.createElement("div");
    await i18n.setLocale("ru");

    render(
      renderOverview(
        createOverviewProps({
          specialistSnapshot: createSnapshot(),
          settings: { ...createOverviewProps().settings, locale: "ru" },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Центр specialist-решений");
    expect(container.textContent).toContain("Уверенность");
    expect(container.textContent).toContain("Авто");
    expect(container.textContent).toContain("Операционная политика");

    await i18n.setLocale("en");
  });

  it("shows an empty specialist state without breaking overview rendering", async () => {
    const container = document.createElement("div");

    render(renderOverview(createOverviewProps()), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Specialist Decision Center");
    expect(container.textContent).toContain(
      "No specialist context yet. Start a session or type a draft to resolve one.",
    );
  });

  it("enables specialist override controls and emits base/session changes", async () => {
    const container = document.createElement("div");
    const onSpecialistOverrideChange = vi.fn();

    render(
      renderOverview(
        createOverviewProps({
          specialistSnapshot: createSnapshot(),
          onSpecialistOverrideChange,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const selects = Array.from(container.querySelectorAll("select"));
    const overrideModeSelect = selects.at(-1) as HTMLSelectElement;
    expect(overrideModeSelect.disabled).toBe(false);

    overrideModeSelect.value = "base";
    overrideModeSelect.dispatchEvent(new Event("change"));
    expect(onSpecialistOverrideChange).toHaveBeenCalledWith({
      mode: "base",
      profileId: "developer",
    });

    render(
      renderOverview(
        createOverviewProps({
          specialistSnapshot: {
            ...createSnapshot(),
            override: {
              supported: true,
              mode: "session",
              sessionProfileId: "builder",
            },
          },
          onSpecialistOverrideChange,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const updatedSelects = Array.from(container.querySelectorAll("select"));
    const profileSelect = updatedSelects.at(-1) as HTMLSelectElement;
    profileSelect.value = "general";
    profileSelect.dispatchEvent(new Event("change"));
    expect(onSpecialistOverrideChange).toHaveBeenCalledWith({
      mode: "session",
      profileId: "general",
    });
  });

  it("renders expanded specialist catalog options in override controls", async () => {
    const container = document.createElement("div");

    render(
      renderOverview(
        createOverviewProps({
          specialistSnapshot: {
            ...createSnapshot(),
            override: {
              supported: true,
              mode: "session",
              sessionProfileId: "integrator",
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const selects = Array.from(container.querySelectorAll("select"));
    const profileSelect = selects.at(-1) as HTMLSelectElement;
    const optionLabels = Array.from(profileSelect.options).map((option) => option.textContent);
    expect(optionLabels).toContain("Integrator");
    expect(optionLabels).toContain("Operator");
    expect(optionLabels).toContain("Media Creator");
  });
});
