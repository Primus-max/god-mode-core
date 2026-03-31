import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import { refreshChat } from "./app-chat.ts";
import {
  startBootstrapPolling,
  startArtifactsPolling,
  startMachinePolling,
  stopBootstrapPolling,
  stopArtifactsPolling,
  stopMachinePolling,
  startLogsPolling,
  stopLogsPolling,
  startDebugPolling,
  stopDebugPolling,
} from "./app-polling.ts";
import { scheduleChatScroll, scheduleLogsScroll } from "./app-scroll.ts";
import type { OpenClawApp } from "./app.ts";
import { loadAgentIdentities, loadAgentIdentity } from "./controllers/agent-identity.ts";
import { loadAgentSkills } from "./controllers/agent-skills.ts";
import { loadAgents } from "./controllers/agents.ts";
import { loadArtifacts } from "./controllers/artifacts.ts";
import { loadBootstrapRequests } from "./controllers/bootstrap.ts";
import { loadChannels } from "./controllers/channels.ts";
import { loadPlatformCatalog } from "./controllers/catalog.ts";
import { loadConfig, loadConfigSchema } from "./controllers/config.ts";
import { loadCronJobs, loadCronRuns, loadCronStatus } from "./controllers/cron.ts";
import { loadDebug } from "./controllers/debug.ts";
import { loadDevices } from "./controllers/devices.ts";
import { loadExecApprovals } from "./controllers/exec-approvals.ts";
import { loadLogs } from "./controllers/logs.ts";
import { loadMachineControl } from "./controllers/machine.ts";
import { loadNodes } from "./controllers/nodes.ts";
import { loadPresence } from "./controllers/presence.ts";
import { loadRuntimeInspector } from "./controllers/runtime-inspector.ts";
import { loadSessions } from "./controllers/sessions.ts";
import { loadSkills } from "./controllers/skills.ts";
import { loadSpecialistContext } from "./controllers/specialist.ts";
import { loadUsage } from "./controllers/usage.ts";
import {
  inferBasePathFromPathname,
  normalizeBasePath,
  normalizePath,
  pathForTab,
  tabFromPath,
  type Tab,
} from "./navigation.ts";
import { collectChannelAttentionTargets } from "./channels-correlation.ts";
import { resolveSessionRuntimeInspectRunId } from "./session-runtime.ts";
import { SKILL_FILTER_BLOCKED, SKILL_FILTER_MISSING } from "./skills-correlation.ts";
import { saveSettings, type UiSettings } from "./storage.ts";
import { startThemeTransition, type ThemeTransitionContext } from "./theme-transition.ts";
import { resolveTheme, type ResolvedTheme, type ThemeMode, type ThemeName } from "./theme.ts";
import type { AgentsListResult, AttentionItem } from "./types.ts";
import { resetChatViewState } from "./views/chat.ts";

type SettingsHost = {
  settings: UiSettings;
  password?: string;
  theme: ThemeName;
  themeMode: ThemeMode;
  themeResolved: ResolvedTheme;
  applySessionKey: string;
  sessionKey: string;
  tab: Tab;
  connected: boolean;
  chatHasAutoScrolled: boolean;
  logsAtBottom: boolean;
  eventLog: unknown[];
  eventLogBuffer: unknown[];
  basePath: string;
  artifactsPollInterval?: number | null;
  bootstrapPollInterval?: number | null;
  machinePollInterval?: number | null;
  machineStatus?: OpenClawApp["machineStatus"];
  agentsList?: AgentsListResult | null;
  agentsSelectedId?: string | null;
  agentsPanel?: "overview" | "files" | "tools" | "skills" | "channels" | "cron";
  pendingGatewayUrl?: string | null;
  systemThemeCleanup?: (() => void) | null;
  pendingGatewayToken?: string | null;
  artifactsSelectedId?: string | null;
  bootstrapSelectedId?: string | null;
  channelsSelectedKey?: string | null;
  runtimeSessionKey?: string | null;
  runtimeRunId?: string | null;
  runtimeSelectedCheckpointId?: string | null;
  cronRunsJobId?: string | null;
  cronRunsScope?: "job" | "all";
  skillsFilter?: string;
  execApprovalsTarget?: "gateway" | "node";
  execApprovalsTargetNodeId?: string | null;
  execApprovalsSelectedAgent?: string | null;
};

type AttentionHost = Pick<
  OpenClawApp,
  | "lastError"
  | "hello"
  | "skillsReport"
  | "bootstrapPendingCount"
  | "bootstrapList"
  | "machineStatus"
  | "channelsSnapshot"
  | "cronJobs"
  | "attentionItems"
  | "basePath"
  | "sessionKey"
  | "execApprovalQueue"
  | "sessionsResult"
  | "runtimeCheckpoints"
  | "runtimeCheckpointDetail"
