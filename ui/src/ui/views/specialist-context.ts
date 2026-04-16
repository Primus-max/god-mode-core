import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type {
  CapabilityCatalogSummary,
  RecipeCatalogSummary,
  RuntimeCheckpointSummary,
  SpecialistRuntimeSnapshot,
} from "../types.ts";

type SpecialistContextProps = {
  loading: boolean;
  saving?: boolean;
  error: string | null;
  snapshot: SpecialistRuntimeSnapshot | null;
  catalogLoading?: boolean;
  catalogError?: string | null;
  recipeCatalog?: RecipeCatalogSummary[];
  capabilityCatalog?: CapabilityCatalogSummary[];
  runtimeLoading?: boolean;
  runtimeError?: string | null;
  runtimeSessionKey?: string | null;
  runtimeCheckpoints?: RuntimeCheckpointSummary[];
  runtimeCheckpointDetail?: RuntimeCheckpointSummary | null;
  onOverrideChange?: (
    next:
      | { mode: "auto" }
      | { mode: "base"; profileId: string }
      | { mode: "session"; profileId: string },
  ) => void;
};

function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function renderSignalSource(
  source: SpecialistRuntimeSnapshot["signals"][number]["source"],
): string {
  return t(`specialist.signalSources.${source}`);
}

function renderRuntimeChips(snapshot: SpecialistRuntimeSnapshot) {
  const chips = [
    snapshot.activeProfileLabel,
    snapshot.taskOverlayLabel ?? null,
    snapshot.recipeId,
    snapshot.modelOverride ? `${t("specialist.model")}: ${snapshot.modelOverride}` : null,
    snapshot.timeoutSeconds ? `${t("specialist.timeout")}: ${snapshot.timeoutSeconds}s` : null,
    snapshot.draftApplied ? t("specialist.draftApplied") : null,
  ].filter(Boolean);

  if (chips.length === 0) {
    return nothing;
  }

  return html`
    <div class="chip-row" style="margin-top: 8px;">
      ${chips.map((chip) => html`<span class="chip">${chip}</span>`)}
    </div>
  `;
}

function renderOperationalFlag(label: string, enabled: boolean) {
  return html`
    <div>
      <strong>${label}:</strong>
      <span class="muted">${enabled ? t("common.enabled") : t("common.disabled")}</span>
    </div>
  `;
}

