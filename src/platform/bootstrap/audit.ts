import fs from "node:fs";
import path from "node:path";
import {
  BootstrapAuditEventSchema,
  BootstrapRequestRecordSchema,
  type BootstrapAuditEvent,
  type BootstrapRequestRecord,
} from "./contracts.js";
import { resolveBootstrapAuditPath, resolvePlatformBootstrapRoot } from "./paths.js";

function ensureAuditDirectory(stateDir: string): void {
  fs.mkdirSync(resolvePlatformBootstrapRoot(stateDir), { recursive: true, mode: 0o700 });
}

export function appendBootstrapAuditEvent(stateDir: string | undefined, event: BootstrapAuditEvent): void {
  if (!stateDir) {
    return;
  }
  ensureAuditDirectory(stateDir);
  const parsed = BootstrapAuditEventSchema.parse(event);
  fs.appendFileSync(resolveBootstrapAuditPath(stateDir), `${JSON.stringify(parsed)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function readBootstrapAuditEvents(stateDir: string | undefined): BootstrapAuditEvent[] {
  if (!stateDir) {
    return [];
  }
  const auditPath = resolveBootstrapAuditPath(stateDir);
  if (!fs.existsSync(auditPath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(auditPath, "utf8");
    const events: BootstrapAuditEvent[] = [];
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const parsed = BootstrapAuditEventSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) {
        events.push(parsed.data);
      }
    }
    return events;
  } catch {
    return [];
  }
}

export function rehydrateBootstrapRequestRecords(stateDir: string | undefined): BootstrapRequestRecord[] {
  const latestById = new Map<string, BootstrapRequestRecord>();
  for (const event of readBootstrapAuditEvents(stateDir)) {
    latestById.set(event.requestId, BootstrapRequestRecordSchema.parse(event.record));
  }
  return Array.from(latestById.values()).sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export function resetBootstrapAuditForTests(stateDir: string | undefined): void {
  if (!stateDir) {
    return;
  }
  try {
    fs.rmSync(resolveBootstrapAuditPath(stateDir), { force: true });
    const rootDir = resolvePlatformBootstrapRoot(stateDir);
    if (fs.existsSync(rootDir) && fs.readdirSync(rootDir).length === 0) {
      fs.rmdirSync(rootDir);
      const platformDir = path.dirname(rootDir);
      if (fs.existsSync(platformDir) && fs.readdirSync(platformDir).length === 0) {
        fs.rmdirSync(platformDir);
      }
    }
  } catch {
    // Best-effort cleanup for tests only.
  }
}
