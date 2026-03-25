import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";

const PLATFORM_BOOTSTRAP_DIRNAME = "platform";
const BOOTSTRAP_DIRNAME = "bootstrap";
const BOOTSTRAP_AUDIT_FILENAME = "requests-audit.jsonl";

export function resolvePlatformBootstrapRoot(stateDir = resolveStateDir()): string {
  return path.join(stateDir, PLATFORM_BOOTSTRAP_DIRNAME, BOOTSTRAP_DIRNAME);
}

export function resolveBootstrapAuditPath(stateDir = resolveStateDir()): string {
  return path.join(resolvePlatformBootstrapRoot(stateDir), BOOTSTRAP_AUDIT_FILENAME);
}
