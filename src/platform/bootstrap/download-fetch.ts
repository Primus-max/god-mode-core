import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  fetchWithSsrFGuard,
  withTrustedEnvProxyGuardedFetchMode,
} from "../../infra/net/fetch-guard.js";

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return Boolean(value && typeof (value as NodeJS.ReadableStream).pipe === "function");
}

function parseExpectedSha256Integrity(
  integrity: string,
): { ok: true; sha256: string } | { ok: false; error: string } {
  const trimmed = integrity.trim();
  const match = /^sha256:([a-f0-9]{64})$/iu.exec(trimmed);
  if (!match?.[1]) {
    return {
      ok: false,
      error: `download installer requires sha256:<hex> integrity, got ${JSON.stringify(integrity)}`,
    };
  }
  return { ok: true, sha256: match[1].toLowerCase() };
}

function resolveDownloadFileName(params: { url: string; archiveKind: "tar" | "zip" }): string {
  try {
    const parsed = new URL(params.url);
    const basename = path.basename(parsed.pathname);
    if (basename) {
      return basename;
    }
  } catch {
    // Fall through to deterministic local naming.
  }
  return params.archiveKind === "zip" ? "artifact.zip" : "artifact.tgz";
}

export async function fetchBootstrapDownloadArtifact(params: {
  url: string;
  integrity: string;
  archiveKind: "tar" | "zip";
  targetDir: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}): Promise<
  { ok: true; archivePath: string; bytes: number; sha256: string } | { ok: false; error: string }
> {
  const integrity = parseExpectedSha256Integrity(params.integrity);
  if (!integrity.ok) {
    return { ok: false, error: integrity.error };
  }

  await fs.promises.mkdir(params.targetDir, { recursive: true });
  const archivePath = path.join(
    params.targetDir,
    `${randomUUID()}-${resolveDownloadFileName({
      url: params.url,
      archiveKind: params.archiveKind,
    })}`,
  );
  const tempPath = `${archivePath}.tmp`;
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;

  const { response, release } = await fetchWithSsrFGuard(
    withTrustedEnvProxyGuardedFetchMode({
      url: params.url,
      timeoutMs: params.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
      fetchImpl: params.fetchImpl,
      auditContext: "bootstrap-download-installer",
    }),
  );

  try {
    if (!response.ok || !response.body) {
      return {
        ok: false,
        error: `bootstrap download failed (${response.status} ${response.statusText})`,
      };
    }

    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return {
        ok: false,
        error: `bootstrap download exceeded size limit: ${contentLength} > ${maxBytes}`,
      };
    }

    let bytes = 0;
    const digest = createHash("sha256");
    const file = fs.createWriteStream(tempPath);
    const body = response.body as unknown;
    const readable: NodeJS.ReadableStream = isNodeReadableStream(body)
      ? body
      : Readable.fromWeb(body as NodeReadableStream);
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes) {
          callback(new Error(`bootstrap download exceeded size limit: ${bytes} > ${maxBytes}`));
          return;
        }
        digest.update(buffer);
        callback(null, buffer);
      },
    });

    await pipeline(readable, meter, file);
    const sha256 = digest.digest("hex").toLowerCase();
    if (sha256 !== integrity.sha256) {
      return {
        ok: false,
        error: `bootstrap download integrity mismatch for ${params.url}`,
      };
    }
    await fs.promises.rename(tempPath, archivePath);
    return {
      ok: true,
      archivePath,
      bytes,
      sha256,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    await release();
  }
}
