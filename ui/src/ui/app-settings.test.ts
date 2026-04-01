import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./controllers/runtime-inspector.ts", () => ({
  loadRuntimeInspector: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./controllers/sessions.ts", () => ({
  loadSessions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./controllers/usage.ts", () => ({
  loadUsage: vi.fn().mockResolvedValue(undefined),
  loadSessionTimeSeries: vi.fn().mockResolvedValue(undefined),
  loadSessionLogs: vi.fn().mockResolvedValue(undefined),
}));

import {
  applyResolvedTheme,
  applySettings,
  applySettingsFromUrl,
  attachThemeListener,
  buildAttentionItems,
  loadOverview,
  refreshActiveTab,
  setTabFromRoute,
  syncUrlWithTab,
  syncThemeWithSettings,
} from "./app-settings.ts";
import * as channels from "./controllers/channels.ts";
import * as cron from "./controllers/cron.ts";
import { loadRuntimeInspector } from "./controllers/runtime-inspector.ts";
import { loadSessions } from "./controllers/sessions.ts";
import { loadSessionLogs, loadSessionTimeSeries, loadUsage } from "./controllers/usage.ts";
import {
  buildSkillSearchText,
  SKILL_FILTER_BLOCKED,
  SKILL_FILTER_MISSING,
} from "./skills-correlation.ts";
import type { ThemeMode, ThemeName } from "./theme.ts";
import type { ChannelsStatusSnapshot, MachineControlStatus } from "./types.ts";

type Tab =
  | "agents"
  | "overview"
  | "channels"
  | "instances"
  | "sessions"
  | "usage"
  | "cron"
  | "artifacts"
  | "bootstrap"
  | "machine"
  | "skills"
  | "nodes"
  | "chat"
  | "config"
  | "communications"
  | "appearance"
  | "automation"
  | "infrastructure"
  | "aiAgents"
  | "debug"
  | "logs";

type SettingsHost = {
  settings: {
    gatewayUrl: string;
    token: string;
    sessionKey: string;
    lastActiveSessionKey: string;
    theme: ThemeName;
    themeMode: ThemeMode;
    chatFocusMode: boolean;
    chatShowThinking: boolean;
    chatShowToolCalls: boolean;
    splitRatio: number;
    navCollapsed: boolean;
    navWidth: number;
    navGroupsCollapsed: Record<string, boolean>;
    borderRadius: number;
  };
  theme: ThemeName & ThemeMode;
  themeMode: ThemeMode;
  themeResolved: import("./theme.ts").ResolvedTheme;
  applySessionKey: string;
  sessionKey: string;
  tab: Tab;
  connected: boolean;
  chatHasAutoScrolled: boolean;
  logsAtBottom: boolean;
  eventLog: unknown[];
  eventLogBuffer: unknown[];
  basePath: string;
  themeMedia: MediaQueryList | null;
  themeMediaHandler: ((event: MediaQueryListEvent) => void) | null;
  logsPollInterval: number | null;
  debugPollInterval: number | null;
  artifactsPollInterval: number | null;
  bootstrapPollInterval: number | null;
  machinePollInterval: number | null;
  machineStatus?: MachineControlStatus | null;
  client?: { request: ReturnType<typeof vi.fn> } | null;
  chatMessage?: string;
  pendingGatewayUrl?: string | null;
  pendingGatewayToken?: string | null;
  agentsSelectedId?: string | null;
  agentsPanel?: "overview" | "files" | "tools" | "skills" | "channels" | "cron";
  agentFileActive?: string | null;
  artifactsFilterQuery?: string;
  artifactsSelectedId?: string | null;
  bootstrapFilterQuery?: string;
  bootstrapSelectedId?: string | null;
  channelsSelectedKey?: string | null;
  runtimeSessionKey?: string | null;
  runtimeRunId?: string | null;
  runtimeSelectedCheckpointId?: string | null;
  sessionsFilterActive?: string;
  sessionsFilterLimit?: string;
  sessionsIncludeGlobal?: boolean;
  sessionsIncludeUnknown?: boolean;
  sessionsSearchQuery?: string;
  sessionsSortColumn?: "key" | "kind" | "updated" | "tokens";
  sessionsSortDir?: "asc" | "desc";
  sessionsPage?: number;
  sessionsPageSize?: number;
  cronJobsQuery?: string;
  cronJobsEnabledFilter?: "all" | "enabled" | "disabled";
  cronJobsScheduleKindFilter?: "all" | "at" | "every" | "cron";
  cronJobsLastStatusFilter?: "all" | "ok" | "error" | "skipped";
  cronJobsSortBy?: "nextRunAtMs" | "updatedAtMs" | "name";
  cronJobsSortDir?: "asc" | "desc";
  cronRunsJobId?: string | null;
  cronRunsScope?: "job" | "all";
  cronRunsQuery?: string;
  cronRunsSortDir?: "asc" | "desc";
  cronRunsStatuses?: Array<"ok" | "error" | "skipped">;
  cronRunsDeliveryStatuses?: Array<"delivered" | "not-delivered" | "unknown" | "not-requested">;
  cronRunsStatusFilter?: "all" | "ok" | "error" | "skipped";
  usageStartDate?: string;
  usageEndDate?: string;
  usageSelectedSessions?: string[];
  usageTimeZone?: "local" | "utc";
  usageQuery?: string;
  usageQueryDraft?: string;
  usageResult?: { sessions?: Array<{ key: string }> } | null;
  usageTimeSeries?: unknown;
  usageSessionLogs?: unknown;
  skillsFilter?: string;
  logsFilterText?: string;
  execApprovalsTarget?: "gateway" | "node";
  execApprovalsTargetNodeId?: string | null;
  execApprovalsSelectedAgent?: string | null;
  bootstrapPendingCount?: number;
  bootstrapList?: Array<{ id: string; state: string }>;
  execApprovalQueue?: Array<{
    id: string;
    request: {
      command: string;
      blockedReason?: string | null;
      nodeId?: string | null;
      agentId?: string | null;
    };
    createdAtMs: number;
    expiresAtMs: number;
  }>;
  sessionsResult?: {
    count?: number;
    sessions: Array<{
      key: string;
      label?: string;
      displayName?: string;
      recoveryStatus?: string;
      recoveryOperatorHint?: string;
      recoveryCheckpointId?: string;
      recoveryBlockedReason?: string;
      handoffTruthSource?: "recovery" | "closure";
      handoffRunId?: string;
      handoffRequestRunId?: string;
      runClosureSummary?: { runId?: string };
    }>;
  } | null;
  runtimeCheckpoints?: Array<{
    id: string;
    sessionKey?: string;
    runId?: string;
    status?: string;
    operatorHint?: string;
    blockedReason?: string;
    target?: { bootstrapRequestId?: string; artifactId?: string };
  }>;
  runtimeCheckpointDetail?: {
    id: string;
    sessionKey?: string;
    runId?: string;
    status?: string;
    operatorHint?: string;
    blockedReason?: string;
    target?: { bootstrapRequestId?: string; artifactId?: string };
  } | null;
  skillsReport?: { skills?: Array<{ disabled?: boolean; missing?: Record<string, unknown>; blockedByAllowlist?: boolean; name: string }> } | null;
  channelsSnapshot?: ChannelsStatusSnapshot | null;
  hello?: { auth?: { role?: string; scopes?: string[] } } | null;
  lastError?: string | null;
  cronJobs?: Array<{ id?: string; name: string; enabled?: boolean; state?: { lastStatus?: string; nextRunAtMs?: number | null } }>;
  attentionItems?: Array<unknown>;
};

function createStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

function setTestWindowUrl(urlString: string) {
  const current = new URL(urlString);
  const history = {
    pushState: vi.fn((_state: unknown, _title: string, nextUrl: string | URL) => {
      const next = new URL(String(nextUrl), current.toString());
      current.href = next.toString();
      current.protocol = next.protocol;
      current.host = next.host;
      current.pathname = next.pathname;
      current.search = next.search;
      current.hash = next.hash;
    }),
    replaceState: vi.fn((_state: unknown, _title: string, nextUrl: string | URL) => {
      const next = new URL(String(nextUrl), current.toString());
      current.href = next.toString();
      current.protocol = next.protocol;
      current.host = next.host;
      current.pathname = next.pathname;
      current.search = next.search;
      current.hash = next.hash;
    }),
  };
  const locationLike = {
    get href() {
      return current.toString();
    },
    get protocol() {
      return current.protocol;
    },
    get host() {
      return current.host;
    },
    get pathname() {
      return current.pathname;
    },
    get search() {
      return current.search;
    },
    get hash() {
      return current.hash;
    },
  };
  vi.stubGlobal("window", {
    location: locationLike,
    history,
    setInterval,
    clearInterval,
  } as unknown as Window & typeof globalThis);
  vi.stubGlobal("location", locationLike as Location);
  return { history, location: locationLike };
}

function toQueryValue(value: string) {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

const createHost = (tab: Tab): SettingsHost => ({
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
  },
  theme: "claw" as unknown as ThemeName & ThemeMode,
  themeMode: "system",
  themeResolved: "dark",
  applySessionKey: "main",
  sessionKey: "main",
  tab,
  connected: false,
  chatHasAutoScrolled: false,
  logsAtBottom: false,
  eventLog: [],
  eventLogBuffer: [],
  basePath: "",
  themeMedia: null,
  themeMediaHandler: null,
  logsPollInterval: null,
  debugPollInterval: null,
  artifactsPollInterval: null,
  bootstrapPollInterval: null,
  machinePollInterval: null,
  machineStatus: null,
  client: null,
  chatMessage: "",
  pendingGatewayUrl: null,
  pendingGatewayToken: null,
  agentsSelectedId: null,
  agentsPanel: "overview",
  agentFileActive: null,
  artifactsFilterQuery: "",
  artifactsSelectedId: null,
  bootstrapFilterQuery: "",
  bootstrapSelectedId: null,
  channelsSelectedKey: null,
  runtimeSessionKey: null,
  runtimeRunId: null,
  runtimeSelectedCheckpointId: null,
  sessionsFilterActive: "",
  sessionsFilterLimit: "120",
  sessionsIncludeGlobal: true,
  sessionsIncludeUnknown: false,
  sessionsSearchQuery: "",
  sessionsSortColumn: "updated",
  sessionsSortDir: "desc",
  sessionsPage: 0,
  sessionsPageSize: 25,
  cronJobsQuery: "",
  cronJobsEnabledFilter: "all",
  cronJobsScheduleKindFilter: "all",
  cronJobsLastStatusFilter: "all",
  cronJobsSortBy: "nextRunAtMs",
  cronJobsSortDir: "asc",
  cronRunsJobId: null,
  cronRunsScope: "all",
  cronRunsQuery: "",
  cronRunsSortDir: "desc",
  cronRunsStatuses: [],
  cronRunsDeliveryStatuses: [],
  cronRunsStatusFilter: "all",
  usageStartDate: "2026-03-31",
  usageEndDate: "2026-03-31",
  usageSelectedSessions: [],
  usageTimeZone: "local",
  usageQuery: "",
  usageQueryDraft: "",
  usageResult: null,
  usageTimeSeries: null,
  usageSessionLogs: null,
  skillsFilter: "",
  logsFilterText: "",
  execApprovalsTarget: "gateway",
  execApprovalsTargetNodeId: null,
  execApprovalsSelectedAgent: null,
  bootstrapPendingCount: 0,
  bootstrapList: [],
  execApprovalQueue: [],
  sessionsResult: null,
  runtimeCheckpoints: [],
  runtimeCheckpointDetail: null,
  skillsReport: null,
  channelsSnapshot: null,
  hello: null,
  lastError: null,
  cronJobs: [],
  attentionItems: [],
});

