export {
  DocumentArtifactPayloadSchema,
  DocumentArtifactTypeSchema,
  DocumentExportArtifactSchema,
  DocumentExportFormatSchema,
  DocumentExtractedFieldSchema,
  DocumentExtractionArtifactSchema,
  DocumentFieldValueTypeSchema,
  DocumentReportArtifactSchema,
  DocumentReportFormatSchema,
  DocumentTableSchema,
  type DocumentArtifactPayload,
  type DocumentArtifactType,
  type DocumentExportArtifact,
  type DocumentExportFormat,
  type DocumentExtractedField,
  type DocumentExtractionArtifact,
  type DocumentFieldValueType,
  type DocumentReportArtifact,
  type DocumentReportFormat,
  type DocumentTable,
} from "./artifacts.js";

export {
  DocumentBackendDescriptorSchema,
  DocumentBackendKindSchema,
  DocumentInputDescriptorSchema,
  DocumentInputHintsSchema,
  DocumentRuntimeRequestSchema,
  DocumentRuntimeResultSchema,
  DocumentRuntimeRouteSchema,
  DocumentTaskDescriptorSchema,
  type DocumentBackendDescriptor,
  type DocumentBackendKind,
  type DocumentInputDescriptor,
  type DocumentInputHints,
  type DocumentRuntimeRequest,
  type DocumentRuntimeResult,
  type DocumentRuntimeRoute,
  type DocumentTaskDescriptor,
} from "./contracts.js";

export { DOCUMENT_TASK_DESCRIPTORS, getDocumentTaskDescriptor } from "./defaults.js";

export {
  captureDocumentArtifactsFromLlmOutput,
  extractDocumentArtifactPayloads,
  listCapturedDocumentArtifacts,
  projectDocumentArtifacts,
  resetCapturedDocumentArtifacts,
} from "./artifact-projection.js";

export { materializeDocumentDescriptor } from "./materialize.js";

export {
  NormalizedDocumentArtifactSchema,
  NormalizedDocumentExportSchema,
  NormalizedDocumentExtractionSchema,
  NormalizedDocumentFieldSchema,
  NormalizedDocumentReportSchema,
  NormalizedDocumentTableSchema,
  normalizeDocumentArtifact,
  normalizeDocumentArtifacts,
  type NormalizedDocumentArtifact,
  type NormalizedDocumentArtifactBundle,
  type NormalizedDocumentExport,
  type NormalizedDocumentExtraction,
  type NormalizedDocumentField,
  type NormalizedDocumentReport,
  type NormalizedDocumentReportArtifact,
  type NormalizedDocumentTable,
} from "./normalize.js";

export { canonicalizeFieldKey, normalizeExtractedFields } from "./normalize-fields.js";
export { normalizePreviewRows, normalizeTables } from "./normalize-tables.js";
export { normalizeReport } from "./normalize-report.js";
