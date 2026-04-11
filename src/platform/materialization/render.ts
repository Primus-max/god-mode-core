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
  type MaterializationRequest,
  type MaterializationResult,
} from "./contracts.js";
import { resolveHtmlBody, writeHtmlMaterialization } from "./html-preview-materializer.js";
import { writePdfMaterialization } from "./pdf-materializer.js";

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
}): MaterializationResult["primary"] {
  fs.mkdirSync(params.outputDir, { recursive: true });
  const filePath = path.join(params.outputDir, `${params.baseFileName}.${params.extension}`);
  fs.writeFileSync(filePath, params.contents, "utf8");
  const sizeBytes = fs.statSync(filePath).size;
  return {
    renderKind: params.extension === "md" ? "markdown" : "html",
    outputTarget: "file",
    path: filePath,
    mimeType: params.mimeType,
    sizeBytes,
    lifecycle: "draft",
  };
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
  const htmlBody = resolveHtmlBody(request.payload);
  const title = request.payload.title ?? request.label;
  const supporting: NonNullable<MaterializationResult["supporting"]> = [];

  if (request.renderKind === "markdown") {
    const primary = writeTextFile({
      outputDir,
      baseFileName,
      extension: "md",
      contents: request.payload.markdown ?? request.payload.text ?? "",
      mimeType: "text/markdown",
    });
    supporting.push(
      writeHtmlMaterialization({
        outputDir,
        baseFileName,
        title,
        bodyHtml: htmlBody,
        summary: request.payload.summary,
        outputTarget: request.outputTarget,
        renderKind: request.outputTarget === "preview" ? "site_preview" : "html",
      }),
    );
    if (request.includePdf) {
      supporting.push(
        writePdfMaterialization({ outputDir, baseFileName, html: htmlBody, title, summary: request.payload.summary }),
      );
    }
    return MaterializationResultSchema.parse({
      primary,
      supporting,
    });
  }

  if (request.renderKind === "pdf") {
    if (options?.pdfRendererAvailable === false) {
      const capabilityRegistry =
        options.capabilityRegistry ??
        createCapabilityRegistry([], options?.capabilityCatalog ?? TRUSTED_CAPABILITY_CATALOG);
      const bootstrapResolution = resolveBootstrapRequest({
        capabilityId: "pdf-renderer",
        registry: capabilityRegistry,
        catalog: options?.capabilityCatalog ?? TRUSTED_CAPABILITY_CATALOG,
        reason: "renderer_unavailable",
        sourceDomain: request.sourceDomain,
        sourceRecipeId: options?.sourceRecipeId,
        executionContext: options?.executionContext,
      });
      const primary = writeHtmlMaterialization({
        outputDir,
        baseFileName,
        title,
        bodyHtml: htmlBody,
        summary: request.payload.summary,
        outputTarget: request.outputTarget,
        renderKind: request.outputTarget === "preview" ? "site_preview" : "html",
      });
      if (bootstrapResolution.request) {
        const createdRequest = (options?.bootstrapService ?? getPlatformBootstrapService()).create(
          bootstrapResolution.request,
        );
        const originRunId = options?.runId?.trim();
        if (originRunId) {
          const originCheckpointId = `bootstrap-origin:${createdRequest.id}:${originRunId}`;
          const runtimeCheckpointService = getPlatformRuntimeCheckpointService();
          runtimeCheckpointService.createCheckpoint({
            id: originCheckpointId,
            runId: originRunId,
            boundary: "bootstrap",
            blockedReason:
              "Bootstrap evidence: the task requested a capability install before it could complete.",
            target: {
              bootstrapRequestId: createdRequest.id,
              operation: "bootstrap.run",
            },
            executionContext: request.executionContext,
          });
          runtimeCheckpointService.updateCheckpoint(originCheckpointId, {
            status: "completed",
            completedAtMs: Date.now(),
          });
        }
      }
      return MaterializationResultSchema.parse({
        primary,
        ...(bootstrapResolution.request ? { bootstrapRequest: bootstrapResolution.request } : {}),
        degraded: true,
        warnings: ["pdf renderer unavailable; fell back to html output"],
      });
    }
    return MaterializationResultSchema.parse({
      primary: writePdfMaterialization({
        outputDir,
        baseFileName,
        html: htmlBody,
        title,
        summary: request.payload.summary,
      }),
    });
  }

  const primary = writeHtmlMaterialization({
    outputDir,
    baseFileName,
    title,
    bodyHtml: htmlBody,
    summary: request.payload.summary,
    outputTarget: request.outputTarget,
    renderKind: request.outputTarget === "preview" ? "site_preview" : "html",
  });
  if (request.includePdf) {
    supporting.push(
      writePdfMaterialization({ outputDir, baseFileName, html: htmlBody, title, summary: request.payload.summary }),
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