describe("setTabFromRoute", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    setTestWindowUrl("https://control.example/ui/chat");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts and stops log polling based on the tab", () => {
    const host = createHost("chat");

    setTabFromRoute(host, "logs");
    expect(host.logsPollInterval).not.toBeNull();
    expect(host.debugPollInterval).toBeNull();

    setTabFromRoute(host, "chat");
    expect(host.logsPollInterval).toBeNull();
  });

  it("starts and stops debug polling based on the tab", () => {
    const host = createHost("chat");

    setTabFromRoute(host, "debug");
    expect(host.debugPollInterval).not.toBeNull();
    expect(host.logsPollInterval).toBeNull();

    setTabFromRoute(host, "chat");
    expect(host.debugPollInterval).toBeNull();
  });

  it("starts and stops artifact polling based on the tab", () => {
    const host = createHost("chat");

    setTabFromRoute(host, "artifacts");
    expect(host.artifactsPollInterval).not.toBeNull();
    expect(host.logsPollInterval).toBeNull();
    expect(host.debugPollInterval).toBeNull();

    setTabFromRoute(host, "chat");
    expect(host.artifactsPollInterval).toBeNull();
  });

  it("starts and stops bootstrap polling based on the tab", () => {
    const host = createHost("chat");

    setTabFromRoute(host, "bootstrap");
    expect(host.bootstrapPollInterval).not.toBeNull();
    expect(host.logsPollInterval).toBeNull();
    expect(host.debugPollInterval).toBeNull();

    setTabFromRoute(host, "chat");
    expect(host.bootstrapPollInterval).toBeNull();
  });

  it("starts and stops machine polling based on the tab", () => {
    const host = createHost("chat");

    setTabFromRoute(host, "machine");
    expect(host.machinePollInterval).not.toBeNull();
    expect(host.logsPollInterval).toBeNull();
    expect(host.debugPollInterval).toBeNull();

    setTabFromRoute(host, "chat");
    expect(host.machinePollInterval).toBeNull();
  });

  it("re-resolves the active palette when only themeMode changes", () => {
    const host = createHost("chat");
    host.settings.theme = "knot";
    host.settings.themeMode = "dark";
    host.theme = "knot" as unknown as ThemeName & ThemeMode;
    host.themeMode = "dark";
    host.themeResolved = "openknot";

    applySettings(host, {
      ...host.settings,
      themeMode: "light",
    });

    expect(host.theme).toBe("knot");
    expect(host.themeMode).toBe("light");
    expect(host.themeResolved).toBe("openknot-light");
  });

  it("syncs both theme family and mode from persisted settings", () => {
    const host = createHost("chat");
    host.settings.theme = "dash";
    host.settings.themeMode = "light";

    syncThemeWithSettings(host);

    expect(host.theme).toBe("dash");
    expect(host.themeMode).toBe("light");
    expect(host.themeResolved).toBe("dash-light");
  });

  it("applies named system themes on OS preference changes", () => {
    const listeners: Array<(event: MediaQueryListEvent) => void> = [];
    const matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: (_name: string, handler: (event: MediaQueryListEvent) => void) => {
        listeners.push(handler);
      },
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("matchMedia", matchMedia);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: matchMedia,
    });

    const host = createHost("chat");
    host.theme = "knot" as unknown as ThemeName & ThemeMode;
    host.themeMode = "system";

    attachThemeListener(host);
    listeners[0]?.({ matches: true } as MediaQueryListEvent);
    expect(host.themeResolved).toBe("openknot");

    listeners[0]?.({ matches: false } as MediaQueryListEvent);
    expect(host.themeResolved).toBe("openknot");
  });

  it("normalizes light family themes to the shared light CSS token", () => {
    const root = {
      dataset: {} as DOMStringMap,
      style: { colorScheme: "" } as CSSStyleDeclaration & { colorScheme: string },
    };
    vi.stubGlobal("document", { documentElement: root } as Document);

    const host = createHost("chat");
    applyResolvedTheme(host, "dash-light");

    expect(host.themeResolved).toBe("dash-light");
    expect(root.dataset.theme).toBe("dash-light");
    expect(root.style.colorScheme).toBe("light");
  });
});

