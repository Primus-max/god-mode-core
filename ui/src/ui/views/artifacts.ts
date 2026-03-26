import { html, nothing } from "lit";
import type { ArtifactOperation } from "../../../../src/platform/schemas/artifact.js";
import { t } from "../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../external-link.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { ArtifactRecordDetail, ArtifactRecordSummary } from "../types.ts";

export type ArtifactsProps = {
  loading: boolean;
  detailLoading: boolean;
  actionBusy: boolean;
  error: string | null;
  detailError: string | null;
  artifacts: ArtifactRecordSummary[];
  filterQuery: string;
  selectedId: string | null;
  detail: ArtifactRecordDetail | null;
  onRefresh: () => void | Promise<void>;
  onSelect: (artifactId: string) => void | Promise<void>;
  onFilterChange: (value: string) => void;
  onTransition: (artifactId: string, operation: ArtifactOperation) => void | Promise<void>;
};

function formatAvailability(available: boolean) {
  return available ? t("artifacts.availabilityYes") : t("artifacts.availabilityNo");
}

function formatBytes(sizeBytes?: number) {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return "n/a";
  }
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeIsoTimestamp(timestamp?: string) {
  if (!timestamp) {
    return "n/a";
  }
  const parsed = Date.parse(timestamp);
  return formatRelativeTimestamp(Number.isFinite(parsed) ? parsed : null);
}

function getArtifactActions(detail: ArtifactRecordDetail | null): ArtifactOperation[] {
  const lifecycle = detail?.descriptor.lifecycle;
  if (!lifecycle) {
    return [];
  }
  if (lifecycle === "deleted") {
    return [];
  }
  if (lifecycle === "archived") {
    return ["delete"];
  }
  if (lifecycle === "published") {
    return ["retain"];
  }
  if (lifecycle === "approved") {
    return ["publish", "retain", "delete"];
  }
  if (lifecycle === "preview") {
    return ["approve", "publish", "retain", "delete"];
  }
  return ["preview", "approve", "publish", "retain", "delete"];
}

function actionLabel(operation: ArtifactOperation) {
  switch (operation) {
    case "preview":
      return t("artifacts.actions.preview");
    case "approve":
      return t("artifacts.actions.approve");
    case "publish":
      return t("artifacts.actions.publish");
    case "retain":
      return t("artifacts.actions.retain");
    case "delete":
      return t("artifacts.actions.delete");
    default:
      return operation;
  }
}

function matchesArtifactQuery(artifact: ArtifactRecordSummary, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return [
    artifact.id,
    artifact.label,
    artifact.kind,
    artifact.lifecycle,
    artifact.artifactType,
    artifact.sourceRecipeId,
    artifact.runId,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => value.toLowerCase().includes(normalized));
}

function renderArtifactListItem(params: {
  artifact: ArtifactRecordSummary;
  selected: boolean;
  onSelect: (artifactId: string) => void | Promise<void>;
}) {
  const { artifact, selected, onSelect } = params;
  return html`
    <button
      class="btn"
      type="button"
      ?disabled=${selected}
      @click=${() => onSelect(artifact.id)}
      style="display:flex; width:100%; text-align:left; justify-content:space-between; gap:12px;"
    >
      <span>
        <strong>${artifact.label}</strong>
        <span style="display:block; opacity:0.75;">
          ${artifact.artifactType ?? artifact.kind} · ${artifact.lifecycle}
        </span>
      </span>
      <span style="opacity:0.75;">${formatRelativeIsoTimestamp(artifact.updatedAt ?? artifact.createdAt)}</span>
    </button>
  `;
}

