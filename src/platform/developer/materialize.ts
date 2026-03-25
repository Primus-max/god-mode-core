import fs from "node:fs";
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
}): ArtifactDescriptor {
  const { descriptor, payload } = params;

  if (payload.type === "preview") {
    const materialized = applyMaterializationToDescriptor({
      descriptor,
      materialization: materializeArtifact({
        artifactId: descriptor.id,
        label: descriptor.label,
        sourceDomain: "developer",
        renderKind: "site_preview",
        outputTarget: "preview",
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
    return {
      ...materialized,
      url: payload.url,
    };
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
    return applyMaterializationToDescriptor({
      descriptor,
      materialization: materializeArtifact({
        artifactId: descriptor.id,
        label: descriptor.label,
        sourceDomain: "developer",
        renderKind: "html",
        outputTarget: "file",
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
  }

  return applyMaterializationToDescriptor({
    descriptor,
    materialization: materializeArtifact({
      artifactId: descriptor.id,
      label: descriptor.label,
      sourceDomain: "developer",
      renderKind: "html",
      outputTarget: "file",
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
}