function renderOperationalPosture(snapshot: SpecialistRuntimeSnapshot) {
  const reasons = snapshot.policyReasons.slice(0, 3);
  const deniedReasons = snapshot.policyDeniedReasons.slice(0, 3);
  const chips = [
    `${t("specialist.operational.autonomyLabel")}: ${t(`specialist.operational.autonomy.${snapshot.policyAutonomy}`)}`,
    snapshot.requiresExplicitApproval
      ? t("specialist.operational.approvalRequired")
      : t("specialist.operational.approvalNotRequired"),
    snapshot.bootstrapContinuationMode
      ? t(`specialist.operational.bootstrapContinuation.${snapshot.bootstrapContinuationMode}`)
      : null,
  ].filter(Boolean);
  return html`
    <div class="callout" style="margin-top: 12px;">
      <strong>${t("specialist.operational.title")}</strong>
      <div class="chip-row" style="margin-top: 8px;">
        ${chips.map((chip) => html`<span class="chip">${chip}</span>`)}
      </div>
      <div style="display: grid; gap: 4px; margin-top: 10px;">
        ${renderOperationalFlag(t("specialist.operational.artifactPersistence"), snapshot.allowArtifactPersistence)}
        ${renderOperationalFlag(t("specialist.operational.publish"), snapshot.allowPublish)}
        ${renderOperationalFlag(
          t("specialist.operational.bootstrap"),
          snapshot.allowCapabilityBootstrap,
        )}
        ${renderOperationalFlag(
          t("specialist.operational.privilegedTools"),
          snapshot.allowPrivilegedTools,
        )}
      </div>
      ${
        reasons.length > 0
          ? html`
              <div style="margin-top: 10px;">
                <div class="muted">${t("specialist.operational.reasons")}</div>
                ${reasons.map((reason) => html`<div>${reason}</div>`)}
              </div>
            `
          : nothing
      }
      ${
        deniedReasons.length > 0
          ? html`
              <div style="margin-top: 10px;">
                <div class="muted">${t("specialist.operational.blocks")}</div>
                ${deniedReasons.map((reason) => html`<div>${reason}</div>`)}
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function renderCatalogRecipeItem(recipe: RecipeCatalogSummary, isActive: boolean) {
  return html`
    <div class="callout" style="margin-top: 8px;">
      <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
        <div>
          <strong>${recipe.id}</strong>
          <div class="muted" style="margin-top: 2px;">${recipe.purpose}</div>
        </div>
        ${isActive ? html`<span class="chip">${t("specialist.catalog.activeRecipe")}</span>` : nothing}
      </div>
      <div class="chip-row" style="margin-top: 8px;">
        <span class="chip">${t("specialist.catalog.risk")}: ${recipe.riskLevel}</span>
        ${
          recipe.timeoutSeconds
            ? html`<span class="chip">${t("specialist.timeout")}: ${recipe.timeoutSeconds}s</span>`
            : nothing
        }
        ${
          recipe.requiredCapabilities.length > 0
            ? html`<span class="chip"
                >${t("specialist.catalog.requiredCapabilities")}: ${recipe.requiredCapabilities.join(", ")}</span
              >`
            : nothing
        }
      </div>
    </div>
  `;
}

function renderCatalogCapabilityItem(
  capability: CapabilityCatalogSummary,
  bootstrapRequired: boolean,
) {
  return html`
    <div class="callout" style="margin-top: 8px;">
      <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
        <div>
          <strong>${capability.label}</strong>
          <div class="muted" style="margin-top: 2px;">${capability.id}</div>
        </div>
        ${
          bootstrapRequired
            ? html`<span class="chip">${t("specialist.catalog.bootstrapRequired")}</span>`
            : nothing
        }
      </div>
      <div class="chip-row" style="margin-top: 8px;">
        <span class="chip">${t("specialist.catalog.status")}: ${capability.status}</span>
        <span class="chip">${t("specialist.catalog.source")}: ${capability.source}</span>
        ${
          capability.installMethod
            ? html`<span class="chip"
                >${t("specialist.catalog.installMethod")}: ${capability.installMethod}</span
              >`
            : nothing
        }
      </div>
      ${
        capability.requiredByRecipes.length > 0
          ? html`
              <div class="muted" style="margin-top: 8px;">
                ${t("specialist.catalog.usedBy")}: ${capability.requiredByRecipes
                  .map((recipe) => recipe.id)
                  .join(", ")}
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function renderCatalogPanel(props: SpecialistContextProps) {
  const recipes = props.recipeCatalog ?? [];
  const capabilities = props.capabilityCatalog ?? [];
  if (props.catalogLoading && recipes.length === 0 && capabilities.length === 0) {
    return html`<div class="muted" style="margin-top: 12px;">${t("specialist.catalog.loading")}</div>`;
  }
  if (props.catalogError) {
    return html`<div class="callout danger" style="margin-top: 12px;">${props.catalogError}</div>`;
  }
  if (recipes.length === 0 && capabilities.length === 0) {
    return nothing;
  }
  const activeRecipeId = props.snapshot?.recipeId;
  const bootstrapRequired = new Set(props.snapshot?.bootstrapRequiredCapabilities ?? []);
  return html`
    <div style="margin-top: 16px;">
      <div class="card-sub">${t("specialist.catalog.title")}</div>
      <div class="muted" style="margin-top: 4px;">${t("specialist.catalog.subtitle")}</div>
      ${
        recipes.length > 0
          ? html`
              <div style="margin-top: 12px;">
                <div class="muted">${t("specialist.catalog.recipeRoutes")}</div>
                ${recipes.map((recipe) => renderCatalogRecipeItem(recipe, recipe.id === activeRecipeId))}
              </div>
            `
          : nothing
      }
      ${
        capabilities.length > 0
          ? html`
              <div style="margin-top: 12px;">
                <div class="muted">${t("specialist.catalog.capabilities")}</div>
                ${capabilities.map((capability) =>
                  renderCatalogCapabilityItem(capability, bootstrapRequired.has(capability.id)),
                )}
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function renderRuntimeQueuePanel(props: SpecialistContextProps) {
  const checkpoints = (props.runtimeCheckpoints ?? []).slice(0, 3);
  if (props.runtimeLoading && checkpoints.length === 0) {
    return html`<div class="muted" style="margin-top: 12px;">${t("specialist.runtime.loading")}</div>`;
  }
  if (props.runtimeError) {
    return html`<div class="callout danger" style="margin-top: 12px;">${props.runtimeError}</div>`;
  }
  if (checkpoints.length === 0) {
    return nothing;
  }
  return html`
    <div style="margin-top: 16px;">
      <div class="card-sub">${t("specialist.runtime.title")}</div>
      <div class="muted" style="margin-top: 4px;">
        ${
          props.runtimeSessionKey
            ? t("specialist.runtime.scopeSession", { sessionKey: props.runtimeSessionKey })
            : t("specialist.runtime.scopeGlobal")
        }
      </div>
      ${checkpoints.map(
        (checkpoint) => html`
          <div class="callout" style="margin-top: 8px;">
            <strong>${checkpoint.boundary}</strong>
            <div class="chip-row" style="margin-top: 8px;">
              <span class="chip">${checkpoint.status}</span>
              ${
                checkpoint.continuation?.state
                  ? html`<span class="chip">${checkpoint.continuation.state}</span>`
                  : nothing
              }
            </div>
            ${
              checkpoint.operatorHint
                ? html`<div class="muted" style="margin-top: 8px;">${checkpoint.operatorHint}</div>`
                : nothing
            }
          </div>
        `,
      )}
    </div>
  `;
}

function renderSignalList(snapshot: SpecialistRuntimeSnapshot) {
  const signals = [...snapshot.signals]
    .toSorted((left, right) => right.weight - left.weight)
    .slice(0, 4);
  if (signals.length === 0) {
    return html`<div class="muted">${t("specialist.noSignals")}</div>`;
  }
  return html`
    <div style="display: grid; gap: 8px; margin-top: 10px;">
      ${signals.map(
        (signal) => html`
          <div>
            <div>
              <strong>${signal.profileLabel}</strong>
              <span class="muted">· ${renderSignalSource(signal.source)} · ${formatConfidence(signal.weight)}</span>
            </div>
            ${
              signal.reason
                ? html`<div class="muted" style="margin-top: 2px;">${signal.reason}</div>`
                : nothing
            }
          </div>
        `,
      )}
    </div>
  `;
}

function renderOverrideModeLabel(mode: SpecialistRuntimeSnapshot["override"]["mode"]): string {
  return t(`specialist.override.modes.${mode}`);
}

function resolveOverrideProfileId(snapshot: SpecialistRuntimeSnapshot): string {
  return (
    snapshot.override.sessionProfileId ??
    snapshot.override.baseProfileId ??
    snapshot.selectedProfileId
  );
}

function resolveModeTargetProfileId(
  snapshot: SpecialistRuntimeSnapshot,
  mode: SpecialistRuntimeSnapshot["override"]["mode"],
): string {
  if (mode === "base") {
    return snapshot.override.baseProfileId ?? snapshot.selectedProfileId;
  }
  if (mode === "session") {
    return snapshot.override.sessionProfileId ?? snapshot.selectedProfileId;
  }
  return snapshot.selectedProfileId;
}

function renderSpecialistEmptyState() {
  return html`<div class="callout" style="margin-top: 12px;">${t("specialist.empty")}</div>`;
}

function renderSpecialistLoadingState() {
  return html`<div class="muted" style="margin-top: 12px;">${t("specialist.loading")}</div>`;
}

export function renderSpecialistChatStrip(props: SpecialistContextProps) {
  if (props.error) {
    return html`<div class="callout danger" style="margin-bottom: 12px;">${props.error}</div>`;
  }
  if (props.loading && !props.snapshot) {
    return renderSpecialistLoadingState();
  }
  if (!props.snapshot) {
    return renderSpecialistEmptyState();
  }
  const snapshot = props.snapshot;
  return html`
    <details class="callout" style="margin-bottom: 12px;">
      <summary
        style="display:flex; justify-content:space-between; gap:12px; align-items:center; cursor:pointer;"
      >
        <div>
          <strong>${t("specialist.chatTitle")}</strong>
          <div class="muted" style="margin-top: 2px;">
            ${snapshot.activeProfileLabel} · ${snapshot.recipeId}
          </div>
        </div>
        <span class="chip">${t("specialist.confidence")}: ${formatConfidence(snapshot.confidence)}</span>
      </summary>
      <div style="margin-top: 12px;">
        <div class="muted">${snapshot.reasoningSummary}</div>
        ${renderRuntimeChips(snapshot)}
        ${renderOperationalPosture(snapshot)}
      </div>
    </details>
  `;
}

export function renderSpecialistOverviewPanel(props: SpecialistContextProps) {
  return html`
    <div class="card">
      <div class="card-title">${t("specialist.overviewTitle")}</div>
      <div class="card-sub">${t("specialist.overviewSubtitle")}</div>
      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }
      ${props.loading && !props.snapshot ? renderSpecialistLoadingState() : nothing}
      ${!props.loading && !props.snapshot && !props.error ? renderSpecialistEmptyState() : nothing}
      ${
        props.snapshot
          ? html`
              <div class="stat-grid" style="margin-top: 16px;">
                <div class="stat">
                  <div class="stat-label">${t("specialist.activeProfile")}</div>
                  <div class="stat-value">${props.snapshot.activeProfileLabel}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">${t("specialist.overlay")}</div>
                  <div class="stat-value">${props.snapshot.taskOverlayLabel ?? t("common.na")}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">${t("specialist.recipe")}</div>
                  <div class="stat-value">${props.snapshot.recipeId}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">${t("specialist.confidence")}</div>
                  <div class="stat-value">${formatConfidence(props.snapshot.confidence)}</div>
                </div>
              </div>

              <div class="muted" style="margin-top: 12px;">
                ${t("specialist.selectionLine", {
                  selected: props.snapshot.selectedProfileLabel,
                  base: props.snapshot.baseProfileId,
                  session: props.snapshot.sessionProfileId ?? t("common.na"),
                })}
              </div>

              <div class="callout" style="margin-top: 12px;">
                <strong>${t("specialist.reasoning")}:</strong> ${props.snapshot.reasoningSummary}
              </div>

              ${renderRuntimeChips(props.snapshot)}
              ${renderOperationalPosture(props.snapshot)}
              ${renderCatalogPanel(props)}
              ${renderRuntimeQueuePanel(props)}

              <div style="margin-top: 14px;">
                <div class="muted">${t("specialist.signals")}</div>
                ${renderSignalList(props.snapshot)}
              </div>

              <div style="margin-top: 16px;">
                <div class="card-sub">${t("specialist.override.title")}</div>
                <div class="muted" style="margin-top: 4px;">${t("specialist.override.subtitle")}</div>
                <label class="field" style="margin-top: 10px;">
                  <span>${t("specialist.override.mode")}</span>
                  <select
                    .value=${props.snapshot.override.mode}
                    ?disabled=${!props.onOverrideChange || props.saving}
                    @change=${(event: Event) => {
                      const mode = (event.currentTarget as HTMLSelectElement).value as
                        | "auto"
                        | "base"
                        | "session";
                      if (!props.onOverrideChange) {
                        return;
                      }
                      if (mode === "auto") {
                        props.onOverrideChange({ mode });
                        return;
                      }
                      props.onOverrideChange({
                        mode,
                        profileId: resolveModeTargetProfileId(props.snapshot!, mode),
                      });
                    }}
                  >
                    <option value="auto">${renderOverrideModeLabel("auto")}</option>
                    <option value="base">${renderOverrideModeLabel("base")}</option>
                    <option value="session">${renderOverrideModeLabel("session")}</option>
                  </select>
                </label>
                ${
                  props.snapshot.override.mode !== "auto"
                    ? html`
                        <label class="field" style="margin-top: 10px;">
                          <span>
                            ${
                              props.snapshot.override.mode === "base"
                                ? t("specialist.override.baseProfile")
                                : t("specialist.override.sessionProfile")
                            }
                          </span>
                          <select
                            .value=${resolveOverrideProfileId(props.snapshot)}
                            ?disabled=${!props.onOverrideChange || props.saving}
                            @change=${(event: Event) => {
                              if (!props.onOverrideChange) {
                                return;
                              }
                              const profileId = (event.currentTarget as HTMLSelectElement).value;
                              props.onOverrideChange({
                                mode: props.snapshot!.override.mode as "base" | "session",
                                profileId,
                              });
                            }}
                          >
                            ${props.snapshot.availableProfiles.map(
                              (profile) =>
                                html`<option value=${profile.id}>${profile.label}</option>`,
                            )}
                          </select>
                        </label>
                      `
                    : nothing
                }
                <div class="muted" style="margin-top: 8px;">
                  ${
                    props.saving
                      ? t("specialist.override.saving")
                      : (props.snapshot.override.note ?? t("specialist.override.ready"))
                  }
                </div>
              </div>
            `
          : nothing
      }
    </div>
  `;
}
