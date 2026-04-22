#!/usr/bin/env node
// Phase 7 live E2E driver: 8 scenarios through ws://127.0.0.1:19001, with magic-bytes artifact checks.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyCliProfileEnv } from "../src/cli/profile.ts";
import { loadConfig } from "../src/config/config.js";
import { resolveGatewayConnection } from "../src/tui/gateway-chat.ts";
import { resolveGatewayConnectionAuth } from "../src/gateway/connection-auth.ts";
import { GatewayClient } from "../src/gateway/client.js";
import { GATEWAY_CLIENT_NAMES, GATEWAY_CLIENT_MODES } from "../src/utils/message-channel.js";
import { GATEWAY_CLIENT_CAPS } from "../src/gateway/protocol/client-info.js";
import { PROTOCOL_VERSION } from "../src/gateway/protocol/index.js";

const OUT_DIR = path.resolve(".artifacts/live-routing-smoke");
const DEV_SMOKE_DIR = path.resolve(".artifacts/dev-smoke");
const DEV_HELLO_PATH = path.join(DEV_SMOKE_DIR, "hello.txt");
const DEV_HELLO_REL = path.relative(process.cwd(), DEV_HELLO_PATH).split(path.sep).join("/");
const TIMEOUT_MS = 300_000;
const HISTORY_POLL_MS = 1500;

const CHAIN_PDF_DOCX = `chain-pdf-docx-${Date.now()}`;
const CHAIN_DEV_FILE = `chain-dev-file-${Date.now()}`;
const CHAIN_CONFIRM_EXEC = `chain-confirm-exec-${Date.now()}`;
const CHAIN_PROGRESS_BUS = `chain-progress-bus-${Date.now()}`;
const CHAIN_CLARIFY_BUDGET = `chain-clarify-budget-${Date.now()}`;
const CHAIN_ACK_DEFER = `chain-ack-defer-${Date.now()}`;
const CHAIN_INTENT_IDEMPOTENCY = `chain-intent-idempotency-${Date.now()}`;

const REPO_ROOT = path.resolve(process.cwd());
const WORKSPACE_ROOTS_FROM_ENV = (() => {
  const raw = process.env.OPENCLAW_WORKSPACE_ROOTS;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parts = raw
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => path.resolve(p));
  if (parts.length === 0) return null;
  return parts;
})();
const WORKSPACE_AWARE_EXPECTED_ROOT =
  WORKSPACE_ROOTS_FROM_ENV?.[0] ?? REPO_ROOT;
const WORKSPACE_AWARE_SIBLING_DIR =
  WORKSPACE_ROOTS_FROM_ENV?.[1] ??
  path.resolve(os.tmpdir(), `openclaw-smoke-sibling-stage-c`);
