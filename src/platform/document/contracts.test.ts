import { describe, expect, it } from "vitest";
import {
  DocumentRuntimeRequestSchema,
  DocumentRuntimeResultSchema,
  DocumentTaskDescriptorSchema,
} from "./contracts.js";
import { DOCUMENT_TASK_DESCRIPTORS, getDocumentTaskDescriptor } from "./defaults.js";

describe("document runtime contracts", () => {
  it.each(DOCUMENT_TASK_DESCRIPTORS)(
    "$id validates as a document task descriptor",
    (descriptor) => {
      expect(DocumentTaskDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    },
  );

  it("accepts a document runtime request", () => {
    const request = {
      route: "ocr_extract",
      instructions: "Extract all stamped text and totals from the scan.",
      input: {
        fileName: "site-scan.png",
        mimeType: "image/png",
        pageCount: 1,
        artifactKind: "document",
        hints: {
          needsOcr: true,
          preferStructuredOutput: true,
        },
      },
    };

    expect(DocumentRuntimeRequestSchema.parse(request)).toEqual(request);
  });

  it("accepts a document runtime result with structured artifacts", () => {
    const result = {
      route: "table_extract",
      backendId: "fake-table-engine",
      artifacts: [
        {
          type: "extraction",
          fields: [{ key: "currency", valueType: "string", value: "USD" }],
        },
        {
          type: "export",
          format: "json",
          fileName: "tables.json",
        },
      ],
    };

    expect(DocumentRuntimeResultSchema.parse(result)).toEqual(result);
  });

  it("resolves default task descriptors by route", () => {
    expect(getDocumentTaskDescriptor("doc_ingest")?.label).toBe("Document Ingest");
    expect(getDocumentTaskDescriptor("ocr_extract")?.requiredCapabilities).toEqual(["ocr-engine"]);
    expect(getDocumentTaskDescriptor("table_extract")?.outputTypes).toEqual([
      "extraction",
      "export",
    ]);
  });
});
