import type { GatewayBrowserClient } from "../gateway.ts";
import type { BootstrapRequestRecordDetail, BootstrapRequestRecordSummary } from "../types.ts";

type BootstrapListResult = {
  requests?: BootstrapRequestRecordSummary[];
  pendingCount?: number;
};

type BootstrapDetailResult = {
  detail?: BootstrapRequestRecordDetail;
};

export type BootstrapState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  bootstrapLoading: boolean;
  bootstrapError: string | null;
  bootstrapList: BootstrapRequestRecordSummary[];
  bootstrapPendingCount: number;
  bootstrapFilterQuery: string;
  bootstrapSelectedId: string | null;
  bootstrapDetailLoading: boolean;
  bootstrapDetail: BootstrapRequestRecordDetail | null;
  bootstrapDetailError: string | null;
  bootstrapActionBusy: boolean;
};

export async function loadBootstrapRequests(state: BootstrapState) {
  if (!state.client || !state.connected || state.bootstrapLoading) {
    return;
  }
  state.bootstrapLoading = true;
  state.bootstrapError = null;
  try {
    const res = await state.client.request<BootstrapListResult>("platform.bootstrap.list", {});
    const requests = Array.isArray(res?.requests) ? res.requests : [];
    state.bootstrapList = requests;
    state.bootstrapPendingCount =
      typeof res?.pendingCount === "number"
        ? res.pendingCount
        : requests.filter((entry) => entry.state === "pending").length;
    const selectedId = requests.some((entry) => entry.id === state.bootstrapSelectedId)
      ? state.bootstrapSelectedId
      : (requests[0]?.id ?? null);
    state.bootstrapSelectedId = selectedId;
    if (!selectedId) {
      state.bootstrapDetail = null;
      state.bootstrapDetailError = null;
      return;
    }
    await loadBootstrapDetail(state, selectedId);
  } catch (err) {
    state.bootstrapError = String(err);
  } finally {
    state.bootstrapLoading = false;
  }
}

export async function loadBootstrapDetail(state: BootstrapState, requestId?: string | null) {
  const selectedId = requestId ?? state.bootstrapSelectedId;
  if (!state.client || !state.connected || !selectedId || state.bootstrapDetailLoading) {
    return;
  }
  state.bootstrapSelectedId = selectedId;
  state.bootstrapDetailLoading = true;
  state.bootstrapDetailError = null;
  try {
    const res = await state.client.request<BootstrapDetailResult>("platform.bootstrap.get", {
      requestId: selectedId,
    });
    state.bootstrapDetail = res?.detail ?? null;
  } catch (err) {
    state.bootstrapDetail = null;
    state.bootstrapDetailError = String(err);
  } finally {
    state.bootstrapDetailLoading = false;
  }
}

export async function resolveBootstrapRequest(
  state: BootstrapState,
  requestId: string,
  decision: "approve" | "deny",
) {
  if (!state.client || !state.connected || state.bootstrapActionBusy) {
    return;
  }
  state.bootstrapActionBusy = true;
  state.bootstrapError = null;
  try {
    const res = await state.client.request<BootstrapDetailResult>("platform.bootstrap.resolve", {
      requestId,
      decision,
    });
    if (res?.detail) {
      state.bootstrapDetail = res.detail;
      state.bootstrapSelectedId = res.detail.id;
      state.bootstrapDetailError = null;
    }
    await loadBootstrapRequests(state);
  } catch (err) {
    state.bootstrapError = String(err);
  } finally {
    state.bootstrapActionBusy = false;
  }
}

export async function runBootstrapRequest(state: BootstrapState, requestId: string) {
  if (!state.client || !state.connected || state.bootstrapActionBusy) {
    return;
  }
  state.bootstrapActionBusy = true;
  state.bootstrapError = null;
  try {
    const res = await state.client.request<BootstrapDetailResult>("platform.bootstrap.run", {
      requestId,
    });
    if (res?.detail) {
      state.bootstrapDetail = res.detail;
      state.bootstrapSelectedId = res.detail.id;
      state.bootstrapDetailError = null;
    }
    await loadBootstrapRequests(state);
  } catch (err) {
    state.bootstrapError = String(err);
  } finally {
    state.bootstrapActionBusy = false;
  }
}