>;

function trimQueryValue(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function normalizeExecApprovalsTarget(value: string | null | undefined): "gateway" | "node" {
  return value === "node" ? "node" : "gateway";
}

function resolveExecApprovalsTarget(
  host: Pick<SettingsHost, "execApprovalsTarget" | "execApprovalsTargetNodeId">,
): { kind: "gateway" } | { kind: "node"; nodeId: string } {
  if (host.execApprovalsTarget === "node" && trimQueryValue(host.execApprovalsTargetNodeId)) {
    return { kind: "node", nodeId: host.execApprovalsTargetNodeId!.trim() };
  }
  return { kind: "gateway" };
}

function setQueryValue(url: URL, key: string, value: string | null | undefined) {
  const trimmed = trimQueryValue(value);
  if (trimmed) {
    url.searchParams.set(key, trimmed);
    return;
  }
  url.searchParams.delete(key);
}

function buildTabHref(
  host: Pick<SettingsHost, "basePath">,
  tab: Tab,
  params: Record<string, string | null | undefined> = {},
): string {
  const url = new URL(`https://openclaw.local${pathForTab(tab, host.basePath)}`);
  for (const [key, value] of Object.entries(params)) {
    setQueryValue(url, key, value);
  }
  return `${url.pathname}${url.search}`;
}

function applyDeepLinkStateFromUrl(
  host: SettingsHost,
  sources: { params: URLSearchParams; hashParams: URLSearchParams },
) {
  const pick = (key: string) => trimQueryValue(sources.params.get(key) ?? sources.hashParams.get(key));
  host.bootstrapSelectedId = pick("bootstrapRequest");
  host.artifactsSelectedId = pick("artifact");
  host.channelsSelectedKey = pick("channel");
  host.runtimeSessionKey = pick("runtimeSession");
  host.runtimeRunId = pick("runtimeRun");
  host.runtimeSelectedCheckpointId = pick("checkpoint");
  host.cronRunsJobId = pick("cronJob");
  host.cronRunsScope = host.cronRunsJobId ? "job" : "all";
  host.skillsFilter = pick("skillFilter") ?? "";
  host.execApprovalsTarget = normalizeExecApprovalsTarget(pick("execTarget"));
  host.execApprovalsTargetNodeId =
    host.execApprovalsTarget === "node" ? pick("execNode") : null;
  host.execApprovalsSelectedAgent = pick("execAgent");
}

function applyTabQueryStateToUrl(host: SettingsHost, tab: Tab, url: URL) {
  setQueryValue(url, "session", host.sessionKey);
  setQueryValue(url, "bootstrapRequest", null);
  setQueryValue(url, "artifact", null);
  setQueryValue(url, "channel", null);
  setQueryValue(url, "runtimeSession", null);
  setQueryValue(url, "runtimeRun", null);
  setQueryValue(url, "checkpoint", null);
  setQueryValue(url, "cronJob", null);
  setQueryValue(url, "skillFilter", null);
  setQueryValue(url, "execTarget", null);
  setQueryValue(url, "execNode", null);
  setQueryValue(url, "execAgent", null);
  if (tab === "bootstrap") {
    setQueryValue(url, "bootstrapRequest", host.bootstrapSelectedId);
  }
  if (tab === "artifacts") {
    setQueryValue(url, "artifact", host.artifactsSelectedId);
  }
  if (tab === "channels") {
    setQueryValue(url, "channel", host.channelsSelectedKey);
  }
  if (tab === "sessions") {
    setQueryValue(url, "runtimeSession", host.runtimeSessionKey);
    setQueryValue(url, "runtimeRun", host.runtimeRunId);
    setQueryValue(url, "checkpoint", host.runtimeSelectedCheckpointId);
  }
  if (tab === "cron" && host.cronRunsScope === "job") {
    setQueryValue(url, "cronJob", host.cronRunsJobId);
  }
  if (tab === "skills") {
    setQueryValue(url, "skillFilter", host.skillsFilter);
  }
  if (tab === "nodes") {
    const execTarget = resolveExecApprovalsTarget(host);
    setQueryValue(url, "execTarget", execTarget.kind);
    setQueryValue(url, "execNode", execTarget.kind === "node" ? execTarget.nodeId : null);
    setQueryValue(url, "execAgent", host.execApprovalsSelectedAgent);
  }
}

export function applySettings(host: SettingsHost, next: UiSettings) {
  const normalized = {
    ...next,
    lastActiveSessionKey: next.lastActiveSessionKey?.trim() || next.sessionKey.trim() || "main",
  };
  host.settings = normalized;
  saveSettings(normalized);
  if (next.theme !== host.theme || next.themeMode !== host.themeMode) {
    host.theme = next.theme;
    host.themeMode = next.themeMode;
    applyResolvedTheme(host, resolveTheme(next.theme, next.themeMode));
  }
  applyBorderRadius(next.borderRadius);
  host.applySessionKey = host.settings.lastActiveSessionKey;
}

export function setLastActiveSessionKey(host: SettingsHost, next: string) {
  const trimmed = next.trim();
  if (!trimmed) {
    return;
  }
  if (host.settings.lastActiveSessionKey === trimmed) {
    return;
  }
  applySettings(host, { ...host.settings, lastActiveSessionKey: trimmed });
}

export function applySettingsFromUrl(host: SettingsHost) {
  if (!window.location.search && !window.location.hash) {
    return;
  }
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);

  const gatewayUrlRaw = params.get("gatewayUrl") ?? hashParams.get("gatewayUrl");
  const nextGatewayUrl = gatewayUrlRaw?.trim() ?? "";
  const gatewayUrlChanged = Boolean(nextGatewayUrl && nextGatewayUrl !== host.settings.gatewayUrl);
  // Prefer fragment tokens over query tokens. Fragments avoid server-side request
  // logs and referrer leakage; query-param tokens remain a one-time legacy fallback
  // for compatibility with older deep links.
  const tokenRaw = hashParams.get("token") ?? params.get("token");
  const passwordRaw = params.get("password") ?? hashParams.get("password");
  const sessionRaw = params.get("session") ?? hashParams.get("session");
  const shouldResetSessionForToken = Boolean(
    tokenRaw?.trim() && !sessionRaw?.trim() && !gatewayUrlChanged,
  );
  let shouldCleanUrl = false;

  if (params.has("token")) {
    params.delete("token");
    shouldCleanUrl = true;
  }

  if (tokenRaw != null) {
    const token = tokenRaw.trim();
    if (token && gatewayUrlChanged) {
      host.pendingGatewayToken = token;
    } else if (token && token !== host.settings.token) {
      applySettings(host, { ...host.settings, token });
    }
    hashParams.delete("token");
    shouldCleanUrl = true;
  }

  if (shouldResetSessionForToken) {
    host.sessionKey = "main";
    applySettings(host, {
      ...host.settings,
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
  }

  if (passwordRaw != null) {
    // Never hydrate password from URL params; strip only.
    params.delete("password");
    hashParams.delete("password");
    shouldCleanUrl = true;
  }

  if (sessionRaw != null) {
    const session = sessionRaw.trim();
    if (session) {
      host.sessionKey = session;
      applySettings(host, {
        ...host.settings,
        sessionKey: session,
        lastActiveSessionKey: session,
      });
    }
  }

  applyDeepLinkStateFromUrl(host, { params, hashParams });

  if (gatewayUrlRaw != null) {
    if (gatewayUrlChanged) {
      host.pendingGatewayUrl = nextGatewayUrl;
      if (!tokenRaw?.trim()) {
        host.pendingGatewayToken = null;
      }
    } else {
      host.pendingGatewayUrl = null;
      host.pendingGatewayToken = null;
    }
    params.delete("gatewayUrl");
    hashParams.delete("gatewayUrl");
    shouldCleanUrl = true;
  }

  if (!shouldCleanUrl) {
    return;
  }
  url.search = params.toString();
  const nextHash = hashParams.toString();
  url.hash = nextHash ? `#${nextHash}` : "";
  window.history.replaceState({}, "", url.toString());
}

export function setTab(host: SettingsHost, next: Tab) {
  applyTabSelection(host, next, { refreshPolicy: "always", syncUrl: true });
}

export function setTheme(host: SettingsHost, next: ThemeName, context?: ThemeTransitionContext) {
  const resolved = resolveTheme(next, host.themeMode);
  const applyTheme = () => {
    applySettings(host, { ...host.settings, theme: next });
  };
  startThemeTransition({
    nextTheme: resolved,
    applyTheme,
    context,
    currentTheme: host.themeResolved,
  });
  syncSystemThemeListener(host);
}

export function setThemeMode(
  host: SettingsHost,
  next: ThemeMode,
  context?: ThemeTransitionContext,
) {
  const resolved = resolveTheme(host.theme, next);
  const applyMode = () => {
    applySettings(host, { ...host.settings, themeMode: next });
  };
  startThemeTransition({
    nextTheme: resolved,
    applyTheme: applyMode,
    context,
    currentTheme: host.themeResolved,
  });
  syncSystemThemeListener(host);
}

export async function refreshActiveTab(host: SettingsHost) {
  if (host.tab === "overview") {
    await loadOverview(host);
  }
  if (host.tab === "channels") {
    await loadChannelsTab(host);
  }
  if (host.tab === "instances") {
    await loadPresence(host as unknown as OpenClawApp);
  }
  if (host.tab === "usage") {
    await loadUsage(host as unknown as OpenClawApp);
  }
  if (host.tab === "sessions") {
    await Promise.allSettled([
      loadSessions(host as unknown as OpenClawApp),
      loadRuntimeInspector(host as unknown as OpenClawApp),
    ]);
  }
  if (host.tab === "cron") {
    await loadCron(host);
  }
  if (host.tab === "artifacts") {
    await loadArtifacts(host as unknown as OpenClawApp);
  }
  if (host.tab === "bootstrap") {
    await Promise.allSettled([
      loadBootstrapRequests(host as unknown as OpenClawApp),
      loadRuntimeInspector(host as unknown as OpenClawApp, {
        sessionKey: null,
        runId: null,
      }),
    ]);
  }
  if (host.tab === "machine") {
    await loadMachineControl(host as unknown as OpenClawApp);
  }
  if (host.tab === "skills") {
    await loadSkills(host as unknown as OpenClawApp);
  }
  if (host.tab === "agents") {
    await loadAgents(host as unknown as OpenClawApp);
    await loadConfig(host as unknown as OpenClawApp);
    const agentIds = host.agentsList?.agents?.map((entry) => entry.id) ?? [];
    if (agentIds.length > 0) {
      void loadAgentIdentities(host as unknown as OpenClawApp, agentIds);
    }
    const agentId =
      host.agentsSelectedId ?? host.agentsList?.defaultId ?? host.agentsList?.agents?.[0]?.id;
    if (agentId) {
      void loadAgentIdentity(host as unknown as OpenClawApp, agentId);
      if (host.agentsPanel === "skills") {
        void loadAgentSkills(host as unknown as OpenClawApp, agentId);
      }
      if (host.agentsPanel === "channels") {
        void loadChannels(host as unknown as OpenClawApp, false);
      }
      if (host.agentsPanel === "cron") {
        void loadCron(host);
      }
    }
  }
  if (host.tab === "nodes") {
    await loadNodes(host as unknown as OpenClawApp);
    await loadDevices(host as unknown as OpenClawApp);
    await loadConfig(host as unknown as OpenClawApp);
    await loadExecApprovals(host as unknown as OpenClawApp, resolveExecApprovalsTarget(host));
  }
  if (host.tab === "chat") {
    await refreshChat(host as unknown as Parameters<typeof refreshChat>[0]);
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      !host.chatHasAutoScrolled,
    );
  }
  if (
    host.tab === "config" ||
    host.tab === "communications" ||
    host.tab === "appearance" ||
    host.tab === "automation" ||
    host.tab === "infrastructure" ||
    host.tab === "aiAgents"
  ) {
    await loadConfigSchema(host as unknown as OpenClawApp);
    await loadConfig(host as unknown as OpenClawApp);
  }
  if (host.tab === "debug") {
    await loadDebug(host as unknown as OpenClawApp);
    host.eventLog = host.eventLogBuffer;
  }
  if (host.tab === "logs") {
    host.logsAtBottom = true;
    await loadLogs(host as unknown as OpenClawApp, { reset: true });
    scheduleLogsScroll(host as unknown as Parameters<typeof scheduleLogsScroll>[0], true);
  }
}

export function inferBasePath() {
  if (typeof window === "undefined") {
    return "";
  }
  const configured = window.__OPENCLAW_CONTROL_UI_BASE_PATH__;
  if (typeof configured === "string" && configured.trim()) {
    return normalizeBasePath(configured);
  }
  return inferBasePathFromPathname(window.location.pathname);
}

export function syncThemeWithSettings(host: SettingsHost) {
  host.theme = host.settings.theme ?? "claw";
  host.themeMode = host.settings.themeMode ?? "system";
  applyResolvedTheme(host, resolveTheme(host.theme, host.themeMode));
  applyBorderRadius(host.settings.borderRadius ?? 50);
  syncSystemThemeListener(host);
}

export function attachThemeListener(host: SettingsHost) {
  syncSystemThemeListener(host);
}

export function detachThemeListener(host: SettingsHost) {
  host.systemThemeCleanup?.();
  host.systemThemeCleanup = null;
}

const BASE_RADII = { sm: 6, md: 10, lg: 14, xl: 20, default: 10 };

export function applyBorderRadius(value: number) {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const scale = value / 50;
  root.style.setProperty("--radius-sm", `${Math.round(BASE_RADII.sm * scale)}px`);
  root.style.setProperty("--radius-md", `${Math.round(BASE_RADII.md * scale)}px`);
  root.style.setProperty("--radius-lg", `${Math.round(BASE_RADII.lg * scale)}px`);
  root.style.setProperty("--radius-xl", `${Math.round(BASE_RADII.xl * scale)}px`);
  root.style.setProperty("--radius", `${Math.round(BASE_RADII.default * scale)}px`);
}

export function applyResolvedTheme(host: SettingsHost, resolved: ResolvedTheme) {
  host.themeResolved = resolved;
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const themeMode = resolved.endsWith("light") ? "light" : "dark";
  root.dataset.theme = resolved;
  root.dataset.themeMode = themeMode;
  root.style.colorScheme = themeMode;
}

function syncSystemThemeListener(host: SettingsHost) {
  // Clean up existing listener if mode is not "system"
  if (host.themeMode !== "system") {
    host.systemThemeCleanup?.();
    host.systemThemeCleanup = null;
    return;
  }

  // Skip if listener already attached for this host
  if (host.systemThemeCleanup) {
    return;
  }

  if (typeof globalThis.matchMedia !== "function") {
    return;
  }

  const mql = globalThis.matchMedia("(prefers-color-scheme: light)");
  const onChange = () => {
    if (host.themeMode !== "system") {
      return;
    }
    applyResolvedTheme(host, resolveTheme(host.theme, "system"));
  };
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange);
    host.systemThemeCleanup = () => mql.removeEventListener("change", onChange);
    return;
  }
  if (typeof mql.addListener === "function") {
    mql.addListener(onChange);
    host.systemThemeCleanup = () => mql.removeListener(onChange);
  }
}

