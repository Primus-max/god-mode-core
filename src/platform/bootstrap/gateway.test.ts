import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPlatformRuntimeCheckpointService,
  resetPlatformRuntimeCheckpointService,
} from "../runtime/index.js";
import type { BootstrapRequest } from "./contracts.js";
import { TRUSTED_CAPABILITY_CATALOG } from "./defaults.js";
import {
  createBootstrapGetGatewayMethod,
  createBootstrapListGatewayMethod,
  createBootstrapResolveGatewayMethod,
  createBootstrapRunGatewayMethod,
} from "./gateway.js";
import { createBootstrapRequestService } from "./service.js";

function buildRequest(overrides: Partial<BootstrapRequest> = {}): BootstrapRequest {
  const catalogEntry = TRUSTED_CAPABILITY_CATALOG.find(
    (entry) => entry.capability.id === "pdf-renderer",
  );
  if (!catalogEntry) {
    throw new Error("pdf-renderer catalog entry unavailable");
  }
  return {
    capabilityId: "pdf-renderer",
    installMethod: catalogEntry.install?.method ?? "node",
    rollbackStrategy: "restore_previous",
    reason: "renderer_unavailable",
    sourceDomain: "document",
    sourceRecipeId: "doc_ingest",
    approvalMode: "explicit",
    catalogEntry,
    ...overrides,
  };
}

function installBootstrapContinuationNoop() {
  getPlatformRuntimeCheckpointService().registerContinuationHandler(
    "bootstrap_run",
    async () => {},
  );
}

describe("bootstrap gateway methods", () => {
  afterEach(() => {
    resetPlatformRuntimeCheckpointService();
  });

  it("lists and fetches bootstrap requests", async () => {
    const service = createBootstrapRequestService();
    const record = service.create(buildRequest());

    const respond = vi.fn();
    await createBootstrapListGatewayMethod(service)({
      params: {},
      req: { type: "req", method: "platform.bootstrap.list", id: "req-1" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        pendingCount: 1,
        requests: [expect.objectContaining({ id: record.id })],
      }),
    );

    const getRespond = vi.fn();
    await createBootstrapGetGatewayMethod(service)({
      params: { requestId: record.id },
      req: { type: "req", method: "platform.bootstrap.get", id: "req-2" },
      client: null,
      isWebchatConnect: () => false,
      respond: getRespond,
      context: {} as never,
    });
    expect(getRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        detail: expect.objectContaining({ id: record.id, state: "pending" }),
      }),
    );
  });

  it("rehydrates requests created by another bootstrap service instance", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bootstrap-gateway-"));
    try {
      const writer = createBootstrapRequestService({ stateDir });
      const reader = createBootstrapRequestService({ stateDir });
      const record = writer.create(buildRequest());

      const listRespond = vi.fn();
      await createBootstrapListGatewayMethod(reader)({
        params: {},
        req: { type: "req", method: "platform.bootstrap.list", id: "req-rehydrate-list" },
        client: null,
        isWebchatConnect: () => false,
        respond: listRespond,
        context: {} as never,
      });
      expect(listRespond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          pendingCount: 1,
          requests: [expect.objectContaining({ id: record.id })],
        }),
      );

      const getRespond = vi.fn();
      await createBootstrapGetGatewayMethod(reader)({
        params: { requestId: record.id },
        req: { type: "req", method: "platform.bootstrap.get", id: "req-rehydrate-get" },
        client: null,
        isWebchatConnect: () => false,
        respond: getRespond,
        context: {} as never,
      });
      expect(getRespond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          detail: expect.objectContaining({ id: record.id, state: "pending" }),
        }),
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("resolves and runs bootstrap requests", async () => {
    const service = createBootstrapRequestService();
    const runtimeService = getPlatformRuntimeCheckpointService();
    installBootstrapContinuationNoop();
    const record = service.create(buildRequest());
    const originalRun = service.run;
    service.run = vi.fn((params) =>
      originalRun({
        ...params,
        installers: {
          node: async ({ request }) => ({
            ok: true,
            capability: {
              ...request.catalogEntry.capability,
              trusted: true,
              sandboxed: true,
              installMethod: "node",
              status: "available",
            },
          }),
        },
        availableBins: ["node"],
        runHealthCheckCommand: async () => true,
      }),
    );

    const resolveRespond = vi.fn();
    await createBootstrapResolveGatewayMethod(service)({
      params: { requestId: record.id, decision: "approve" },
      req: { type: "req", method: "platform.bootstrap.resolve", id: "req-3" },
      client: {
        connId: "conn-bootstrap",
        connect: {
          client: {
            id: "control-ui",
            displayName: "Operator Tanya",
          },
          device: {
            id: "device-bootstrap",
          },
        },
      } as never,
      isWebchatConnect: () => false,
      respond: resolveRespond,
      context: {} as never,
    });
    expect(resolveRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        detail: expect.objectContaining({ state: "approved" }),
      }),
    );
    expect(runtimeService.get(record.id)?.lastOperatorDecision).toEqual(
      expect.objectContaining({
        action: "approve",
        actor: expect.objectContaining({
          displayName: "Operator Tanya",
          deviceId: "device-bootstrap",
        }),
      }),
    );

    const runRespond = vi.fn();
    await createBootstrapRunGatewayMethod(service)({
      params: { requestId: record.id },
      req: { type: "req", method: "platform.bootstrap.run", id: "req-4" },
      client: {
        connId: "conn-bootstrap",
        connect: {
          client: {
            id: "control-ui",
            displayName: "Operator Tanya",
          },
          device: {
            id: "device-bootstrap",
          },
        },
      } as never,
      isWebchatConnect: () => false,
      respond: runRespond,
      context: {} as never,
    });
    expect(runRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        detail: expect.objectContaining({ state: "available" }),
      }),
    );
    expect(runtimeService.get(record.id)?.lastOperatorDecision).toEqual(
      expect.objectContaining({
        action: "run",
        actor: expect.objectContaining({
          displayName: "Operator Tanya",
        }),
      }),
    );
    expect(
      runtimeService.getAction(`bootstrap:${record.id}:run`)?.receipt?.operatorDecision,
    ).toEqual(
      expect.objectContaining({
        action: "run",
        actor: expect.objectContaining({
          deviceId: "device-bootstrap",
        }),
      }),
    );
  });
});