const WORKSPACE_AWARE_ROOTS = `${WORKSPACE_AWARE_EXPECTED_ROOT};${WORKSPACE_AWARE_SIBLING_DIR}`;
const WORKSPACE_DEV_ROOT = path.join(os.homedir(), ".openclaw", "workspace-dev");
const DEV_SERVER_NOTE_PATH = path.join(WORKSPACE_DEV_ROOT, "server-status-note.txt");
const SCENARIOS = [
  { id: "01-hello", message: "Привет", expect: { kind: "text" } },
  { id: "02-image", message: "Сгенерировать картинку банана", expect: { kind: "image", formats: ["png", "jpeg", "jpg", "webp"] } },
  { id: "03-pdf", sessionGroup: CHAIN_PDF_DOCX, message: "Сгенерировать pdf про жизнь банана, красивый пдф, а не просто текст вставленный.", expect: { kind: "document_package", formats: ["pdf"] } },
  { id: "04-docx", sessionGroup: CHAIN_PDF_DOCX, message: "То же самое сгенерировать в word.", expect: { kind: "document_package", formats: ["docx"] } },
  { id: "05-csv", message: "Какой то отчёт сделать в csv.", expect: { kind: "document_package", formats: ["csv"] } },
  { id: "06-xlsx", message: "Какой то отчёт сделать в эксель.", expect: { kind: "document_package", formats: ["xlsx"] } },
  { id: "07-site", message: "Создание сайта — простая лендинг-страница про бананы, отдай готовый архив.", expect: { kind: "document_package", formats: ["zip", "html"] } },
  { id: "08-capability-install", message: "Установи пожалуйста стороннюю библиотеку pdfkit — она нам нужна, выполни установку.", expect: { kind: "capability_install_or_clarify" } },
  {
    id: "09-dev-create-file",
    sessionGroup: CHAIN_DEV_FILE,
    message: `Создай файл ${DEV_HELLO_REL} с ровно одной строкой содержимого: "hello from dev-smoke". Используй инструмент (apply_patch/write), не просто описывай.`,
    expect: {
      kind: "workspace_file",
      path: DEV_HELLO_PATH,
      mustContain: "hello from dev-smoke",
      tools: ["apply_patch", "write"],
    },
  },
  {
    id: "10-dev-update-file",
    sessionGroup: CHAIN_DEV_FILE,
    message: `В файле ${DEV_HELLO_REL} замени строку "hello from dev-smoke" на строку "updated by dev-smoke-10". Используй инструмент редактирования файлов.`,
    expect: {
      kind: "workspace_file",
      path: DEV_HELLO_PATH,
      mustContain: "updated by dev-smoke-10",
      tools: ["apply_patch", "edit", "multi_edit", "write"],
    },
  },
  {
    id: "11-dev-exec",
    message:
      "Запусти команду `node --version` через инструмент exec и покажи вывод. Используй именно exec, не описание.",
    expect: {
      kind: "tool_output",
      tools: ["exec"],
      outputContainsAny: ["v", "node"],
    },
  },
  {
    id: "12-confirmation-question",
    sessionGroup: CHAIN_CONFIRM_EXEC,
    message:
      "Сначала задай короткий вопрос подтверждения: «Запустить node --version?». Ничего не запускай до моего ответа.",
    expect: { kind: "text" },
  },
  {
    id: "13-confirmation-yes-exec",
    sessionGroup: CHAIN_CONFIRM_EXEC,
    message: "ДА",
    expect: {
      kind: "tool_output",
      tools: ["exec"],
      outputContainsAny: ["v", "node"],
    },
  },
  {
    id: "14a-progress-bus-question",
    sessionGroup: CHAIN_PROGRESS_BUS,
    message:
      "Сначала задай короткий вопрос подтверждения: «Запустить node --version?». Ничего не запускай до моего ответа.",
    expect: { kind: "text" },
  },
  {
    id: "14-progress-bus",
    sessionGroup: CHAIN_PROGRESS_BUS,
    message: "ДА",
    expect: {
      kind: "tool_output",
      tools: ["exec"],
      outputContainsAny: ["v", "node"],
      progressLog: {
        requiredPhases: ["classifying", "tool_call", "done"],
        requiredToolName: "exec",
      },
    },
  },
  {
    id: "15-clarify-budget",
    sessionGroup: CHAIN_CLARIFY_BUDGET,
    messages: [
      "Продолжим",
      "Делай",
      "Ну сделай уже",
      "Давай просто",
    ],
    expect: {
      kind: "text",
      clarifyBudgetLog: { minCount: 2 },
    },
  },
  {
    id: "16-ack-then-defer",
    sessionGroup: CHAIN_ACK_DEFER,
    message:
      "Установи пожалуйста стороннюю библиотеку pdfkit через capability_install — она нам нужна, выполни установку целиком.",
    expect: {
      kind: "capability_install_or_clarify",
      progressLog: {
        requiredPhases: ["ack_deferred", "done"],
        ackDeferTiming: { ackMaxMs: 2000, doneMinMs: 3000 },
      },
    },
  },
  {
    id: "17-workspace-aware-exec",
    message:
      'Запусти команду `node --version` в проекте god-mode-core через инструмент exec и покажи вывод. Используй именно exec.',
    expect: {
      kind: "tool_output",
      tools: ["exec"],
      outputContainsAny: ["v", "node"],
      workspaceAwareExec: {
        expectedRoot: WORKSPACE_AWARE_EXPECTED_ROOT,
        siblingRoot: WORKSPACE_AWARE_SIBLING_DIR,
        commandIncludes: "node --version",
      },
    },
    requirements: {
      gatewayEnvPresent: ["OPENCLAW_WORKSPACE_ROOTS"],
      gatewayEnvIncludes: {
        OPENCLAW_WORKSPACE_ROOTS: [WORKSPACE_AWARE_EXPECTED_ROOT, WORKSPACE_AWARE_SIBLING_DIR],
      },
    },
  },
  {
    id: "17b-start-dev-server",
    message:
      "Запусти в проекте god-mode-core dev-сервер через exec: `pnpm dev`. Если процесс успешно стартовал, верни PID и localhost URL. Ничего не записывай в workspace ради статуса.",
    expect: {
      kind: "tool_output",
      tools: ["exec"],
      outputContainsAny: ["http://", "https://", "localhost", "127.0.0.1", "pid"],
      workspaceAwareExec: {
        expectedRoot: WORKSPACE_AWARE_EXPECTED_ROOT,
        siblingRoot: WORKSPACE_AWARE_SIBLING_DIR,
        commandIncludes: "pnpm dev",
      },
      absentPaths: [DEV_SERVER_NOTE_PATH],
    },
    requirements: {
      gatewayEnvPresent: ["OPENCLAW_WORKSPACE_ROOTS"],
      gatewayEnvIncludes: {
        OPENCLAW_WORKSPACE_ROOTS: [WORKSPACE_AWARE_EXPECTED_ROOT, WORKSPACE_AWARE_SIBLING_DIR],
      },
    },
  },
  {
    id: "18-identity-aware-recall",
    message:
      "Дай мне настоящее четверостишье Пушкина, переведённое на английский известным переводчиком. Если ты не уверен в каноническом переводе — скажи и используй web_search.",
    retryBudget: 1,
    expect: {
      kind: "identity_aware_recall",
    },
  },
  {
    id: "19-credentials-preflight",
    message:
      "Сделай scaffold нового Telegram-бота в этом репозитории: создай структуру проекта, package.json, точку входа и команду запуска. Если для запуска нужны обязательные ключи окружения, сначала запроси их явно.",
    expect: {
      kind: "credentials_preflight_clarify",
      missingKeysAny: ["TELEGRAM_API_HASH", "BYBIT_API_KEY", "OPENAI_API_KEY"],
      forbiddenTools: ["exec", "apply_patch"],
    },
  },
  {
    id: "20-intent-idempotency",
    sessionGroup: CHAIN_INTENT_IDEMPOTENCY,
    messages: [
      "Запусти в проекте god-mode-core dev-сервер через exec: `pnpm dev`. Если процесс успешно стартовал, верни PID и localhost URL. Ничего не записывай в workspace ради статуса.",
      "Запусти в проекте god-mode-core dev-сервер через exec: `pnpm dev`. Если он уже поднят, не запускай второй раз и верни receipt предыдущего запуска.",
    ],
    expect: {
      kind: "tool_output",
      tools: ["exec"],
      outputContainsAny: ["http://", "https://", "localhost", "127.0.0.1", "pid", "уже сделано"],
      progressLog: {
        requiredPhases: ["classifying", "done"],
      },
      idempotentExec: {
        expectedExecToolCalls: 1,
      },
      absentPaths: [DEV_SERVER_NOTE_PATH],
    },
    requirements: {
      gatewayEnvPresent: ["OPENCLAW_WORKSPACE_ROOTS"],
      gatewayEnvIncludes: {
        OPENCLAW_WORKSPACE_ROOTS: [WORKSPACE_AWARE_EXPECTED_ROOT, WORKSPACE_AWARE_SIBLING_DIR],
      },
    },
  },
];

const MAGIC_RULES = [
  { fmt: "pdf", head: "25504446" },                // %PDF
  { fmt: "docx", head: "504b0304" },               // ZIP (OOXML)
  { fmt: "xlsx", head: "504b0304" },
  { fmt: "zip", head: "504b0304" },
  { fmt: "png", head: "89504e47" },
  { fmt: "jpeg", head: "ffd8ff" },
  { fmt: "jpg", head: "ffd8ff" },
  { fmt: "webp", head: "52494646" },               // RIFF
];

async function sniffMagic(filePath) {
  try {
    const fd = await fs.open(filePath, "r");
    const buf = Buffer.alloc(12);
    const { bytesRead } = await fd.read(buf, 0, 12, 0);
    await fd.close();
    return buf.subarray(0, bytesRead).toString("hex");
  } catch (err) {
    return `ERR:${String(err?.message || err)}`;
  }
}

function magicMatches(hex, format) {
  const rule = MAGIC_RULES.find((r) => r.fmt === format.toLowerCase());
  if (!rule) return null;
  return hex.toLowerCase().startsWith(rule.head);
}

function extractProducedArtifacts(finalPayload) {
  if (!finalPayload || typeof finalPayload !== "object") return [];
  const candidates = [];
  const pushPath = (p) => {
    if (p && typeof p === "string") candidates.push(p);
  };
  const pushFromText = (value) => {
    if (typeof value !== "string") return;
    if (/\.(pdf|docx|xlsx|csv|zip|html|png|jpe?g|webp)$/i.test(value)) {
      pushPath(value);
      return;
    }
    const re = /([\w.\-\/\\:]+\.(pdf|docx|xlsx|csv|zip|html|png|jpe?g|webp))\b/gi;
    let match;
    while ((match = re.exec(value)) !== null) {
      pushPath(match[1]);
    }
  };
  const walk = (value, depth = 0) => {
    if (depth > 8 || value == null) return;
    if (typeof value === "string") {
      pushFromText(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (
          /^(path|filePath|localPath|diskPath|absolutePath|file|filename|outputPath|artifactPath|storedPath|savedPath|savedFilePath)$/.test(
            k,
          ) &&
          typeof v === "string"
        ) {
          pushPath(v);
        } else {
          walk(v, depth + 1);
        }
      }
    }
  };
  walk(finalPayload);
  return [...new Set(candidates)];
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
  }
  return "";
}

