import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  setDefaultSecurityHeaders,
  sendMethodNotAllowed,
  sendText,
} from "../../gateway/http-common.js";
import { SafeOpenError, openFileWithinRoot } from "../../infra/fs-safe.js";
import { detectMime } from "../../media/mime.js";
import type { PluginLogger } from "../../plugins/types.js";
import type { ArtifactService } from "./service.js";

export const PLATFORM_ARTIFACTS_ROUTE_PREFIX = "/platform/artifacts";
export const PLATFORM_ARTIFACTS_PREVIEW_PREFIX = `${PLATFORM_ARTIFACTS_ROUTE_PREFIX}/preview/`;
export const PLATFORM_ARTIFACTS_CONTENT_PREFIX = `${PLATFORM_ARTIFACTS_ROUTE_PREFIX}/content/`;

const PLATFORM_ARTIFACT_HTML_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");
const MAX_ARTIFACT_SERVE_BYTES = 25 * 1024 * 1024;

type ArtifactRouteMatch =
  | { route: "preview"; artifactId: string; token: string }
  | { route: "content"; artifactId: string; token: string };

function parseRequestUrl(rawUrl?: string): URL | null {
  if (!rawUrl) {
    return null;
  }
  try {
    return new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return null;
  }
}

function matchArtifactRoute(pathname: string): ArtifactRouteMatch | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 5 || parts[0] !== "platform" || parts[1] !== "artifacts") {
    return null;
  }
  const route = parts[2];
  const artifactIdPart = parts[3];
  const tokenPart = parts[4];
  if (!artifactIdPart || !tokenPart) {
    return null;
  }
  try {
    const artifactId = decodeURIComponent(artifactIdPart);
    const token = decodeURIComponent(tokenPart);
    if (!artifactId || !token) {
      return null;
    }
    if (route === "preview") {
      return { route, artifactId, token };
    }
    if (route === "content") {
      return { route, artifactId, token };
    }
  } catch {
    return null;
  }
  return null;
}

function resolveServedPath(params: {
  service: ArtifactService;
  route: ArtifactRouteMatch["route"];
  artifactId: string;
}): string | undefined {
  const record = params.service.getRecord(params.artifactId);
  if (!record) {
    return undefined;
  }
  if (params.route === "preview") {
    return record.materialization?.primary.path;
  }
  return record.descriptor.path ?? record.materialization?.primary.path;
}

function setArtifactHeaders(res: ServerResponse, contentType: string, isHtml: boolean): void {
  setDefaultSecurityHeaders(res);
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", contentType);
  if (isHtml) {
    res.setHeader("Content-Security-Policy", PLATFORM_ARTIFACT_HTML_CSP);
  }
}

export function createArtifactHttpHandler(params: {
  service: ArtifactService;
  logger?: PluginLogger;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const parsed = parseRequestUrl(req.url);
    if (!parsed) {
      return false;
    }
    if (!parsed.pathname.startsWith(PLATFORM_ARTIFACTS_ROUTE_PREFIX)) {
      return false;
    }
    const match = matchArtifactRoute(parsed.pathname);
    if (!match) {
      sendText(res, 404, "Not Found");
      return true;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendMethodNotAllowed(res, "GET, HEAD");
      return true;
    }

    const record = params.service.getRecord(match.artifactId);
    if (!record || record.access.token !== match.token) {
      sendText(res, 404, "Not Found");
      return true;
    }

    const servedPath = resolveServedPath({
      service: params.service,
      route: match.route,
      artifactId: match.artifactId,
    });
    if (!servedPath) {
      sendText(res, 404, "Not Found");
      return true;
    }

    const rootDir = params.service.resolveOutputDir(match.artifactId);
    const relativePath = path.relative(rootDir, servedPath);
    try {
      const opened = await openFileWithinRoot({
        rootDir,
        relativePath,
      });
      try {
        if (opened.stat.size > MAX_ARTIFACT_SERVE_BYTES) {
          sendText(res, 413, "Artifact too large");
          return true;
        }
        const buffer =
          req.method === "HEAD" ? Buffer.alloc(0) : Buffer.from(await opened.handle.readFile());
        const mimeType =
          record.descriptor.mimeType ??
          record.materialization?.primary.mimeType ??
          (req.method === "HEAD"
            ? path.extname(opened.realPath).toLowerCase() === ".html"
              ? "text/html; charset=utf-8"
              : "application/octet-stream"
            : ((await detectMime({ buffer, filePath: opened.realPath })) ??
              "application/octet-stream"));
        const isHtml = mimeType.startsWith("text/html");
        res.statusCode = 200;
        setArtifactHeaders(res, mimeType, isHtml);
        if (req.method === "HEAD") {
          res.end();
        } else {
          res.end(buffer);
        }
        return true;
      } finally {
        await opened.handle.close().catch(() => {});
      }
    } catch (error) {
      if (error instanceof SafeOpenError) {
        const status = error.code === "not-found" ? 404 : error.code === "too-large" ? 413 : 400;
        sendText(res, status, status === 404 ? "Not Found" : "Invalid artifact path");
        return true;
      }
      params.logger?.warn?.(
        `platform artifacts: failed serving ${match.artifactId}: ${String(error)}`,
      );
      sendText(res, 500, "Failed to load artifact");
      return true;
    }
  };
}
