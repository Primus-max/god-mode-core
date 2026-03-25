import { createHash } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";

export const PLATFORM_ARTIFACTS_DIRNAME = "platform";
export const ARTIFACTS_DIRNAME = "artifacts";
export const ARTIFACT_METADATA_FILENAME = "meta.json";

function sanitizeArtifactDirectoryPrefix(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
}

export function buildArtifactDirectoryName(artifactId: string): string {
  const prefix = sanitizeArtifactDirectoryPrefix(artifactId) || "artifact";
  const hash = createHash("sha256").update(artifactId).digest("hex").slice(0, 12);
  return `${prefix}-${hash}`;
}

export function resolvePlatformArtifactsRoot(stateDir = resolveStateDir()): string {
  return path.join(stateDir, PLATFORM_ARTIFACTS_DIRNAME, ARTIFACTS_DIRNAME);
}

export function resolveArtifactDirectory(params: {
  artifactId: string;
  stateDir?: string;
}): string {
  return path.join(
    resolvePlatformArtifactsRoot(params.stateDir),
    buildArtifactDirectoryName(params.artifactId),
  );
}

export function resolveArtifactMetadataPath(params: {
  artifactId: string;
  stateDir?: string;
}): string {
  return path.join(resolveArtifactDirectory(params), ARTIFACT_METADATA_FILENAME);
}