describe("applySettingsFromUrl", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    setTestWindowUrl("https://control.example/ui/overview");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("hydrates query token params and strips them from the URL", () => {
    setTestWindowUrl("https://control.example/ui/overview?token=abc123");
    const host = createHost("overview");
    host.settings.gatewayUrl = "wss://control.example/openclaw";

    applySettingsFromUrl(host);

    expect(host.settings.token).toBe("abc123");
    expect(window.location.search).toBe("");
  });

  it("keeps query token params pending when a gatewayUrl confirmation is required", () => {
    setTestWindowUrl(
      "https://control.example/ui/overview?gatewayUrl=wss://other-gateway.example/openclaw&token=abc123",
    );
    const host = createHost("overview");
    host.settings.gatewayUrl = "wss://control.example/openclaw";

    applySettingsFromUrl(host);

    expect(host.settings.token).toBe("");
    expect(host.pendingGatewayUrl).toBe("wss://other-gateway.example/openclaw");
    expect(host.pendingGatewayToken).toBe("abc123");
    expect(window.location.search).toBe("");
  });

  it("prefers fragment tokens over legacy query tokens when both are present", () => {
    setTestWindowUrl("https://control.example/ui/overview?token=query-token#token=hash-token");
    const host = createHost("overview");
    host.settings.gatewayUrl = "wss://control.example/openclaw";

    applySettingsFromUrl(host);

    expect(host.settings.token).toBe("hash-token");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });

  it("resets stale persisted session selection to main when a token is supplied without a session", () => {
    setTestWindowUrl("https://control.example/chat#token=test-token");
    const host = createHost("chat");
    host.settings = {
      ...host.settings,
      gatewayUrl: "ws://localhost:18789",
      token: "",
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
    };
    host.sessionKey = "agent:test_old:main";

    applySettingsFromUrl(host);

    expect(host.sessionKey).toBe("main");
    expect(host.settings.sessionKey).toBe("main");
    expect(host.settings.lastActiveSessionKey).toBe("main");
  });

  it("preserves an explicit session from the URL when token and session are both supplied", () => {
    setTestWindowUrl(
      "https://control.example/chat?session=agent%3Atest_new%3Amain#token=test-token",
    );
    const host = createHost("chat");
    host.settings = {
      ...host.settings,
      gatewayUrl: "ws://localhost:18789",
      token: "",
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
    };
    host.sessionKey = "agent:test_old:main";

    applySettingsFromUrl(host);

    expect(host.sessionKey).toBe("agent:test_new:main");
    expect(host.settings.sessionKey).toBe("agent:test_new:main");
    expect(host.settings.lastActiveSessionKey).toBe("agent:test_new:main");
  });

  it("does not reset the current gateway session when a different gateway is pending confirmation", () => {
    setTestWindowUrl(
      "https://control.example/chat?gatewayUrl=ws%3A%2F%2Fgateway-b.example%3A18789#token=test-token",
    );
    const host = createHost("chat");
    host.settings = {
      ...host.settings,
      gatewayUrl: "ws://gateway-a.example:18789",
      token: "",
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
    };
    host.sessionKey = "agent:test_old:main";

    applySettingsFromUrl(host);

    expect(host.sessionKey).toBe("agent:test_old:main");
    expect(host.settings.sessionKey).toBe("agent:test_old:main");
    expect(host.settings.lastActiveSessionKey).toBe("agent:test_old:main");
    expect(host.pendingGatewayUrl).toBe("ws://gateway-b.example:18789");
    expect(host.pendingGatewayToken).toBe("test-token");
  });

  it("hydrates deep-link query state for agents, sessions, usage, runtime, bootstrap, artifacts, cron, skills, channels, logs, and nodes", () => {
    setTestWindowUrl(
      "https://control.example/ui/sessions?session=agent%3Amain%3Amain&agent=beta&agentsPanel=files&agentFile=AGENTS.md&sessionsActive=30&sessionsLimit=250&sessionsGlobal=false&sessionsUnknown=true&sessionsQ=main%20agent&sessionsSort=key&sessionsDir=asc&sessionsPage=2&sessionsPageSize=50&cronQ=digest&cronEnabled=enabled&cronSchedule=cron&cronStatus=error&cronSort=name&cronDir=desc&usageFrom=2026-03-01&usageTo=2026-03-31&usageTz=utc&usageSession=agent%3Amain%3Amain&usageQ=cost%20spike&runtimeSession=agent%3Amain%3Amain&runtimeRun=run-1&checkpoint=cp-1&bootstrapQ=renderer&bootstrapRequest=bootstrap-1&artifactQ=invoice&artifact=artifact-1&cronJob=cron-1&cronRunsQ=needle&cronRunsSort=asc&cronRunsStatus=ok%2Cerror&cronRunsDelivery=delivered&skillFilter=missing&channel=slack&logQ=timeout&execTarget=node&execNode=node-1&execAgent=main",
    );
    const host = createHost("sessions");

    applySettingsFromUrl(host);

    expect(host.sessionKey).toBe("agent:main:main");
    expect(host.agentsSelectedId).toBe("beta");
    expect(host.agentsPanel).toBe("files");
    expect(host.agentFileActive).toBe("AGENTS.md");
    expect(host.sessionsFilterActive).toBe("30");
    expect(host.sessionsFilterLimit).toBe("250");
    expect(host.sessionsIncludeGlobal).toBe(false);
    expect(host.sessionsIncludeUnknown).toBe(true);
    expect(host.sessionsSearchQuery).toBe("main agent");
    expect(host.sessionsSortColumn).toBe("key");
    expect(host.sessionsSortDir).toBe("asc");
    expect(host.sessionsPage).toBe(2);
    expect(host.sessionsPageSize).toBe(50);
    expect(host.usageStartDate).toBe("2026-03-01");
    expect(host.usageEndDate).toBe("2026-03-31");
    expect(host.usageTimeZone).toBe("utc");
    expect(host.usageSelectedSessions).toEqual(["agent:main:main"]);
    expect(host.usageQuery).toBe("cost spike");
    expect(host.usageQueryDraft).toBe("cost spike");
    expect(host.runtimeSessionKey).toBe("agent:main:main");
    expect(host.runtimeRunId).toBe("run-1");
    expect(host.runtimeSelectedCheckpointId).toBe("cp-1");
    expect(host.bootstrapFilterQuery).toBe("renderer");
    expect(host.bootstrapSelectedId).toBe("bootstrap-1");
    expect(host.artifactsFilterQuery).toBe("invoice");
    expect(host.artifactsSelectedId).toBe("artifact-1");
    expect(host.cronJobsQuery).toBe("digest");
    expect(host.cronJobsEnabledFilter).toBe("enabled");
    expect(host.cronJobsScheduleKindFilter).toBe("cron");
    expect(host.cronJobsLastStatusFilter).toBe("error");
    expect(host.cronJobsSortBy).toBe("name");
    expect(host.cronJobsSortDir).toBe("desc");
    expect(host.cronRunsJobId).toBe("cron-1");
    expect(host.cronRunsScope).toBe("job");
    expect(host.cronRunsQuery).toBe("needle");
    expect(host.cronRunsSortDir).toBe("asc");
    expect(host.cronRunsStatuses).toEqual(["ok", "error"]);
    expect(host.cronRunsStatusFilter).toBe("all");
    expect(host.cronRunsDeliveryStatuses).toEqual(["delivered"]);
    expect(host.skillsFilter).toBe("missing");
    expect(host.channelsSelectedKey).toBe("slack");
    expect(host.logsFilterText).toBe("timeout");
    expect(host.execApprovalsTarget).toBe("node");
    expect(host.execApprovalsTargetNodeId).toBe("node-1");
    expect(host.execApprovalsSelectedAgent).toBe("main");
  });

  it("falls back to default sessions list query state when query values are invalid", () => {
    setTestWindowUrl(
      "https://control.example/ui/sessions?session=agent%3Amain%3Amain&sessionsGlobal=maybe&sessionsUnknown=wat&sessionsSort=bogus&sessionsDir=sideways&sessionsPage=-1&sessionsPageSize=7",
    );
    const host = createHost("sessions");

    applySettingsFromUrl(host);

    expect(host.sessionsIncludeGlobal).toBe(true);
    expect(host.sessionsIncludeUnknown).toBe(false);
    expect(host.sessionsSortColumn).toBe("updated");
    expect(host.sessionsSortDir).toBe("desc");
    expect(host.sessionsPage).toBe(0);
    expect(host.sessionsPageSize).toBe(25);
  });

  it("falls back to default cron list query state when query values are invalid", () => {
    setTestWindowUrl(
      "https://control.example/ui/cron?session=agent%3Amain%3Amain&cronEnabled=maybe&cronSchedule=weekly&cronStatus=nope&cronSort=priority&cronDir=sideways",
    );
    const host = createHost("cron");

    applySettingsFromUrl(host);

    expect(host.cronJobsEnabledFilter).toBe("all");
    expect(host.cronJobsScheduleKindFilter).toBe("all");
    expect(host.cronJobsLastStatusFilter).toBe("all");
    expect(host.cronJobsSortBy).toBe("nextRunAtMs");
    expect(host.cronJobsSortDir).toBe("asc");
  });

  it("hydrates cron runs deep-link state and falls back when scope=job is invalid without cronJob", () => {
    setTestWindowUrl(
      "https://control.example/ui/cron?session=main&cronRunsScope=job&cronRunsSort=zigzag&cronRunsStatus=ok%2Cbogus&cronRunsDelivery=delivered%2Cextra",
    );
    const host = createHost("cron");

    applySettingsFromUrl(host);

    expect(host.cronRunsScope).toBe("all");
    expect(host.cronRunsJobId).toBeNull();
    expect(host.cronRunsSortDir).toBe("desc");
    expect(host.cronRunsStatuses).toEqual(["ok"]);
    expect(host.cronRunsStatusFilter).toBe("ok");
    expect(host.cronRunsDeliveryStatuses).toEqual(["delivered"]);
  });

  it("treats cronRunsScope=all as explicit: clears cronJob for runs even when cronJob is present", () => {
    setTestWindowUrl(
      "https://control.example/ui/cron?session=main&cronRunsScope=all&cronJob=cron-1",
    );
    const host = createHost("cron");

    applySettingsFromUrl(host);

    expect(host.cronRunsScope).toBe("all");
    expect(host.cronRunsJobId).toBeNull();
  });
});