export function syncTabWithLocation(host: SettingsHost, replace: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  const resolved = tabFromPath(window.location.pathname, host.basePath) ?? "chat";
  setTabFromRoute(host, resolved);
  syncUrlWithTab(host, resolved, replace);
}

export function onPopState(host: SettingsHost) {
  if (typeof window === "undefined") {
    return;
  }
  const resolved = tabFromPath(window.location.pathname, host.basePath);
  if (!resolved) {
    return;
  }

  const url = new URL(window.location.href);
  const session = url.searchParams.get("session")?.trim();
  if (session) {
    host.sessionKey = session;
    applySettings(host, {
      ...host.settings,
      sessionKey: session,
      lastActiveSessionKey: session,
    });
  }
  applyDeepLinkStateFromUrl(host, {
    params: url.searchParams,
    hashParams: new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash),
  });

  setTabFromRoute(host, resolved);
}

export function setTabFromRoute(host: SettingsHost, next: Tab) {
  applyTabSelection(host, next, { refreshPolicy: "connected" });
}

function applyTabSelection(
  host: SettingsHost,
  next: Tab,
  options: { refreshPolicy: "always" | "connected"; syncUrl?: boolean },
) {
  const prev = host.tab;
  if (host.tab !== next) {
    host.tab = next;
  }

  // Cleanup chat module state when navigating away from chat
  if (prev === "chat" && next !== "chat") {
    resetChatViewState();
  }

  if (next === "chat") {
    host.chatHasAutoScrolled = false;
  }
  if (next === "logs") {
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
  } else {
    stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
  }
  if (next === "debug") {
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  } else {
    stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  }
  if (next === "artifacts") {
    startArtifactsPolling(host as unknown as Parameters<typeof startArtifactsPolling>[0]);
  } else {
    stopArtifactsPolling(host as unknown as Parameters<typeof stopArtifactsPolling>[0]);
  }
  if (next === "bootstrap") {
    startBootstrapPolling(host as unknown as Parameters<typeof startBootstrapPolling>[0]);
  } else {
    stopBootstrapPolling(host as unknown as Parameters<typeof stopBootstrapPolling>[0]);
  }
  if (next === "machine") {
    startMachinePolling(host as unknown as Parameters<typeof startMachinePolling>[0]);
  } else {
    stopMachinePolling(host as unknown as Parameters<typeof stopMachinePolling>[0]);
  }

  if (options.refreshPolicy === "always" || host.connected) {
    void refreshActiveTab(host);
  }

  if (options.syncUrl) {
    syncUrlWithTab(host, next, false);
  }
}

