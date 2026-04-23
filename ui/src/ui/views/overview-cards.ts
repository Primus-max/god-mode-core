import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { t } from "../../i18n/index.ts";
import { formatCost, formatTokens, formatRelativeTimestamp } from "../format.ts";
import type { Tab } from "../navigation.ts";
import { formatNextRun } from "../presenter.ts";
import { SKILL_FILTER_BLOCKED, SKILL_FILTER_MISSING } from "../skills-correlation.ts";
import type {
  SessionsUsageResult,
  SessionsListResult,
  SkillStatusReport,
  CronJob,
  CronStatus,
} from "../types.ts";

type OverviewCardNavigateOptions = {
  skillFilter?: string;
};

/**
 * Tabs reachable from overview cards. Pinned to a Tab subset so callers in
 * `overview.ts` can stay narrowly-typed and we don't accept arbitrary Tabs
 * just because the function shape would allow them (avoids contravariant
 * function-type drift between overview.ts and overview-cards.ts).
 */
type OverviewCardTab = Extract<Tab, "usage" | "sessions" | "skills" | "cron">;

export type OverviewCardsProps = {
  usageResult: SessionsUsageResult | null;
  sessionsResult: SessionsListResult | null;
  skillsReport: SkillStatusReport | null;
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  presenceCount: number;
  buildHref: (tab: OverviewCardTab, options?: OverviewCardNavigateOptions) => string;
  buildChatHref: (sessionKey: string) => string;
  onNavigate: (tab: OverviewCardTab, options?: OverviewCardNavigateOptions) => void;
  onNavigateToChat: (sessionKey: string) => void;
};

const DIGIT_RUN = /\d{3,}/g;

function blurDigits(value: string): TemplateResult {
  const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const blurred = escaped.replace(DIGIT_RUN, (m) => `<span class="blur-digits">${m}</span>`);
  return html`${unsafeHTML(blurred)}`;
}

type StatCard = {
  kind: string;
  tab: OverviewCardTab;
  label: string;
  value: string | TemplateResult;
  hint: string | TemplateResult;
  href: string;
  navigateOptions?: OverviewCardNavigateOptions;
};

function renderStatCard(
  card: StatCard,
  onNavigate: (tab: OverviewCardTab, options?: OverviewCardNavigateOptions) => void,
) {
  return html`
    <a
      href=${card.href}
      class="ov-card"
      data-kind=${card.kind}
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        onNavigate(card.tab, card.navigateOptions);
      }}
    >
      <span class="ov-card__label">${card.label}</span>
      <span class="ov-card__value">${card.value}</span>
      <span class="ov-card__hint">${card.hint}</span>
    </a>
  `;
}

function renderRecentSessionRow(
  session: NonNullable<SessionsListResult>["sessions"][number],
  buildChatHref: (sessionKey: string) => string,
  onNavigateToChat: (sessionKey: string) => void,
) {
  return html`
    <li>
      <a
        href=${buildChatHref(session.key)}
        class="ov-recent__row"
        data-session-key=${session.key}
        @click=${(event: MouseEvent) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          event.preventDefault();
          onNavigateToChat(session.key);
        }}
      >
        <span class="ov-recent__key">${blurDigits(session.displayName || session.label || session.key)}</span>
        <span class="ov-recent__model">${session.model ?? ""}</span>
        <span class="ov-recent__time">${session.updatedAt ? formatRelativeTimestamp(session.updatedAt) : ""}</span>
      </a>
    </li>
  `;
}

function renderSkeletonCards() {
  return html`
    <section class="ov-cards">
      ${[0, 1, 2, 3].map(
        (i) => html`
          <div class="ov-card" style="cursor:default;animation-delay:${i * 50}ms">
            <span class="skeleton skeleton-line" style="width:60px;height:10px"></span>
            <span class="skeleton skeleton-stat"></span>
            <span class="skeleton skeleton-line skeleton-line--medium" style="height:12px"></span>
          </div>
        `,
      )}
    </section>
  `;
}