describe("syncUrlWithTab", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    setTestWindowUrl("https://control.example/ui/chat?session=main");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("persists tab-specific deep-link state with basePath", () => {
    const host = createHost("sessions");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.sessionsFilterActive = "30";
    host.sessionsFilterLimit = "250";
    host.sessionsIncludeGlobal = false;
    host.sessionsIncludeUnknown = true;
    host.sessionsSearchQuery = "main agent";
    host.sessionsSortColumn = "tokens";
    host.sessionsSortDir = "asc";
    host.sessionsPage = 3;
    host.sessionsPageSize = 50;
    host.runtimeSessionKey = "agent:main:main";
    host.runtimeRunId = "run-1";
    host.runtimeSelectedCheckpointId = "cp-1";

    syncUrlWithTab(host, "sessions", true);

    expect(window.location.pathname).toBe("/ui/sessions");
    expect(window.location.search).toContain("session=agent%3Amain%3Amain");
    expect(window.location.search).toContain("sessionsActive=30");
    expect(window.location.search).toContain("sessionsLimit=250");
    expect(window.location.search).toContain("sessionsGlobal=false");
    expect(window.location.search).toContain("sessionsUnknown=true");
    expect(window.location.search).toContain(`sessionsQ=${toQueryValue("main agent")}`);
    expect(window.location.search).toContain("sessionsSort=tokens");
    expect(window.location.search).toContain("sessionsDir=asc");
    expect(window.location.search).toContain("sessionsPage=3");
    expect(window.location.search).toContain("sessionsPageSize=50");
    expect(window.location.search).toContain("runtimeSession=agent%3Amain%3Amain");
    expect(window.location.search).toContain("runtimeRun=run-1");
    expect(window.location.search).toContain("checkpoint=cp-1");
  });

  it("persists cron deep-link selection with basePath", () => {
    const host = createHost("cron");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.cronJobsQuery = "digest";
    host.cronJobsEnabledFilter = "enabled";
    host.cronJobsScheduleKindFilter = "cron";
    host.cronJobsLastStatusFilter = "error";
    host.cronJobsSortBy = "name";
    host.cronJobsSortDir = "desc";
    host.cronRunsJobId = "cron-1";
    host.cronRunsScope = "job";

    syncUrlWithTab(host, "cron", true);

    expect(window.location.pathname).toBe("/ui/cron");
    expect(window.location.search).toContain("session=agent%3Amain%3Amain");
    expect(window.location.search).toContain(`cronQ=${toQueryValue("digest")}`);
    expect(window.location.search).toContain("cronEnabled=enabled");
    expect(window.location.search).toContain("cronSchedule=cron");
    expect(window.location.search).toContain("cronStatus=error");
    expect(window.location.search).toContain("cronSort=name");
    expect(window.location.search).toContain("cronDir=desc");
    expect(window.location.search).toContain("cronRunsScope=job");
    expect(window.location.search).toContain("cronJob=cron-1");
  });

  it("persists cron runs explorer query state with basePath", () => {
    const host = createHost("cron");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.cronJobsQuery = "digest";
    host.cronJobsEnabledFilter = "enabled";
    host.cronJobsScheduleKindFilter = "cron";
    host.cronJobsLastStatusFilter = "error";
    host.cronJobsSortBy = "name";
    host.cronJobsSortDir = "desc";
    host.cronRunsScope = "all";
    host.cronRunsQuery = "needle";
    host.cronRunsSortDir = "asc";
    host.cronRunsStatuses = ["ok", "error"];
    host.cronRunsStatusFilter = "all";
    host.cronRunsDeliveryStatuses = ["delivered"];

    syncUrlWithTab(host, "cron", true);

    expect(window.location.pathname).toBe("/ui/cron");
    expect(window.location.search).toContain("cronRunsScope=all");
    expect(window.location.search).toContain(`cronRunsQ=${toQueryValue("needle")}`);
    expect(window.location.search).toContain("cronRunsSort=asc");
    expect(window.location.search).toContain("cronRunsStatus=ok%2Cerror");
    expect(window.location.search).toContain("cronRunsDelivery=delivered");
    expect(window.location.search).not.toContain("cronJob=");
  });

  it("persists bootstrap deep-link selection and list query with basePath", () => {
    const host = createHost("bootstrap");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.bootstrapFilterQuery = "renderer";
    host.bootstrapSelectedId = "bootstrap-1";

    syncUrlWithTab(host, "bootstrap", true);

    expect(window.location.pathname).toBe("/ui/bootstrap");
    expect(window.location.search).toContain("session=agent%3Amain%3Amain");
    expect(window.location.search).toContain(`bootstrapQ=${toQueryValue("renderer")}`);
    expect(window.location.search).toContain("bootstrapRequest=bootstrap-1");
  });

  it("persists artifacts deep-link selection and list query with basePath", () => {
    const host = createHost("artifacts");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.artifactsFilterQuery = "invoice";
    host.artifactsSelectedId = "artifact-1";

    syncUrlWithTab(host, "artifacts", true);

    expect(window.location.pathname).toBe("/ui/artifacts");
    expect(window.location.search).toContain("session=agent%3Amain%3Amain");
    expect(window.location.search).toContain(`artifactQ=${toQueryValue("invoice")}`);
    expect(window.location.search).toContain("artifact=artifact-1");
  });

  it("clears bootstrap and artifact list query params outside their tabs", () => {
    const host = createHost("bootstrap");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.bootstrapFilterQuery = "renderer";
    host.bootstrapSelectedId = "bootstrap-1";

    syncUrlWithTab(host, "bootstrap", true);
    syncUrlWithTab(host, "chat", true);

    expect(window.location.pathname).toBe("/ui/chat");
    expect(window.location.search).not.toContain("bootstrapQ=");
    expect(window.location.search).not.toContain("bootstrapRequest=");
    expect(window.location.search).not.toContain("artifactQ=");
    expect(window.location.search).not.toContain("artifact=");
  });

  it("persists skills deep-link selection with basePath", () => {
    const host = createHost("skills");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.skillsFilter = SKILL_FILTER_BLOCKED;

    syncUrlWithTab(host, "skills", true);

    expect(window.location.pathname).toBe("/ui/skills");
    expect(window.location.search).toContain("session=agent%3Amain%3Amain");
    expect(window.location.search).toContain(`skillFilter=${toQueryValue(SKILL_FILTER_BLOCKED)}`);
  });

  it("persists usage deep-link selection with basePath", () => {
    const host = createHost("usage");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.usageStartDate = "2026-03-01";
    host.usageEndDate = "2026-03-31";
    host.usageTimeZone = "utc";
    host.usageSelectedSessions = ["agent:main:main"];
    host.usageQuery = "cost spike";
    host.usageQueryDraft = "cost spike";

    syncUrlWithTab(host, "usage", true);

    expect(window.location.pathname).toBe("/ui/usage");
    expect(window.location.search).toContain("session=agent%3Amain%3Amain");
    expect(window.location.search).toContain("usageFrom=2026-03-01");
    expect(window.location.search).toContain("usageTo=2026-03-31");
    expect(window.location.search).toContain("usageTz=utc");
    expect(window.location.search).toContain("usageSession=agent%3Amain%3Amain");
    expect(window.location.search).toContain(`usageQ=${toQueryValue("cost spike")}`);
  });

  it("persists agents file deep-link selection with basePath", () => {
    const host = createHost("agents");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.agentsSelectedId = "beta";
    host.agentsPanel = "files";
    host.agentFileActive = "AGENTS.md";

    syncUrlWithTab(host, "agents", true);

    expect(window.location.pathname).toBe("/ui/agents");
    expect(window.location.search).toContain("session=agent%3Amain%3Amain");
    expect(window.location.search).toContain("agent=beta");
    expect(window.location.search).toContain("agentsPanel=files");
    expect(window.location.search).toContain(`agentFile=${toQueryValue("AGENTS.md")}`);
  });

  it("persists skills filter when agents skills panel is active", () => {
    const host = createHost("agents");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.agentsSelectedId = "beta";
    host.agentsPanel = "skills";
    host.skillsFilter = SKILL_FILTER_MISSING;

    syncUrlWithTab(host, "agents", true);

    expect(window.location.pathname).toBe("/ui/agents");
    expect(window.location.search).toContain("agent=beta");
    expect(window.location.search).toContain("agentsPanel=skills");
    expect(window.location.search).toContain(`skillFilter=${toQueryValue(SKILL_FILTER_MISSING)}`);
  });

  it("persists channels deep-link selection with basePath", () => {
    const host = createHost("channels");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.channelsSelectedKey = "slack";

    syncUrlWithTab(host, "channels", true);

    expect(window.location.pathname).toBe("/ui/channels");
    expect(window.location.search).toContain("session=agent%3Amain%3Amain");
    expect(window.location.search).toContain("channel=slack");
  });

  it("persists logs deep-link selection with basePath", () => {
    const host = createHost("logs");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.logsFilterText = "timeout error";

    syncUrlWithTab(host, "logs", true);

    expect(window.location.pathname).toBe("/ui/logs");
    expect(window.location.search).toContain("session=agent%3Amain%3Amain");
    expect(window.location.search).toContain(`logQ=${toQueryValue("timeout error")}`);
  });

  it("persists nodes deep-link selection with basePath", () => {
    const host = createHost("nodes");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.execApprovalsTarget = "node";
    host.execApprovalsTargetNodeId = "node-1";
    host.execApprovalsSelectedAgent = "main";

    syncUrlWithTab(host, "nodes", true);

    expect(window.location.pathname).toBe("/ui/nodes");
    expect(window.location.search).toContain("session=agent%3Amain%3Amain");
    expect(window.location.search).toContain("execTarget=node");
    expect(window.location.search).toContain("execNode=node-1");
    expect(window.location.search).toContain("execAgent=main");
  });
});

