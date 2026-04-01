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
import type { AppViewState } from "./app-view-state.ts";
import type { OpenClawApp } from "./app.ts";
import { collectChannelAttentionTargets } from "./channels-correlation.ts";
import { loadAgentFileContent, loadAgentFiles } from "./controllers/agent-files.ts";
import { loadAgentIdentities, loadAgentIdentity } from "./controllers/agent-identity.ts";
import { loadAgentSkills } from "./controllers/agent-skills.ts";
import { loadAgents, loadToolsCatalog } from "./controllers/agents.ts";
import { loadArtifacts } from "./controllers/artifacts.ts";
import { loadBootstrapRequests } from "./controllers/bootstrap.ts";
import { loadPlatformCatalog } from "./controllers/catalog.ts";
import { loadChannels } from "./controllers/channels.ts";
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
import { loadSessionLogs, loadSessionTimeSeries, loadUsage } from "./controllers/usage.ts";
import {
  inferBasePathFromPathname,
  normalizeBasePath,
  normalizePath,
  pathForTab,
  tabFromPath,
  type Tab,
} from "./navigation.ts";
import { resolveSessionRuntimeInspectRunId } from "./session-runtime.ts";
import { SKILL_FILTER_BLOCKED, SKILL_FILTER_MISSING } from "./skills-correlation.ts";
import { saveSettings, type UiSettings } from "./storage.ts";
import { startThemeTransition, type ThemeTransitionContext } from "./theme-transition.ts";
import { resolveTheme, type ResolvedTheme, type ThemeMode, type ThemeName } from "./theme.ts";
import type {
  AgentsListResult,
  AttentionItem,
  CronDeliveryStatus,
  CronRunScope,
  CronRunsStatusValue,
} from "./types.ts";
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
  agentFileActive?: string | null;
  pendingGatewayUrl?: string | null;
  systemThemeCleanup?: (() => void) | null;
  pendingGatewayToken?: string | null;
  bootstrapFilterQuery?: string;
  artifactsFilterQuery?: string;
  artifactsSelectedId?: string | null;
  bootstrapSelectedId?: string | null;
  channelsSelectedKey?: string | null;
  runtimeSessionKey?: string | null;
  runtimeRunId?: string | null;
  runtimeSelectedCheckpointId?: string | null;
  runtimeSelectedActionId?: string | null;
  runtimeSelectedClosureRunId?: string | null;
  sessionsFilterActive?: string;
  sessionsFilterLimit?: string;
  sessionsIncludeGlobal?: boolean;
  sessionsIncludeUnknown?: boolean;
  sessionsSearchQuery?: string;
  sessionsSortColumn?: "key" | "kind" | "updated" | "tokens";
  sessionsSortDir?: "asc" | "desc";
  sessionsPage?: number;
  sessionsPageSize?: number;
  sessionsResult?: { count?: number | null; sessions?: Array<{ key: string }> } | null;
  cronJobsQuery?: string;
  cronJobsEnabledFilter?: "all" | "enabled" | "disabled";
  cronJobsScheduleKindFilter?: "all" | "at" | "every" | "cron";
  cronJobsLastStatusFilter?: "all" | "ok" | "error" | "skipped";
  cronJobsSortBy?: "nextRunAtMs" | "updatedAtMs" | "name";
  cronJobsSortDir?: "asc" | "desc";
  cronRunsJobId?: string | null;
  cronRunsScope?: CronRunScope;
  cronRunsQuery?: string;
  cronRunsSortDir?: "asc" | "desc";
  cronRunsStatuses?: CronRunsStatusValue[];
  cronRunsDeliveryStatuses?: CronDeliveryStatus[];
  cronRunsStatusFilter?: "all" | CronRunsStatusValue;
  usageStartDate?: string;
  usageEndDate?: string;
  usageSelectedSessions?: string[];
  usageTimeZone?: "local" | "utc";
  usageQuery?: string;
  usageQueryDraft?: string;
  usageResult?: { sessions?: Array<{ key: string }> } | null;
  usageTimeSeries?: OpenClawApp["usageTimeSeries"];
  usageSessionLogs?: OpenClawApp["usageSessionLogs"];
  skillsFilter?: string;
  instancesReveal?: boolean;
  configFormMode?: "form" | "raw";
  configSearchQuery?: string;
  configActiveSection?: string | null;
  configActiveSubsection?: string | null;
  communicationsFormMode?: "form" | "raw";
  communicationsSearchQuery?: string;
  communicationsActiveSection?: string | null;
  communicationsActiveSubsection?: string | null;
  appearanceFormMode?: "form" | "raw";
  appearanceSearchQuery?: string;
  appearanceActiveSection?: string | null;
  appearanceActiveSubsection?: string | null;
  automationFormMode?: "form" | "raw";
  automationSearchQuery?: string;
  automationActiveSection?: string | null;
  automationActiveSubsection?: string | null;
  infrastructureFormMode?: "form" | "raw";
  infrastructureSearchQuery?: string;
  infrastructureActiveSection?: string | null;
  infrastructureActiveSubsection?: string | null;
  aiAgentsFormMode?: "form" | "raw";
  aiAgentsSearchQuery?: string;
  aiAgentsActiveSection?: string | null;
  aiAgentsActiveSubsection?: string | null;
  debugCallMethod?: string;
  debugCallParams?: string;
  logsFilterText?: string;
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

