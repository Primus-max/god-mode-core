import type {
  MaterializationDocumentInputKind,
  MaterializationOutputTarget,
  MaterializationRenderKind,
  MaterializationRendererTarget,
  MaterializationRequest,
} from "./contracts.js";
import { resolveHtmlBody } from "./html-preview-materializer.js";

export type CanonicalMaterializationRequest = MaterializationRequest & {
  documentInputKind: MaterializationDocumentInputKind;
  rendererTarget: MaterializationRendererTarget;
  title: string;
  htmlBody: string;
};

export function inferDocumentInputKind(
  request: Pick<MaterializationRequest, "documentInputKind" | "payload" | "renderKind">,
): MaterializationDocumentInputKind {
  if (request.documentInputKind) {
    return request.documentInputKind;
  }
  if (request.payload.html) {
    return "html";
  }
  if (request.payload.spec !== undefined || request.payload.jsonData !== undefined) {
    return "spec";
  }
  if (request.payload.markdown) {
    return "markdown";
  }
  if (request.payload.text) {
    return "text";
  }
  return request.renderKind === "markdown" ? "markdown" : "html";
}

export function inferRendererTarget(
  request: Pick<MaterializationRequest, "rendererTarget" | "outputTarget" | "renderKind">,
): MaterializationRendererTarget {
  if (request.rendererTarget) {
    return request.rendererTarget;
  }
  if (request.outputTarget === "preview" || request.renderKind === "site_preview") {
    return "preview";
  }
  if (request.renderKind === "pdf") {
    return "pdf";
  }
  if (request.renderKind === "markdown") {
    return "markdown";
  }
  return "html";
}

export function canonicalizeMaterializationRequest(
  request: MaterializationRequest,
): CanonicalMaterializationRequest {
  const documentInputKind = inferDocumentInputKind(request);
  const rendererTarget = inferRendererTarget(request);
  return {
    ...request,
    documentInputKind,
    rendererTarget,
    title: request.payload.title ?? request.label,
    htmlBody: resolveHtmlBody({
      html: request.payload.html,
      spec: request.payload.spec ?? request.payload.jsonData,
      markdown: request.payload.markdown,
      text: request.payload.text,
      jsonData: request.payload.jsonData,
    }),
  };
}

export function resolveRenderKindFromRendererTarget(params: {
  rendererTarget: MaterializationRendererTarget;
  outputTarget: MaterializationOutputTarget;
}): MaterializationRenderKind {
  if (params.rendererTarget === "preview" || params.outputTarget === "preview") {
    return "site_preview";
  }
  if (params.rendererTarget === "pdf") {
    return "pdf";
  }
  if (params.rendererTarget === "markdown") {
    return "markdown";
  }
  return "html";
}
