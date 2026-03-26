import type { GatewayBrowserClient } from "../gateway.ts";
import type { SpecialistRuntimeSnapshot } from "../types.ts";

const specialistDraftTimers = new WeakMap<object, number>();
const specialistRequestSeq = new WeakMap<object, number>();
const SPECIALIST_REFRESH_DEBOUNCE_MS = 250;

export type SpecialistState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  specialistLoading: boolean;
  specialistSaving: boolean;
  specialistError: string | null;
  specialistSnapshot: SpecialistRuntimeSnapshot | null;
};

type SaveSpecialistOverrideArgs =
  | { mode: "auto" }
  | { mode: "base"; profileId: string }
  | { mode: "session"; profileId: string };

function nextRequestSeq(state: object): number {
  const next = (specialistRequestSeq.get(state) ?? 0) + 1;
  specialistRequestSeq.set(state, next);
  return next;
}

function isLatestRequest(state: object, requestSeq: number): boolean {
  return specialistRequestSeq.get(state) === requestSeq;
}

export async function loadSpecialistContext(
  state: SpecialistState,
  opts?: { draft?: string },
): Promise<void> {
  if (!state.client || !state.connected) {
    state.specialistLoading = false;
    state.specialistError = null;
    state.specialistSnapshot = null;
    return;
  }

  const requestSeq = nextRequestSeq(state);
  state.specialistLoading = true;
  state.specialistError = null;
  try {
    const res = await state.client.request<SpecialistRuntimeSnapshot>("platform.profile.resolve", {
      sessionKey: state.sessionKey,
      ...(opts?.draft != null ? { draft: opts.draft } : {}),
    });
    if (!isLatestRequest(state, requestSeq)) {
      return;
    }
    state.specialistSnapshot = res ?? null;
  } catch (err) {
    if (!isLatestRequest(state, requestSeq)) {
      return;
    }
    state.specialistError = String(err);
  } finally {
    if (isLatestRequest(state, requestSeq)) {
      state.specialistLoading = false;
    }
  }
}

export async function saveSpecialistOverride(
  state: SpecialistState,
  args: SaveSpecialistOverrideArgs,
): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  state.specialistSaving = true;
  state.specialistError = null;
  try {
    if (args.mode === "auto") {
      await state.client.request("sessions.patch", {
        key: state.sessionKey,
        specialistOverrideMode: "auto",
      });
    } else if (args.mode === "base") {
      await state.client.request("sessions.patch", {
        key: state.sessionKey,
        specialistOverrideMode: "base",
        specialistBaseProfileId: args.profileId,
      });
    } else {
      await state.client.request("sessions.patch", {
        key: state.sessionKey,
        specialistOverrideMode: "session",
        specialistSessionProfileId: args.profileId,
      });
    }
    await loadSpecialistContext(state, { draft: "" });
  } catch (err) {
    state.specialistError = String(err);
  } finally {
    state.specialistSaving = false;
  }
}

export function scheduleSpecialistContextRefresh(
  state: SpecialistState,
  draft: string,
  delayMs = SPECIALIST_REFRESH_DEBOUNCE_MS,
): void {
  const existing = specialistDraftTimers.get(state);
  if (existing != null) {
    window.clearTimeout(existing);
  }
  const timer = window.setTimeout(() => {
    specialistDraftTimers.delete(state);
    void loadSpecialistContext(state, { draft });
  }, delayMs);
  specialistDraftTimers.set(state, timer);
}