describe("refreshActiveTab usage deep links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    setTestWindowUrl("https://control.example/ui/usage?session=agent%3Amain%3Amain");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("restores the single-session detail path after usage summary load", async () => {
    const host = createHost("usage");
    host.basePath = "/ui";
    host.connected = true;
    host.usageSelectedSessions = ["agent:main:main"];
    vi.mocked(loadUsage).mockImplementationOnce(async (state) => {
      (state as SettingsHost).usageResult = {
        sessions: [{ key: "agent:main:main" }],
      };
    });

    await refreshActiveTab(host);

    expect(loadUsage).toHaveBeenCalledWith(host);
    expect(loadSessionTimeSeries).toHaveBeenCalledWith(host, "agent:main:main");
    expect(loadSessionLogs).toHaveBeenCalledWith(host, "agent:main:main");
  });

  it("clears invalid usageSession deep links without dropping the rest of the usage context", async () => {
    const host = createHost("usage");
    host.basePath = "/ui";
    host.connected = true;
    host.sessionKey = "agent:main:main";
    host.usageStartDate = "2026-03-01";
    host.usageEndDate = "2026-03-31";
    host.usageTimeZone = "utc";
    host.usageQuery = "cost spike";
    host.usageQueryDraft = "cost spike";
    host.usageSelectedSessions = ["agent:missing:main"];
    vi.mocked(loadUsage).mockImplementationOnce(async (state) => {
      (state as SettingsHost).usageResult = {
        sessions: [{ key: "agent:main:main" }],
      };
    });

    await refreshActiveTab(host);

    expect(host.usageSelectedSessions).toEqual([]);
    expect(window.location.search).toContain("usageFrom=2026-03-01");
    expect(window.location.search).toContain("usageTo=2026-03-31");
    expect(window.location.search).toContain("usageTz=utc");
    expect(window.location.search).toContain(`usageQ=${toQueryValue("cost spike")}`);
    expect(window.location.search).not.toContain("usageSession=");
  });
});