function normalizeDebugCallParams(value: string | null | undefined, fallback: string): string {
  const trimmed = trimQueryValue(value);
  if (!trimmed) {
    return fallback;
  }
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    return fallback;
  }
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

function normalizeAgentsPanel(
  value: string | null | undefined,
): "overview" | "files" | "tools" | "skills" | "channels" | "cron" {
  switch (value) {
    case "files":
    case "tools":
    case "skills":
    case "channels":
    case "cron":
      return value;
    default:
      return "overview";
  }
}

function todayUsageDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function normalizeUsageTimeZone(value: string | null | undefined): "local" | "utc" {
  return value === "utc" ? "utc" : "local";
}

function resolveUsageSelectedSessionKey(
  host: Pick<SettingsHost, "usageSelectedSessions">,
): string | null {
  const selected = host.usageSelectedSessions ?? [];
  return selected.length === 1 ? trimQueryValue(selected[0]) : null;
}

function normalizeBooleanQuery(value: string | null | undefined, fallback: boolean): boolean {
  if (value == null) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  return fallback;
}

type SettingsNavigationTab =
  | "config"
  | "communications"
  | "appearance"
  | "automation"
  | "infrastructure"
  | "aiAgents";

type SettingsFormMode = "form" | "raw";

type SettingsNavigationBinding = {
  tab: SettingsNavigationTab;
  modeParam: string;
  queryParam: string;
  sectionParam: string;
  subsectionParam: string;
  modeProp: string;
  queryProp: string;
  sectionProp: string;
  subsectionProp: string;
};

const SETTINGS_NAVIGATION_BINDINGS: readonly SettingsNavigationBinding[] = [
  {
    tab: "config",
    modeParam: "configMode",
    queryParam: "configQ",
    sectionParam: "configSection",
    subsectionParam: "configSubsection",
    modeProp: "configFormMode",
    queryProp: "configSearchQuery",
    sectionProp: "configActiveSection",
    subsectionProp: "configActiveSubsection",
  },
  {
    tab: "communications",
    modeParam: "communicationsMode",
    queryParam: "communicationsQ",
    sectionParam: "communicationsSection",
    subsectionParam: "communicationsSubsection",
    modeProp: "communicationsFormMode",
    queryProp: "communicationsSearchQuery",
    sectionProp: "communicationsActiveSection",
    subsectionProp: "communicationsActiveSubsection",
  },
  {
    tab: "appearance",
    modeParam: "appearanceMode",
    queryParam: "appearanceQ",
    sectionParam: "appearanceSection",
    subsectionParam: "appearanceSubsection",
    modeProp: "appearanceFormMode",
    queryProp: "appearanceSearchQuery",
    sectionProp: "appearanceActiveSection",
    subsectionProp: "appearanceActiveSubsection",
  },
  {
    tab: "automation",
    modeParam: "automationMode",
    queryParam: "automationQ",
    sectionParam: "automationSection",
    subsectionParam: "automationSubsection",
    modeProp: "automationFormMode",
    queryProp: "automationSearchQuery",
    sectionProp: "automationActiveSection",
    subsectionProp: "automationActiveSubsection",
  },
  {
    tab: "infrastructure",
    modeParam: "infrastructureMode",
    queryParam: "infrastructureQ",
    sectionParam: "infrastructureSection",
    subsectionParam: "infrastructureSubsection",
    modeProp: "infrastructureFormMode",
    queryProp: "infrastructureSearchQuery",
    sectionProp: "infrastructureActiveSection",
    subsectionProp: "infrastructureActiveSubsection",
  },
  {
    tab: "aiAgents",
    modeParam: "aiAgentsMode",
    queryParam: "aiAgentsQ",
    sectionParam: "aiAgentsSection",
    subsectionParam: "aiAgentsSubsection",
    modeProp: "aiAgentsFormMode",
    queryProp: "aiAgentsSearchQuery",
    sectionProp: "aiAgentsActiveSection",
    subsectionProp: "aiAgentsActiveSubsection",
  },
];

