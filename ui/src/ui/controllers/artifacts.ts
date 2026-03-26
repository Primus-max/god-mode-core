import type { ArtifactOperation } from "../../../../src/platform/schemas/artifact.js";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ArtifactRecordDetail, ArtifactRecordSummary } from "../types.ts";

type ArtifactListResult = {
  artifacts?: ArtifactRecordSummary[];
};

type ArtifactDetailResult = {
  detail?: ArtifactRecordDetail;
};

type ArtifactTransitionResult = {
  detail?: ArtifactRecordDetail;
};

export type ArtifactsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  artifactsLoading: boolean;
  artifactsError: string | null;
  artifactsList: ArtifactRecordSummary[];
  artifactsFilterQuery: string;
  artifactsSelectedId: string | null;
  artifactDetailLoading: boolean;
  artifactDetail: ArtifactRecordDetail | null;
  artifactDetailError: string | null;
  artifactTransitionBusy: boolean;
};

export async function loadArtifacts(state: ArtifactsState) {
  if (!state.client || !state.connected || state.artifactsLoading) {
    return;
  }
  state.artifactsLoading = true;
  state.artifactsError = null;
  try {
    const res = await state.client.request<ArtifactListResult>("platform.artifacts.list", {});
    const artifacts = Array.isArray(res?.artifacts) ? res.artifacts : [];
    state.artifactsList = artifacts;
    const selectedId = artifacts.some((entry) => entry.id === state.artifactsSelectedId)
      ? state.artifactsSelectedId
      : (artifacts[0]?.id ?? null);
    state.artifactsSelectedId = selectedId;
    if (!selectedId) {
      state.artifactDetail = null;
      state.artifactDetailError = null;
      return;
    }
    await loadArtifactDetail(state, selectedId);
  } catch (err) {
    state.artifactsError = String(err);
  } finally {
    state.artifactsLoading = false;
  }
}

export async function loadArtifactDetail(state: ArtifactsState, artifactId?: string | null) {
  const selectedId = artifactId ?? state.artifactsSelectedId;
  if (!state.client || !state.connected || !selectedId || state.artifactDetailLoading) {
    return;
  }
  state.artifactsSelectedId = selectedId;
  state.artifactDetailLoading = true;
  state.artifactDetailError = null;
  try {
    const res = await state.client.request<ArtifactDetailResult>("platform.artifacts.get", {
      artifactId: selectedId,
    });
    state.artifactDetail = res?.detail ?? null;
  } catch (err) {
    state.artifactDetail = null;
    state.artifactDetailError = String(err);
  } finally {
    state.artifactDetailLoading = false;
  }
}

export async function transitionArtifact(
  state: ArtifactsState,
  artifactId: string,
  operation: ArtifactOperation,
) {
  if (!state.client || !state.connected || state.artifactTransitionBusy) {
    return;
  }
  if (
    operation === "delete" &&
    !window.confirm(
      "Delete this artifact?\n\nThis keeps the history in the store but marks the artifact as deleted.",
    )
  ) {
    return;
  }
  state.artifactTransitionBusy = true;
  state.artifactsError = null;
  try {
    const res = await state.client.request<ArtifactTransitionResult>("platform.artifacts.transition", {
      artifactId,
      operation,
    });
    if (res?.detail) {
      state.artifactDetail = res.detail;
      state.artifactsSelectedId = res.detail.descriptor.id;
      state.artifactDetailError = null;
    }
    await loadArtifacts(state);
  } catch (err) {
    state.artifactsError = String(err);
  } finally {
    state.artifactTransitionBusy = false;
  }
}