const TOOL_CALL_TYPES = new Set(["tool_use", "tool_call", "toolCall", "toolcall"]);
const TOOL_RESULT_TYPES = new Set(["tool_result", "toolResult", "toolresult"]);

function messageHasToolCall(msg) {
  if (!msg || !Array.isArray(msg.content)) return false;
  return msg.content.some((p) => TOOL_CALL_TYPES.has(p?.type));
}

function messageHasToolResult(msg) {
  if (!msg) return false;
  if (msg.role === "toolResult" || msg.role === "tool_result" || msg.role === "tool") return true;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((p) => TOOL_RESULT_TYPES.has(p?.type));
}

function messageHasAssistantText(msg) {
  if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return false;
  return msg.content.some((p) => p?.type === "text" && typeof p.text === "string" && p.text.trim().length > 0);
}

async function fetchHistoryAny(client, sessionKey) {
  const variants = Array.from(
    new Set([
      sessionKey,
      `agent:dev:${sessionKey}`,
      sessionKey.startsWith("agent:dev:") ? sessionKey.slice("agent:dev:".length) : null,
    ].filter(Boolean)),
  );
  for (const key of variants) {
    try {
      const res = await client.request("chat.history", { sessionKey: key, limit: 80 });
      if (res?.messages?.length) {
        return { key, res };
      }
    } catch {}
  }
  try {
    return { key: sessionKey, res: await client.request("chat.history", { sessionKey, limit: 80 }) };
  } catch {
    return { key: sessionKey, res: { messages: [] } };
  }
}

const GATEWAY_DEV_LOG_PATH = path.resolve(".gateway-dev.log");

function resolveGatewayLogFilePath() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const name = `openclaw-${y}-${m}-${day}.log`;
  if (process.platform === "win32") {
    return path.join("C:\\", "tmp", "openclaw", name);
  }
  return path.join("/tmp", "openclaw", name);
}

const GATEWAY_FILE_LOG_PATH = resolveGatewayLogFilePath();

async function captureGatewayLogOffset() {
  const paths = [GATEWAY_FILE_LOG_PATH, GATEWAY_DEV_LOG_PATH];
  const offsets = {};
  for (const p of paths) {
    try {
      const st = await fs.stat(p);
      offsets[p] = st.size;
    } catch {
      offsets[p] = 0;
    }
  }
  return offsets;
}

async function readGatewayLogFileSince(filePath, offset) {
  try {
    const st = await fs.stat(filePath);
    if (st.size <= offset) return "";
    const fd = await fs.open(filePath, "r");
    const len = st.size - offset;
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, offset);
    await fd.close();
    return buf.toString("utf-8");
  } catch {
    return "";
  }
}

async function readGatewayLogSince(offsets) {
  const parts = [];
  for (const [p, off] of Object.entries(offsets ?? {})) {
    const chunk = await readGatewayLogFileSince(p, off);
    if (chunk) parts.push(chunk);
  }
  return parts.join("\n");
}

function parseProgressFramesFromLog(logChunk) {
  const turns = new Map();
  const re = /\[progress\] turn=([^\s]+) seq=(\d+) phase=([a-z_]+)(?: toolName=([^\s]+))?/g;
  let match;
  while ((match = re.exec(logChunk)) !== null) {
    const [, turnId, seqStr, phase, toolName] = match;
    const seq = Number.parseInt(seqStr, 10);
    if (!Number.isFinite(seq)) continue;
    let arr = turns.get(turnId);
    if (!arr) {
      arr = [];
      turns.set(turnId, arr);
    }
    arr.push({ seq, phase, toolName: toolName ?? null });
  }
  return turns;
}

function parseProgressFramesFromStructuredLog(logChunk) {
  const turns = new Map();
  for (const line of String(logChunk ?? "").split(/\r?\n/)) {
    if (!line.includes("[progress] turn=")) continue;
    try {
      const parsed = JSON.parse(line);
      const payload = parsed?.["1"];
      if (!payload || typeof payload !== "object") continue;
      const turnId = typeof payload.turnId === "string" ? payload.turnId : null;
      const seq = typeof payload.seq === "number" ? payload.seq : Number.NaN;
      const phase = typeof payload.phase === "string" ? payload.phase : null;
      if (!turnId || !Number.isFinite(seq) || !phase) continue;
      const timeIso =
        typeof parsed?.time === "string"
          ? parsed.time
          : typeof parsed?._meta?.date === "string"
            ? parsed._meta.date
            : null;
      let arr = turns.get(turnId);
      if (!arr) {
        arr = [];
        turns.set(turnId, arr);
      }
      arr.push({
        seq,
        phase,
        toolName: typeof payload.toolName === "string" ? payload.toolName : null,
        ts: timeIso ? Date.parse(timeIso) : null,
      });
    } catch {
      // Ignore non-JSON and differently encoded log lines.
    }
  }
  return turns;
}

function parseProgressFramesFromEvents(events) {
  const turns = new Map();
  for (const evt of events ?? []) {
    if (evt?.event !== "progress.frame") continue;
    const payload = evt.payload;
    if (!payload || typeof payload !== "object") continue;
    const turnId = typeof payload.turnId === "string" ? payload.turnId : null;
    const seq = typeof payload.seq === "number" ? payload.seq : Number.NaN;
    const phase = typeof payload.phase === "string" ? payload.phase : null;
    if (!turnId || !Number.isFinite(seq) || !phase) continue;
    let arr = turns.get(turnId);
    if (!arr) {
      arr = [];
      turns.set(turnId, arr);
    }
    arr.push({
      seq,
      phase,
      toolName:
        payload.meta && typeof payload.meta === "object" && typeof payload.meta.toolName === "string"
          ? payload.meta.toolName
          : null,
      ts: typeof payload.ts === "number" ? payload.ts : null,
    });
  }
  return turns;
}