function normalizeSettingsFormMode(
  value: string | null | undefined,
  fallback: SettingsFormMode,
): SettingsFormMode {
  return value === "raw" || value === "form" ? value : fallback;
}

function getSettingsNavigationBinding(tab: Tab): SettingsNavigationBinding | null {
  return SETTINGS_NAVIGATION_BINDINGS.find((binding) => binding.tab === tab) ?? null;
}

function applySettingsNavigationStateFromUrl(
  host: SettingsHost,
  pick: (key: string) => string | null,
) {
  const dynamicHost = host as unknown as Record<string, string | null | undefined>;
  for (const binding of SETTINGS_NAVIGATION_BINDINGS) {
    dynamicHost[binding.modeProp] = normalizeSettingsFormMode(pick(binding.modeParam), "form");
    dynamicHost[binding.queryProp] = pick(binding.queryParam) ?? "";
    dynamicHost[binding.sectionProp] = pick(binding.sectionParam);
    dynamicHost[binding.subsectionProp] = dynamicHost[binding.sectionProp]
      ? pick(binding.subsectionParam)
      : null;
  }
}

function clearSettingsNavigationQueryState(url: URL) {
  for (const binding of SETTINGS_NAVIGATION_BINDINGS) {
    setQueryValue(url, binding.modeParam, null);
    setQueryValue(url, binding.queryParam, null);
    setQueryValue(url, binding.sectionParam, null);
    setQueryValue(url, binding.subsectionParam, null);
  }
}

function applySettingsNavigationStateToUrl(host: SettingsHost, tab: Tab, url: URL) {
  clearSettingsNavigationQueryState(url);
  const binding = getSettingsNavigationBinding(tab);
  if (!binding) {
    return;
  }
  const dynamicHost = host as unknown as Record<string, string | null | undefined>;
  const activeSection = dynamicHost[binding.sectionProp];
  setQueryValue(url, binding.modeParam, dynamicHost[binding.modeProp] ?? "form");
  setQueryValue(url, binding.queryParam, dynamicHost[binding.queryProp]);
  setQueryValue(url, binding.sectionParam, activeSection);
  setQueryValue(
    url,
    binding.subsectionParam,
    activeSection ? dynamicHost[binding.subsectionProp] : null,
  );
}

function normalizeSessionsSortColumn(
  value: string | null | undefined,
  fallback: "key" | "kind" | "updated" | "tokens",
): "key" | "kind" | "updated" | "tokens" {
  switch (value) {
    case "key":
    case "kind":
    case "updated":
    case "tokens":
      return value;
    default:
      return fallback;
  }
}

function normalizeSessionsSortDir(
  value: string | null | undefined,
  fallback: "asc" | "desc",
): "asc" | "desc" {
  return value === "asc" || value === "desc" ? value : fallback;
}

