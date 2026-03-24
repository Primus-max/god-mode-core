import { describe, expect, it } from "vitest";
import { CapabilityCatalogEntrySchema, CapabilityDescriptorSchema } from "./capability.js";

describe("CapabilityDescriptorSchema", () => {
  const minimal = {
    id: "node",
    label: "Node.js",
    status: "available",
    trusted: true,
  } as const;

  it("accepts a minimal descriptor", () => {
    expect(CapabilityDescriptorSchema.parse(minimal)).toEqual(minimal);
  });

  it("accepts a full descriptor", () => {
    const full = {
      id: "pdf-table-extractor",
      label: "PDF Table Extractor",
      description: "Extract tables from PDF documents",
      version: "2.1.0",
      status: "available",
      installMethod: "node",
      trusted: true,
      sandboxed: true,
      os: ["linux", "darwin"],
      requiredBins: ["node"],
      requiredEnv: ["EXTRACTOR_API_KEY"],
      healthCheckCommand: "extractor --version",
      tags: ["pdf", "table", "extraction"],
    };
    expect(CapabilityDescriptorSchema.parse(full)).toEqual(full);
  });

  it("rejects unknown status", () => {
    expect(
      CapabilityDescriptorSchema.safeParse({ ...minimal, status: "broken" }).success,
    ).toBe(false);
  });

  it("rejects unknown os value", () => {
    expect(
      CapabilityDescriptorSchema.safeParse({ ...minimal, os: ["freebsd"] }).success,
    ).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      CapabilityDescriptorSchema.safeParse({ ...minimal, extra: 1 }).success,
    ).toBe(false);
  });
});

describe("CapabilityCatalogEntrySchema", () => {
  it("accepts a builtin entry", () => {
    const entry = {
      capability: { id: "git", label: "Git", status: "available", trusted: true },
      source: "builtin",
    };
    expect(CapabilityCatalogEntrySchema.parse(entry)).toEqual(entry);
  });

  it("accepts a catalog entry with packageRef", () => {
    const entry = {
      capability: { id: "ollama-local", label: "Ollama Local", status: "missing", trusted: true },
      packageRef: "ollama-local-tier@1.0.0",
      source: "catalog",
    };
    expect(CapabilityCatalogEntrySchema.parse(entry)).toEqual(entry);
  });
});