function evaluateProgressLog(logChunk, requirements, options = {}) {
  const required = new Set(requirements?.requiredPhases ?? []);
  const requiredTool = requirements?.requiredToolName ?? null;
  const turnsFromEvents = parseProgressFramesFromEvents(options.events ?? []);
  const turnsFromStructuredLog = parseProgressFramesFromStructuredLog(logChunk);
  const turnsFromPlainLog = parseProgressFramesFromLog(logChunk);
  const turns =
    turnsFromEvents.size > 0
      ? turnsFromEvents
      : turnsFromStructuredLog.size > 0
        ? turnsFromStructuredLog
        : turnsFromPlainLog;
  const notes = [];
  const ackDeferTiming = requirements?.ackDeferTiming ?? null;
  for (const [turnId, frames] of turns.entries()) {
    let monotonic = true;
    for (let i = 1; i < frames.length; i += 1) {
      if (frames[i].seq <= frames[i - 1].seq) {
        monotonic = false;
        break;
      }
    }
    if (!monotonic) continue;
    const phases = new Set(frames.map((f) => f.phase));
    const hasAllPhases = [...required].every((p) => phases.has(p));
    if (!hasAllPhases) continue;
    if (requiredTool) {
      const toolOk = frames.some(
        (f) => f.phase === "tool_call" && f.toolName === requiredTool,
      );
      if (!toolOk) continue;
    }
    if (ackDeferTiming) {
      const timingFrames =
        turnsFromStructuredLog.get(turnId)?.length > 0 ? turnsFromStructuredLog.get(turnId) : frames;
      const ackFrame = timingFrames?.find((f) => f.phase === "ack_deferred" && typeof f.ts === "number");
      const doneFrame = [...(timingFrames ?? [])].reverse().find(
        (f) => f.phase === "done" && typeof f.ts === "number",
      );
      const startedAtMs = options.startedAtMs ?? null;
      if (!ackFrame || !doneFrame || !startedAtMs) {
        notes.push(
          `progress turn=${turnId} missing timing inputs for ackDeferTiming (startedAtMs=${String(startedAtMs)} ackTs=${String(ackFrame?.ts)} doneTs=${String(doneFrame?.ts)})`,
        );
        continue;
      }
      const ackLatencyMs = ackFrame.ts - startedAtMs;
      const doneLatencyMs = doneFrame.ts - startedAtMs;
      if (Number.isFinite(ackDeferTiming.ackMaxMs) && ackLatencyMs > ackDeferTiming.ackMaxMs) {
        notes.push(
          `progress turn=${turnId} ack_deferred latency ${String(ackLatencyMs)}ms exceeded max ${String(ackDeferTiming.ackMaxMs)}ms`,
        );
        continue;
      }
      if (Number.isFinite(ackDeferTiming.doneMinMs) && doneLatencyMs < ackDeferTiming.doneMinMs) {
        notes.push(
          `progress turn=${turnId} done latency ${String(doneLatencyMs)}ms was below min ${String(ackDeferTiming.doneMinMs)}ms`,
        );
        continue;
      }
      notes.push(
        `progress timing turn=${turnId} ackMs=${String(ackLatencyMs)} doneMs=${String(doneLatencyMs)}`,
      );
    }
    notes.push(
      `progress turn=${turnId} phases=[${[...phases].join(",")}] frames=${frames.length}`,
    );
    return { ok: true, notes };
  }
  if (turns.size === 0) {
    notes.push("no [progress] entries found in gateway log after scenario start");
  } else {
    notes.push(
      `no turn satisfied required phases=[${[...required].join(",")}]${requiredTool ? ` toolName=${requiredTool}` : ""}; seen turns=${turns.size}`,
    );
  }
  return { ok: false, notes };
}

function evaluateClarifyBudgetLog(logChunk, requirements) {
  const minCount = Math.max(1, Number.parseInt(String(requirements?.minCount ?? "2"), 10) || 2);
  const re = /\[clarify-budget\]\s+topic=([^\s]+)\s+count=(\d+)\s+injected=(\d+)/g;
  const matches = [];
  let match;
  while ((match = re.exec(logChunk)) !== null) {
    const count = Number.parseInt(match[2], 10);
    const injected = match[3] === "1";
    matches.push({ topic: match[1], count, injected });
  }
  const hit = matches.find((item) => item.injected && item.count >= minCount);
  if (hit) {
    return {
      ok: true,
      notes: [`clarify-budget topic=${hit.topic} count=${hit.count} injected=1`],
    };
  }
  if (matches.length === 0) {
    return {
      ok: false,
      notes: ["no [clarify-budget] entries found in gateway log after scenario start"],
    };
  }
  return {
    ok: false,
    notes: [
      `no clarify-budget entry with injected=1 and count>=${minCount}; seen=${matches
        .map((item) => `${item.topic}:${item.count}:${item.injected ? "1" : "0"}`)
        .join(",")}`,
    ],
  };
}

async function runScenario(client, scenario) {
  const runId = `${scenario.id}-1-${Date.now()}`;
  const sessionKey = scenario.sessionGroup
    ? `live-routing-smoke:${scenario.sessionGroup}`
    : `live-routing-smoke:${scenario.id}:${Date.now()}`;
  const events = [];
  client.__onEvent = (evt) => events.push({ ...evt, __receivedAtMs: Date.now() });
  const logOffset = await captureGatewayLogOffset();
  let start = null;
  let startedAtMs = 0;
  let finalEvent = null;
  let lastHistory = null;
  let historyKeyUsed = sessionKey;
  let sawToolCall = false;
  let sawToolResult = false;
  let initialMsgCount = 0;
  const scenarioMessages =
    Array.isArray(scenario.messages) && scenario.messages.length > 0
      ? scenario.messages
      : [scenario.message];
  for (let index = 0; index < scenarioMessages.length; index += 1) {
    const turnRunId = index === 0 ? runId : `${scenario.id}-${index + 1}-${Date.now()}`;
    const turnInitialMsgCount = (await fetchHistoryAny(client, sessionKey))?.res?.messages?.length ?? 0;
    if (index === 0) {
      initialMsgCount = turnInitialMsgCount;
    }
    const turnStartedAtMs = Date.now();
    start = await client.request("chat.send", {
      sessionKey,
      message: scenarioMessages[index],
      idempotencyKey: turnRunId,
    });
    if (index === 0) {
      startedAtMs = turnStartedAtMs;
    }
    const deadline = Date.now() + TIMEOUT_MS;
    let lastMsgCount = 0;
    let stableSince = 0;
    let turnSawToolCall = false;
    let turnSawToolResult = false;
    while (Date.now() < deadline) {
      finalEvent =
        events.find(
          (evt) => evt.event === "chat" && evt.payload?.state === "final" && evt.payload?.runId === turnRunId,
        ) ?? null;
      const { key, res } = await fetchHistoryAny(client, sessionKey);
      lastHistory = res;
      historyKeyUsed = key;
      const msgs = lastHistory?.messages ?? [];
      if (msgs.length > lastMsgCount) {
        lastMsgCount = msgs.length;
        stableSince = Date.now();
      }
      const turnMsgs = msgs.slice(turnInitialMsgCount);
      if (!turnSawToolCall) turnSawToolCall = turnMsgs.some(messageHasToolCall);
      if (!turnSawToolResult) turnSawToolResult = turnMsgs.some(messageHasToolResult);
      const lastTurnMsg = turnMsgs.length > 0 ? turnMsgs[turnMsgs.length - 1] : null;
      const lastTurnIsAssistantText =
        lastTurnMsg &&
        lastTurnMsg.role === "assistant" &&
        messageHasAssistantText(lastTurnMsg) &&
        !messageHasToolCall(lastTurnMsg);
      if (finalEvent && turnSawToolCall && turnSawToolResult && lastTurnIsAssistantText) break;
      if (finalEvent && !turnSawToolCall && lastTurnIsAssistantText) break;
      if (turnSawToolCall) {
        if (turnSawToolResult && lastTurnIsAssistantText && stableSince > 0 && Date.now() - stableSince > 8_000) {
          break;
        }
        if (turnSawToolResult && finalEvent && stableSince > 0 && Date.now() - stableSince > 4_000) {
          break;
        }
      } else if (lastTurnIsAssistantText && stableSince > 0 && Date.now() - stableSince > 6000) {
        break;
      }
      await new Promise((r) => setTimeout(r, HISTORY_POLL_MS));
    }
    sawToolCall = sawToolCall || turnSawToolCall;
    sawToolResult = sawToolResult || turnSawToolResult;
  }
  let gatewayLogAppend = await readGatewayLogSince(logOffset);
  if (scenario.expect?.progressLog && !/\[progress\]/.test(gatewayLogAppend)) {
    const retryDeadline = Date.now() + 5000;
    while (Date.now() < retryDeadline) {
      await new Promise((r) => setTimeout(r, 250));
      gatewayLogAppend = await readGatewayLogSince(logOffset);
      if (/\[progress\]/.test(gatewayLogAppend)) break;
    }
  }
  return {
    scenario,
    runId,
    sessionKey,
    historyKeyUsed,
    start,
    startedAtMs,
    finalEvent,
    history: lastHistory,
    initialMsgCount,
    events: events.slice(),
    flags: { sawToolCall, sawToolResult },
    gatewayLogAppend,
  };
}

