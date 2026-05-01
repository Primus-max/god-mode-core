import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TRUSTED_CAPABILITY_CATALOG,
  getPlatformBootstrapService,
  orchestrateBootstrapRequest,
  resolveBootstrapRequest,
  type BootstrapInstaller,
  type BootstrapOrchestrationResult,
  type BootstrapRequestService,
} from "../bootstrap/index.js";
import type { PlatformExecutionContextSnapshot } from "../decision/contracts.js";
import type { PolicyContext } from "../policy/types.js";
import { createCapabilityRegistry } from "../registry/capability-registry.js";
import type { CapabilityRegistry } from "../registry/types.js";
import { getPlatformRuntimeCheckpointService } from "../runtime/service.js";
import type { ArtifactDescriptor } from "../schemas/artifact.js";
import type { CapabilityCatalogEntry, CapabilityInstallMethod } from "../schemas/capability.js";
import {
  MaterializationRequestSchema,
  MaterializationResultSchema,
  type MaterializationDocumentInputKind,
  type MaterializationRenderKind,
  type MaterializationRendererTarget,
  type MaterializationRequest,
  type MaterializationResult,
} from "./contracts.js";
import { writeHtmlMaterialization } from "./html-preview-materializer.js";
import { writePdfMaterialization } from "./pdf-materializer.js";
import {
  DEFAULT_RENDERER_REGISTRY,
  resolveFallbackRenderer,
  resolveRendererDefinition,
  type RendererDefinition,
} from "./renderer-registry.js";
import {
  canonicalizeMaterializationRequest,
  type CanonicalMaterializationRequest,
} from "./request-normalizer.js";

function sanitizeFilePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function resolveOutputDir(request: MaterializationRequest): string {
  if (request.outputDir) {
    return request.outputDir;
  }
  return path.join(
    os.tmpdir(),
    "openclaw-platform-artifacts",
    sanitizeFilePart(request.artifactId),
  );
}

function resolveBaseFileName(request: MaterializationRequest): string {
  return sanitizeFilePart(request.baseFileName ?? request.label) || "artifact";
}

function writeTextFile(params: {
  outputDir: string;
  baseFileName: string;
  extension: "md" | "txt";
  contents: string;
  mimeType: string;
  renderKind: MaterializationRenderKind;
  documentInputKind?: MaterializationDocumentInputKind;
  rendererTarget?: MaterializationRendererTarget;
  rendererId?: string;
}): MaterializationResult["primary"] {
  fs.mkdirSync(params.outputDir, { recursive: true });
  const filePath = path.join(params.outputDir, `${params.baseFileName}.${params.extension}`);
  fs.writeFileSync(filePath, params.contents, "utf8");
  const sizeBytes = fs.statSync(filePath).size;
  return {
    renderKind: params.renderKind,
    ...(params.documentInputKind ? { documentInputKind: params.documentInputKind } : {}),
    ...(params.rendererTarget ? { rendererTarget: params.rendererTarget } : {}),
    ...(params.rendererId ? { rendererId: params.rendererId } : {}),
    outputTarget: "file",
    path: filePath,
    mimeType: params.mimeType,
    sizeBytes,
    lifecycle: "draft",
  };
}

function writeHtmlPrimary(params: {
  request: CanonicalMaterializationRequest;
  outputDir: string;
  baseFileName: string;
  renderer: RendererDefinition;
}): MaterializationResult["primary"] {
  return writeHtmlMaterialization({
    outputDir: params.outputDir,
    baseFileName: params.baseFileName,
    title: params.request.title,
    bodyHtml: params.request.htmlBody,
    summary: params.request.payload.summary,
    outputTarget: params.renderer.outputTarget,
    renderKind: params.renderer.renderKind === "site_preview" ? "site_preview" : "html",
    documentInputKind: params.request.documentInputKind,
    rendererTarget: params.renderer.rendererTarget,
    rendererId: params.renderer.id,
  });
}

