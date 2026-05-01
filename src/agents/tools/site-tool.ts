import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Type } from "@sinclair/typebox";
import { saveMediaBuffer } from "../../media/store.js";
import { loadCapabilityModule } from "../../platform/bootstrap/index.js";
import { type AnyAgentTool, readStringParam } from "./common.js";

const SiteToolSchema = Type.Object({
  fileName: Type.Optional(Type.String({ description: "Zip filename stem." })),
  title: Type.Optional(Type.String()),
  theme: Type.Optional(Type.String({ description: "light|dark" })),
  pages: Type.Array(
    Type.Object({
      path: Type.String({
        description: "Relative path inside the zip, e.g. index.html or about/index.html.",
      }),
      title: Type.Optional(Type.String()),
      html: Type.Optional(Type.String()),
      markdown: Type.Optional(Type.String()),
    }),
  ),
  assets: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String(),
        text: Type.Optional(Type.String()),
        base64: Type.Optional(Type.String()),
      }),
    ),
  ),
});

type SitePageInput = {
  path: string;
  title?: string;
  html?: string;
  markdown?: string;
};

type SiteAssetInput = {
  path: string;
  text?: string;
  base64?: string;
};

type ArchiverFactory = (format: "zip", options?: Record<string, unknown>) => ArchiverInstance;
type ArchiverModule = {
  default?: ArchiverFactory;
} & ArchiverFactory;

type ArchiverInstance = {
  append: (data: Buffer | string, options: { name: string }) => ArchiverInstance;
  pipe: (destination: NodeJS.WritableStream) => NodeJS.WritableStream;
  finalize: () => Promise<void>;
  on: (event: string, handler: (...args: unknown[]) => void) => ArchiverInstance;
};

function sanitizeFileStem(candidate: string | undefined, fallback: string): string {
  const source = (candidate ?? fallback).trim();
  const cleaned = source.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/_+/g, "_");
  return cleaned.slice(0, 48) || fallback;
}

function ensureRelativePath(candidate: string): string {
  const trimmed = candidate.trim().replace(/^[/\\]+/, "");
  if (!trimmed || trimmed.includes("..")) {
    throw new Error(`invalid page/asset path: ${candidate}`);
  }
  return trimmed.replace(/\\/g, "/");
}

function renderMarkdownToHtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const htmlLines: string[] = [];
  let inList = false;
  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      if (inList) {
        htmlLines.push("</ul>");
        inList = false;
      }
      const level = headingMatch[1]?.length ?? 1;
      htmlLines.push(`<h${level}>${escapeHtml(headingMatch[2] ?? "")}</h${level}>`);
      continue;
    }
    const bulletMatch = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bulletMatch) {
      if (!inList) {
        htmlLines.push("<ul>");
        inList = true;
      }
      htmlLines.push(`<li>${escapeHtml(bulletMatch[1] ?? "")}</li>`);
      continue;
    }
    if (inList) {
      htmlLines.push("</ul>");
      inList = false;
    }
    if (line.trim()) {
      htmlLines.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  if (inList) {
    htmlLines.push("</ul>");
  }
  return htmlLines.join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapPageHtml(params: {
  title?: string;
  body: string;
  theme?: string;
  siteTitle?: string;
}): string {
  const theme = params.theme === "dark" ? "dark" : "light";
  const pageTitle = params.title ?? params.siteTitle ?? "Site";
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(pageTitle)}</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<main>${params.body}</main>
</body>
</html>
`;
}

const DEFAULT_STYLESHEET = `:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; line-height: 1.5; }
main { max-width: 72ch; margin: 0 auto; }
[data-theme="dark"] body, body[data-theme="dark"] { background: #111; color: #eee; }
h1, h2, h3 { line-height: 1.15; }
`;

function normalizePages(raw: unknown): SitePageInput[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.path !== "string" || !e.path.trim()) {
        return null;
      }
      return {
        path: e.path,
        ...(typeof e.title === "string" ? { title: e.title } : {}),
        ...(typeof e.html === "string" ? { html: e.html } : {}),
        ...(typeof e.markdown === "string" ? { markdown: e.markdown } : {}),
      } satisfies SitePageInput;
    })
    .filter((entry): entry is SitePageInput => entry !== null);
}

function normalizeAssets(raw: unknown): SiteAssetInput[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.path !== "string" || !e.path.trim()) {
        return null;
      }
      return {
        path: e.path,
        ...(typeof e.text === "string" ? { text: e.text } : {}),
        ...(typeof e.base64 === "string" ? { base64: e.base64 } : {}),
      } satisfies SiteAssetInput;
    })
    .filter((entry): entry is SiteAssetInput => entry !== null);
}

export function createSiteTool(): AnyAgentTool {
  return {
    label: "Site Packager",
    name: "site_pack",
    description:
      "Package a static website (HTML + CSS + assets) into a downloadable .zip. Backed by the managed site-packager capability — installed automatically on first use.",
    parameters: SiteToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const pages = normalizePages(params.pages);
      if (pages.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "site_pack requires at least one page with a path.",
            },
          ],
          details: { error: "missing_pages" },
        };
      }
      let archiverModule: ArchiverModule;
      try {
        archiverModule = await loadCapabilityModule<ArchiverModule>({
          capabilityId: "site-packager",
          packageName: "archiver",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `site_pack unavailable: ${message}`,
            },
          ],
          details: { error: "capability_unavailable", message },
        };
      }
      const archiverFactory: ArchiverFactory | null =
        typeof archiverModule === "function"
          ? (archiverModule as ArchiverFactory)
          : ((archiverModule as { default?: ArchiverFactory }).default ?? null);
      if (!archiverFactory) {
        return {
          content: [
            {
              type: "text",
              text: "site_pack unavailable: archiver module does not expose a factory.",
            },
          ],
          details: { error: "capability_invalid" },
        };
      }
      const archive = archiverFactory("zip", { zlib: { level: 9 } });
      const collector = new PassThrough();
      const chunks: Buffer[] = [];
      collector.on("data", (chunk: Buffer) => chunks.push(chunk));
      archive.pipe(collector);
      const siteTitle = readStringParam(params, "title");
      const theme = readStringParam(params, "theme");
      const stylesheetAsset = normalizeAssets(params.assets).find(
        (a) => ensureRelativePath(a.path) === "styles.css",
      );
      let stylesheetInjected = false;
      for (const page of pages) {
        const relativePath = ensureRelativePath(page.path);
        const body = page.html
          ? page.html
          : page.markdown
            ? renderMarkdownToHtml(page.markdown)
            : "<p></p>";
        const html = wrapPageHtml({
          ...(page.title ? { title: page.title } : {}),
          body,
          ...(theme ? { theme } : {}),
          ...(siteTitle ? { siteTitle } : {}),
        });
        archive.append(html, { name: relativePath });
      }
      for (const asset of normalizeAssets(params.assets)) {
        const relativePath = ensureRelativePath(asset.path);
        if (relativePath === "styles.css") {
          stylesheetInjected = true;
        }
        if (asset.text !== undefined) {
          archive.append(asset.text, { name: relativePath });
        } else if (asset.base64 !== undefined) {
          archive.append(Buffer.from(asset.base64, "base64"), { name: relativePath });
        }
      }
      if (!stylesheetInjected && !stylesheetAsset) {
        archive.append(DEFAULT_STYLESHEET, { name: "styles.css" });
      }
      await archive.finalize();
      await new Promise<void>((resolve) => {
        collector.on("end", () => resolve());
        collector.end();
      });
      const buffer = Buffer.concat(chunks);
      const fileStem = sanitizeFileStem(readStringParam(params, "fileName"), "site");
      const saved = await saveMediaBuffer(
        buffer,
        "application/zip",
        "outbound",
        20 * 1024 * 1024,
        `${fileStem}.zip`,
      );
      const basename = path.basename(saved.path);
      return {
        content: [
          {
            type: "text",
            text: `Site archive ready: ${basename} (${(saved.size / 1024).toFixed(1)} KB, ${pages.length} pages).`,
          },
        ],
        details: {
          artifact: {
            kind: "site",
            format: "zip",
            mimeType: "application/zip",
            path: saved.path,
            sizeBytes: saved.size,
            metadata: { pageCount: pages.length },
          },
          media: { mediaUrl: saved.path },
        },
      };
    },
  };
}

// Touch unused fs/os imports to silence tree-shaking concerns and keep them available for
// future expansion (e.g. temporary staging).
void fs;
void os;
