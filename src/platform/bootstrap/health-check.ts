import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import type { CapabilityDescriptor } from "../schemas/capability.js";

const execFileAsync = promisify(execFile);
const SIMPLE_HEALTH_CHECK_TOKEN_RE = /^[A-Za-z0-9_./:\\%+=,@-]+$/u;
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 10_000;

function parseSimpleHealthCheckCommand(
  command: string,
): { ok: true; command: string; args: string[] } | { ok: false; reason: string } {
  const trimmed = command.trim();
  if (!trimmed) {
    return { ok: false, reason: "health check command is empty" };
  }
  const tokens = trimmed.split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) {
    return { ok: false, reason: "health check command is empty" };
  }
  if (!tokens.every((token) => SIMPLE_HEALTH_CHECK_TOKEN_RE.test(token))) {
    return {
      ok: false,
      reason: `health check command requires an injected runner: ${command}`,
    };
  }
  return {
    ok: true,
    command: tokens[0],
    args: tokens.slice(1),
  };
}

function normalizeCommandCandidate(value: string): string {
  return path
    .basename(value)
    .toLowerCase()
    .replace(/\.(cmd|exe|bat)$/iu, "");
}

function buildExecutableCandidates(command: string): string[] {
  if (process.platform !== "win32") {
    return [command];
  }
  const lower = command.toLowerCase();
  if (/\.(cmd|exe|bat)$/iu.test(lower)) {
    return [command];
  }
  return [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`];
}

function isResolvableFile(command: string): boolean {
  try {
    return fs.statSync(command).isFile();
  } catch {
    return false;
  }
}

function canResolveCommandFromPath(command: string): boolean {
  if (!command.trim()) {
    return false;
  }
  if (path.isAbsolute(command)) {
    return isResolvableFile(command);
  }
  if (command.includes("/") || command.includes("\\")) {
    return isResolvableFile(path.resolve(command));
  }
  const pathValue =
    process.env.PATH ?? (process.platform === "win32" ? process.env.Path : undefined) ?? "";
  if (!pathValue) {
    return false;
  }
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const candidate of buildExecutableCandidates(command)) {
      if (isResolvableFile(path.join(dir, candidate))) {
        return true;
      }
    }
  }
  return false;
}

function commandMatchesRequiredBins(command: string, capability: CapabilityDescriptor): boolean {
  const requiredBins = capability.requiredBins ?? [];
  if (requiredBins.length === 0) {
    return true;
  }
  const normalized = normalizeCommandCandidate(command);
  return requiredBins.some((bin) => normalizeCommandCandidate(bin) === normalized);
}

export async function runDefaultBootstrapHealthCheckCommand(params: {
  capability: CapabilityDescriptor;
  command: string;
}): Promise<{ ok: boolean; reasons: string[] }> {
  const parsed = parseSimpleHealthCheckCommand(params.command);
  if (!parsed.ok) {
    return { ok: false, reasons: [parsed.reason] };
  }
  if (!commandMatchesRequiredBins(parsed.command, params.capability)) {
    return {
      ok: false,
      reasons: [`health check command must use a declared required bin: ${params.command}`],
    };
  }
  for (const candidate of buildExecutableCandidates(parsed.command)) {
    try {
      await execFileAsync(candidate, parsed.args, {
        timeout: DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
        windowsHide: true,
      });
      return { ok: true, reasons: [] };
    } catch {
      // Try the next platform-specific executable candidate.
    }
  }
  return {
    ok: false,
    reasons: [`health check failed: ${params.command}`],
  };
}

export async function verifyCapabilityHealth(params: {
  capability: CapabilityDescriptor;
  availableBins?: string[];
  availableEnv?: string[];
  runHealthCheckCommand?: (command: string) => Promise<boolean> | boolean;
}): Promise<{ ok: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  const bins = new Set((params.availableBins ?? []).map((value) => value.toLowerCase()));
  const env = new Set((params.availableEnv ?? []).map((value) => value.toUpperCase()));

  for (const bin of params.capability.requiredBins ?? []) {
    if (!bins.has(bin.toLowerCase()) && !canResolveCommandFromPath(bin)) {
      reasons.push(`required bin missing: ${bin}`);
    }
  }
  for (const envVar of params.capability.requiredEnv ?? []) {
    if (!env.has(envVar.toUpperCase())) {
      reasons.push(`required env missing: ${envVar}`);
    }
  }

  if (params.capability.healthCheckCommand) {
    if (params.runHealthCheckCommand) {
      const ok = await params.runHealthCheckCommand(params.capability.healthCheckCommand);
      if (!ok) {
        reasons.push(`health check failed: ${params.capability.healthCheckCommand}`);
      }
    } else {
      const defaultResult = await runDefaultBootstrapHealthCheckCommand({
        capability: params.capability,
        command: params.capability.healthCheckCommand,
      });
      if (!defaultResult.ok) {
        reasons.push(...defaultResult.reasons);
      }
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}
