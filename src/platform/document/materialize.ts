import { applyMaterializationToDescriptor, materializeArtifact } from "../materialization/index.js";
import type { ArtifactDescriptor } from "../schemas/artifact.js";
import type { DocumentRuntimeRoute } from "./contracts.js";
import type {
  NormalizedDocumentArtifact,
  NormalizedDocumentExtraction,
  NormalizedDocumentExport,
  NormalizedDocumentReportArtifact,
} from "./normalize.js";

function buildMarkdownTable(columns: string[], rows: Array<Record<string, unknown>>): string {
  if (columns.length === 0 || rows.length === 0) {
    return "_No rows available._";
  }
  const formatCell = (value: unknown): string => {
    if (value === null || value === undefined) {
      return "";
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return JSON.stringify(value);
  };
  const header = `| ${columns.join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (row) => `| ${columns.map((column) => formatCell(row[column])).join(" | ")} |`,
  );
  return [header, divider, ...body].join("\n");
}

function buildExtractionMarkdown(
  route: DocumentRuntimeRoute,
  payload: NormalizedDocumentExtraction,
): string {
  const lines = [`# ${route} extraction summary`, ""];
  if (payload.fields.length > 0) {
    lines.push("## Fields", "");
    for (const field of payload.fields) {
      lines.push(`- **${field.label}**: ${field.valueText}`);
    }
    lines.push("");
  }
  if (payload.tables.length > 0) {
    lines.push("## Tables", "");
    for (const table of payload.tables) {
      lines.push(`### ${table.title ?? table.id}`, "");
      lines.push(buildMarkdownTable(table.headers, table.rows), "");
    }
  }
  if (payload.notes?.length) {
    lines.push("## Notes", "", ...payload.notes.map((note) => `- ${note}`), "");
  }
  return lines.join("\n").trim();
}

function materializeNormalizedDocumentArtifact(params: {
  descriptor: ArtifactDescriptor;
  route: DocumentRuntimeRoute;
  payload: NormalizedDocumentArtifact;
}): ArtifactDescriptor {
  const { descriptor, route, payload } = params;
  if (payload.type === "report") {
    let parsedJsonContent: unknown;
    if (payload.format === "json") {
      try {
        parsedJsonContent = JSON.parse(payload.content);
      } catch {
        parsedJsonContent = payload.content;
      }
    }
    return applyMaterializationToDescriptor({
      descriptor,
      materialization: materializeArtifact({
        artifactId: descriptor.id,
        label: descriptor.label,
        sourceDomain: "document",
        renderKind: payload.format === "markdown" ? "markdown" : "html",
        outputTarget: "file",
        includePdf: true,
        payload: {
          title: descriptor.label,
          summary: payload.summary,
          ...(payload.format === "markdown"
            ? { markdown: payload.content }
            : payload.format === "text"
              ? { text: payload.content }
              : { jsonData: parsedJsonContent }),
        },
      }),
    });
  }

  if (payload.type === "export") {
    const markdown = [
      `# ${descriptor.label}`,
      "",
      `Format: ${payload.format}`,
      "",
      buildMarkdownTable(payload.columns, payload.previewRows),
    ].join("\n");
    return applyMaterializationToDescriptor({
      descriptor,
      materialization: materializeArtifact({
        artifactId: descriptor.id,
        label: descriptor.label,
        sourceDomain: "document",
        renderKind: "html",
        outputTarget: "file",
        payload: {
          title: descriptor.label,
          summary: `Export preview with ${String(payload.rowCount)} rows`,
          markdown,
        },
      }),
    });
  }

  return applyMaterializationToDescriptor({
    descriptor,
    materialization: materializeArtifact({
      artifactId: descriptor.id,
      label: descriptor.label,
      sourceDomain: "document",
      renderKind: "html",
      outputTarget: "file",
      includePdf: true,
      payload: {
        title: descriptor.label,
        summary: `${route} produced ${String(payload.fieldCount)} fields and ${String(payload.tableCount)} tables`,
        markdown: buildExtractionMarkdown(route, payload),
      },
    }),
  });
}

export function materializeDocumentDescriptor(params: {
  descriptor: ArtifactDescriptor;
  route: DocumentRuntimeRoute;
  payload: NormalizedDocumentArtifact;
}): ArtifactDescriptor {
  return materializeNormalizedDocumentArtifact(params);
}

export type {
  NormalizedDocumentArtifact,
  NormalizedDocumentExport,
  NormalizedDocumentExtraction,
  NormalizedDocumentReportArtifact,
};
