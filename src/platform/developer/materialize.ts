import fs from "node:fs";
import type { ArtifactService } from "../artifacts/index.js";
import { applyMaterializationToDescriptor, materializeArtifact } from "../materialization/index.js";
import type { ArtifactDescriptor } from "../schemas/artifact.js";
import type { DeveloperArtifactPayload } from "./artifacts.js";

function buildReleaseMarkdown(params: {
  label: string;
  version: string;
  tag?: string;
  target: string;
  notes?: string;
  url?: string;
}): string {
  return [
    `# ${params.label}`,
    "",
    `- Target: ${params.target}`,
    `- Version: ${params.version}`,
    ...(params.tag ? [`- Tag: ${params.tag}`] : []),
    ...(params.url ? [`- URL: ${params.url}`] : []),
    "",
    "## Notes",
    "",
    params.notes?.trim() || "_No release notes provided._",
  ].join("\n");
}

export function materializeDeveloperDescriptor(params: {
  descriptor: ArtifactDescriptor;
  payload: DeveloperArtifactPayload;
  artifactService?: ArtifactService;
}): ArtifactDescriptor {
  const { descriptor, payload, artifactService } = params;

  if (payload.type === "preview") {
    const materialized = applyMaterializationToDescriptor({
      descriptor,
      materialization: materializeArtifact({
        artifactId: descriptor.id,
        label: descriptor.label,
        sourceDomain: "developer",
        renderKind: "site_preview",
        outputTarget: "preview",
        ...(artifactService ? { outputDir: artifactService.resolveOutputDir(descriptor.id) } : {}),
        payload: {
          title: descriptor.label,
          summary: payload.summary,
          markdown: [
            `# ${descriptor.label}`,
            "",
            `Target: ${payload.target}`,
            ...(payload.summary ? ["", payload.summary] : []),
            "",
            `External preview URL: ${payload.url}`,
          ].join("\n"),
        },
      }),
    });
    const withExternalUrl = {
      ...materialized,
      url: payload.url,
    };
    return artifactService ? artifactService.register(withExternalUrl) : withExternalUrl;
  }

  if (payload.type === "binary" && payload.path) {
    const existing = fs.existsSync(payload.path) ? fs.statSync(payload.path) : undefined;
    return {
      ...descriptor,
      path: payload.path,
      sizeBytes: descriptor.sizeBytes ?? existing?.size,
      mimeType: descriptor.mimeType ?? payload.mimeType,
      metadata: {
        ...descriptor.metadata,
        materialization: {
          existingBinaryPath: payload.path,
        },
      },
    };
  }

  if (payload.type === "binary") {
    const materialized = applyMaterializationToDescriptor({
      descriptor,
      materialization: materializeArtifact({
        artifactId: descriptor.id,
        label: descriptor.label,
        sourceDomain: "developer",
        renderKind: "html",
        outputTarget: "file",
        ...(artifactService ? { outputDir: artifactService.resolveOutputDir(descriptor.id) } : {}),
        payload: {
          title: descriptor.label,
          summary: payload.summary,
          markdown: [
            `# ${descriptor.label}`,
            "",
            payload.summary ?? "Binary artifact metadata only.",
          ].join("\n"),
        },
      }),
    });
    return artifactService ? artifactService.register(materialized) : materialized;
  }

  const materialized = applyMaterializationToDescriptor({
    descriptor,
    materialization: materializeArtifact({
      artifactId: descriptor.id,
      label: descriptor.label,
      sourceDomain: "developer",
      renderKind: "html",
      outputTarget: "file",
      ...(artifactService ? { outputDir: artifactService.resolveOutputDir(descriptor.id) } : {}),
      includePdf: true,
      payload: {
        title: descriptor.label,
        summary: payload.published ? "Published release artifact" : "Draft release artifact",
        markdown: buildReleaseMarkdown({
          label: descriptor.label,
          version: payload.version,
          tag: payload.tag,
          target: payload.target,
          notes: payload.notes,
          url: payload.url,
        }),
      },
    }),
  });
  return artifactService ? artifactService.register(materialized) : materialized;
}
