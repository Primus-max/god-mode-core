export {
  MaterializationOutputTargetSchema,
  MaterializationPayloadSchema,
  MaterializationRenderKindSchema,
  MaterializationRequestSchema,
  MaterializationResultSchema,
  MaterializationSourceDomainSchema,
  MaterializedArtifactOutputSchema,
  type MaterializationOutputTarget,
  type MaterializationPayload,
  type MaterializationRenderKind,
  type MaterializationRequest,
  type MaterializationResult,
  type MaterializationSourceDomain,
  type MaterializedArtifactOutput,
} from "./contracts.js";

export { escapeHtml, renderMarkdownToHtml } from "./markdown-report-materializer.js";
export {
  buildHtmlDocument,
  resolveHtmlBody,
  writeHtmlMaterialization,
} from "./html-preview-materializer.js";
export { writePdfMaterialization } from "./pdf-materializer.js";
export { applyMaterializationToDescriptor, materializeArtifact } from "./render.js";
