import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { BootstrapRequestRecordDetail, BootstrapRequestRecordSummary } from "../types.ts";

export type BootstrapProps = {
  loading: boolean;
  detailLoading: boolean;
  actionBusy: boolean;
  error: string | null;
  detailError: string | null;
  requests: BootstrapRequestRecordSummary[];
  pendingCount: number;
  filterQuery: string;
  selectedId: string | null;
  detail: BootstrapRequestRecordDetail | null;
  onRefresh: () => void | Promise<void>;
  onSelect: (requestId: string) => void | Promise<void>;
  onFilterChange: (value: string) => void;
  onResolve: (requestId: string, decision: "approve" | "deny") => void | Promise<void>;
  onRun: (requestId: string) => void | Promise<void>;
};

function matchesBootstrapQuery(entry: BootstrapRequestRecordSummary, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return [
    entry.id,
    entry.capabilityId,
    entry.installMethod,
    entry.reason,
    entry.sourceDomain,
    entry.sourceRecipeId,
    entry.state,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => value.toLowerCase().includes(normalized));
}

function renderBootstrapListItem(params: {
  request: BootstrapRequestRecordSummary;
  selected: boolean;
  onSelect: (requestId: string) => void | Promise<void>;
}) {
  const { request, selected, onSelect } = params;
  return html`
    <button
      class="btn"
      type="button"
      ?disabled=${selected}
      @click=${() => onSelect(request.id)}
      style="display:flex; width:100%; text-align:left; justify-content:space-between; gap:12px;"
    >
      <span>
        <strong>${request.capabilityId}</strong>
        <span style="display:block; opacity:0.75;">
          ${request.reason} · ${request.state}
        </span>
      </span>
      <span style="opacity:0.75;">${formatRelativeTimestamp(request.updatedAt)}</span>
    </button>
  `;
}

function renderReasonList(label: string, reasons?: string[]) {
  if (!reasons?.length) {
    return nothing;
  }
  return html`
    <div style="margin-top:16px;">
      <strong>${label}</strong>
      <ul style="margin:8px 0 0 18px;">
        ${reasons.map((reason) => html`<li>${reason}</li>`)}
      </ul>
    </div>
  `;
}

export function renderBootstrap(props: BootstrapProps) {
  const filteredRequests = props.requests.filter((entry) =>
    matchesBootstrapQuery(entry, props.filterQuery),
  );
  const detail = props.detail;
  const request = detail?.request;
  const result = detail?.result;
  const showApprove = detail?.state === "pending";
  const showRun = detail?.state === "approved";

  return html`
    <section class="card">
      <div class="row" style="justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
        <div>
          <h2 style="margin:0;">${t("tabs.bootstrap")}</h2>
          <div style="opacity:0.75;">
            Pending capability install approvals and lifecycle results. ${props.pendingCount} pending.
          </div>
        </div>
        <button class="btn" type="button" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${t("common.refresh")}
        </button>
      </div>
      <div class="row" style="margin-top:12px;">
        <input
          type="search"
          placeholder="Filter bootstrap requests"
          .value=${props.filterQuery}
          @input=${(event: Event) =>
            props.onFilterChange((event.target as HTMLInputElement).value)}
        />
      </div>
      ${props.error
        ? html`<p role="alert" style="color:var(--color-danger, #d44);">${props.error}</p>`
        : nothing}
      <div
        style="display:grid; grid-template-columns:minmax(280px, 360px) minmax(0, 1fr); gap:16px; margin-top:16px;"
      >
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${filteredRequests.length === 0
            ? html`<div style="opacity:0.75;">No bootstrap requests yet.</div>`
            : filteredRequests.map((entry) =>
                renderBootstrapListItem({
                  request: entry,
                  selected: entry.id === props.selectedId,
                  onSelect: props.onSelect,
                }),
              )}
        </div>
        <div class="card" style="padding:16px;">
          ${props.detailLoading
            ? html`<div>Loading bootstrap details…</div>`
            : detail && request
              ? html`
                  <div class="row" style="justify-content:space-between; align-items:flex-start;">
                    <div>
                      <h3 style="margin:0;">${request.capabilityId}</h3>
                      <div style="opacity:0.75;">${request.reason} · ${detail.state}</div>
                    </div>
                    <div style="opacity:0.75;">${request.installMethod}</div>
                  </div>
                  ${props.detailError
                    ? html`<p role="alert" style="color:var(--color-danger, #d44);">
                        ${props.detailError}
                      </p>`
                    : nothing}
                  <dl
                    style="display:grid; grid-template-columns:max-content 1fr; gap:8px 16px; margin:16px 0;"
                  >
                    <dt>ID</dt>
                    <dd>${detail.id}</dd>
                    <dt>Source</dt>
                    <dd>${request.sourceDomain}</dd>
                    <dt>Recipe</dt>
                    <dd>${request.sourceRecipeId ?? "n/a"}</dd>
                    <dt>Approval</dt>
                    <dd>${request.approvalMode}</dd>
                    <dt>Created</dt>
                    <dd>${detail.createdAt}</dd>
                    <dt>Updated</dt>
                    <dd>${detail.updatedAt}</dd>
                    <dt>Lifecycle</dt>
                    <dd>${result?.lifecycle?.status ?? result?.status ?? "not run"}</dd>
                  </dl>
                  ${renderReasonList("Record reasons", detail.reasons)}
                  ${renderReasonList("Result reasons", result?.reasons)}
                  <div class="row" style="gap:8px; flex-wrap:wrap; margin-top:16px;">
                    ${showApprove
                      ? html`
                          <button
                            class="btn primary"
                            type="button"
                            ?disabled=${props.actionBusy}
                            @click=${() => props.onResolve(detail.id, "approve")}
                          >
                            Approve
                          </button>
                          <button
                            class="btn danger"
                            type="button"
                            ?disabled=${props.actionBusy}
                            @click=${() => props.onResolve(detail.id, "deny")}
                          >
                            Deny
                          </button>
                        `
                      : nothing}
                    ${showRun
                      ? html`
                          <button
                            class="btn primary"
                            type="button"
                            ?disabled=${props.actionBusy}
                            @click=${() => props.onRun(detail.id)}
                          >
                            Run bootstrap
                          </button>
                        `
                      : nothing}
                  </div>
                `
              : html`<div style="opacity:0.75;">Select a bootstrap request to inspect it.</div>`}
        </div>
      </div>
    </section>
  `;
}
