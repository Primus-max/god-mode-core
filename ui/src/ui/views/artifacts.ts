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
  return available ? "Yes" : "No";
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
      return "Mark preview";
    case "approve":
      return "Approve";
    case "publish":
      return "Publish";
    case "retain":
      return "Archive";
    case "delete":
      return "Delete";
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
      <span style="opacity:0.75;">${formatRelativeTimestamp(artifact.updatedAt ?? artifact.createdAt)}</span>
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
          <div style="opacity:0.75;">Browse persisted previews, exports, and publishable outputs.</div>
        </div>
        <button class="btn" type="button" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${t("common.refresh")}
        </button>
      </div>
      <div class="row" style="margin-top:12px;">
        <input
          type="search"
          placeholder="Filter artifacts"
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
            ? html`<div style="opacity:0.75;">No artifacts yet.</div>`
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
            ? html`<div>Loading artifact details…</div>`
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
                    <dt>ID</dt>
                    <dd>${descriptor.id}</dd>
                    <dt>Kind</dt>
                    <dd>${descriptor.kind}</dd>
                    <dt>Recipe</dt>
                    <dd>${descriptor.sourceRecipeId ?? "n/a"}</dd>
                    <dt>Run</dt>
                    <dd>${detail.runId ?? "n/a"}</dd>
                    <dt>Preview</dt>
                    <dd>${formatAvailability(detail.previewAvailable)}</dd>
                    <dt>Content</dt>
                    <dd>${formatAvailability(detail.contentAvailable)}</dd>
                    <dt>MIME</dt>
                    <dd>${descriptor.mimeType ?? "n/a"}</dd>
                    <dt>Size</dt>
                    <dd>${formatBytes(descriptor.sizeBytes)}</dd>
                    <dt>Updated</dt>
                    <dd>${formatRelativeTimestamp(descriptor.updatedAt ?? descriptor.createdAt)}</dd>
                  </dl>
                  ${detail.warnings?.length
                    ? html`
                        <div style="margin-bottom:16px;">
                          <strong>Warnings</strong>
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
                            Open preview
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
                            Open content
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
              : html`<div style="opacity:0.75;">Select an artifact to inspect its details.</div>`}
        </div>
      </div>
    </section>
  `;
}