export function renderArtifacts(props: ArtifactsProps) {
  const filteredArtifacts = props.artifacts.filter((artifact) =>
    matchesArtifactQuery(artifact, props.filterQuery),
  );
  const detail = props.detail;
  const descriptor = detail?.descriptor;
  const actions = getArtifactActions(detail);

  return html`
    <section class="card">
      <div class="row" style="justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
        <div>
          <h2 style="margin:0;">${t("tabs.artifacts")}</h2>
          <div style="opacity:0.75;">${t("artifacts.subtitle")}</div>
        </div>
        <button class="btn" type="button" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${t("common.refresh")}
        </button>
      </div>
      <div class="row" style="margin-top:12px;">
        <input
          type="search"
          placeholder=${t("artifacts.filterPlaceholder")}
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
          ${filteredArtifacts.length === 0
            ? html`<div style="opacity:0.75;">${t("artifacts.empty")}</div>`
            : filteredArtifacts.map((artifact) =>
                renderArtifactListItem({
                  artifact,
                  selected: artifact.id === props.selectedId,
                  onSelect: props.onSelect,
                }),
              )}
        </div>
        <div class="card" style="padding:16px;">
          ${props.detailLoading
            ? html`<div>${t("artifacts.loadingDetail")}</div>`
            : detail && descriptor
              ? html`
                  <div class="row" style="justify-content:space-between; align-items:flex-start;">
                    <div>
                      <h3 style="margin:0;">${descriptor.label}</h3>
                      <div style="opacity:0.75;">${detail.artifactType ?? descriptor.kind}</div>
                    </div>
                    <div style="opacity:0.75;">${descriptor.lifecycle}</div>
                  </div>
                  ${props.detailError
                    ? html`<p role="alert" style="color:var(--color-danger, #d44);">
                        ${props.detailError}
                      </p>`
                    : nothing}
                  <dl
                    style="display:grid; grid-template-columns:max-content 1fr; gap:8px 16px; margin:16px 0;"
                  >
                    <dt>${t("artifacts.fields.id")}</dt>
                    <dd>${descriptor.id}</dd>
                    <dt>${t("artifacts.fields.kind")}</dt>
                    <dd>${descriptor.kind}</dd>
                    <dt>${t("artifacts.fields.recipe")}</dt>
                    <dd>${descriptor.sourceRecipeId ?? "n/a"}</dd>
                    <dt>${t("artifacts.fields.run")}</dt>
                    <dd>${detail.runId ?? "n/a"}</dd>
                    <dt>${t("artifacts.fields.preview")}</dt>
                    <dd>${formatAvailability(detail.previewAvailable)}</dd>
                    <dt>${t("artifacts.fields.content")}</dt>
                    <dd>${formatAvailability(detail.contentAvailable)}</dd>
                    <dt>${t("artifacts.fields.mime")}</dt>
                    <dd>${descriptor.mimeType ?? "n/a"}</dd>
                    <dt>${t("artifacts.fields.size")}</dt>
                    <dd>${formatBytes(descriptor.sizeBytes)}</dd>
                    <dt>${t("artifacts.fields.updated")}</dt>
                    <dd>${formatRelativeIsoTimestamp(descriptor.updatedAt ?? descriptor.createdAt)}</dd>
                  </dl>
                  ${detail.warnings?.length
                    ? html`
                        <div style="margin-bottom:16px;">
                          <strong>${t("artifacts.warnings")}</strong>
                          <ul>
                            ${detail.warnings.map((warning) => html`<li>${warning}</li>`)}
                          </ul>
                        </div>
                      `
                    : nothing}
                  <div class="row" style="gap:8px; flex-wrap:wrap;">
                    ${detail.previewUrl
                      ? html`
                          <a
                            class="btn"
                            href=${detail.previewUrl}
                            target=${EXTERNAL_LINK_TARGET}
                            rel=${buildExternalLinkRel()}
                          >
                            ${t("artifacts.openPreview")}
                          </a>
                        `
                      : nothing}
                    ${detail.contentUrl
                      ? html`
                          <a
                            class="btn"
                            href=${detail.contentUrl}
                            target=${EXTERNAL_LINK_TARGET}
                            rel=${buildExternalLinkRel()}
                          >
                            ${t("artifacts.openContent")}
                          </a>
                        `
                      : nothing}
                    ${actions.map(
                      (operation) => html`
                        <button
                          class="btn"
                          type="button"
                          ?disabled=${props.actionBusy}
                          @click=${() => props.onTransition(descriptor.id, operation)}
                        >
                          ${actionLabel(operation)}
                        </button>
                      `,
                    )}
                  </div>
                `
              : html`<div style="opacity:0.75;">${t("artifacts.selectHint")}</div>`}
        </div>
      </div>
    </section>
  `;
}
