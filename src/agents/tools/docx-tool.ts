import path from "node:path";
import { Type } from "@sinclair/typebox";
import { saveMediaBuffer } from "../../media/store.js";
import { loadCapabilityModule } from "../../platform/bootstrap/index.js";
import { type AnyAgentTool, readStringParam } from "./common.js";

const DocxToolSchema = Type.Object({
  fileName: Type.Optional(
    Type.String({ description: "Filename stem (no extension)." }),
  ),
  title: Type.Optional(Type.String({ description: "Document title (H1)." })),
  sections: Type.Array(
    Type.Object({
      heading: Type.Optional(Type.String()),
      paragraphs: Type.Optional(Type.Array(Type.String())),
      bullets: Type.Optional(Type.Array(Type.String())),
    }),
    {
      description:
        "Ordered document sections. Each section renders heading + paragraphs + bullet list.",
    },
  ),
  footer: Type.Optional(Type.String()),
  style: Type.Optional(
    Type.String({
      description: "Style hint (minimal|rich|presentation). From deliverable.constraints.",
    }),
  ),
});

type DocxSectionInput = {
  heading?: string;
  paragraphs?: string[];
  bullets?: string[];
};

type DocxModule = {
  Document: new (options: unknown) => unknown;
  Packer: { toBuffer: (doc: unknown) => Promise<Buffer | Uint8Array> };
  Paragraph: new (options: unknown) => unknown;
  TextRun: new (options: unknown) => unknown;
  HeadingLevel: {
    TITLE: string;
    HEADING_1: string;
    HEADING_2: string;
  };
};

function sanitizeFileStem(candidate: string | undefined, fallback: string): string {
  const source = (candidate ?? fallback).trim();
  const cleaned = source.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/_+/g, "_");
  return cleaned.slice(0, 48) || fallback;
}

function normalizeSections(raw: unknown): DocxSectionInput[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((section) => {
      if (!section || typeof section !== "object") {
        return null;
      }
      const s = section as Record<string, unknown>;
      const heading = typeof s.heading === "string" ? s.heading : undefined;
      const paragraphs = Array.isArray(s.paragraphs)
        ? (s.paragraphs.filter((v) => typeof v === "string") as string[])
        : undefined;
      const bullets = Array.isArray(s.bullets)
        ? (s.bullets.filter((v) => typeof v === "string") as string[])
        : undefined;
      if (!heading && !paragraphs?.length && !bullets?.length) {
        return null;
      }
      return {
        ...(heading ? { heading } : {}),
        ...(paragraphs ? { paragraphs } : {}),
        ...(bullets ? { bullets } : {}),
      } satisfies DocxSectionInput;
    })
    .filter((entry): entry is DocxSectionInput => entry !== null);
}

function buildDocxDocument(params: {
  module: DocxModule;
  title?: string;
  sections: DocxSectionInput[];
  footer?: string;
}): unknown {
  const { Document, Paragraph, TextRun, HeadingLevel } = params.module;
  const body: unknown[] = [];
  if (params.title) {
    body.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun({ text: params.title, bold: true })],
      }),
    );
  }
  for (const section of params.sections) {
    if (section.heading) {
      body.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: section.heading, bold: true })],
        }),
      );
    }
    for (const paragraph of section.paragraphs ?? []) {
      body.push(new Paragraph({ children: [new TextRun({ text: paragraph })] }));
    }
    for (const bullet of section.bullets ?? []) {
      body.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [new TextRun({ text: bullet })],
        }),
      );
    }
  }
  if (params.footer) {
    body.push(
      new Paragraph({
        children: [new TextRun({ text: params.footer, italics: true, size: 20 })],
      }),
    );
  }
  return new Document({
    sections: [{ properties: {}, children: body }],
  });
}

export function createDocxTool(): AnyAgentTool {
  return {
    label: "DOCX Writer",
    name: "docx_write",
    description:
      "Generate a Word document (.docx) from structured sections. Backed by the managed docx-writer capability — installed automatically on first use.",
    parameters: DocxToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sections = normalizeSections(params.sections);
      if (sections.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "docx_write requires at least one non-empty section.",
            },
          ],
          details: { error: "missing_sections" },
        };
      }
      let docxModule: DocxModule;
      try {
        const rawModule = await loadCapabilityModule<DocxModule & { default?: DocxModule }>({
          capabilityId: "docx-writer",
          packageName: "docx",
        });
        const candidate =
          rawModule?.HeadingLevel && rawModule?.Document
            ? rawModule
            : (rawModule?.default as DocxModule | undefined);
        if (!candidate || !candidate.HeadingLevel || !candidate.Document) {
          throw new Error(
            "docx module did not expose expected exports (Document/HeadingLevel)",
          );
        }
        docxModule = candidate;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `docx_write unavailable: ${message}`,
            },
          ],
          details: { error: "capability_unavailable", message },
        };
      }
      const title = readStringParam(params, "title");
      const footer = readStringParam(params, "footer");
      const document = buildDocxDocument({
        module: docxModule,
        ...(title ? { title } : {}),
        sections,
        ...(footer ? { footer } : {}),
      });
      const rawBuffer = await docxModule.Packer.toBuffer(document);
      const buffer = Buffer.isBuffer(rawBuffer)
        ? rawBuffer
        : Buffer.from(rawBuffer as Uint8Array);
      const fileStem = sanitizeFileStem(
        readStringParam(params, "fileName"),
        "document",
      );
      const saved = await saveMediaBuffer(
        buffer,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "outbound",
        10 * 1024 * 1024,
        `${fileStem}.docx`,
      );
      const basename = path.basename(saved.path);
      return {
        content: [
          {
            type: "text",
            text: `DOCX document ready: ${basename} (${(saved.size / 1024).toFixed(1)} KB).`,
          },
        ],
        details: {
          artifact: {
            kind: "document",
            format: "docx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            path: saved.path,
            sizeBytes: saved.size,
          },
          media: { mediaUrl: saved.path },
        },
      };
    },
  };
}
