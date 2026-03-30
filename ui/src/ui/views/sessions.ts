import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import { pathForTab } from "../navigation.ts";
import { formatSessionTokens } from "../presenter.ts";
import type {
  GatewaySessionRow,
  RuntimeActionDetail,
  RuntimeActionSummary,
  RuntimeCheckpointSummary,
  RuntimeClosureDetail,
  RuntimeClosureSummary,
  SessionsListResult,
} from "../types.ts";

export type SessionsProps = {
  loading: boolean;
  runtimeLoading: boolean;
  runtimeDetailLoading: boolean;
  result: SessionsListResult | null;
  error: string | null;
  runtimeError: string | null;
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
  runtimeSessionKey: string | null;
  runtimeRunId: string | null;
  runtimeCheckpoints: RuntimeCheckpointSummary[];
  runtimeSelectedCheckpointId: string | null;
  runtimeCheckpointDetail: RuntimeCheckpointSummary | null;
  runtimeActions: RuntimeActionSummary[];
  runtimeSelectedActionId: string | null;
  runtimeActionDetail: RuntimeActionDetail | null;
  runtimeClosures: RuntimeClosureSummary[];
  runtimeSelectedClosureRunId: string | null;
  runtimeClosureDetail: RuntimeClosureDetail | null;
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
  onInspectRuntimeSession: (sessionKey: string, runId?: string) => void;
  onSelectRuntimeCheckpoint: (checkpointId: string) => void;
  onSelectRuntimeAction: (actionId: string) => void;
  onSelectRuntimeClosure: (runId: string) => void;
  onClearRuntimeScope: () => void;
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

function formatMsTimestamp(timestamp?: number | null): string {
  return typeof timestamp === "number" ? formatRelativeTimestamp(timestamp) : t("common.na");
}

function renderRuntimeStatusChip(label: string) {
  return html`<span class="chip">${label}</span>`;
}

function renderRuntimeInspector(props: SessionsProps) {
  const checkpoints = props.runtimeCheckpoints;
  const selectedCheckpoint = props.runtimeCheckpointDetail;
  const selectedAction = props.runtimeActionDetail;
  const selectedClosure = props.runtimeClosureDetail;
  return html`
    <section class="card" style="margin-top: 16px;">
      <div class="row" style="justify-content: space-between; gap: 12px; align-items: center;">
        <div>
          <div class="card-title">${t("sessions.runtime.title")}</div>
          <div class="card-sub">
            ${props.runtimeSessionKey
              ? t("sessions.runtime.scopeSession", { sessionKey: props.runtimeSessionKey })
              : t("sessions.runtime.scopeGlobal")}
          </div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap;">
          <button class="btn" type="button" ?disabled=${props.runtimeLoading} @click=${props.onRefresh}>
            ${t("common.refresh")}
          </button>
          ${
            props.runtimeSessionKey || props.runtimeRunId
              ? html`
                  <button class="btn" type="button" @click=${props.onClearRuntimeScope}>
                    ${t("sessions.runtime.clearScope")}
                  </button>
                `
              : nothing
          }
        </div>
      </div>
      ${
        props.runtimeError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.runtimeError}</div>`
          : nothing
      }
      ${
        props.runtimeLoading && checkpoints.length === 0
          ? html`<div class="muted" style="margin-top: 12px;">${t("sessions.runtime.loading")}</div>`
          : nothing
      }
      ${
        !props.runtimeLoading && checkpoints.length === 0
          ? html`<div class="muted" style="margin-top: 12px;">${t("sessions.runtime.empty")}</div>`
          : nothing
      }
      ${
        checkpoints.length > 0
          ? html`
              <div
                style="display:grid; grid-template-columns:minmax(260px, 320px) minmax(0, 1fr); gap:16px; margin-top:16px;"
              >
                <div style="display:flex; flex-direction:column; gap:8px;">
                  ${checkpoints.map(
                    (checkpoint) => html`
                      <button
                        class="btn"
                        type="button"
                        ?disabled=${checkpoint.id === props.runtimeSelectedCheckpointId}
                        @click=${() => props.onSelectRuntimeCheckpoint(checkpoint.id)}
                        style="display:flex; width:100%; text-align:left; justify-content:space-between; gap:12px;"
                      >
                        <span>
                          <strong>${checkpoint.boundary}</strong>
                          <span style="display:block; opacity:0.75;">
                            ${checkpoint.status}
                            ${checkpoint.operatorHint ? html`· ${checkpoint.operatorHint}` : nothing}
                          </span>
                        </span>
                        <span style="opacity:0.75;">${formatMsTimestamp(checkpoint.updatedAtMs)}</span>
                      </button>
                    `,
                  )}
                </div>
                <div class="card" style="padding:16px;">
                  ${
                    props.runtimeDetailLoading && !selectedCheckpoint
                      ? html`<div>${t("sessions.runtime.loadingDetail")}</div>`
                      : selectedCheckpoint
                        ? html`
                            <div class="row" style="justify-content:space-between; gap:12px; align-items:flex-start;">
                              <div>
                                <h3 style="margin:0;">${selectedCheckpoint.boundary}</h3>
                                <div class="muted" style="margin-top: 2px;">
                                  ${selectedCheckpoint.operatorHint ?? t("sessions.runtime.noHint")}
                                </div>
                              </div>
                              ${renderRuntimeStatusChip(selectedCheckpoint.status)}
                            </div>
                            <dl
                              style="display:grid; grid-template-columns:max-content 1fr; gap:8px 16px; margin:16px 0;"
                            >
                              <dt>${t("sessions.runtime.fields.checkpointId")}</dt>
                              <dd>${selectedCheckpoint.id}</dd>
                              <dt>${t("sessions.runtime.fields.runId")}</dt>
                              <dd>${selectedCheckpoint.runId}</dd>
                              <dt>${t("sessions.runtime.fields.sessionKey")}</dt>
                              <dd>${selectedCheckpoint.sessionKey ?? t("common.na")}</dd>
                              <dt>${t("sessions.runtime.fields.updated")}</dt>
                              <dd>${formatMsTimestamp(selectedCheckpoint.updatedAtMs)}</dd>
                              <dt>${t("sessions.runtime.fields.blockedReason")}</dt>
                              <dd>${selectedCheckpoint.blockedReason ?? t("common.na")}</dd>
                            </dl>
                            ${
                              selectedCheckpoint.nextActions?.length
                                ? html`
                                    <div style="margin-top: 12px;">
                                      <strong>${t("sessions.runtime.nextActions")}</strong>
                                      <ul style="margin:8px 0 0 18px;">
                                        ${selectedCheckpoint.nextActions.map(
                                          (action) =>
                                            html`<li>${action.label} (${action.method})</li>`,
                                        )}
                                      </ul>
                                    </div>
                                  `
                                : nothing
                            }
                            ${
                              selectedCheckpoint.continuation
                                ? html`
                                    <div style="margin-top: 12px;">
                                      <strong>${t("sessions.runtime.continuation")}</strong>
                                      <div class="chip-row" style="margin-top: 8px;">
                                        <span class="chip">${selectedCheckpoint.continuation.kind}</span>
                                        ${
                                          selectedCheckpoint.continuation.state
                                            ? html`<span class="chip"
                                                >${selectedCheckpoint.continuation.state}</span
                                              >`
                                            : nothing
                                        }
                                        ${
                                          selectedCheckpoint.continuation.attempts !== undefined
                                            ? html`<span class="chip"
                                                >${t("sessions.runtime.attempts")}: ${selectedCheckpoint
                                                  .continuation.attempts}</span
                                              >`
                                            : nothing
                                        }
                                      </div>
                                    </div>
                                  `
                                : nothing
                            }
                            <div
                              style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:16px; margin-top:16px;"
                            >
                              <div>
                                <strong>${t("sessions.runtime.actionsTitle")}</strong>
                                <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
                                  ${
                                    props.runtimeActions.length === 0
                                      ? html`<div class="muted">${t("sessions.runtime.noActions")}</div>`
                                      : props.runtimeActions.map(
                                          (action) => html`
                                            <button
                                              class="btn"
                                              type="button"
                                              ?disabled=${action.actionId === props.runtimeSelectedActionId}
                                              @click=${() => props.onSelectRuntimeAction(action.actionId)}
                                              style="justify-content:space-between;"
                                            >
                                              <span>${action.kind}</span>
                                              <span style="opacity:0.75;">${action.state}</span>
                                            </button>
                                          `,
                                        )
                                  }
                                </div>
                                ${
                                  selectedAction
                                    ? html`
                                        <div class="callout" style="margin-top:12px;">
                                          <strong>${selectedAction.actionId}</strong>
                                          <div class="muted" style="margin-top:4px;">
                                            ${selectedAction.kind} · ${selectedAction.state}
                                          </div>
                                          ${
                                            selectedAction.receipt?.resultStatus
                                              ? html`<div style="margin-top:8px;">
                                                  ${t("sessions.runtime.fields.resultStatus")}: ${selectedAction
                                                    .receipt.resultStatus}
                                                </div>`
                                              : nothing
                                          }
                                          ${
                                            selectedAction.lastError
                                              ? html`<div style="margin-top:8px;">
                                                  ${selectedAction.lastError}
                                                </div>`
                                              : nothing
                                          }
                                        </div>
                                      `
                                    : nothing
                                }
                              </div>
                              <div>
                                <strong>${t("sessions.runtime.closuresTitle")}</strong>
                                <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
                                  ${
                                    props.runtimeClosures.length === 0
                                      ? html`<div class="muted">${t("sessions.runtime.noClosures")}</div>`
                                      : props.runtimeClosures.map(
                                          (closure) => html`
                                            <button
                                              class="btn"
                                              type="button"
                                              ?disabled=${closure.runId === props.runtimeSelectedClosureRunId}
                                              @click=${() => props.onSelectRuntimeClosure(closure.runId)}
                                              style="justify-content:space-between;"
                                            >
                                              <span>${closure.runId}</span>
                                              <span style="opacity:0.75;">${closure.outcomeStatus}</span>
                                            </button>
                                          `,
                                        )
                                  }
                                </div>
                                ${
                                  selectedClosure
                                    ? html`
                                        <div class="callout" style="margin-top:12px;">
                                          <strong>${selectedClosure.runId}</strong>
                                          <div class="muted" style="margin-top:4px;">
                                            ${selectedClosure.acceptanceOutcome.status} · ${selectedClosure
                                              .supervisorVerdict.action}
                                          </div>
                                          <div style="margin-top:8px;">
                                            ${t("sessions.runtime.fields.updated")}: ${formatMsTimestamp(
                                              selectedClosure.updatedAtMs,
                                            )}
                                          </div>
                                        </div>
                                      `
                                    : nothing
                                }
                              </div>
                            </div>
                          `
                        : html`<div class="muted">${t("sessions.runtime.selectHint")}</div>`
                  }
                </div>
              </div>
            `
          : nothing
      }
    </section>
  `;
}

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
                <th>${t("sessions.table.runtime")}</th>
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
                        <td colspan="11" style="text-align: center; padding: 48px 16px; color: var(--muted)">
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
                        props.onInspectRuntimeSession,
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
      ${renderRuntimeInspector(props)}
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
  onInspectRuntimeSession: SessionsProps["onInspectRuntimeSession"],
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
        <div style="display:flex; flex-direction:column; gap:6px; min-width: 180px;">
          ${
            row.recoveryStatus
              ? renderRuntimeStatusChip(row.recoveryStatus)
              : row.runClosureSummary?.outcomeStatus
                ? renderRuntimeStatusChip(row.runClosureSummary.outcomeStatus)
                : html`<span class="muted">${t("common.na")}</span>`
          }
          ${
            row.recoveryOperatorHint
              ? html`<div class="muted" style="font-size:12px;">${row.recoveryOperatorHint}</div>`
              : nothing
          }
          <button
            class="btn btn--sm"
            type="button"
            @click=${() =>
              onInspectRuntimeSession(
                row.key,
                row.runClosureSummary?.runId ?? row.handoffRunId ?? row.handoffRequestRunId,
              )}
          >
            ${t("sessions.runtime.inspect")}
          </button>
        </div>
      </td>
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
