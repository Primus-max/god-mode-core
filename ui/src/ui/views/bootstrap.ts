import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type {
  BootstrapRequestRecordDetail,
  BootstrapRequestRecordSummary,
  RuntimeCheckpointSummary,
} from "../types.ts";

export type BootstrapProps = {
  loading: boolean;
  detailLoading: boolean;
  actionBusy: boolean;
  runtimeLoading?: boolean;
  error: string | null;
  detailError: string | null;
  runtimeError?: string | null;
  requests: BootstrapRequestRecordSummary[];
  pendingCount: number;
  filterQuery: string;
  selectedId: string | null;
  detail: BootstrapRequestRecordDetail | null;
  runtimeCheckpoints?: RuntimeCheckpointSummary[];
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
      <span style="opacity:0.75;">${formatRelativeIsoTimestamp(request.updatedAt)}</span>
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

function formatRelativeIsoTimestamp(timestamp?: string) {
  if (!timestamp) {
    return "n/a";
  }
  const parsed = Date.parse(timestamp);
  return formatRelativeTimestamp(Number.isFinite(parsed) ? parsed : null);
}

function renderRuntimeCheckpointPanel(
  detail: BootstrapRequestRecordDetail | null,
  checkpoints: RuntimeCheckpointSummary[],
  runtimeLoading?: boolean,
  runtimeError?: string | null,
) {
  if (!detail) {
    return nothing;
  }
  if (runtimeError) {
    return html`<div class="callout danger" style="margin-top:16px;">${runtimeError}</div>`;
  }
  if (runtimeLoading && checkpoints.length === 0) {
    return html`<div class="muted" style="margin-top:16px;">${t("bootstrap.runtime.loading")}</div>`;
  }
  const checkpoint = checkpoints.find(
    (entry) =>
      entry.target?.bootstrapRequestId === detail.id ||
      (entry.boundary === "bootstrap" && entry.id === detail.id),
  );
  if (!checkpoint) {
    return nothing;
  }
  return html`
    <div class="callout" style="margin-top:16px;">
      <strong>${t("bootstrap.runtime.title")}</strong>
      <div class="chip-row" style="margin-top:8px;">
        <span class="chip">${checkpoint.status}</span>
        ${checkpoint.continuation?.state ? html`<span class="chip">${checkpoint.continuation.state}</span>` : nothing}
      </div>
      ${
        checkpoint.operatorHint
          ? html`<div class="muted" style="margin-top:8px;">${checkpoint.operatorHint}</div>`
          : nothing
      }
      ${
        checkpoint.nextActions?.length
          ? html`
              <ul style="margin:8px 0 0 18px;">
                ${checkpoint.nextActions.map((action) => html`<li>${action.label}</li>`)}
              </ul>
            `
          : nothing
      }
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
  const runtimeCheckpoints = props.runtimeCheckpoints ?? [];
  const showApprove = detail?.state === "pending";
  const showRun = detail?.state === "approved";

  return html`
    <section class="card">
      <div class="row" style="justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
        <div>
          <h2 style="margin:0;">${t("tabs.bootstrap")}</h2>
          <div style="opacity:0.75;">${t("bootstrap.subtitle", { count: String(props.pendingCount) })}</div>
        </div>
        <button class="btn" type="button" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${t("common.refresh")}
        </button>
      </div>
      <div class="row" style="margin-top:12px;">
        <input
          type="search"
          placeholder=${t("bootstrap.filterPlaceholder")}
          .value=${props.filterQuery}
          @input=${(event: Event) => props.onFilterChange((event.target as HTMLInputElement).value)}
        />
      </div>
      ${
        props.error
          ? html`<p role="alert" style="color:var(--color-danger, #d44);">${props.error}</p>`
          : nothing
      }
      <div
        style="display:grid; grid-template-columns:minmax(280px, 360px) minmax(0, 1fr); gap:16px; margin-top:16px;"
      >
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${
            filteredRequests.length === 0
              ? html`<div style="opacity:0.75;">${t("bootstrap.empty")}</div>`
              : filteredRequests.map((entry) =>
                  renderBootstrapListItem({
                    request: entry,
                    selected: entry.id === props.selectedId,
                    onSelect: props.onSelect,
                  }),
                )
          }
        </div>
        <div class="card" style="padding:16px;">
          ${
            props.detailLoading
              ? html`<div>${t("bootstrap.loadingDetail")}</div>`
              : detail && request
                ? html`
                  <div class="row" style="justify-content:space-between; align-items:flex-start;">
                    <div>
                      <h3 style="margin:0;">${request.capabilityId}</h3>
                      <div style="opacity:0.75;">${request.reason} · ${detail.state}</div>
                    </div>
                    <div style="opacity:0.75;">${request.installMethod}</div>
                  </div>
                  ${
                    props.detailError
                      ? html`<p role="alert" style="color:var(--color-danger, #d44);">
                        ${props.detailError}
                      </p>`
                      : nothing
                  }
                  <dl
                    style="display:grid; grid-template-columns:max-content 1fr; gap:8px 16px; margin:16px 0;"
                  >
                    <dt>${t("bootstrap.fields.id")}</dt>
                    <dd>${detail.id}</dd>
                    <dt>${t("bootstrap.fields.source")}</dt>
                    <dd>${request.sourceDomain}</dd>
                    <dt>${t("bootstrap.fields.recipe")}</dt>
                    <dd>${request.sourceRecipeId ?? "n/a"}</dd>
                    <dt>${t("bootstrap.fields.approval")}</dt>
                    <dd>${request.approvalMode}</dd>
                    <dt>${t("bootstrap.fields.created")}</dt>
                    <dd>${detail.createdAt}</dd>
                    <dt>${t("bootstrap.fields.updated")}</dt>
                    <dd>${detail.updatedAt}</dd>
                    <dt>${t("bootstrap.fields.lifecycle")}</dt>
                    <dd>${result?.lifecycle?.status ?? result?.status ?? t("bootstrap.notRun")}</dd>
                  </dl>
                  ${renderReasonList(t("bootstrap.reasonLists.record"), detail.reasons)}
                  ${renderReasonList(t("bootstrap.reasonLists.result"), result?.reasons)}
                  ${renderRuntimeCheckpointPanel(
                    detail,
                    runtimeCheckpoints,
                    props.runtimeLoading,
                    props.runtimeError,
                  )}
                  <div class="row" style="gap:8px; flex-wrap:wrap; margin-top:16px;">
                    ${
                      showApprove
                        ? html`
                          <button
                            class="btn primary"
                            type="button"
                            ?disabled=${props.actionBusy}
                            @click=${() => props.onResolve(detail.id, "approve")}
                          >
                            ${t("bootstrap.actions.approve")}
                          </button>
                          <button
                            class="btn danger"
                            type="button"
                            ?disabled=${props.actionBusy}
                            @click=${() => props.onResolve(detail.id, "deny")}
                          >
                            ${t("bootstrap.actions.deny")}
                          </button>
                        `
                        : nothing
                    }
                    ${
                      showRun
                        ? html`
                          <button
                            class="btn primary"
                            type="button"
                            ?disabled=${props.actionBusy}
                            @click=${() => props.onRun(detail.id)}
                          >
                            ${t("bootstrap.actions.run")}
                          </button>
                        `
                        : nothing
                    }
                  </div>
                `
                : html`<div style="opacity:0.75;">${t("bootstrap.selectHint")}</div>`
          }
        </div>
      </div>
    </section>
  `;
}