export function syncUrlWithTab(host: SettingsHost, tab: Tab, replace: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  const targetPath = normalizePath(pathForTab(tab, host.basePath));
  const currentPath = normalizePath(window.location.pathname);
  const url = new URL(window.location.href);

  if (tab === "chat" && host.sessionKey) {
    url.searchParams.set("session", host.sessionKey);
  }
  applyTabQueryStateToUrl(host, tab, url);

  if (currentPath !== targetPath) {
    url.pathname = targetPath;
  }

  if (replace) {
    window.history.replaceState({}, "", url.toString());
  } else {
    window.history.pushState({}, "", url.toString());
  }
}

export function syncUrlWithSessionKey(host: SettingsHost, sessionKey: string, replace: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("session", sessionKey);
  if (replace) {
    window.history.replaceState({}, "", url.toString());
  } else {
    window.history.pushState({}, "", url.toString());
  }
}

export async function loadOverview(host: SettingsHost) {
  const app = host as unknown as OpenClawApp;
  const activeSession = app.sessionsResult?.sessions.find((session) => session.key === app.sessionKey);
  const runtimeRunId = resolveSessionRuntimeInspectRunId(activeSession) ?? null;
  await Promise.allSettled([
    loadChannels(app, false),
    loadPresence(app),
    loadSessions(app),
    loadCronStatus(app),
    loadCronJobs(app),
    loadDebug(app),
    loadSkills(app),
    loadUsage(app),
    loadBootstrapRequests(app),
    loadRuntimeInspector(app, { sessionKey: app.sessionKey || null, runId: runtimeRunId }),
    loadPlatformCatalog(app),
    loadMachineControl(app),
    loadSpecialistContext(app, { draft: app.chatMessage }),
    loadOverviewLogs(app),
  ]);
  buildAttentionItems(app);
}

