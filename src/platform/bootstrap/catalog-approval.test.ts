import { describe, expect, it } from "vitest";
import type { CapabilityCatalogEntry } from "../schemas/capability.js";
import { TRUSTED_CAPABILITY_CATALOG } from "./defaults.js";
import {
  assertApprovedCatalogEntryOrThrow,
  catalogEntryMatchesApprovedSnapshot,
  getApprovedCapabilityCatalogEntry,
  listApprovedCapabilityCatalogIds,
} from "./catalog-approval.js";

describe("catalog approval helpers", () => {
  it("lists stable approved ids in deterministic order", () => {
    const ids = listApprovedCapabilityCatalogIds();
    expect(ids).toEqual(TRUSTED_CAPABILITY_CATALOG.map((e) => e.capability.id));
  });

  it("returns canonical entries for approved ids", () => {
    const entry = getApprovedCapabilityCatalogEntry("pdf-renderer");
    expect(entry?.capability.id).toBe("pdf-renderer");
    expect(entry?.install?.downloadUrl).toContain("openclaw.ai");
  });

  it("matches approved snapshots exactly", () => {
    const canonical = TRUSTED_CAPABILITY_CATALOG.find((e) => e.capability.id === "pdf-parser")!;
    expect(catalogEntryMatchesApprovedSnapshot(canonical)).toBe(true);
  });

  it("rejects tampered catalog entries", () => {
    const canonical = TRUSTED_CAPABILITY_CATALOG.find((e) => e.capability.id === "pdf-parser")!;
    const tampered: CapabilityCatalogEntry = {
      ...canonical,
      install: {
        ...canonical.install!,
        packageRef: "@evil/pdf-parser@1.0.0",
      },
    };
    expect(catalogEntryMatchesApprovedSnapshot(tampered)).toBe(false);
    expect(() => assertApprovedCatalogEntryOrThrow(tampered)).toThrow(/does not match the approved catalog snapshot/);
  });

  it("rejects unknown capability ids", () => {
    const alien: CapabilityCatalogEntry = {
      capability: {
        id: "alien-tool",
        label: "Alien",
        status: "missing",
        trusted: true,
        requiredBins: ["alien"],
      },
      source: "catalog",
      install: {
        method: "download",
        packageRef: "alien-tool@1.0.0",
        integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        downloadUrl: "https://openclaw.ai/bootstrap/alien-tool-1.0.0.tgz",
        archiveKind: "tar",
        rollbackStrategy: "restore_previous",
      },
    };
    expect(() => assertApprovedCatalogEntryOrThrow(alien)).toThrow(/not in the approved capability catalog/);
  });
});
