import { describe, expect, it } from "vitest";
import {
  DocumentArtifactPayloadSchema,
  DocumentExportArtifactSchema,
  DocumentExtractionArtifactSchema,
  DocumentReportArtifactSchema,
} from "./artifacts.js";

describe("document artifact payload schemas", () => {
  it("accepts extraction artifacts with fields and tables", () => {
    const artifact = {
      type: "extraction",
      sourceArtifactId: "estimate.pdf",
      fields: [
        {
          key: "project_total",
          label: "Project Total",
          valueType: "currency",
          value: "$12,450",
          confidence: 0.94,
          pageRefs: [1],
        },
      ],
      tables: [
        {
          id: "line-items",
          title: "Line Items",
          headers: ["Item", "Qty", "Price"],
          rows: [["Concrete", "12", "1000"]],
        },
      ],
    };

    expect(DocumentExtractionArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(DocumentArtifactPayloadSchema.parse(artifact)).toEqual(artifact);
  });

  it("accepts report artifacts", () => {
    const artifact = {
      type: "report",
      format: "markdown",
      content: "# Summary\n\nThe estimate includes 12 line items.",
      sections: ["summary", "risks"],
    };

    expect(DocumentReportArtifactSchema.parse(artifact)).toEqual(artifact);
  });

  it("accepts export artifacts", () => {
    const artifact = {
      type: "export",
      format: "csv",
      fileName: "estimate-lines.csv",
      mimeType: "text/csv",
      previewRows: [{ Item: "Concrete", Qty: 12 }],
    };

    expect(DocumentExportArtifactSchema.parse(artifact)).toEqual(artifact);
  });

  it("rejects unknown artifact payload types", () => {
    expect(
      DocumentArtifactPayloadSchema.safeParse({ type: "summary", content: "nope" }).success,
    ).toBe(false);
  });
});