export function hasOperatorReadAccess(
  auth: { role?: string; scopes?: readonly string[] } | null,
): boolean {
  if (!auth?.scopes) {
    return false;
  }
  return roleScopesAllow({
    role: auth.role ?? "operator",
    requestedScopes: ["operator.read"],
    allowedScopes: auth.scopes,
  });
}

export function hasMissingSkillDependencies(
  missing: Record<string, unknown> | null | undefined,
): boolean {
  if (!missing) {
    return false;
  }
  return Object.values(missing).some((value) => Array.isArray(value) && value.length > 0);
}

async function loadOverviewLogs(host: OpenClawApp) {
  if (!host.client || !host.connected) {
    return;
  }
  try {
    const res = await host.client.request("logs.tail", {
      cursor: host.overviewLogCursor || undefined,
      limit: 100,
      maxBytes: 50_000,
    });
    const payload = res as {
      cursor?: number;
      lines?: unknown;
    };
    const lines = Array.isArray(payload.lines)
      ? payload.lines.filter((line): line is string => typeof line === "string")
      : [];
    host.overviewLogLines = [...host.overviewLogLines, ...lines].slice(-500);
    if (typeof payload.cursor === "number") {
      host.overviewLogCursor = payload.cursor;
    }
  } catch {
    /* non-critical */
  }
}