function maybeRecordBootstrapOrigin(params: {
  request: CanonicalMaterializationRequest;
  bootstrapRequestId: string;
  runId?: string;
}): void {
  const originRunId = params.runId?.trim();
  if (!originRunId) {
    return;
  }
  const originCheckpointId = `bootstrap-origin:${params.bootstrapRequestId}:${originRunId}`;
  const runtimeCheckpointService = getPlatformRuntimeCheckpointService();
  runtimeCheckpointService.createCheckpoint({
    id: originCheckpointId,
    runId: originRunId,
    boundary: "bootstrap",
    blockedReason: "Bootstrap evidence: the task requested a capability install before it could complete.",
    target: {
      bootstrapRequestId: params.bootstrapRequestId,
      operation: "bootstrap.run",
    },
    executionContext: params.request.executionContext,
  });
  runtimeCheckpointService.updateCheckpoint(originCheckpointId, {
    status: "completed",
    completedAtMs: Date.now(),
  });
}

function materializeUnavailableRenderer(params: {
  request: CanonicalMaterializationRequest;
  outputDir: string;
  baseFileName: string;
  renderer: RendererDefinition;
  options?: {
    runId?: string;
    capabilityRegistry?: CapabilityRegistry;
    capabilityCatalog?: CapabilityCatalogEntry[];
    sourceRecipeId?: string;
    executionContext?: PlatformExecutionContextSnapshot;
    bootstrapService?: BootstrapRequestService;
  };
}): MaterializationResult {
  if (!params.renderer.requiredCapabilityId) {
    throw new Error(`Renderer "${params.renderer.id}" cannot degrade without a required capability`);
  }
  const capabilityRegistry =
    params.options?.capabilityRegistry ??
    createCapabilityRegistry([], params.options?.capabilityCatalog ?? TRUSTED_CAPABILITY_CATALOG);
  const bootstrapResolution = resolveBootstrapRequest({
    capabilityId: params.renderer.requiredCapabilityId,
    registry: capabilityRegistry,
    catalog: params.options?.capabilityCatalog ?? TRUSTED_CAPABILITY_CATALOG,
    reason: params.renderer.bootstrapReason ?? "renderer_unavailable",
    sourceDomain: params.request.sourceDomain,
    sourceRecipeId: params.options?.sourceRecipeId,
    executionContext: params.options?.executionContext,
  });
  const fallbackRenderer = resolveFallbackRenderer({
    renderer: params.renderer,
    registry: DEFAULT_RENDERER_REGISTRY,
  });
  const primary = writeHtmlMaterialization({
    outputDir: params.outputDir,
    baseFileName: params.baseFileName,
    title: params.request.title,
    bodyHtml: params.request.htmlBody,
    summary: params.request.payload.summary,
    outputTarget: fallbackRenderer.outputTarget,
    renderKind: "html",
    documentInputKind: params.request.documentInputKind,
    rendererTarget: fallbackRenderer.rendererTarget,
    rendererId: fallbackRenderer.id,
  });
  if (bootstrapResolution.request) {
    const createdRequest = (params.options?.bootstrapService ?? getPlatformBootstrapService()).create(
      bootstrapResolution.request,
    );
    maybeRecordBootstrapOrigin({
      request: params.request,
      bootstrapRequestId: createdRequest.id,
      runId: params.options?.runId,
    });
  }
  return MaterializationResultSchema.parse({
    primary,
    ...(bootstrapResolution.request ? { bootstrapRequest: bootstrapResolution.request } : {}),
    degraded: true,
    warnings: [params.renderer.unavailableWarning ?? `${params.renderer.id} unavailable; fell back to html output`],
  });
}