describe("refreshActiveTab sessions list deep links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    setTestWindowUrl("https://control.example/ui/sessions?session=agent%3Amain%3Amain");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("clamps out-of-range sessions page after the list loads", async () => {
    const host = createHost("sessions");
    host.basePath = "/ui";
    host.connected = true;
    host.sessionKey = "agent:main:main";
    host.sessionsFilterActive = "30";
    host.sessionsFilterLimit = "250";
    host.sessionsIncludeGlobal = false;
    host.sessionsIncludeUnknown = true;
    host.sessionsSearchQuery = "main agent";
    host.sessionsSortColumn = "tokens";
    host.sessionsSortDir = "asc";
    host.sessionsPage = 4;
    host.sessionsPageSize = 50;
    vi.mocked(loadSessions).mockImplementationOnce(async (state) => {
      (state as SettingsHost).sessionsResult = {
        count: 10,
        sessions: [{ key: "agent:main:main" }],
      };
    });

    await refreshActiveTab(host);

    expect(loadSessions).toHaveBeenCalledWith(host);
    expect(host.sessionsPage).toBe(0);
    expect(window.location.search).toContain("sessionsSort=tokens");
    expect(window.location.search).toContain("sessionsDir=asc");
    expect(window.location.search).toContain("sessionsPage=0");
    expect(window.location.search).toContain("sessionsPageSize=50");
    expect(loadRuntimeInspector).toHaveBeenCalledWith(host);
  });
});

describe("refreshActiveTab cron job deep links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    setTestWindowUrl(
      "https://control.example/ui/cron?session=agent%3Amain%3Amain&cronQ=digest&cronRunsScope=job&cronJob=missing-cron",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("falls back to all runs scope when the loaded job list does not contain the deep-linked cron job id", async () => {
    const host = createHost("cron");
    host.basePath = "/ui";
    host.connected = true;
    host.sessionKey = "agent:main:main";
    host.cronJobsQuery = "digest";
    host.cronRunsScope = "job";
    host.cronRunsJobId = "missing-cron";

    vi.spyOn(channels, "loadChannels").mockResolvedValue(undefined as never);
    vi.spyOn(cron, "loadCronStatus").mockResolvedValue(undefined as never);
    vi.spyOn(cron, "loadCronJobs").mockImplementation(async (state: { cronJobs: unknown[] }) => {
      state.cronJobs = [{ id: "other", name: "Other" }];
    });
    const runsSpy = vi.spyOn(cron, "loadCronRuns").mockResolvedValue(undefined as never);

    await refreshActiveTab(host);

    expect(host.cronRunsScope).toBe("all");
    expect(host.cronRunsJobId).toBeNull();
    expect(runsSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(window.location.search).toContain(`cronQ=${toQueryValue("digest")}`);
    expect(window.location.search).toContain("cronRunsScope=all");
    expect(window.location.search).not.toContain("cronJob=");
  });
});

describe("loadOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preloads runtime inspector with the truth-aware handoff run", async () => {
    const host = createHost("overview");
    host.sessionKey = "agent:main:main";
    host.sessionsResult = {
      sessions: [
        {
          key: "agent:main:main",
          handoffTruthSource: "recovery",
          handoffRunId: "recovery-run",
          handoffRequestRunId: "request-run",
          runClosureSummary: { runId: "closure-run" },
        },
      ],
    };

    await loadOverview(host as never);

    expect(loadRuntimeInspector).toHaveBeenCalledWith(host, {
      sessionKey: "agent:main:main",
      runId: "recovery-run",
    });
  });

  it("falls back to a null runtime run when no cached session row exists", async () => {
    const host = createHost("overview");
    host.sessionKey = "agent:main:main";
    host.sessionsResult = null;

    await loadOverview(host as never);

    expect(loadRuntimeInspector).toHaveBeenCalledWith(host, {
      sessionKey: "agent:main:main",
      runId: null,
    });
  });
});

