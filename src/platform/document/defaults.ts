import { DocumentTaskDescriptorSchema } from "./contracts.js";
import type { DocumentRuntimeRoute, DocumentTaskDescriptor } from "./contracts.js";

export const DOCUMENT_TASK_DESCRIPTORS: DocumentTaskDescriptor[] = [
  {
    id: "doc_ingest",
    route: "doc_ingest",
    label: "Document Ingest",
    description: "Parse a document into structured fields and a lightweight report.",
    acceptedMimeTypes: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
    ],
    requiredCapabilities: ["pdf-parser"],
    backendKinds: ["parser"],
    outputTypes: ["extraction", "report"],
  },
  {
    id: "ocr_extract",
    route: "ocr_extract",
    label: "OCR Extract",
    description:
      "Extract structured text and fields from scans, screenshots, and image-heavy pages.",
    acceptedMimeTypes: ["application/pdf", "image/jpeg", "image/png", "image/webp"],
    requiredCapabilities: ["ocr-engine"],
    backendKinds: ["ocr"],
    outputTypes: ["extraction", "report"],
  },
  {
    id: "table_extract",
    route: "table_extract",
    label: "Table Extract",
    description: "Extract tables into structured rows suitable for downstream exports.",
    acceptedMimeTypes: [
      "application/pdf",
      "text/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "image/jpeg",
      "image/png",
    ],
    requiredCapabilities: ["table-parser"],
    backendKinds: ["parser", "table"],
    outputTypes: ["extraction", "export"],
  },
];

for (const descriptor of DOCUMENT_TASK_DESCRIPTORS) {
  DocumentTaskDescriptorSchema.parse(descriptor);
}

export function getDocumentTaskDescriptor(
  route: DocumentRuntimeRoute,
): DocumentTaskDescriptor | undefined {
  return DOCUMENT_TASK_DESCRIPTORS.find((descriptor) => descriptor.route === route);
}