function resolveRecoveryAttentionSeverity(status?: string | null): AttentionItem["severity"] {
  if (status === "denied" || status === "cancelled" || status === "failed") {
    return "error";
  }
  if (status === "approved" || status === "resumed") {
    return "info";
  }
  return "warning";
}

function matchesRuntimeScope(
  checkpoint: { sessionKey?: string; runId?: string },
  sessionKey: string,
  runId?: string | null,
): boolean {
  if (checkpoint.sessionKey !== sessionKey) {
    return false;
  }
  if (!runId) {
    return true;
  }
  return checkpoint.runId === runId;
}

export function buildAttentionItems(host: AttentionHost) {
  const items: AttentionItem[] = [];

  if (host.lastError) {
    items.push({
      severity: "error",
      icon: "x",
      title: "Gateway Error",
      description: host.lastError,
    });
  }

  const hello = host.hello;
  const auth = (hello as { auth?: { role?: string; scopes?: string[] } } | null)?.auth ?? null;
  if (auth?.scopes && !hasOperatorReadAccess(auth)) {
    items.push({
      severity: "warning",
      icon: "key",
      title: "Missing operator.read scope",
      description:
        "This connection does not have the operator.read scope. Some features may be unavailable.",
      href: "https://docs.openclaw.ai/web/dashboard",
      external: true,
    });
  }

  const activeSession = host.sessionsResult?.sessions.find((session) => session.key === host.sessionKey);
  const activeRunId = resolveSessionRuntimeInspectRunId(activeSession);
  const fallbackCheckpoint =
    host.runtimeCheckpoints.find((checkpoint) => checkpoint.sessionKey === host.sessionKey) ?? null;
  const scopedCheckpoint =
    host.runtimeCheckpointDetail &&
    matchesRuntimeScope(host.runtimeCheckpointDetail, host.sessionKey, activeRunId)
      ? host.runtimeCheckpointDetail
      : host.runtimeCheckpoints.find((checkpoint) =>
            matchesRuntimeScope(checkpoint, host.sessionKey, activeRunId),
          ) ?? fallbackCheckpoint;
  const recoveryDescription =
    activeSession?.recoveryOperatorHint ??
    scopedCheckpoint?.operatorHint ??
    activeSession?.recoveryBlockedReason ??
    scopedCheckpoint?.blockedReason ??
    null;
  if (recoveryDescription && (activeSession?.recoveryStatus || scopedCheckpoint?.status)) {
    items.push({
      severity: resolveRecoveryAttentionSeverity(activeSession?.recoveryStatus ?? scopedCheckpoint?.status),
      icon: "shield",
      title: `Recovery needs review for ${activeSession?.label ?? activeSession?.displayName ?? host.sessionKey}`,
      description: recoveryDescription,
      href: buildTabHref(host, "sessions", {
        session: host.sessionKey,
        runtimeSession: host.sessionKey,
        runtimeRun: activeRunId ?? scopedCheckpoint?.runId ?? null,
        checkpoint: activeSession?.recoveryCheckpointId ?? scopedCheckpoint?.id ?? null,
      }),
      actionLabel: "Review",
    });
  }

  if (scopedCheckpoint?.target?.bootstrapRequestId) {
    items.push({
      severity: resolveRecoveryAttentionSeverity(scopedCheckpoint.status),
      icon: "shield",
      title: "Bootstrap request linked to current recovery",
      description: scopedCheckpoint.operatorHint ?? "Open the linked bootstrap request.",
      href: buildTabHref(host, "bootstrap", {
        session: host.sessionKey,
        bootstrapRequest: scopedCheckpoint.target.bootstrapRequestId,
      }),
      actionLabel: "Open request",
    });
  } else if (scopedCheckpoint?.target?.artifactId) {
    items.push({
      severity: resolveRecoveryAttentionSeverity(scopedCheckpoint.status),
      icon: "folder",
      title: "Artifact transition needs review",
      description: scopedCheckpoint.operatorHint ?? "Open the linked artifact and review the transition.",
      href: buildTabHref(host, "artifacts", {
        session: host.sessionKey,
        artifact: scopedCheckpoint.target.artifactId,
      }),
      actionLabel: "Open artifact",
    });
  }

  const skills = host.skillsReport?.skills ?? [];
  const missingDeps = skills.filter((s) => !s.disabled && hasMissingSkillDependencies(s.missing));
  if (missingDeps.length > 0) {
    const names = missingDeps.slice(0, 3).map((s) => s.name);
    const more = missingDeps.length > 3 ? ` +${missingDeps.length - 3} more` : "";
    items.push({
      severity: "warning",
      icon: "zap",
      title: "Skills with missing dependencies",
      description: `${names.join(", ")}${more}`,
      href: buildTabHref(host, "skills", {
        session: host.sessionKey,
        skillFilter: SKILL_FILTER_MISSING,
      }),
      actionLabel: "Open",
    });
  }

  const blocked = skills.filter((s) => s.blockedByAllowlist);
  if (blocked.length > 0) {
    items.push({
      severity: "warning",
      icon: "shield",
      title: `${blocked.length} skill${blocked.length > 1 ? "s" : ""} blocked`,
      description: blocked.map((s) => s.name).join(", "),
      href: buildTabHref(host, "skills", {
        session: host.sessionKey,
        skillFilter: SKILL_FILTER_BLOCKED,
      }),
      actionLabel: "Open",
    });
  }

  const channelIssues = collectChannelAttentionTargets(host.channelsSnapshot);
  if (channelIssues.length > 0) {
    const primaryIssue = channelIssues[0];
    const names = channelIssues.slice(0, 3).map((entry) => entry.label);
    const more = channelIssues.length > 3 ? ` +${channelIssues.length - 3} more` : "";
    items.push({
      severity: "warning",
      icon: "radio",
      title: `${channelIssues.length} channel issue${channelIssues.length > 1 ? "s" : ""} detected`,
      description: `${names.join(", ")}${more}`,
      href: buildTabHref(host, "channels", {
        session: host.sessionKey,
        channel: primaryIssue.key,
      }),
      actionLabel: "Open",
    });
  }

  const execApprovalQueue = host.execApprovalQueue ?? [];
  if (execApprovalQueue.length > 0) {
    const primaryApproval = execApprovalQueue[0];
    const target = primaryApproval?.request.nodeId?.trim()
      ? { execTarget: "node", execNode: primaryApproval.request.nodeId, execAgent: primaryApproval.request.agentId }
      : { execTarget: "gateway", execNode: null, execAgent: primaryApproval?.request.agentId ?? null };
    items.push({
      severity: "warning",
      icon: "shield",
      title: `${execApprovalQueue.length} exec approval${execApprovalQueue.length > 1 ? "s" : ""} pending`,
      description: primaryApproval?.request.blockedReason ?? primaryApproval?.request.command ?? "Operator review is required before execution can continue.",
      href: buildTabHref(host, "nodes", {
        session: host.sessionKey,
        execTarget: target.execTarget,
        execNode: target.execNode,
        execAgent: target.execAgent ?? null,
      }),
      actionLabel: "Open",
    });
  }

  if (host.bootstrapPendingCount > 0) {
    const pendingRequestId =
      host.bootstrapList.find((entry) => entry.state === "pending")?.id ??
      host.bootstrapList[0]?.id ??
      null;
    items.push({
      severity: "warning",
      icon: "shield",
      title: `${host.bootstrapPendingCount} bootstrap request${host.bootstrapPendingCount > 1 ? "s" : ""} pending`,
      description: "Capability installs are waiting for operator approval.",
      href: buildTabHref(host, "bootstrap", {
        session: host.sessionKey,
        bootstrapRequest: pendingRequestId,
      }),
      actionLabel: "Open",
    });
  }

  const machineStatus = host.machineStatus;
  if (machineStatus?.killSwitch.enabled) {
    items.push({
      severity: "warning",
      icon: "monitor",
      title: "Machine control kill switch enabled",
      description: "All machine-scoped execution is currently blocked.",
      href: buildTabHref(host, "machine", { session: host.sessionKey }),
      actionLabel: "Open",
    });
  } else if (machineStatus?.currentDevice?.access.code === "device_not_linked") {
    items.push({
      severity: "warning",
      icon: "monitor",
      title: "Current device is not linked for machine control",
      description: "Link this operator device before approving machine-scoped execution.",
      href: buildTabHref(host, "machine", { session: host.sessionKey }),
      actionLabel: "Open",
    });
  }

  const cronJobs = host.cronJobs ?? [];
  const failedCron = cronJobs.filter((j) => j.state?.lastStatus === "error");
  if (failedCron.length > 0) {
    const failedCronJobId =
      (failedCron[0] as { id?: string | null } | undefined)?.id ?? null;
    items.push({
      severity: "error",
      icon: "clock",
      title: `${failedCron.length} cron job${failedCron.length > 1 ? "s" : ""} failed`,
      description: failedCron.map((j) => j.name).join(", "),
      href: failedCronJobId
        ? buildTabHref(host, "cron", {
            session: host.sessionKey,
            cronJob: failedCronJobId,
          })
        : undefined,
      actionLabel: failedCronJobId ? "Open" : undefined,
    });
  }

  const now = Date.now();
  const overdue = cronJobs.filter(
    (j) => j.enabled && j.state?.nextRunAtMs != null && now - j.state.nextRunAtMs > 300_000,
  );
  if (overdue.length > 0) {
    const overdueCronJobId =
      (overdue[0] as { id?: string | null } | undefined)?.id ?? null;
    items.push({
      severity: "warning",
      icon: "clock",
      title: `${overdue.length} overdue job${overdue.length > 1 ? "s" : ""}`,
      description: overdue.map((j) => j.name).join(", "),
      href: overdueCronJobId
        ? buildTabHref(host, "cron", {
            session: host.sessionKey,
            cronJob: overdueCronJobId,
          })
        : undefined,
      actionLabel: overdueCronJobId ? "Open" : undefined,
    });
  }

  host.attentionItems = items;
}

export async function loadChannelsTab(host: SettingsHost) {
  await Promise.all([
    loadChannels(host as unknown as OpenClawApp, true),
    loadConfigSchema(host as unknown as OpenClawApp),
    loadConfig(host as unknown as OpenClawApp),
  ]);
}

export async function loadCron(host: SettingsHost) {
  const app = host as unknown as OpenClawApp;
  const activeCronJobId = app.cronRunsScope === "job" ? app.cronRunsJobId : null;
  await Promise.all([
    loadChannels(app, false),
    loadCronStatus(app),
    loadCronJobs(app),
    loadCronRuns(app, activeCronJobId),
  ]);
}
