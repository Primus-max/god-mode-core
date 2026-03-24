import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeFieldKey,
  extractDocumentArtifactPayloads,
  normalizeDocumentArtifacts,
  normalizeReport,
} from "./index.js";

function readFixture(name: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, "__fixtures__", name), "utf-8");
}

describe("document normalization", () => {
  it("canonicalizes noisy field keys deterministically", () => {
    expect(canonicalizeFieldKey("Permit No.")).toBe("permit_number");
    expect(canonicalizeFieldKey("Estimated Cost")).toBe("estimated_cost");
    expect(canonicalizeFieldKey("Approved?")).toBe("approved");
  });

  it("normalizes noisy OCR fields into a stable extraction shape", () => {
    const payloads = extractDocumentArtifactPayloads(
      [readFixture("ocr-extract-noisy.json")],
      "ocr_extract",
    );
    const normalized = normalizeDocumentArtifacts("ocr_extract", payloads);
    const extraction = normalized[0]?.normalized;

    expect(extraction?.type).toBe("extraction");
    if (!extraction || extraction.type !== "extraction") {
      throw new Error("expected extraction artifact");
    }
    expect(extraction).toMatchObject({
      route: "ocr_extract",
      fieldCount: 3,
      tableCount: 0,
      plainText: expect.stringContaining("Permit No."),
    });
    expect(extraction?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "approved",
          booleanValue: true,
          valueText: "yes",
        }),
        expect.objectContaining({
          key: "estimated_cost",
          numberValue: 12450,
        }),
        expect.objectContaining({
          key: "permit_number",
          sourceKeys: ["Permit No.", "permit number"],
        }),
      ]),
    );
  });

  it("normalizes uneven table extracts into stable headers and padded rows", () => {
    const payloads = extractDocumentArtifactPayloads(
      [readFixture("table-extract-uneven.json")],
      "table_extract",
    );
    const normalized = normalizeDocumentArtifacts("table_extract", payloads);
    const extraction = normalized[0]?.normalized;
    const exportPayload = normalized[1]?.normalized;

    expect(extraction?.type).toBe("extraction");
    if (!extraction || extraction.type !== "extraction") {
      throw new Error("expected extraction artifact");
    }
    expect(extraction.tables[0]).toMatchObject({
      headers: ["item", "item_2", "price"],
      rowCount: 3,
      columnCount: 3,
    });
    expect(extraction.tables[0]?.rows[1]).toEqual({
      item: "Steel",
      item_2: "Secondary",
      price: "",
    });

    expect(exportPayload?.type).toBe("export");
    if (!exportPayload || exportPayload.type !== "export") {
      throw new Error("expected export artifact");
    }
    expect(exportPayload).toMatchObject({
      columns: ["extra_notes", "item_name", "unit_price"],
      rowCount: 2,
    });
    expect(exportPayload.previewRows[1]).toEqual({
      extra_notes: "secondary",
      item_name: "Steel",
      unit_price: null,
    });
  });

  it("derives report summaries when they are omitted", () => {
    const normalized = normalizeReport({
      type: "report",
      format: "markdown",
      content: "# Summary\n\nThe estimate includes 12 line items.\n\n## Risks\nBudget is tight.",
    });

    expect(normalized.summary).toBe("The estimate includes 12 line items.");
    expect(normalized.sections).toEqual([]);
  });
});
