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
const TIMEOUT_MS = 300_000;
const HISTORY_POLL_MS = 1500;

const CHAIN_PDF_DOCX = `chain-pdf-docx-${Date.now()}`;
const SCENARIOS = [
  { id: "01-hello", message: "Привет", expect: { kind: "text" } },
  { id: "02-image", message: "Сгенерировать картинку банана", expect: { kind: "image", formats: ["png", "jpeg", "jpg", "webp"] } },
  { id: "03-pdf", sessionGroup: CHAIN_PDF_DOCX, message: "Сгенерировать pdf про жизнь банана, красивый пдф, а не просто текст вставленный.", expect: { kind: "document_package", formats: ["pdf"] } },
  { id: "04-docx", sessionGroup: CHAIN_PDF_DOCX, message: "То же самое сгенерировать в word.", expect: { kind: "document_package", formats: ["docx"] } },
  { id: "05-csv", message: "Какой то отчёт сделать в csv.", expect: { kind: "document_package", formats: ["csv"] } },
  { id: "06-xlsx", message: "Какой то отчёт сделать в эксель.", expect: { kind: "document_package", formats: ["xlsx"] } },
  { id: "07-site", message: "Создание сайта — простая лендинг-страница про бананы, отдай готовый архив.", expect: { kind: "document_package", formats: ["zip", "html"] } },
  { id: "08-capability-install", message: "Установи пожалуйста стороннюю библиотеку pdfkit — она нам нужна, выполни установку.", expect: { kind: "capability_install_or_clarify" } },
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

async function runScenario(client, scenario) {
  const runId = `${scenario.id}-${Date.now()}`;
  const sessionKey = scenario.sessionGroup
    ? `live-routing-smoke:${scenario.sessionGroup}`
    : `live-routing-smoke:${scenario.id}:${Date.now()}`;
  const events = [];
  client.__onEvent = (evt) => events.push(evt);

  const start = await client.request("chat.send", {
    sessionKey,
    message: scenario.message,
    idempotencyKey: runId,
  });
  const deadline = Date.now() + TIMEOUT_MS;
  let finalEvent = null;
  let lastHistory = null;
  let historyKeyUsed = sessionKey;
  let lastMsgCount = 0;
  let stableSince = 0;
  let sawToolCall = false;
  let sawToolResult = false;
  const initialMsgCount = (await fetchHistoryAny(client, sessionKey))?.res?.messages?.length ?? 0;
  while (Date.now() < deadline) {
    finalEvent =
      events.find((evt) => evt.event === "chat" && evt.payload?.state === "final" && evt.payload?.runId === runId) ??
      null;
    const { key, res } = await fetchHistoryAny(client, sessionKey);
    lastHistory = res;
    historyKeyUsed = key;
    const msgs = lastHistory?.messages ?? [];
    if (msgs.length > lastMsgCount) {
      lastMsgCount = msgs.length;
      stableSince = Date.now();
    }
    const turnMsgs = msgs.slice(initialMsgCount);
    if (!sawToolCall) sawToolCall = turnMsgs.some(messageHasToolCall);
    if (!sawToolResult) sawToolResult = turnMsgs.some(messageHasToolResult);
    const lastTurnMsg = turnMsgs.length > 0 ? turnMsgs[turnMsgs.length - 1] : null;
    const lastTurnIsAssistantText =
      lastTurnMsg &&
      lastTurnMsg.role === "assistant" &&
      messageHasAssistantText(lastTurnMsg) &&
      !messageHasToolCall(lastTurnMsg);
    if (finalEvent && sawToolCall && sawToolResult && lastTurnIsAssistantText) break;
    if (finalEvent && !sawToolCall && lastTurnIsAssistantText) break;
    if (sawToolCall) {
      if (sawToolResult && lastTurnIsAssistantText && stableSince > 0 && Date.now() - stableSince > 8_000) {
        break;
      }
      if (sawToolResult && finalEvent && stableSince > 0 && Date.now() - stableSince > 4_000) {
        break;
      }
    } else if (lastTurnIsAssistantText && stableSince > 0 && Date.now() - stableSince > 6000) {
      break;
    }
    await new Promise((r) => setTimeout(r, HISTORY_POLL_MS));
  }
  return {
    scenario,
    runId,
    sessionKey,
    historyKeyUsed,
    start,
    finalEvent,
    history: lastHistory,
    initialMsgCount,
    events: events.slice(),
    flags: { sawToolCall, sawToolResult },
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

    for (const scenario of SCENARIOS) {
      const started = Date.now();
      console.log(`\n[scn ${scenario.id}] send: ${scenario.message}`);
      let raw;
      try {
        raw = await runScenario(client, scenario);
      } catch (err) {
        overall.results.push({
          id: scenario.id,
          message: scenario.message,
          expect: scenario.expect,
          pass: false,
          notes: [`scenario threw: ${String(err?.message || err)}`],
        });
        continue;
      }
      const evalResult = await evaluate(raw);
      const durSec = Math.round((Date.now() - started) / 1000);
      console.log(`[scn ${scenario.id}] done in ${durSec}s pass=${evalResult.pass} finalState=${evalResult.finalState}`);
      if (!evalResult.pass) {
        console.log(`  notes: ${evalResult.notes.join(" | ")}`);
        console.log(`  assistant: ${evalResult.assistantTextPreview}`);
      }
      await fs.writeFile(
        path.join(OUT_DIR, `${scenario.id}.json`),
        JSON.stringify({ raw: { final: raw.finalEvent?.payload ?? null, history: raw.history }, eval: evalResult }, null, 2),
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