export function materializeArtifact(
  requestInput: MaterializationRequest,
  options?: {
    pdfRendererAvailable?: boolean;
    runId?: string;
    capabilityRegistry?: CapabilityRegistry;
    capabilityCatalog?: CapabilityCatalogEntry[];
    sourceRecipeId?: string;
    executionContext?: PlatformExecutionContextSnapshot;
    bootstrapService?: BootstrapRequestService;
  },
): MaterializationResult {
  const request = MaterializationRequestSchema.parse(requestInput);
  const outputDir = resolveOutputDir(request);
  const baseFileName = resolveBaseFileName(request);
  const canonicalRequest = canonicalizeMaterializationRequest(request);
  const renderer = resolveRendererDefinition({
    rendererTarget: canonicalRequest.rendererTarget,
    outputTarget: canonicalRequest.outputTarget,
    registry: DEFAULT_RENDERER_REGISTRY,
  });
  const supporting: NonNullable<MaterializationResult["supporting"]> = [];

  if (renderer.id === "markdown-file") {
    const primary = writeTextFile({
      outputDir,
      baseFileName,
      extension: "md",
      contents: request.payload.markdown ?? request.payload.text ?? "",
      mimeType: "text/markdown",
      renderKind: "markdown",
      documentInputKind: canonicalRequest.documentInputKind,
      rendererTarget: canonicalRequest.rendererTarget,
      rendererId: renderer.id,
    });
    supporting.push(
      writeHtmlMaterialization({
        outputDir,
        baseFileName,
        title: canonicalRequest.title,
        bodyHtml: canonicalRequest.htmlBody,
        summary: request.payload.summary,
        outputTarget: request.outputTarget,
        renderKind: request.outputTarget === "preview" ? "site_preview" : "html",
        documentInputKind: canonicalRequest.documentInputKind,
        rendererTarget: request.outputTarget === "preview" ? "preview" : "html",
        rendererId: request.outputTarget === "preview" ? "html-preview" : "html-file",
      }),
    );
    if (request.includePdf) {
      supporting.push(
        writePdfMaterialization({
          outputDir,
          baseFileName,
          html: canonicalRequest.htmlBody,
          title: canonicalRequest.title,
          summary: request.payload.summary,
          documentInputKind: canonicalRequest.documentInputKind,
          rendererTarget: "pdf",
          rendererId: "pdf-from-html",
        }),
      );
    }
    return MaterializationResultSchema.parse({
      primary,
      supporting,
    });
  }

  if (renderer.id === "pdf-from-html") {
    if (options?.pdfRendererAvailable === false) {
      return materializeUnavailableRenderer({
        request: canonicalRequest,
        outputDir,
        baseFileName,
        renderer,
        options,
      });
    }
    return MaterializationResultSchema.parse({
      primary: writePdfMaterialization({
        outputDir,
        baseFileName,
        html: canonicalRequest.htmlBody,
        title: canonicalRequest.title,
        summary: request.payload.summary,
        documentInputKind: canonicalRequest.documentInputKind,
        rendererTarget: renderer.rendererTarget,
        rendererId: renderer.id,
      }),
    });
  }

  const primary = writeHtmlPrimary({
    request: canonicalRequest,
    outputDir,
    baseFileName,
    renderer,
  });
  if (request.includePdf) {
    supporting.push(
      writePdfMaterialization({
        outputDir,
        baseFileName,
        html: canonicalRequest.htmlBody,
        title: canonicalRequest.title,
        summary: request.payload.summary,
        documentInputKind: canonicalRequest.documentInputKind,
        rendererTarget: "pdf",
        rendererId: "pdf-from-html",
      }),
    );
  }
  return MaterializationResultSchema.parse({
    primary,
    ...(supporting.length > 0 ? { supporting } : {}),
  });
}

export function applyMaterializationToDescriptor(params: {
  descriptor: ArtifactDescriptor;
  materialization: MaterializationResult;
}): ArtifactDescriptor {
  const { descriptor, materialization } = params;
  return {
    ...descriptor,
    path: materialization.primary.path,
    url: descriptor.url ?? materialization.primary.url,
    mimeType: materialization.primary.mimeType,
    sizeBytes: materialization.primary.sizeBytes,
    lifecycle:
      descriptor.lifecycle === "published"
        ? descriptor.lifecycle
        : (materialization.primary.lifecycle ?? descriptor.lifecycle),
    metadata: {
      ...descriptor.metadata,
      materialization,
    },
  };
}

export async function runMaterializationBootstrap(params: {
  materialization: MaterializationResult;
  policyContext: PolicyContext;
  registry: CapabilityRegistry;
  installers?: Partial<Record<CapabilityInstallMethod, BootstrapInstaller>>;
  availableBins?: string[];
  availableEnv?: string[];
  runHealthCheckCommand?: (command: string) => Promise<boolean> | boolean;
}): Promise<BootstrapOrchestrationResult | undefined> {
  const request = params.materialization.bootstrapRequest;
  if (!request) {
    return undefined;
  }
  return orchestrateBootstrapRequest({
    request,
    policyContext: params.policyContext,
    registry: params.registry,
    installers: params.installers,
    availableBins: params.availableBins,
    availableEnv: params.availableEnv,
    runHealthCheckCommand: params.runHealthCheckCommand,
  });
}