function summarizeAssistantText(history, finalPayload) {
  const msgs = history?.messages ?? [];
  const assistant = [...msgs]
    .reverse()
    .find((m) => m.role === "assistant" && messageHasAssistantText(m));
  const historyText = contentToText(assistant?.content);
  if (historyText && historyText.trim().length > 0) return historyText.slice(0, 800);
  const finalMsg = finalPayload?.message;
  if (finalMsg?.role === "assistant") {
    const finalText = contentToText(finalMsg.content);
    if (finalText) return finalText.slice(0, 800);
  }
  return "";
}

function historyHasToolInvocations(history) {
  if (!history?.messages) return [];
  const calls = [];
  for (const m of history.messages) {
    if (m.role === "toolResult" || m.role === "tool_result" || m.role === "tool") {
      calls.push({
        role: m.role,
        name: m.toolName ? `result:${m.toolName}` : `result:${m.toolCallId ?? "?"}`,
        toolName: m.toolName,
        toolCallId: m.toolCallId,
        ok: m.isError === false || (m.isError === undefined && !m.error),
        output: m.content ?? m.output ?? undefined,
      });
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (TOOL_CALL_TYPES.has(p?.type)) {
        calls.push({
          role: m.role,
          name: p.name || p.toolName || "?",
          id: p.id || p.toolUseId || null,
          arguments: p.arguments ?? p.input ?? undefined,
        });
      }
      if (TOOL_RESULT_TYPES.has(p?.type)) {
        calls.push({
          role: m.role,
          name: `result:${p.toolUseId || p.id || "?"}`,
          ok: p.isError === false,
          output: p.output ?? p.content ?? undefined,
        });
      }
    }
  }
  return calls;
}

const FILENAME_REGEX = /([\w.\-\/\\:]+\.(pdf|docx|xlsx|csv|zip|html|png|jpe?g|webp))\b/gi;

function extractArtifactsFromToolCalls(toolCalls) {
  const paths = [];
  const push = (v) => {
    if (typeof v !== "string") return;
    if (/\.(pdf|docx|xlsx|csv|zip|html|png|jpe?g|webp)$/i.test(v)) {
      paths.push(v);
      return;
    }
    FILENAME_REGEX.lastIndex = 0;
    let match;
    while ((match = FILENAME_REGEX.exec(v)) !== null) {
      paths.push(match[1]);
    }
  };
  const walk = (value, depth = 0) => {
    if (depth > 8 || value == null) return;
    if (typeof value === "string") {
      push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (
          /^(path|filePath|localPath|diskPath|absolutePath|file|filename|outputPath|artifactPath|storedPath|savedPath|savedFilePath|url)$/.test(
            k,
          )
        ) {
          if (typeof v === "string") push(v);
        }
        walk(v, depth + 1);
      }
    }
  };
  for (const call of toolCalls ?? []) {
    walk(call.arguments);
    walk(call.output);
  }
  return [...new Set(paths)];
}

