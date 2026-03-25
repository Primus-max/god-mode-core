import type { CapabilityCatalogEntry } from "../schemas/capability.js";

export const TRUSTED_CAPABILITY_CATALOG: CapabilityCatalogEntry[] = [
  {
    capability: {
      id: "pdf-renderer",
      label: "PDF Renderer",
      status: "missing",
      trusted: true,
      requiredBins: ["playwright"],
      healthCheckCommand: "playwright --version",
      tags: ["pdf", "render"],
    },
    source: "catalog",
    install: {
      method: "download",
      packageRef: "playwright-pdf-renderer@1.0.0",
      integrity: "sha256:trusted-pdf-renderer",
      sandboxed: true,
      rollbackStrategy: "restore_previous",
    },
  },
  {
    capability: {
      id: "pdf-parser",
      label: "PDF Parser",
      status: "missing",
      trusted: true,
      requiredBins: ["node"],
      tags: ["pdf", "parse"],
    },
    source: "catalog",
    install: {
      method: "node",
      packageRef: "@openclaw/pdf-parser@1.0.0",
      integrity: "sha256:trusted-pdf-parser",
      rollbackStrategy: "restore_previous",
    },
  },
  {
    capability: {
      id: "ocr-engine",
      label: "OCR Engine",
      status: "missing",
      trusted: true,
      tags: ["ocr"],
    },
    source: "catalog",
    install: {
      method: "download",
      packageRef: "ocr-engine-bundle@1.0.0",
      integrity: "sha256:trusted-ocr-engine",
      sandboxed: true,
      rollbackStrategy: "keep_failed",
    },
  },
  {
    capability: {
      id: "table-parser",
      label: "Table Parser",
      status: "missing",
      trusted: true,
      requiredBins: ["node"],
      tags: ["table", "parse"],
    },
    source: "catalog",
    install: {
      method: "node",
      packageRef: "@openclaw/table-parser@1.0.0",
      integrity: "sha256:trusted-table-parser",
      rollbackStrategy: "restore_previous",
    },
  },
];
