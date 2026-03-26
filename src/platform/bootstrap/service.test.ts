import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TRUSTED_CAPABILITY_CATALOG } from "./defaults.js";
import { createBootstrapRequestService } from "./service.js";
import type { BootstrapRequest } from "./contracts.js";

function buildRequest(overrides: Partial<BootstrapRequest> = {}): BootstrapRequest {
  const catalogEntry = TRUSTED_CAPABILITY_CATALOG.find((entry) => entry.capability.id === "pdf-renderer");
  if (!catalogEntry) {
    throw new Error("pdf-renderer catalog entry unavailable");
  }
  return {
    capabilityId: "pdf-renderer",
    installMethod: "download",
    rollbackStrategy: "restore_previous",
    reason: "renderer_unavailable",
    sourceDomain: "document",
    sourceRecipeId: "doc_ingest",
    approvalMode: "explicit",
    catalogEntry,
    ...overrides,
  };
}

describe("bootstrap request service", () => {
  it("creates, lists, and resolves bootstrap requests", () => {
    const service = createBootstrapRequestService();
    const created = service.create(buildRequest());

    expect(service.list()).toEqual([
      expect.objectContaining({
        id: created.id,
        capabilityId: "pdf-renderer",
        state: "pending",
      }),
    ]);

    const approved = service.resolve(created.id, "approve");
    expect(approved?.state).toBe("approved");
    expect(service.get(created.id)?.state).toBe("approved");
  });

  it("reuses an active request with the same signature", () => {
    const service = createBootstrapRequestService();
    const first = service.create(buildRequest());
    const second = service.create(buildRequest());

    expect(second.id).toBe(first.id);
    expect(service.list()).toHaveLength(1);
  });

  it("runs an approved request and stores the orchestration result", async () => {
    const service = createBootstrapRequestService();
    const created = service.create(buildRequest());
    service.resolve(created.id, "approve");

    const result = await service.run({
      id: created.id,
      installers: {
        download: async ({ request }) => ({
          ok: true,
          capability: {
            ...request.catalogEntry.capability,
            trusted: true,
            sandboxed: true,
            installMethod: "download",
            status: "available",
          },
        }),
      },
      availableBins: ["playwright"],
      runHealthCheckCommand: async () => true,
    });

    expect(result?.state).toBe("available");
    expect(result?.result?.status).toBe("bootstrapped");
    expect(result?.result?.lifecycle?.status).toBe("available");
  });

  it("persists the bootstrap audit trail and rehydrates records after restart", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bootstrap-service-"));
    try {
      const service = createBootstrapRequestService({ stateDir });
      const created = service.create(buildRequest());
      service.resolve(created.id, "approve");
      await service.run({
        id: created.id,
        installers: {
          download: async ({ request }) => ({
            ok: true,
            capability: {
              ...request.catalogEntry.capability,
              trusted: true,
              sandboxed: true,
              installMethod: "download",
              status: "available",
            },
          }),
        },
        availableBins: ["playwright"],
        runHealthCheckCommand: async () => true,
      });

      expect(service.getAuditPath()).toMatch(/requests-audit\.jsonl$/);
      const next = createBootstrapRequestService({ stateDir });
      expect(next.rehydrate()).toBe(1);
      expect(next.get(created.id)).toEqual(
        expect.objectContaining({
          id: created.id,
          state: "available",
          result: expect.objectContaining({
            status: "bootstrapped",
          }),
        }),
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
