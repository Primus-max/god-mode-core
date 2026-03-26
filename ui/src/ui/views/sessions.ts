import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import { pathForTab } from "../navigation.ts";
import { formatSessionTokens } from "../presenter.ts";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";

export type SessionsProps = {
  loading: boolean;
  result: SessionsListResult | null;
  error: string | null;
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  basePath: string;
  searchQuery: string;
  sortColumn: "key" | "kind" | "updated" | "tokens";
  sortDir: "asc" | "desc";
  page: number;
  pageSize: number;
  selectedKeys: Set<string>;
  onFiltersChange: (next: {
    activeMinutes: string;
    limit: string;
    includeGlobal: boolean;
    includeUnknown: boolean;
  }) => void;
  onSearchChange: (query: string) => void;
  onSortChange: (column: "key" | "kind" | "updated" | "tokens", dir: "asc" | "desc") => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onRefresh: () => void;
  onPatch: (
    key: string,
    patch: {
      label?: string | null;
      thinkingLevel?: string | null;
      fastMode?: boolean | null;
      verboseLevel?: string | null;
      reasoningLevel?: string | null;
    },
  ) => void;
  onToggleSelect: (key: string) => void;
  onSelectPage: (keys: string[]) => void;
  onDeselectPage: (keys: string[]) => void;
  onDeselectAll: () => void;
  onDeleteSelected: () => void;
  onNavigateToChat?: (sessionKey: string) => void;
};

const THINK_LEVELS = ["", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
const BINARY_THINK_LEVELS = ["", "off", "on"] as const;
const REASONING_LEVELS = ["", "off", "on", "stream"] as const;
const PAGE_SIZES = [10, 25, 50, 100] as const;

function buildVerboseLevels(): Array<{ value: string; label: string }> {
  return [
    { value: "", label: t("sessions.table.inherit") },
    { value: "off", label: t("sessions.verboseLevels.offExplicit") },
    { value: "on", label: t("sessions.verboseLevels.on") },
    { value: "full", label: t("sessions.verboseLevels.full") },
  ];
}

function buildFastLevels(): Array<{ value: string; label: string }> {
  return [
    { value: "", label: t("sessions.table.inherit") },
    { value: "on", label: t("sessions.fastLevels.on") },
    { value: "off", label: t("sessions.fastLevels.off") },
  ];
}

function thinkLevelOptionLabel(level: string, isBinary: boolean): string {
  if (!level) {
    return t("sessions.table.inherit");
  }
  if (isBinary) {
    if (level === "on") {
      return t("sessions.fastLevels.on");
    }
    if (level === "off") {
      return t("sessions.fastLevels.off");
    }
  }
  return level;
}

function normalizeProviderId(provider?: string | null): string {
  if (!provider) {
    return "";
  }
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  return normalized;
}

function isBinaryThinkingProvider(provider?: string | null): boolean {
  return normalizeProviderId(provider) === "zai";
}

function resolveThinkLevelOptions(provider?: string | null): readonly string[] {
  return isBinaryThinkingProvider(provider) ? BINARY_THINK_LEVELS : THINK_LEVELS;
}

function withCurrentOption(options: readonly string[], current: string): string[] {
  if (!current) {
    return [...options];
  }
  if (options.includes(current)) {
    return [...options];
  }
  return [...options, current];
}

function withCurrentLabeledOption(
  options: readonly { value: string; label: string }[],
  current: string,
): Array<{ value: string; label: string }> {
  if (!current) {
    return [...options];
  }
  if (options.some((option) => option.value === current)) {
    return [...options];
  }
  return [...options, { value: current, label: t("sessions.table.custom", { value: current }) }];
}

function resolveThinkLevelDisplay(value: string, isBinary: boolean): string {
  if (!isBinary) {
    return value;
  }
  if (!value || value === "off") {
    return value;
  }
  return "on";
}

function resolveThinkLevelPatchValue(value: string, isBinary: boolean): string | null {
  if (!value) {
    return null;
  }
  if (!isBinary) {
    return value;
  }
  if (value === "on") {
    return "low";
  }
  return value;
}

function filterRows(rows: GatewaySessionRow[], query: string): GatewaySessionRow[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return rows;
  }
  return rows.filter((row) => {
    const key = (row.key ?? "").toLowerCase();
    const label = (row.label ?? "").toLowerCase();
    const kind = (row.kind ?? "").toLowerCase();
    const displayName = (row.displayName ?? "").toLowerCase();
    return key.includes(q) || label.includes(q) || kind.includes(q) || displayName.includes(q);
  });
}