describe("buildAttentionItems", () => {
  it("adds handoff-aware recovery and scoped bootstrap attention links", () => {
    const host = createHost("overview");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.sessionsResult = {
      sessions: [
        {
          key: "agent:main:main",
          label: "Main session",
          handoffTruthSource: "recovery",
          handoffRunId: "recovery-run",
          handoffRequestRunId: "request-run",
          runClosureSummary: { runId: "closure-run" },
          recoveryStatus: "blocked",
          recoveryOperatorHint: "Awaiting operator approval.",
          recoveryCheckpointId: "cp-2",
        },
      ],
    };
    host.runtimeCheckpoints = [
      {
        id: "cp-1",
        sessionKey: "agent:main:main",
        runId: "closure-run",
        status: "blocked",
        operatorHint: "Old closure checkpoint.",
        target: { bootstrapRequestId: "bootstrap-old" },
      },
      {
        id: "cp-2",
        sessionKey: "agent:main:main",
        runId: "recovery-run",
        status: "blocked",
        operatorHint: "Awaiting operator approval.",
        target: { bootstrapRequestId: "bootstrap-1" },
      },
    ];
    host.runtimeCheckpointDetail = {
      id: "cp-1",
      sessionKey: "agent:main:main",
      runId: "closure-run",
      status: "blocked",
      operatorHint: "Old closure checkpoint.",
      target: { bootstrapRequestId: "bootstrap-old" },
    };

    buildAttentionItems(host as never);

    expect(host.attentionItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Recovery needs review for Main session",
          href: "/ui/sessions?session=agent%3Amain%3Amain&runtimeSession=agent%3Amain%3Amain&runtimeRun=recovery-run&checkpoint=cp-2",
        }),
        expect.objectContaining({
          title: "Bootstrap request linked to current recovery",
          href: "/ui/bootstrap?session=agent%3Amain%3Amain&bootstrapRequest=bootstrap-1",
        }),
      ]),
    );
  });

  it("keeps session-scoped recovery links when no truth-aware run is available", () => {
    const host = createHost("overview");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.sessionsResult = {
      sessions: [
        {
          key: "agent:main:main",
          label: "Main session",
          recoveryStatus: "blocked",
          recoveryOperatorHint: "Awaiting operator approval.",
          recoveryCheckpointId: "cp-1",
        },
      ],
    };
    host.runtimeCheckpoints = [
      {
        id: "cp-1",
        sessionKey: "agent:main:main",
        status: "blocked",
        operatorHint: "Awaiting operator approval.",
      },
    ];

    buildAttentionItems(host as never);

    expect(host.attentionItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Recovery needs review for Main session",
          href: "/ui/sessions?session=agent%3Amain%3Amain&runtimeSession=agent%3Amain%3Amain&checkpoint=cp-1",
        }),
      ]),
    );
  });

  it("adds actionable cron attention links", () => {
    const host = createHost("overview");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.cronJobs = [
      {
        id: "cron-1",
        name: "Nightly digest",
        enabled: true,
        state: { lastStatus: "error", nextRunAtMs: Date.now() - 600_000 },
      },
    ];

    buildAttentionItems(host as never);

    expect(host.attentionItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "1 cron job failed",
          href: "/ui/cron?session=agent%3Amain%3Amain&cronJob=cron-1",
          actionLabel: "Open",
        }),
        expect.objectContaining({
          title: "1 overdue job",
          href: "/ui/cron?session=agent%3Amain%3Amain&cronJob=cron-1",
          actionLabel: "Open",
        }),
      ]),
    );
  });

  it("adds actionable skills attention links", () => {
    const host = createHost("overview");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.skillsReport = {
      skills: [
        {
          name: "Browser Ops",
          disabled: false,
          missing: { bins: ["playwright"], env: [], config: [], os: [] },
          blockedByAllowlist: false,
        },
        {
          name: "SSH Ops",
          disabled: false,
          missing: { bins: [], env: [], config: [], os: [] },
          blockedByAllowlist: true,
        },
      ],
    };

    buildAttentionItems(host as never);

    expect(host.attentionItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Skills with missing dependencies",
          href: `/ui/skills?session=agent%3Amain%3Amain&skillFilter=${toQueryValue(SKILL_FILTER_MISSING)}`,
          actionLabel: "Open",
        }),
        expect.objectContaining({
          title: "1 skill blocked",
          href: `/ui/skills?session=agent%3Amain%3Amain&skillFilter=${toQueryValue(SKILL_FILTER_BLOCKED)}`,
          actionLabel: "Open",
        }),
      ]),
    );
  });

  it("adds actionable channels attention links for channels with explicit errors", () => {
    const host = createHost("overview");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.channelsSnapshot = {
      ts: Date.now(),
      channelOrder: ["slack", "telegram"],
      channelLabels: { slack: "Slack", telegram: "Telegram" },
      channels: {
        slack: { lastError: "Token expired" },
        telegram: {},
      },
      channelAccounts: {
        slack: [{ accountId: "default", lastError: "Token expired" }],
        telegram: [],
      },
      channelDefaultAccountId: {},
    };

    buildAttentionItems(host as never);

    expect(host.attentionItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "1 channel issue detected",
          href: "/ui/channels?session=agent%3Amain%3Amain&channel=slack",
          actionLabel: "Open",
        }),
      ]),
    );
  });

  it("routes gateway errors to the logs surface", () => {
    const host = createHost("overview");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.lastError = "Gateway disconnected";

    buildAttentionItems(host as never);

    expect(host.attentionItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Gateway Error",
          href: "/ui/logs?session=agent%3Amain%3Amain",
          actionLabel: "Open",
        }),
      ]),
    );
  });

  it("adds actionable exec approval attention links for pending approvals", () => {
    const host = createHost("overview");
    host.basePath = "/ui";
    host.sessionKey = "agent:main:main";
    host.execApprovalQueue = [
      {
        id: "approval-1",
        request: {
          command: "pnpm build",
          blockedReason: "Approval required",
          nodeId: "node-1",
          agentId: "main",
        },
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      },
    ];

    buildAttentionItems(host as never);

    expect(host.attentionItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "1 exec approval pending",
          href: "/ui/nodes?session=agent%3Amain%3Amain&execTarget=node&execNode=node-1&execAgent=main",
          actionLabel: "Open",
        }),
      ]),
    );
  });
});

describe("skills correlation helpers", () => {
  it("includes derived missing and blocked tokens in the searchable skills text", () => {
    const searchable = buildSkillSearchText({
      name: "SSH Ops",
      description: "SSH automation helpers",
      source: "workspace",
      filePath: "/workspace/ssh",
      baseDir: "/workspace",
      skillKey: "ssh-ops",
      always: false,
      disabled: false,
      blockedByAllowlist: true,
      eligible: false,
      requirements: { bins: [], env: [], config: [], os: [] },
      missing: { bins: ["ssh"], env: [], config: [], os: [] },
      configChecks: [],
      install: [],
    });

    expect(searchable).toContain(SKILL_FILTER_MISSING);
    expect(searchable).toContain(SKILL_FILTER_BLOCKED);
    expect(searchable).toContain("bin:ssh");
  });
});