export function renderOverviewCards(props: OverviewCardsProps) {
  const dataLoaded =
    props.usageResult != null || props.sessionsResult != null || props.skillsReport != null;
  if (!dataLoaded) {
    return renderSkeletonCards();
  }

  const totals = props.usageResult?.totals;
  const totalCost = formatCost(totals?.totalCost);
  const totalTokens = formatTokens(totals?.totalTokens);
  const totalMessages = totals ? String(props.usageResult?.aggregates?.messages?.total ?? 0) : "0";
  const sessionCount = props.sessionsResult?.count ?? null;

  const skills = props.skillsReport?.skills ?? [];
  const enabledSkills = skills.filter((s) => !s.disabled).length;
  const blockedSkills = skills.filter((s) => s.blockedByAllowlist).length;
  const skillsMissingCount = skills.filter(
    (s) =>
      s.missing.bins.length > 0 ||
      s.missing.env.length > 0 ||
      s.missing.config.length > 0 ||
      s.missing.os.length > 0,
  ).length;
  const totalSkills = skills.length;

  const cronEnabled = props.cronStatus?.enabled ?? null;
  const cronNext = props.cronStatus?.nextWakeAtMs ?? null;
  const cronJobCount = props.cronJobs.length;
  const failedCronCount = props.cronJobs.filter((j) => j.state?.lastStatus === "error").length;

  const cronValue =
    cronEnabled == null
      ? t("common.na")
      : cronEnabled
        ? t("overview.cardMetrics.cronJobs", { count: String(cronJobCount) })
        : t("common.disabled");

  const cronHint =
    failedCronCount > 0
      ? html`<span class="danger">${t("overview.cardMetrics.cronFailed", { count: String(failedCronCount) })}</span>`
      : cronNext
        ? t("overview.stats.cronNext", { time: formatNextRun(cronNext) })
        : "";

  const cards: StatCard[] = [
    {
      kind: "cost",
      tab: "usage",
      href: props.buildHref("usage"),
      label: t("overview.cards.cost"),
      value: totalCost,
      hint: t("overview.cardMetrics.costHint", { tokens: totalTokens, msgs: totalMessages }),
    },
    {
      kind: "sessions",
      tab: "sessions",
      href: props.buildHref("sessions"),
      label: t("overview.stats.sessions"),
      value: String(sessionCount ?? t("common.na")),
      hint: t("overview.stats.sessionsHint"),
    },
    {
      kind: "skills",
      tab: "skills",
      href: props.buildHref(
        "skills",
        blockedSkills > 0
          ? { skillFilter: SKILL_FILTER_BLOCKED }
          : skillsMissingCount > 0
            ? { skillFilter: SKILL_FILTER_MISSING }
            : undefined,
      ),
      label: t("overview.cards.skills"),
      value: `${enabledSkills}/${totalSkills}`,
      hint:
        blockedSkills > 0
          ? t("overview.cardMetrics.skillsBlocked", { count: String(blockedSkills) })
          : t("overview.cardMetrics.skillsActive", { count: String(enabledSkills) }),
      navigateOptions:
        blockedSkills > 0
          ? { skillFilter: SKILL_FILTER_BLOCKED }
          : skillsMissingCount > 0
            ? { skillFilter: SKILL_FILTER_MISSING }
            : undefined,
    },
    {
      kind: "cron",
      tab: "cron",
      href: props.buildHref("cron"),
      label: t("overview.stats.cron"),
      value: cronValue,
      hint: cronHint,
    },
  ];

  const sessions = props.sessionsResult?.sessions.slice(0, 5) ?? [];

  return html`
    <section class="ov-cards">
      ${cards.map((c) => renderStatCard(c, props.onNavigate))}
    </section>

    ${
      sessions.length > 0
        ? html`
        <section class="ov-recent">
          <h3 class="ov-recent__title">${t("overview.cards.recentSessions")}</h3>
          <ul class="ov-recent__list">
            ${sessions.map(
              (s) => renderRecentSessionRow(s, props.buildChatHref, props.onNavigateToChat),
            )}
          </ul>
        </section>
      `
        : nothing
    }
  `;
}