function sortRows(
  rows: GatewaySessionRow[],
  column: "key" | "kind" | "updated" | "tokens",
  dir: "asc" | "desc",
): GatewaySessionRow[] {
  const cmp = dir === "asc" ? 1 : -1;
  return [...rows].toSorted((a, b) => {
    let diff = 0;
    switch (column) {
      case "key":
        diff = (a.key ?? "").localeCompare(b.key ?? "");
        break;
      case "kind":
        diff = (a.kind ?? "").localeCompare(b.kind ?? "");
        break;
      case "updated": {
        const au = a.updatedAt ?? 0;
        const bu = b.updatedAt ?? 0;
        diff = au - bu;
        break;
      }
      case "tokens": {
        const at = a.totalTokens ?? a.inputTokens ?? a.outputTokens ?? 0;
        const bt = b.totalTokens ?? b.inputTokens ?? b.outputTokens ?? 0;
        diff = at - bt;
        break;
      }
    }
    return diff * cmp;
  });
}

function paginateRows<T>(rows: T[], page: number, pageSize: number): T[] {
  const start = page * pageSize;
  return rows.slice(start, start + pageSize);
}

export function renderSessions(props: SessionsProps) {
  const rawRows = props.result?.sessions ?? [];
  const filtered = filterRows(rawRows, props.searchQuery);
  const sorted = sortRows(filtered, props.sortColumn, props.sortDir);
  const totalRows = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / props.pageSize));
  const page = Math.min(props.page, totalPages - 1);
  const paginated = paginateRows(sorted, page, props.pageSize);

  const sortHeader = (
    col: "key" | "kind" | "updated" | "tokens",
    label: string,
    extraClass = "",
  ) => {
    const isActive = props.sortColumn === col;
    const nextDir = isActive && props.sortDir === "asc" ? ("desc" as const) : ("asc" as const);
    return html`
      <th
        class=${extraClass}
        data-sortable
        data-sort-dir=${isActive ? props.sortDir : ""}
        @click=${() => props.onSortChange(col, isActive ? nextDir : "desc")}
      >
        ${label}
        <span class="data-table-sort-icon">${icons.arrowUpDown}</span>
      </th>
    `;
  };

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; margin-bottom: 12px;">
        <div>
          <div class="card-title">${t("sessions.title")}</div>
          <div class="card-sub">${
            props.result ? t("sessions.store", { path: props.result.path }) : t("sessions.subtitle")
          }</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("sessions.state.loading") : t("common.refresh")}
        </button>
      </div>

      <div class="filters" style="margin-bottom: 12px;">
        <label class="field-inline">
          <span>${t("sessions.filters.active")}</span>
          <input
            style="width: 72px;"
            placeholder=${t("sessions.filters.minPlaceholder")}
            .value=${props.activeMinutes}
            @input=${(e: Event) =>
              props.onFiltersChange({
                activeMinutes: (e.target as HTMLInputElement).value,
                limit: props.limit,
                includeGlobal: props.includeGlobal,
                includeUnknown: props.includeUnknown,
              })}
          />
        </label>
        <label class="field-inline">
          <span>${t("sessions.filters.limit")}</span>
          <input
            style="width: 64px;"
            .value=${props.limit}
            @input=${(e: Event) =>
              props.onFiltersChange({
                activeMinutes: props.activeMinutes,
                limit: (e.target as HTMLInputElement).value,
                includeGlobal: props.includeGlobal,
                includeUnknown: props.includeUnknown,
              })}
          />
        </label>
        <label class="field-inline checkbox">
          <input
            type="checkbox"
            .checked=${props.includeGlobal}
            @change=${(e: Event) =>
              props.onFiltersChange({
                activeMinutes: props.activeMinutes,
                limit: props.limit,
                includeGlobal: (e.target as HTMLInputElement).checked,
                includeUnknown: props.includeUnknown,
              })}
          />
          <span>${t("sessions.filters.global")}</span>
        </label>
        <label class="field-inline checkbox">
          <input
            type="checkbox"
            .checked=${props.includeUnknown}
            @change=${(e: Event) =>
              props.onFiltersChange({
                activeMinutes: props.activeMinutes,
                limit: props.limit,
                includeGlobal: props.includeGlobal,
                includeUnknown: (e.target as HTMLInputElement).checked,
              })}
          />
          <span>${t("sessions.filters.unknown")}</span>
        </label>
      </div>

      ${
        props.error
          ? html`<div class="callout danger" style="margin-bottom: 12px;">${props.error}</div>`
          : nothing
      }

      <div class="data-table-wrapper">
        <div class="data-table-toolbar">
          <div class="data-table-search">
            <input
              type="text"
              placeholder=${t("sessions.filters.searchPlaceholder")}
              .value=${props.searchQuery}
              @input=${(e: Event) => props.onSearchChange((e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        ${
          props.selectedKeys.size > 0
            ? html`
                <div class="data-table-bulk-bar">
                  <span>${t("sessions.bulk.selected", { count: String(props.selectedKeys.size) })}</span>
                  <button
                    class="btn btn--sm"
                    @click=${props.onDeselectAll}
                  >
                    ${t("sessions.bulk.clear")}
                  </button>
                  <button
                    class="btn btn--sm danger"
                    ?disabled=${props.loading}
                    @click=${props.onDeleteSelected}
                  >
                    ${icons.trash} ${t("sessions.bulk.delete")}
                  </button>
                </div>
              `
            : nothing
        }

        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th class="data-table-checkbox-col">
                  ${
                    paginated.length > 0
                      ? html`<input
                        type="checkbox"
                        .checked=${paginated.length > 0 && paginated.every((r) => props.selectedKeys.has(r.key))}
                        .indeterminate=${paginated.some((r) => props.selectedKeys.has(r.key)) && !paginated.every((r) => props.selectedKeys.has(r.key))}
                        @change=${() => {
                          const allSelected = paginated.every((r) => props.selectedKeys.has(r.key));
                          if (allSelected) {
                            props.onDeselectPage(paginated.map((r) => r.key));
                          } else {
                            props.onSelectPage(paginated.map((r) => r.key));
                          }
                        }}
                        aria-label=${t("sessions.table.selectAllOnPage")}
                      />`
                      : nothing
                  }
                </th>
                ${sortHeader("key", t("sessions.table.key"), "data-table-key-col")}
                <th>${t("sessions.table.label")}</th>
                ${sortHeader("kind", t("sessions.table.kind"))}
                ${sortHeader("updated", t("sessions.table.updated"))}
                ${sortHeader("tokens", t("sessions.table.tokens"))}
                <th>${t("sessions.table.thinking")}</th>
                <th>${t("sessions.table.fast")}</th>
                <th>${t("sessions.table.verbose")}</th>
                <th>${t("sessions.table.reasoning")}</th>
              </tr>
            </thead>
            <tbody>
              ${
                paginated.length === 0
                  ? html`
                      <tr>
                        <td colspan="10" style="text-align: center; padding: 48px 16px; color: var(--muted)">
                          ${t("sessions.table.empty")}
                        </td>
                      </tr>
                    `
                  : paginated.map((row) =>
                      renderRow(
                        row,
                        props.basePath,
                        props.onPatch,
                        props.selectedKeys.has(row.key),
                        props.onToggleSelect,
                        props.loading,
                        props.onNavigateToChat,
                      ),
                    )
              }
            </tbody>
          </table>
        </div>

        ${
          totalRows > 0
            ? html`
                <div class="data-table-pagination">
                  <div class="data-table-pagination__info">
                    ${t("sessions.pagination.rows", {
                      start: String(page * props.pageSize + 1),
                      end: String(Math.min((page + 1) * props.pageSize, totalRows)),
                      total: String(totalRows),
                      rowLabel:
                        totalRows === 1
                          ? t("sessions.pagination.row")
                          : t("sessions.pagination.rowsPlural"),
                    })}
                  </div>
                  <div class="data-table-pagination__controls">
                    <select
                      style="height: 32px; padding: 0 8px; font-size: 13px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--card);"
                      .value=${String(props.pageSize)}
                      @change=${(e: Event) =>
                        props.onPageSizeChange(Number((e.target as HTMLSelectElement).value))}
                    >
                      ${PAGE_SIZES.map(
                        (s) =>
                          html`<option value=${s}>${t("sessions.pagination.perPage", { size: String(s) })}</option>`,
                      )}
                    </select>
                    <button
                      ?disabled=${page <= 0}
                      @click=${() => props.onPageChange(page - 1)}
                    >
                      ${t("sessions.pagination.previous")}
                    </button>
                    <button
                      ?disabled=${page >= totalPages - 1}
                      @click=${() => props.onPageChange(page + 1)}
                    >
                      ${t("sessions.pagination.next")}
                    </button>
                  </div>
                </div>
              `
            : nothing
        }
      </div>
    </section>
  `;
}

function renderRow(
  row: GatewaySessionRow,
  basePath: string,
  onPatch: SessionsProps["onPatch"],
  selected: boolean,
  onToggleSelect: SessionsProps["onToggleSelect"],
  disabled: boolean,
  onNavigateToChat?: (sessionKey: string) => void,
) {
  const updated = row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : t("common.na");
  const rawThinking = row.thinkingLevel ?? "";
  const isBinaryThinking = isBinaryThinkingProvider(row.modelProvider);
  const thinking = resolveThinkLevelDisplay(rawThinking, isBinaryThinking);
  const thinkLevels = withCurrentOption(resolveThinkLevelOptions(row.modelProvider), thinking);
  const fastMode = row.fastMode === true ? "on" : row.fastMode === false ? "off" : "";
  const fastLevels = withCurrentLabeledOption(buildFastLevels(), fastMode);
  const verbose = row.verboseLevel ?? "";
  const verboseLevels = withCurrentLabeledOption(buildVerboseLevels(), verbose);
  const reasoning = row.reasoningLevel ?? "";
  const reasoningLevels = withCurrentOption(REASONING_LEVELS, reasoning);
  const displayName =
    typeof row.displayName === "string" && row.displayName.trim().length > 0
      ? row.displayName.trim()
      : null;
  const showDisplayName = Boolean(
    displayName &&
    displayName !== row.key &&
    displayName !== (typeof row.label === "string" ? row.label.trim() : ""),
  );
  const canLink = row.kind !== "global";
  const chatUrl = canLink
    ? `${pathForTab("chat", basePath)}?session=${encodeURIComponent(row.key)}`
    : null;
  const badgeClass =
    row.kind === "direct"
      ? "data-table-badge--direct"
      : row.kind === "group"
        ? "data-table-badge--group"
        : row.kind === "global"
          ? "data-table-badge--global"
          : "data-table-badge--unknown";

  return html`
    <tr>
      <td class="data-table-checkbox-col">
        <input
          type="checkbox"
          .checked=${selected}
          @change=${() => onToggleSelect(row.key)}
          aria-label=${t("sessions.table.selectSession")}
        />
      </td>
      <td class="data-table-key-col">
        <div class="mono session-key-cell">
          ${
            canLink
              ? html`<a
                  href=${chatUrl}
                  class="session-link"
                  @click=${(e: MouseEvent) => {
                    if (
                      e.defaultPrevented ||
                      e.button !== 0 ||
                      e.metaKey ||
                      e.ctrlKey ||
                      e.shiftKey ||
                      e.altKey
                    ) {
                      return;
                    }
                    if (onNavigateToChat) {
                      e.preventDefault();
                      onNavigateToChat(row.key);
                    }
                  }}
                >${row.key}</a>`
              : row.key
          }
          ${
            showDisplayName
              ? html`<span class="muted session-key-display-name">${displayName}</span>`
              : nothing
          }
        </div>
      </td>
      <td>
        <input
          .value=${row.label ?? ""}
          ?disabled=${disabled}
          placeholder=${t("sessions.table.optionalPlaceholder")}
          style="width: 100%; max-width: 140px; padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm);"
          @change=${(e: Event) => {
            const value = (e.target as HTMLInputElement).value.trim();
            onPatch(row.key, { label: value || null });
          }}
        />
      </td>
      <td>
        <span class="data-table-badge ${badgeClass}">${row.kind}</span>
      </td>
      <td>${updated}</td>
      <td>${formatSessionTokens(row)}</td>
      <td>
        <select
          ?disabled=${disabled}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            onPatch(row.key, {
              thinkingLevel: resolveThinkLevelPatchValue(value, isBinaryThinking),
            });
          }}
        >
          ${thinkLevels.map(
            (level) =>
              html`<option value=${level} ?selected=${thinking === level}>
                ${thinkLevelOptionLabel(level, isBinaryThinking)}
              </option>`,
          )}
        </select>
      </td>
      <td>
        <select
          ?disabled=${disabled}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            onPatch(row.key, { fastMode: value === "" ? null : value === "on" });
          }}
        >
          ${fastLevels.map(
            (level) =>
              html`<option value=${level.value} ?selected=${fastMode === level.value}>
                ${level.label}
              </option>`,
          )}
        </select>
      </td>
      <td>
        <select
          ?disabled=${disabled}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            onPatch(row.key, { verboseLevel: value || null });
          }}
        >
          ${verboseLevels.map(
            (level) =>
              html`<option value=${level.value} ?selected=${verbose === level.value}>
                ${level.label}
              </option>`,
          )}
        </select>
      </td>
      <td>
        <select
          ?disabled=${disabled}
          style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); min-width: 90px;"
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            onPatch(row.key, { reasoningLevel: value || null });
          }}
        >
          ${reasoningLevels.map(
            (level) =>
              html`<option value=${level} ?selected=${reasoning === level}>
                ${level ? level : t("sessions.table.inherit")}
              </option>`,
          )}
        </select>
      </td>
    </tr>
  `;
}
