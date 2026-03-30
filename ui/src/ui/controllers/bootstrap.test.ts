import { describe, expect, it, vi } from "vitest";
import {
  loadBootstrapDetail,
  loadBootstrapRequests,
  resolveBootstrapRequest,
  runBootstrapRequest,
  type BootstrapState,
} from "./bootstrap.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createState(request: RequestFn, overrides: Partial<BootstrapState> = {}): BootstrapState {
  return {
    client: { request } as unknown as BootstrapState["client"],
    connected: true,
    bootstrapLoading: false,
    bootstrapError: null,
    bootstrapList: [],
    bootstrapPendingCount: 0,
    bootstrapFilterQuery: "",
    bootstrapSelectedId: null,
    bootstrapDetailLoading: false,
    bootstrapDetail: null,
    bootstrapDetailError: null,
    bootstrapActionBusy: false,
    ...overrides,
  };
}

describe("bootstrap controller", () => {
  it("loads the list and selected detail", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "platform.bootstrap.list") {
        return {
          pendingCount: 1,
          requests: [
            {
              id: "bootstrap-1",
              capabilityId: "pdf-renderer",
              installMethod: "download",
              reason: "renderer_unavailable",
              sourceDomain: "document",
              state: "pending",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              hasResult: false,
            },
          ],
        };
      }
      if (method === "platform.bootstrap.get") {
        expect(params).toEqual({ requestId: "bootstrap-1" });
        return {
          detail: {
            id: "bootstrap-1",
            state: "pending",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            request: {
              capabilityId: "pdf-renderer",
              installMethod: "download",
              reason: "renderer_unavailable",
              sourceDomain: "document",
              approvalMode: "explicit",
              catalogEntry: {
                capability: {
                  id: "pdf-renderer",
                  version: "1.0.0",
                  trustLevel: "trusted",
                  status: "missing",
                },
                install: {
                  method: "download",
                  packageRef: "@openclaw/pdf-renderer",
                  sandboxed: true,
                  rollbackStrategy: "restore_previous",
                },
                healthChecks: [{ kind: "binary", name: "playwright" }],
              },
            },
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);

    await loadBootstrapRequests(state);

    expect(state.bootstrapSelectedId).toBe("bootstrap-1");
    expect(state.bootstrapPendingCount).toBe(1);
    expect(state.bootstrapDetail?.id).toBe("bootstrap-1");
  });

  it("resolves and runs a request, then refreshes the list", async () => {
    let runInvoked = false;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "platform.bootstrap.resolve") {
        expect(params).toEqual({ requestId: "bootstrap-1", decision: "approve" });
        return {
          detail: {
            id: "bootstrap-1",
            state: "approved",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            request: {
              capabilityId: "pdf-renderer",
              installMethod: "download",
              reason: "renderer_unavailable",
              sourceDomain: "document",
              approvalMode: "explicit",
              catalogEntry: {
                capability: {
                  id: "pdf-renderer",
                  version: "1.0.0",
                  trustLevel: "trusted",
                  status: "missing",
                },
                install: {
                  method: "download",
                  packageRef: "@openclaw/pdf-renderer",
                  sandboxed: true,
                  rollbackStrategy: "restore_previous",
                },
                healthChecks: [{ kind: "binary", name: "playwright" }],
              },
            },
          },
        };
      }
      if (method === "platform.bootstrap.run") {
        runInvoked = true;
        expect(params).toEqual({ requestId: "bootstrap-1" });
        return {
          detail: {
            id: "bootstrap-1",
            state: "available",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            request: {
              capabilityId: "pdf-renderer",
              installMethod: "download",
              reason: "renderer_unavailable",
              sourceDomain: "document",
              approvalMode: "explicit",
              catalogEntry: {
                capability: {
                  id: "pdf-renderer",
                  version: "1.0.0",
                  trustLevel: "trusted",
                  status: "available",
                },
                install: {
                  method: "download",
                  packageRef: "@openclaw/pdf-renderer",
                  sandboxed: true,
                  rollbackStrategy: "restore_previous",
                },
                healthChecks: [{ kind: "binary", name: "playwright" }],
              },
            },
            result: {
              capabilityId: "pdf-renderer",
              status: "bootstrapped",
              request: {
                capabilityId: "pdf-renderer",
                installMethod: "download",
                reason: "renderer_unavailable",
                sourceDomain: "document",
                approvalMode: "explicit",
                catalogEntry: {
                  capability: {
                    id: "pdf-renderer",
                    version: "1.0.0",
                    trustLevel: "trusted",
                    status: "missing",
                  },
                  install: {
                    method: "download",
                    packageRef: "@openclaw/pdf-renderer",
                    sandboxed: true,
                    rollbackStrategy: "restore_previous",
                  },
                  healthChecks: [{ kind: "binary", name: "playwright" }],
                },
              },
              policy: {
                allowCapabilityBootstrap: true,
                allowPrivilegedTools: true,
                requireExplicitApproval: false,
                reasons: [],
                deniedReasons: [],
              },
            },
          },
        };
      }
      if (method === "platform.bootstrap.list") {
        return {
          pendingCount: runInvoked ? 0 : 0,
          requests: [
            {
              id: "bootstrap-1",
              capabilityId: "pdf-renderer",
              installMethod: "download",
              reason: "renderer_unavailable",
              sourceDomain: "document",
              state: runInvoked ? "available" : "approved",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              ...(runInvoked
                ? { lastResultStatus: "bootstrapped", hasResult: true }
                : { hasResult: false }),
            },
          ],
        };
      }
      if (method === "platform.bootstrap.get") {
        return {
          detail: {
            id: "bootstrap-1",
            state: runInvoked ? "available" : "approved",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            request: {
              capabilityId: "pdf-renderer",
              installMethod: "download",
              reason: "renderer_unavailable",
              sourceDomain: "document",
              approvalMode: "explicit",
              catalogEntry: {
                capability: {
                  id: "pdf-renderer",
                  version: "1.0.0",
                  trustLevel: "trusted",
                  status: runInvoked ? "available" : "missing",
                },
                install: {
                  method: "download",
                  packageRef: "@openclaw/pdf-renderer",
                  sandboxed: true,
                  rollbackStrategy: "restore_previous",
                },
                healthChecks: [{ kind: "binary", name: "playwright" }],
              },
            },
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request, { bootstrapSelectedId: "bootstrap-1" });

    await resolveBootstrapRequest(state, "bootstrap-1", "approve");
    expect(state.bootstrapDetail?.state).toBe("approved");

    await runBootstrapRequest(state, "bootstrap-1");
    expect(state.bootstrapDetail?.state).toBe("available");
    expect(state.bootstrapPendingCount).toBe(0);
  });

  it("stores detail errors without throwing", async () => {
    const request = vi.fn(async () => {
      throw new Error("detail failed");
    });
    const state = createState(request, { bootstrapSelectedId: "bootstrap-1" });

    await loadBootstrapDetail(state);

    expect(state.bootstrapDetail).toBeNull();
    expect(state.bootstrapDetailError).toContain("detail failed");
  });
});