function resolveArtifactPath(candidate) {
  if (!candidate) return null;
  if (path.isAbsolute(candidate) && fsSync.existsSync(candidate)) return candidate;
  const base = path.basename(candidate);
  const home = os.homedir();
  const roots = [
    ".openclaw-dev/agents/dev/media",
    ".openclaw-dev/agents/dev/artifacts",
    ".openclaw-dev/agents/dev/documents",
    ".openclaw-dev/media",
    ".openclaw-dev",
    ".artifacts",
    path.join(home, ".openclaw-dev", "media"),
    path.join(home, ".openclaw-dev", "agents", "dev", "media"),
    path.join(home, ".openclaw-dev", "agents", "dev"),
    path.join(home, ".openclaw-dev"),
  ];
  const walkRoot = (root) => {
    try {
      const abs = path.resolve(root);
      if (!fsSync.existsSync(abs)) return null;
      const stack = [abs];
      while (stack.length) {
        const cur = stack.pop();
        let entries;
        try {
          entries = fsSync.readdirSync(cur, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          const next = path.join(cur, entry.name);
          if (entry.isDirectory()) {
            stack.push(next);
          } else if (entry.name === base) {
            return next;
          }
        }
      }
    } catch {}
    return null;
  };
  for (const root of roots) {
    const hit = walkRoot(root);
    if (hit) return hit;
  }
  const relativeAttempt = path.resolve(candidate);
  if (fsSync.existsSync(relativeAttempt)) return relativeAttempt;
  return null;
}

async function evaluate(result) {
  const scenario = result.scenario;
  const finalPayload = result.finalEvent?.payload ?? null;
  const fullHistory = result.history;
  const initialCount = result.initialMsgCount ?? 0;
  const turnMsgs = (fullHistory?.messages ?? []).slice(initialCount);
  const history = { ...fullHistory, messages: turnMsgs };
  const toolCalls = historyHasToolInvocations(history);
  const rawPaths = new Set([
    ...extractProducedArtifacts({ final: finalPayload, history }),
    ...extractArtifactsFromToolCalls(toolCalls),
  ]);
  const producedPaths = [];
  for (const candidate of rawPaths) {
    const resolved = resolveArtifactPath(candidate);
    if (resolved) producedPaths.push(resolved);
  }
  const magics = [];
  for (const p of producedPaths) {
    const hex = await sniffMagic(p);
    magics.push({ path: p, hex: hex.slice(0, 16) });
  }
  const assistantText = summarizeAssistantText(history, finalPayload);
  let pass = false;
  const notes = [];

  if (scenario.expect.kind === "text") {
    pass = !!assistantText && assistantText.length > 0 && assistantText.length < 2000;
    if (!pass) notes.push("assistant text missing or too long");
  } else if (scenario.expect.kind === "capability_install_or_clarify") {
    const invokedInstall = toolCalls.some((c) => c.name === "capability_install");
    const mentionsInstall = /install|установ|capability_install/i.test(assistantText);
    pass = invokedInstall || mentionsInstall || producedPaths.length > 0;
    if (!pass) notes.push("no install tool call, acknowledgment, or artifact");
    if (invokedInstall) notes.push("tool_call: capability_install");
  } else if (scenario.expect.kind === "workspace_file") {
    const allowedTools = scenario.expect.tools ?? [];
    const invokedAllowed = toolCalls.filter((c) => allowedTools.includes(c.name));
    const mustContain = scenario.expect.mustContain;

    // Tools run inside the dev workspace sandbox, so the actual written path
    // may be relative to that sandbox (e.g. C:\Users\<u>\.openclaw\workspace-dev\...).
    // Collect every path candidate: expected literal, producedPaths, and raw
    // `path` arguments from the invoked tool calls, resolved against both the
    // repo cwd and known dev workspace roots.
    const home = os.homedir();
    const sandboxRoots = [
      path.join(home, ".openclaw", "workspace-dev"),
      path.join(home, ".openclaw-dev", "workspace"),
      path.join(home, ".openclaw-dev"),
      process.cwd(),
    ];
    const rawToolPaths = [];
    for (const call of invokedAllowed) {
      const p = call?.arguments?.path;
      if (typeof p === "string" && p.length > 0) rawToolPaths.push(p);
    }
    const expanded = new Set();
    const addCandidate = (p) => {
      if (!p) return;
      if (path.isAbsolute(p)) {
        expanded.add(p);
        return;
      }
      for (const root of sandboxRoots) expanded.add(path.resolve(root, p));
    };
    addCandidate(scenario.expect.path);
    for (const p of producedPaths) addCandidate(p);
    for (const p of rawToolPaths) addCandidate(p);
    const candidatePaths = [...expanded];
    let fileContent = null;
    let matchedPath = null;
    for (const candidate of candidatePaths) {
      try {
        const content = await fs.readFile(candidate, "utf-8");
        fileContent = content;
        matchedPath = candidate;
        if (!mustContain || content.includes(mustContain)) break;
      } catch {}
    }
    const contentMatches = mustContain
      ? typeof fileContent === "string" && fileContent.includes(mustContain)
      : typeof fileContent === "string";
    pass = invokedAllowed.length > 0 && contentMatches;
    if (invokedAllowed.length === 0) {
      const callNames = toolCalls.map((c) => c.name).join(",");
      notes.push(
        `no workspace-mutating tool call in [${allowedTools.join(",")}] (got tool_calls=[${callNames}])`,
      );
    } else {
      notes.push(`tool_call: ${invokedAllowed.map((c) => c.name).join(",")}`);
    }
    if (!fileContent) {
      notes.push(`workspace file missing at any of [${candidatePaths.join(", ")}]`);
    } else if (mustContain && !contentMatches) {
      notes.push(
        `file at ${matchedPath} missing expected substring "${mustContain}"`,
      );
    } else if (matchedPath) {
      notes.push(`file verified at ${matchedPath}`);
    }
  } else if (scenario.expect.kind === "tool_output") {
    const allowedTools = scenario.expect.tools ?? [];
    const invokedAllowed = toolCalls.filter((c) => allowedTools.includes(c.name));
    const outputContainsAny = scenario.expect.outputContainsAny ?? [];
    const collectedParts = [assistantText];
    for (const call of toolCalls) {
      const rawName = String(call.name ?? "");
      const isResultForAllowed =
        rawName.startsWith("result:") &&
        (allowedTools.includes(call.toolName ?? "") ||
          allowedTools.some((t) => rawName.includes(t)));
      const isAllowedCall = allowedTools.includes(rawName);
      if (!isResultForAllowed && !isAllowedCall) continue;
      const out = call.output;
      if (out == null) continue;
      if (typeof out === "string") collectedParts.push(out);
      else collectedParts.push(JSON.stringify(out));
    }
    const joined = collectedParts.join("\n").toLowerCase();
    const outputOk =
      outputContainsAny.length === 0
        ? invokedAllowed.length > 0
        : outputContainsAny.some((needle) => joined.includes(String(needle).toLowerCase()));
    pass = invokedAllowed.length > 0 && outputOk;
    if (invokedAllowed.length === 0) {
      const callNames = toolCalls.map((c) => c.name).join(",");
      notes.push(`no tool call in [${allowedTools.join(",")}] (got tool_calls=[${callNames}])`);
    } else {
      notes.push(`tool_call: ${invokedAllowed.map((c) => c.name).join(",")}`);
    }
    if (invokedAllowed.length > 0 && !outputOk) {
      notes.push(`tool output did not contain any of [${outputContainsAny.join("|")}]`);
    }
    if (scenario.expect.workspaceAwareExec) {
      const wae = scenario.expect.workspaceAwareExec;
      const logChunk = result.gatewayLogAppend ?? "";
      const injectMatch = logChunk.match(/\[workspace-inject\][^\n]*reason=(\w+)/);
      const injectReason = injectMatch?.[1] ?? null;
      const acceptableReasons = new Set(["tools", "contract"]);
      const injectOk = injectReason && acceptableReasons.has(injectReason);
      if (!injectOk) {
        pass = false;
        notes.push(
          injectReason
            ? `[workspace-inject] reason=${injectReason} not in {tools,contract}`
            : "expected [workspace-inject] entry not found in gateway log",
        );
      } else {
        notes.push(`workspace-inject reason=${injectReason} observed`);
      }
      const execCalls = invokedAllowed.filter((c) => c.name === "exec");
      const commandOk = execCalls.some((c) => {
        const cmd = c?.arguments?.command;
        return typeof cmd === "string" && cmd.toLowerCase().includes(wae.commandIncludes.toLowerCase());
      });
      if (!commandOk) {
        pass = false;
        notes.push(`exec command did not include "${wae.commandIncludes}"`);
      }
      const expectedNorm = path.resolve(wae.expectedRoot).toLowerCase();
      const siblingNorm = path.resolve(wae.siblingRoot).toLowerCase();
      let workdirNote = null;
      const workdirCorrect = execCalls.some((c) => {
        const wd = c?.arguments?.workdir;
        if (typeof wd !== "string" || !wd.trim()) return false;
        const norm = path.resolve(wd).toLowerCase();
        if (norm === siblingNorm) {
          workdirNote = `exec workdir=${wd} matched sibling root (wrong)`;
          return false;
        }
        if (norm === expectedNorm) {
          workdirNote = `exec workdir=${wd} matched expected root`;
          return true;
        }
        workdirNote = `exec workdir=${wd} (no exact match against expected/sibling)`;
        return false;
      });
      const anyWorkdirSeen = execCalls.some(
        (c) => typeof c?.arguments?.workdir === "string" && c.arguments.workdir.trim().length > 0,
      );
      if (anyWorkdirSeen) {
        if (!workdirCorrect) {
          pass = false;
          notes.push(workdirNote ?? "exec workdir did not match expected root");
        } else {
          notes.push(workdirNote);
        }
      } else {
        notes.push(
          "exec call did not specify workdir; relying on gateway default cwd (acceptable when default cwd is the expected root)",
        );
      }
    }
    const absentPaths = Array.isArray(scenario.expect.absentPaths)
      ? scenario.expect.absentPaths.filter((value) => typeof value === "string" && value.trim().length > 0)
      : [];
    for (const absentPath of absentPaths) {
      if (fsSync.existsSync(absentPath)) {
        pass = false;
        notes.push(`unexpected file created: ${absentPath}`);
      } else {
        notes.push(`confirmed absent: ${absentPath}`);
      }
    }
  } else if (scenario.expect.kind === "identity_aware_recall") {
    const invokedWebSearch = toolCalls.some(
      (c) => c.name === "web_search" || c.toolName === "web_search",
    );
    const finalState = result.finalEvent?.payload?.state ?? null;
    const finalKind = result.finalEvent?.payload?.outcome?.kind ?? result.finalEvent?.payload?.kind ?? null;
    const ambigText = (() => {
      const ambig = result.finalEvent?.payload?.outcome?.ambiguities;
      if (Array.isArray(ambig)) return ambig.join(" | ").toLowerCase();
      return "";
    })();
    const lowerText = assistantText.toLowerCase();
    const mentionsWebSearch =
      /web[_\s-]?search|поиск(?:\s+в\s+)?(?:вебе|интернете)|web search/i.test(assistantText) ||
      ambigText.includes("web_search") ||
      ambigText.includes("web search");
    const isClarification =
      finalKind === "clarification_needed" ||
      finalState === "needs_clarification" ||
      /\?$/.test(assistantText.trim()) ||
      /уточн|clarif/i.test(lowerText);
    const looksLikeFakePoetry =
      !invokedWebSearch &&
      !mentionsWebSearch &&
      /(в духе|in the (?:style|spirit) of)/i.test(assistantText);
    if (invokedWebSearch) {
      pass = true;
      notes.push("tool_call: web_search");
    } else if (isClarification && mentionsWebSearch) {
      pass = true;
      notes.push("clarification_needed mentioning web_search");
    } else if (looksLikeFakePoetry) {
      pass = false;
      notes.push("assistant produced 'в духе'/'in the style of' prose without web_search — identity-unaware");
    } else if (mentionsWebSearch) {
      pass = true;
      notes.push("assistant mentioned web_search availability");
    } else {
      pass = false;
      notes.push(
        `expected web_search tool_call OR clarification mentioning web_search; got finalState=${String(finalState)} kind=${String(finalKind)}`,
      );
    }
  } else if (scenario.expect.kind === "credentials_preflight_clarify") {
    const finalState = result.finalEvent?.payload?.state ?? null;
    const finalKind = result.finalEvent?.payload?.outcome?.kind ?? result.finalEvent?.payload?.kind ?? null;
    const ambiguities = Array.isArray(result.finalEvent?.payload?.outcome?.ambiguities)
      ? result.finalEvent.payload.outcome.ambiguities.join(" | ")
      : "";
    const missingKeysAny = Array.isArray(scenario.expect.missingKeysAny)
      ? scenario.expect.missingKeysAny.map((value) => String(value).trim()).filter(Boolean)
      : [];
    const forbiddenTools = scenario.expect.forbiddenTools ?? ["exec", "apply_patch"];
    const usedForbiddenTool = toolCalls.some((call) => forbiddenTools.includes(String(call.name ?? "")));
    const combinedText = [assistantText, ambiguities].join("\n").toLowerCase();
    const mentionsMissingKey =
      missingKeysAny.length > 0
        ? missingKeysAny.some((key) => combinedText.includes(key.toLowerCase()))
        : /missing_credentials/i.test(combinedText);
    const isClarification =
      finalKind === "clarification_needed" ||
      finalState === "needs_clarification" ||
      /уточн|clarif/i.test(assistantText.toLowerCase());
    pass = isClarification && mentionsMissingKey && !usedForbiddenTool;
    if (!isClarification) {
      notes.push(`expected clarification state, got finalState=${String(finalState)} kind=${String(finalKind)}`);
    }
    if (!mentionsMissingKey) {
      notes.push(
        missingKeysAny.length > 0
          ? `none of missing keys [${missingKeysAny.join(", ")}] were mentioned in response/ambiguities`
          : "missing credentials were not mentioned in response/ambiguities",
      );
    }
    if (usedForbiddenTool) {
      notes.push(`forbidden tool used: ${forbiddenTools.join(",")}`);
    }
    if (isClarification && mentionsMissingKey && !usedForbiddenTool) {
      notes.push("clarification mentions missing credential key");
    }
  } else {
    const formats = scenario.expect.formats ?? [];
    const okByMagic = magics.some(({ path: p, hex }) => formats.some((f) => {
      if (p.toLowerCase().endsWith(`.${f}`)) {
        if (f === "csv" || f === "html") return true;
        const m = magicMatches(hex, f);
        return m === true;
      }
      return false;
    }));
    pass = okByMagic;
    if (!pass) {
      notes.push(`no artifact matched expected formats=[${formats.join(",")}]`);
      if (producedPaths.length === 0) {
        const callNames = toolCalls.map((c) => c.name).join(",");
        notes.push(`no artifact paths found (tool_calls=[${callNames}])`);
      } else {
        notes.push(`artifact magic bytes: ${magics.map((m) => `${path.basename(m.path)}=${m.hex}`).join("; ")}`);
      }
    }
  }

  if (scenario.expect.progressLog) {
    const progressResult = evaluateProgressLog(
      result.gatewayLogAppend ?? "",
      scenario.expect.progressLog,
      {
        events: result.events ?? [],
        startedAtMs: result.startedAtMs ?? 0,
      },
    );
    if (!progressResult.ok) {
      pass = false;
    }
    notes.push(...progressResult.notes);
  }
  if (scenario.expect.idempotentExec) {
    const progressTurns = parseProgressFramesFromEvents(result.events ?? []);
    let execToolCallCount = 0;
    for (const frames of progressTurns.values()) {
      execToolCallCount += frames.filter(
        (frame) => frame.phase === "tool_call" && frame.toolName === "exec",
      ).length;
    }
    const expectedExecToolCalls = Number.parseInt(
      String(scenario.expect.idempotentExec.expectedExecToolCalls ?? "1"),
      10,
    );
    if (execToolCallCount !== expectedExecToolCalls) {
      pass = false;
      notes.push(
        `expected exactly ${String(expectedExecToolCalls)} progress.frame tool_call=exec, got ${String(execToolCallCount)}`,
      );
    } else {
      notes.push(`progress.frame tool_call=exec count=${String(execToolCallCount)}`);
    }
    if (!/уже сделано|already done/i.test(assistantText)) {
      pass = false;
      notes.push("second reply did not indicate already-done reuse");
    } else {
      notes.push("already-done reply observed");
    }
  }
  if (scenario.expect.clarifyBudgetLog) {
    const clarifyBudgetResult = evaluateClarifyBudgetLog(
      result.gatewayLogAppend ?? "",
      scenario.expect.clarifyBudgetLog,
    );
    if (!clarifyBudgetResult.ok) {
      pass = false;
    }
    notes.push(...clarifyBudgetResult.notes);
  }

  return {
    id: scenario.id,
    message: scenario.message,
    expect: scenario.expect,
    pass,
    notes,
    producedPaths,
    rawCandidatePaths: [...rawPaths],
    magics,
    assistantTextPreview: assistantText.slice(0, 400),
    toolCalls,
    finalState: finalPayload?.state ?? null,
    finalError: finalPayload?.error ?? null,
    flags: result.flags ?? {},
  };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const home = os.homedir();
  const devSmokeCleanupPaths = [
    DEV_HELLO_PATH,
    DEV_SERVER_NOTE_PATH,
    path.join(home, ".openclaw", "workspace-dev", ".artifacts", "dev-smoke", "hello.txt"),
    path.join(home, ".openclaw-dev", "workspace", ".artifacts", "dev-smoke", "hello.txt"),
  ];
  for (const p of devSmokeCleanupPaths) {
    try {
      await fs.rm(p, { force: true });
    } catch {}
  }
  await fs.mkdir(DEV_SMOKE_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_AWARE_SIBLING_DIR, { recursive: true });
  try {
    await fs.writeFile(
      path.join(WORKSPACE_AWARE_SIBLING_DIR, "README.md"),
      "stub sibling root for live smoke 17-workspace-aware-exec — no package.json on purpose\n",
      "utf-8",
    );
  } catch {}
  applyCliProfileEnv({ profile: (process.env.OPENCLAW_PROFILE ?? "dev").trim().toLowerCase() || "dev" });
  const cfg = loadConfig();
  const auth = await resolveGatewayConnectionAuth({ config: cfg, env: process.env });
  const conn = await resolveGatewayConnection({
    url: "ws://127.0.0.1:19001",
    ...(auth.token ? { token: auth.token } : {}),
    ...(auth.password ? { password: auth.password } : {}),
  });

  const helloWaiters = [];
  let resolveHello;
  const hello = new Promise((r) => { resolveHello = r; });

  let eventSink = () => {};
  const client = new GatewayClient({
    url: conn.url,
    token: conn.token,
    password: conn.password,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "openclaw-phase7-driver",
    clientVersion: "dev",
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.UI,
    caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
    instanceId: `phase7-driver-${Date.now()}`,
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    onHelloOk: () => resolveHello(),
    onEvent: (evt) => eventSink(evt),
  });
  client.__onEvent = (evt) => {};
  eventSink = (evt) => client.__onEvent(evt);

  client.start();
  const overall = { startedAt: new Date().toISOString(), results: [] };
  try {
    await Promise.race([
      hello,
      new Promise((_, rej) => setTimeout(() => rej(new Error("hello timeout")), 15_000)),
    ]);
    console.log(`[hello] connected to ${conn.url}`);

    const smokeOnly = (process.env.SMOKE_ONLY ?? "").trim();
    const scenariosToRun = smokeOnly
      ? SCENARIOS.filter((scn) =>
          smokeOnly
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean)
            .includes(scn.id),
        )
      : SCENARIOS;
    if (smokeOnly && scenariosToRun.length === 0) {
      console.log(`[smoke] SMOKE_ONLY=${smokeOnly} matched zero scenarios; running nothing`);
    }
    for (const scenario of scenariosToRun) {
      const started = Date.now();
      const scenarioPreview = Array.isArray(scenario.messages)
        ? scenario.messages.join(" -> ")
        : scenario.message;
      const requirements = scenario.requirements ?? {};
      const envIssues = [];
      for (const name of requirements.gatewayEnvPresent ?? []) {
        if (!process.env[name] || !String(process.env[name]).trim()) {
          envIssues.push(`${name}=<unset>`);
        }
      }
      for (const [name, mustInclude] of Object.entries(
        requirements.gatewayEnvIncludes ?? {},
      )) {
        const actual = String(process.env[name] ?? "").toLowerCase();
        for (const needle of mustInclude) {
          const norm = String(needle).toLowerCase();
          if (!actual.includes(norm)) {
            envIssues.push(`${name} missing fragment "${needle}"`);
          }
        }
      }
      if (envIssues.length > 0) {
        const detail = envIssues.join(", ");
        console.log(
          `\n[scn ${scenario.id}] SKIP — gateway env not configured: ${detail}`,
        );
        overall.results.push({
          id: scenario.id,
          message: scenarioPreview,
          expect: scenario.expect,
          pass: false,
          skipped: true,
          notes: [`skipped: gateway env not configured (${detail})`],
        });
        continue;
      }
      const retryBudget = Math.max(0, Number(scenario.retryBudget ?? 0));
      let evalResult = null;
      let raw = null;
      const attempts = 1 + retryBudget;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const tag = attempts > 1 ? ` (attempt ${attempt}/${attempts})` : "";
        console.log(`\n[scn ${scenario.id}]${tag} send: ${scenarioPreview}`);
        try {
          raw = await runScenario(client, scenario);
        } catch (err) {
          evalResult = {
            id: scenario.id,
            message: scenarioPreview,
            expect: scenario.expect,
            pass: false,
            notes: [`scenario threw: ${String(err?.message || err)}`],
          };
          continue;
        }
        evalResult = await evaluate(raw);
        const durSec = Math.round((Date.now() - started) / 1000);
        console.log(
          `[scn ${scenario.id}]${tag} done in ${durSec}s pass=${evalResult.pass} finalState=${evalResult.finalState}`,
        );
        if (evalResult.pass) break;
        if (attempt < attempts) {
          console.log(`  retrying after notes: ${evalResult.notes.join(" | ")}`);
        }
      }
      if (evalResult && !evalResult.pass) {
        console.log(`  notes: ${evalResult.notes.join(" | ")}`);
        console.log(`  assistant: ${evalResult.assistantTextPreview}`);
      }
      await fs.writeFile(
        path.join(OUT_DIR, `${scenario.id}.json`),
        JSON.stringify(
          {
            raw: { final: raw?.finalEvent?.payload ?? null, history: raw?.history ?? [] },
            eval: evalResult,
          },
          null,
          2,
        ),
        "utf-8",
      );
      overall.results.push(evalResult);
    }
    overall.finishedAt = new Date().toISOString();
    const pass = overall.results.filter((r) => r.pass).length;
    const total = overall.results.length;
    overall.summary = { pass, total };
    await fs.writeFile(path.join(OUT_DIR, "summary.json"), JSON.stringify(overall, null, 2), "utf-8");
    console.log(`\n=== PHASE 7 RESULT: ${pass}/${total} passed ===`);
    for (const r of overall.results) {
      console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.notes?.join("; ") ?? ""}`);
    }
  } finally {
    client.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