function normalizeNonNegativeInteger(value: string | null | undefined, fallback: number): number {
  if (value == null) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeSessionsPageSize(value: string | null | undefined, fallback: number): number {
  const parsed = normalizeNonNegativeInteger(value, fallback);
  return parsed === 10 || parsed === 25 || parsed === 50 || parsed === 100 ? parsed : fallback;
}

function normalizeCronJobsEnabledFilter(
  value: string | null | undefined,
  fallback: "all" | "enabled" | "disabled",
): "all" | "enabled" | "disabled" {
  switch (value) {
    case "all":
    case "enabled":
    case "disabled":
      return value;
    default:
      return fallback;
  }
}

function normalizeCronJobsScheduleKindFilter(
  value: string | null | undefined,
  fallback: "all" | "at" | "every" | "cron",
): "all" | "at" | "every" | "cron" {
  switch (value) {
    case "all":
    case "at":
    case "every":
    case "cron":
      return value;
    default:
      return fallback;
  }
}

function normalizeCronJobsLastStatusFilter(
  value: string | null | undefined,
  fallback: "all" | "ok" | "error" | "skipped",
): "all" | "ok" | "error" | "skipped" {
  switch (value) {
    case "all":
    case "ok":
    case "error":
    case "skipped":
      return value;
    default:
      return fallback;
  }
}

function normalizeCronJobsSortBy(
  value: string | null | undefined,
  fallback: "nextRunAtMs" | "updatedAtMs" | "name",
): "nextRunAtMs" | "updatedAtMs" | "name" {
  switch (value) {
    case "nextRunAtMs":
    case "updatedAtMs":
    case "name":
      return value;
    default:
      return fallback;
  }
}

function normalizeCronSortDir(
  value: string | null | undefined,
  fallback: "asc" | "desc",
): "asc" | "desc" {
  return value === "asc" || value === "desc" ? value : fallback;
}

const CRON_RUNS_STATUS_URL = new Set<CronRunsStatusValue>(["ok", "error", "skipped"]);
const CRON_RUNS_DELIVERY_URL = new Set<CronDeliveryStatus>([
  "delivered",
  "not-delivered",
  "unknown",
  "not-requested",
]);

function normalizeCronRunsScopeParam(value: string | null | undefined): CronRunScope | null {
  if (value === "job" || value === "all") {
    return value;
  }
  return null;
}

function parseCronRunsStatusesParam(raw: string | null | undefined): CronRunsStatusValue[] {
  const trimmed = trimQueryValue(raw);
  if (!trimmed) {
    return [];
  }
  const out: CronRunsStatusValue[] = [];
  for (const part of trimmed.split(",")) {
    const token = part.trim();
    if (token && CRON_RUNS_STATUS_URL.has(token as CronRunsStatusValue)) {
      out.push(token as CronRunsStatusValue);
    }
  }
  return out;
}

function parseCronRunsDeliveryParam(raw: string | null | undefined): CronDeliveryStatus[] {
  const trimmed = trimQueryValue(raw);
  if (!trimmed) {
    return [];
  }
  const out: CronDeliveryStatus[] = [];
  for (const part of trimmed.split(",")) {
    const token = part.trim();
    if (token && CRON_RUNS_DELIVERY_URL.has(token as CronDeliveryStatus)) {
      out.push(token as CronDeliveryStatus);
    }
  }
  return out;
}

function applyCronRunsStatusesToHost(
  host: Pick<SettingsHost, "cronRunsStatuses" | "cronRunsStatusFilter">,
  statuses: CronRunsStatusValue[],
) {
  host.cronRunsStatuses = statuses;
  host.cronRunsStatusFilter = statuses.length === 1 ? statuses[0] : "all";
}

function serializeCronRunsStatuses(host: SettingsHost): string | null {
  const list = host.cronRunsStatuses ?? [];
  if (list.length === 0) {
    return null;
  }
  return list.join(",");
}

function serializeCronRunsDelivery(host: SettingsHost): string | null {
  const list = host.cronRunsDeliveryStatuses ?? [];
  if (list.length === 0) {
    return null;
  }
  return list.join(",");
}

function setQueryValue(url: URL, key: string, value: string | null | undefined) {
  const trimmed = trimQueryValue(value);
  if (trimmed) {
    url.searchParams.set(key, trimmed);
    return;
  }
  url.searchParams.delete(key);
}

export function buildTabHref(
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

export function buildCanonicalTabHref(host: SettingsHost | AppViewState, tab: Tab): string {
  const url = new URL(`https://openclaw.local${pathForTab(tab, host.basePath)}`);
  applyTabQueryStateToUrl(host as SettingsHost, tab, url);
  return `${url.pathname}${url.search}`;
}

function applyDeepLinkStateFromUrl(
  host: SettingsHost,
  sources: { params: URLSearchParams; hashParams: URLSearchParams },
) {
  const pick = (key: string) =>
    trimQueryValue(sources.params.get(key) ?? sources.hashParams.get(key));
  host.agentsSelectedId = pick("agent");
  host.agentsPanel = normalizeAgentsPanel(pick("agentsPanel"));
  host.agentFileActive = host.agentsPanel === "files" ? pick("agentFile") : null;
  host.bootstrapFilterQuery = pick("bootstrapQ") ?? host.bootstrapFilterQuery ?? "";
  host.bootstrapSelectedId = pick("bootstrapRequest");
  host.artifactsFilterQuery = pick("artifactQ") ?? host.artifactsFilterQuery ?? "";
  host.artifactsSelectedId = pick("artifact");
  host.channelsSelectedKey = pick("channel");
  host.instancesReveal = normalizeBooleanQuery(
    pick("instancesReveal"),
    host.instancesReveal ?? false,
  );
  host.runtimeSessionKey = pick("runtimeSession");
  host.runtimeRunId = pick("runtimeRun");
  host.runtimeSelectedCheckpointId = pick("checkpoint");
  host.runtimeSelectedActionId = pick("runtimeAction");
  host.runtimeSelectedClosureRunId = pick("runtimeClosure");
  host.sessionsFilterActive = pick("sessionsActive") ?? host.sessionsFilterActive ?? "";
  host.sessionsFilterLimit = pick("sessionsLimit") ?? host.sessionsFilterLimit ?? "120";
  host.sessionsIncludeGlobal = normalizeBooleanQuery(
    pick("sessionsGlobal"),
    host.sessionsIncludeGlobal ?? true,
  );
  host.sessionsIncludeUnknown = normalizeBooleanQuery(
    pick("sessionsUnknown"),
    host.sessionsIncludeUnknown ?? false,
  );
  host.sessionsSearchQuery = pick("sessionsQ") ?? host.sessionsSearchQuery ?? "";
  host.sessionsSortColumn = normalizeSessionsSortColumn(
    pick("sessionsSort"),
    host.sessionsSortColumn ?? "updated",
  );
  host.sessionsSortDir = normalizeSessionsSortDir(
    pick("sessionsDir"),
    host.sessionsSortDir ?? "desc",
  );
  host.sessionsPage = normalizeNonNegativeInteger(pick("sessionsPage"), host.sessionsPage ?? 0);
  host.sessionsPageSize = normalizeSessionsPageSize(
    pick("sessionsPageSize"),
    host.sessionsPageSize ?? 25,
  );
  host.cronJobsQuery = pick("cronQ") ?? host.cronJobsQuery ?? "";
  host.cronJobsEnabledFilter = normalizeCronJobsEnabledFilter(
    pick("cronEnabled"),
    host.cronJobsEnabledFilter ?? "all",
  );
  host.cronJobsScheduleKindFilter = normalizeCronJobsScheduleKindFilter(
    pick("cronSchedule"),
    host.cronJobsScheduleKindFilter ?? "all",
  );
  host.cronJobsLastStatusFilter = normalizeCronJobsLastStatusFilter(
    pick("cronStatus"),
    host.cronJobsLastStatusFilter ?? "all",
  );
  host.cronJobsSortBy = normalizeCronJobsSortBy(
    pick("cronSort"),
    host.cronJobsSortBy ?? "nextRunAtMs",
  );
  host.cronJobsSortDir = normalizeCronSortDir(pick("cronDir"), host.cronJobsSortDir ?? "asc");
  const cronJobPick = pick("cronJob");
  const scopeParam = normalizeCronRunsScopeParam(pick("cronRunsScope"));
  let resolvedScope: CronRunScope = scopeParam ?? (cronJobPick ? "job" : "all");
  if (resolvedScope === "job" && !cronJobPick) {
    resolvedScope = "all";
  }
  host.cronRunsScope = resolvedScope;
  host.cronRunsJobId = resolvedScope === "job" ? cronJobPick : null;
  host.cronRunsQuery = pick("cronRunsQ") ?? "";
  host.cronRunsSortDir = normalizeCronSortDir(pick("cronRunsSort"), host.cronRunsSortDir ?? "desc");
  const parsedStatuses = parseCronRunsStatusesParam(pick("cronRunsStatus"));
  const parsedDelivery = parseCronRunsDeliveryParam(pick("cronRunsDelivery"));
  applyCronRunsStatusesToHost(host, parsedStatuses);
  host.cronRunsDeliveryStatuses = parsedDelivery;
  host.usageStartDate = pick("usageFrom") ?? todayUsageDate();
  host.usageEndDate = pick("usageTo") ?? todayUsageDate();
  host.usageTimeZone = normalizeUsageTimeZone(pick("usageTz"));
  const usageSelectedSession = pick("usageSession");
  host.usageSelectedSessions = usageSelectedSession ? [usageSelectedSession] : [];
  host.usageQuery = pick("usageQ") ?? "";
  host.usageQueryDraft = host.usageQuery;
  host.skillsFilter = pick("skillFilter") ?? "";
  applySettingsNavigationStateFromUrl(host, pick);
  host.debugCallMethod = pick("debugMethod") ?? host.debugCallMethod ?? "";
  host.debugCallParams = normalizeDebugCallParams(
    pick("debugParams"),
    host.debugCallParams ?? "{}",
  );
  host.logsFilterText = pick("logQ") ?? "";
  host.execApprovalsTarget = normalizeExecApprovalsTarget(pick("execTarget"));
  host.execApprovalsTargetNodeId = host.execApprovalsTarget === "node" ? pick("execNode") : null;
  host.execApprovalsSelectedAgent = pick("execAgent");
}

function applyTabQueryStateToUrl(host: SettingsHost, tab: Tab, url: URL) {
  setQueryValue(url, "session", host.sessionKey);
  setQueryValue(url, "agent", null);
  setQueryValue(url, "agentsPanel", null);
  setQueryValue(url, "agentFile", null);
  setQueryValue(url, "bootstrapQ", null);
  setQueryValue(url, "bootstrapRequest", null);
  setQueryValue(url, "artifactQ", null);
  setQueryValue(url, "artifact", null);
  setQueryValue(url, "channel", null);
  setQueryValue(url, "instancesReveal", null);
  setQueryValue(url, "runtimeSession", null);
  setQueryValue(url, "runtimeRun", null);
  setQueryValue(url, "checkpoint", null);
  setQueryValue(url, "runtimeAction", null);
  setQueryValue(url, "runtimeClosure", null);
  setQueryValue(url, "sessionsActive", null);
  setQueryValue(url, "sessionsLimit", null);
  setQueryValue(url, "sessionsGlobal", null);
  setQueryValue(url, "sessionsUnknown", null);
  setQueryValue(url, "sessionsQ", null);
  setQueryValue(url, "sessionsSort", null);
  setQueryValue(url, "sessionsDir", null);
  setQueryValue(url, "sessionsPage", null);
  setQueryValue(url, "sessionsPageSize", null);
  setQueryValue(url, "cronQ", null);
  setQueryValue(url, "cronEnabled", null);
  setQueryValue(url, "cronSchedule", null);
  setQueryValue(url, "cronStatus", null);
  setQueryValue(url, "cronSort", null);
  setQueryValue(url, "cronDir", null);
  setQueryValue(url, "cronJob", null);
  setQueryValue(url, "cronRunsScope", null);
  setQueryValue(url, "cronRunsQ", null);
  setQueryValue(url, "cronRunsSort", null);
  setQueryValue(url, "cronRunsStatus", null);
  setQueryValue(url, "cronRunsDelivery", null);
  setQueryValue(url, "usageFrom", null);
  setQueryValue(url, "usageTo", null);
  setQueryValue(url, "usageTz", null);
  setQueryValue(url, "usageSession", null);
  setQueryValue(url, "usageQ", null);
  setQueryValue(url, "skillFilter", null);
  clearSettingsNavigationQueryState(url);
  setQueryValue(url, "debugMethod", null);
  setQueryValue(url, "debugParams", null);
  setQueryValue(url, "logQ", null);
  setQueryValue(url, "execTarget", null);
  setQueryValue(url, "execNode", null);
  setQueryValue(url, "execAgent", null);
  if (tab === "agents") {
    setQueryValue(url, "agent", host.agentsSelectedId);
    setQueryValue(url, "agentsPanel", host.agentsPanel ?? "overview");
    if (host.agentsPanel === "files") {
      setQueryValue(url, "agentFile", host.agentFileActive);
    }
    if (host.agentsPanel === "skills") {
      setQueryValue(url, "skillFilter", host.skillsFilter);
    }
  }
  if (tab === "bootstrap") {
    setQueryValue(url, "bootstrapQ", host.bootstrapFilterQuery);
    setQueryValue(url, "bootstrapRequest", host.bootstrapSelectedId);
  }
  if (tab === "artifacts") {
    setQueryValue(url, "artifactQ", host.artifactsFilterQuery);
    setQueryValue(url, "artifact", host.artifactsSelectedId);
  }
  if (tab === "channels") {
    setQueryValue(url, "channel", host.channelsSelectedKey);
  }
  if (tab === "instances") {
    setQueryValue(url, "instancesReveal", host.instancesReveal ? "true" : null);
  }
  if (tab === "sessions") {
    setQueryValue(url, "sessionsActive", host.sessionsFilterActive);
    setQueryValue(url, "sessionsLimit", host.sessionsFilterLimit);
    setQueryValue(url, "sessionsGlobal", String(host.sessionsIncludeGlobal ?? true));
    setQueryValue(url, "sessionsUnknown", String(host.sessionsIncludeUnknown ?? false));
    setQueryValue(url, "sessionsQ", host.sessionsSearchQuery);
    setQueryValue(url, "sessionsSort", host.sessionsSortColumn);
    setQueryValue(url, "sessionsDir", host.sessionsSortDir);
    setQueryValue(url, "sessionsPage", String(host.sessionsPage ?? 0));
    setQueryValue(url, "sessionsPageSize", String(host.sessionsPageSize ?? 25));
    setQueryValue(url, "runtimeSession", host.runtimeSessionKey);
    setQueryValue(url, "runtimeRun", host.runtimeRunId);
    setQueryValue(url, "checkpoint", host.runtimeSelectedCheckpointId);
    setQueryValue(url, "runtimeAction", host.runtimeSelectedActionId);
    setQueryValue(url, "runtimeClosure", host.runtimeSelectedClosureRunId);
  }
  if (tab === "cron") {
    setQueryValue(url, "cronQ", host.cronJobsQuery);
    setQueryValue(url, "cronEnabled", host.cronJobsEnabledFilter);
    setQueryValue(url, "cronSchedule", host.cronJobsScheduleKindFilter);
    setQueryValue(url, "cronStatus", host.cronJobsLastStatusFilter);
    setQueryValue(url, "cronSort", host.cronJobsSortBy);
    setQueryValue(url, "cronDir", host.cronJobsSortDir);
    if (host.cronRunsScope === "job") {
      setQueryValue(url, "cronRunsScope", "job");
      setQueryValue(url, "cronJob", host.cronRunsJobId);
    } else {
      setQueryValue(url, "cronRunsScope", "all");
    }
    setQueryValue(url, "cronRunsQ", host.cronRunsQuery?.trim() ? host.cronRunsQuery : null);
    if (host.cronRunsSortDir && host.cronRunsSortDir !== "desc") {
      setQueryValue(url, "cronRunsSort", host.cronRunsSortDir);
    }
    setQueryValue(url, "cronRunsStatus", serializeCronRunsStatuses(host));
    setQueryValue(url, "cronRunsDelivery", serializeCronRunsDelivery(host));
  }
  if (tab === "usage") {
    setQueryValue(url, "usageFrom", host.usageStartDate);
    setQueryValue(url, "usageTo", host.usageEndDate);
    setQueryValue(url, "usageTz", host.usageTimeZone);
    setQueryValue(url, "usageSession", resolveUsageSelectedSessionKey(host));
    setQueryValue(url, "usageQ", host.usageQuery);
  }
  if (tab === "skills") {
    setQueryValue(url, "skillFilter", host.skillsFilter);
  }
  applySettingsNavigationStateToUrl(host, tab, url);
  if (tab === "debug") {
    setQueryValue(url, "debugMethod", trimQueryValue(host.debugCallMethod));
    const debugParams = trimQueryValue(host.debugCallParams);
    setQueryValue(url, "debugParams", debugParams && debugParams !== "{}" ? debugParams : null);
  }
  if (tab === "logs") {
    setQueryValue(url, "logQ", host.logsFilterText);
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
    const usageSessionKey = resolveUsageSelectedSessionKey(host);
    if (!usageSessionKey) {
      host.usageTimeSeries = null;
      host.usageSessionLogs = null;
    } else if (host.usageResult?.sessions?.some((entry) => entry.key === usageSessionKey)) {
      await Promise.allSettled([
        loadSessionTimeSeries(host as unknown as OpenClawApp, usageSessionKey),
        loadSessionLogs(host as unknown as OpenClawApp, usageSessionKey),
      ]);
    } else {
      host.usageSelectedSessions = [];
      host.usageTimeSeries = null;
      host.usageSessionLogs = null;
      syncUrlWithTab(host, "usage", true);
    }
  }
  if (host.tab === "sessions") {
    const urlRuntimeAction =
      typeof window !== "undefined"
        ? trimQueryValue(new URL(window.location.href).searchParams.get("runtimeAction"))
        : null;
    const urlRuntimeClosure =
      typeof window !== "undefined"
        ? trimQueryValue(new URL(window.location.href).searchParams.get("runtimeClosure"))
        : null;
    await Promise.allSettled([
      loadSessions(host as unknown as OpenClawApp),
      loadRuntimeInspector(host as unknown as OpenClawApp),
    ]);
    const totalRows =
      typeof host.sessionsResult?.count === "number"
        ? host.sessionsResult.count
        : (host.sessionsResult?.sessions?.length ?? 0);
    const pageSize = host.sessionsPageSize ?? 25;
    const maxPage = Math.max(0, Math.ceil(totalRows / pageSize) - 1);
    if ((host.sessionsPage ?? 0) > maxPage) {
      host.sessionsPage = maxPage;
      syncUrlWithTab(host, "sessions", true);
      return;
    }
    if (
      (urlRuntimeAction != null &&
        urlRuntimeAction !== (trimQueryValue(host.runtimeSelectedActionId) ?? null)) ||
      (urlRuntimeClosure != null &&
        urlRuntimeClosure !== (trimQueryValue(host.runtimeSelectedClosureRunId) ?? null))
    ) {
      syncUrlWithTab(host, "sessions", true);
    }
  }
  if (host.tab === "cron") {
    await loadCron(host);
    const app = host as unknown as OpenClawApp;
    if (
      app.cronRunsScope === "job" &&
      app.cronRunsJobId &&
      !app.cronJobs.some((j) => j.id === app.cronRunsJobId)
    ) {
      app.cronRunsScope = "all";
      app.cronRunsJobId = null;
      await loadCronRuns(app, null);
      syncUrlWithTab(host, "cron", true);
    }
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
      if (host.agentsPanel === "files") {
        const previousFile = host.agentFileActive ?? null;
        await loadAgentFiles(host as unknown as OpenClawApp, agentId);
        if (host.agentFileActive) {
          void loadAgentFileContent(host as unknown as OpenClawApp, agentId, host.agentFileActive);
        }
        if (previousFile !== host.agentFileActive) {
          syncUrlWithTab(host, "agents", true);
        }
      }
      if (host.agentsPanel === "tools") {
        void loadToolsCatalog(host as unknown as OpenClawApp, agentId);
      }
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

export function syncUrlWithTab(host: SettingsHost | AppViewState, tab: Tab, replace: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  const settingsHost = host as SettingsHost;
  const targetPath = normalizePath(pathForTab(tab, settingsHost.basePath));
  const currentPath = normalizePath(window.location.pathname);
  const url = new URL(window.location.href);

  if (tab === "chat" && settingsHost.sessionKey) {
    url.searchParams.set("session", settingsHost.sessionKey);
  }
  applyTabQueryStateToUrl(settingsHost, tab, url);

  if (currentPath !== targetPath) {
    url.pathname = targetPath;
  }

  if (replace) {
    window.history.replaceState({}, "", url.toString());
  } else {
    window.history.pushState({}, "", url.toString());
  }
}

export function syncUrlWithSessionKey(
  host: SettingsHost | AppViewState,
  sessionKey: string,
  replace: boolean,
) {
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
  const activeSession = app.sessionsResult?.sessions.find(
    (session) => session.key === app.sessionKey,
  );
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
      href: buildTabHref(host, "logs", {
        session: host.sessionKey,
      }),
      actionLabel: "Open",
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

  const activeSession = host.sessionsResult?.sessions.find(
    (session) => session.key === host.sessionKey,
  );
  const activeRunId = resolveSessionRuntimeInspectRunId(activeSession);
  const fallbackCheckpoint =
    host.runtimeCheckpoints.find((checkpoint) => checkpoint.sessionKey === host.sessionKey) ?? null;
  const scopedCheckpoint =
    host.runtimeCheckpointDetail &&
    matchesRuntimeScope(host.runtimeCheckpointDetail, host.sessionKey, activeRunId)
      ? host.runtimeCheckpointDetail
      : (host.runtimeCheckpoints.find((checkpoint) =>
          matchesRuntimeScope(checkpoint, host.sessionKey, activeRunId),
        ) ?? fallbackCheckpoint);
  const recoveryDescription =
    activeSession?.recoveryOperatorHint ??
    scopedCheckpoint?.operatorHint ??
    activeSession?.recoveryBlockedReason ??
    scopedCheckpoint?.blockedReason ??
    null;
  if (recoveryDescription && (activeSession?.recoveryStatus || scopedCheckpoint?.status)) {
    items.push({
      severity: resolveRecoveryAttentionSeverity(
        activeSession?.recoveryStatus ?? scopedCheckpoint?.status,
      ),
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
      description:
        scopedCheckpoint.operatorHint ?? "Open the linked artifact and review the transition.",
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
      ? {
          execTarget: "node",
          execNode: primaryApproval.request.nodeId,
          execAgent: primaryApproval.request.agentId,
        }
      : {
          execTarget: "gateway",
          execNode: null,
          execAgent: primaryApproval?.request.agentId ?? null,
        };
    items.push({
      severity: "warning",
      icon: "shield",
      title: `${execApprovalQueue.length} exec approval${execApprovalQueue.length > 1 ? "s" : ""} pending`,
      description:
        primaryApproval?.request.blockedReason ??
        primaryApproval?.request.command ??
        "Operator review is required before execution can continue.",
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
    const failedCronJobId = (failedCron[0] as { id?: string | null } | undefined)?.id ?? null;
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
    const overdueCronJobId = (overdue[0] as { id?: string | null } | undefined)?.id ?? null;
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
