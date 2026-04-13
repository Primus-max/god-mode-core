import { randomUUID } from "node:crypto";
import { connectGatewayClient, disconnectGatewayClient } from "../../src/gateway/test-helpers.e2e.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../src/utils/message-channel.js";
import {
  extractFirstTextBlock,
  waitForChatFinalEvent,
  type ChatEventPayload,
} from "../../test/helpers/gateway-e2e-harness.js";
import { sleep } from "../../src/utils.js";

const CASE1_PROMPT = "Привет! Как дела? Просто поздоровайся.";
const CASE2_PROMPT =
  "Напиши подробный анализ: какие 5 метрик важны для SaaS продукта и почему. С примерами.";
const CASE4_PROMPT = "Сгенерируй PDF отчет с таблицей: название, количество, цена. Сохрани на диск.";
const CASE5_PROMPT = "\n\n\n   Привет!     Как работает   routing в OpenClaw?";
const CASE8_PROMPT =
  'Используй model:hydra/gpt-4o. Переведи на английский: "Умный роутинг экономит токены"';
const CASE19_PROMPT =
  "Посчитай базовую вентиляцию для комнаты 6x4x3 м, 4 человека, офисный режим. Дай assumptions, формулу и короткую сводку.";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function parseAction(): string {
  const action = process.argv[2]?.trim();
  if (!action) {
    throw new Error(
      "Usage: pnpm tsx scripts/dev/stage86-live-probe.ts <send-case1|send-case2|send-case4|send-case5|send-case8|send-case19|send-user-like-check|list-bootstrap|approve-run-latest-pdf>",
    );
  }
  return action;
}

async function sendPromptCase(params: {
  action: string;
  caseName: string;
  prompt: string;
  client: Awaited<ReturnType<typeof connectGatewayClient>>;
  events: ChatEventPayload[];
  getGrantedScopes: () => string[];
}) {
  const finalTimeoutMs =
    Number.parseInt(process.env.STAGE86_FINAL_TIMEOUT_MS ?? "", 10) ||
    (params.caseName === "stage86-case2" ? 300_000 : 120_000);
  const sessionKey =
    process.env.STAGE86_SESSION_KEY?.trim() ?? `agent:main:thread:${params.caseName}-${Date.now()}`;
  const sendRes = await params.client.request<{ runId?: string; status?: string }>("chat.send", {
    sessionKey,
    message: params.prompt,
    idempotencyKey: `${params.caseName}-${randomUUID()}`,
  });
  const runId = String(sendRes.runId ?? "");
  const finalEvent = await waitForChatFinalEvent({
    events: params.events,
    runId,
    sessionKey,
    timeoutMs: finalTimeoutMs,
  });
  const history = await params.client.request<{ items?: Array<{ message?: { role?: string } }> }>(
    "chat.history",
    {
      sessionKey,
      limit: 20,
    },
  );
  const bootstrap = await params.client.request<{
    requests?: Array<{
      id: string;
      capabilityId: string;
      state: string;
      createdAt: string;
      updatedAt: string;
    }>;
    pendingCount?: number;
  }>("platform.bootstrap.list", {});

  console.log(
    JSON.stringify(
      {
        action: params.action,
        sessionKey,
        runId,
        status: sendRes.status ?? null,
        finalState: finalEvent.state ?? null,
        finalText: extractFirstTextBlock(finalEvent.message),
        finalTimeoutMs,
        grantedScopes: params.getGrantedScopes(),
        historyCount: Array.isArray(history?.items) ? history.items.length : 0,
        bootstrapPendingCount: bootstrap.pendingCount ?? null,
        bootstrapRequests: bootstrap.requests ?? [],
      },
      null,
      2,
    ),
  );
}

async function runUserLikeCheck(params: {
  action: string;
  client: Awaited<ReturnType<typeof connectGatewayClient>>;
  events: ChatEventPayload[];
  getGrantedScopes: () => string[];
}) {
  const sessionKey = `agent:main:thread:stage86-user-like-${Date.now()}`;
  const finalTimeoutMs = Number.parseInt(process.env.STAGE86_FINAL_TIMEOUT_MS ?? "", 10) || 180_000;
  const prompts = [
    "Привет! Как дела? Просто поздоровайся.",
    "Теперь кратко скажи, какие 2 метрики SaaS самые важные и почему.",
  ];
  const finalTexts: string[] = [];

  for (const prompt of prompts) {
    const sendRes = await params.client.request<{ runId?: string; status?: string }>("chat.send", {
      sessionKey,
      message: prompt,
      idempotencyKey: `stage86-user-like-${randomUUID()}`,
    });
    const runId = String(sendRes.runId ?? "");
    const finalEvent = await waitForChatFinalEvent({
      events: params.events,
      runId,
      sessionKey,
      timeoutMs: finalTimeoutMs,
    });
    finalTexts.push(extractFirstTextBlock(finalEvent.message) ?? "");
  }

  const history = await params.client.request<{ messages?: Array<unknown> }>("chat.history", {
    sessionKey,
    limit: 20,
  });
  const historyMessages = Array.isArray(history?.messages) ? history.messages : [];
  const assistantTexts = historyMessages
    .filter((message): message is { role?: string; text?: string; content?: unknown } =>
      Boolean(message && typeof message === "object"),
    )
    .filter((message) => message.role === "assistant")
    .map((message) => {
      if (typeof message.text === "string") {
        return message.text.trim();
      }
      if (typeof message.content === "string") {
        return message.content.trim();
      }
      if (Array.isArray(message.content)) {
        return message.content
          .map((block) =>
            block && typeof block === "object" && "text" in block && typeof block.text === "string"
              ? block.text
              : "",
          )
          .join("\n")
          .trim();
      }
      return "";
    })
    .filter(Boolean);
  const duplicateAdjacentCount = assistantTexts.filter(
    (text, index) => index > 0 && text === assistantTexts[index - 1],
  ).length;
  const recoveryLeakCount = assistantTexts.filter((text) =>
    /I understand the directive|Queued #1|The previous run did not satisfy|Execution contract expected confirmed delivery|missing verified receipt|semantic retry/i.test(
      text,
    ),
  ).length;

  console.log(
    JSON.stringify(
      {
        action: params.action,
        sessionKey,
        finalTimeoutMs,
        grantedScopes: params.getGrantedScopes(),
        prompts,
        finalTexts,
        assistantCount: assistantTexts.length,
        duplicateAdjacentCount,
        recoveryLeakCount,
        assistantTexts,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const action = parseAction();
  const url = requireEnv("STAGE86_GATEWAY_URL");
  const token = requireEnv("OPENCLAW_GATEWAY_TOKEN");
  const events: ChatEventPayload[] = [];
  let grantedScopes: string[] = [];

  const client = await connectGatewayClient({
    url,
    token,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: "stage86-live-probe",
    clientVersion: "dev",
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.CLI,
    // Stage 86 live probes should emulate an owner/operator client so inline
    // directives like `model:` are exercised on the same path as authorized
    // Telegram/operator usage.
    scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
    onHelloOk: (hello) => {
      const authScopes = Array.isArray(hello?.auth?.scopes) ? hello.auth.scopes.filter(Boolean) : [];
      if (authScopes.length > 0) {
        grantedScopes = authScopes;
        return;
      }
      const presence = Array.isArray(hello?.snapshot?.presence) ? hello.snapshot.presence : [];
      const mine = presence.find((entry) => entry?.client?.id === GATEWAY_CLIENT_NAMES.CLI);
      grantedScopes = Array.isArray(mine?.scopes) ? mine.scopes.filter(Boolean) : [];
    },
    onEvent: (evt) => {
      if (evt.event === "chat" && evt.payload && typeof evt.payload === "object") {
        events.push(evt.payload as ChatEventPayload);
      }
    },
  });

  try {
    if (action === "send-case1") {
      await sendPromptCase({
        action,
        caseName: "stage86-case1",
        prompt: CASE1_PROMPT,
        client,
        events,
        getGrantedScopes: () => grantedScopes,
      });
      return;
    }

    if (action === "send-case2") {
      await sendPromptCase({
        action,
        caseName: "stage86-case2",
        prompt: CASE2_PROMPT,
        client,
        events,
        getGrantedScopes: () => grantedScopes,
      });
      return;
    }

    if (action === "send-case4") {
      await sendPromptCase({
        action,
        caseName: "stage86-case4-rerun",
        prompt: CASE4_PROMPT,
        client,
        events,
        getGrantedScopes: () => grantedScopes,
      });
      return;
    }

    if (action === "send-case5") {
      await sendPromptCase({
        action,
        caseName: "stage86-case5",
        prompt: CASE5_PROMPT,
        client,
        events,
        getGrantedScopes: () => grantedScopes,
      });
      return;
    }

    if (action === "send-case8") {
      await sendPromptCase({
        action,
        caseName: "stage86-case8",
        prompt: CASE8_PROMPT,
        client,
        events,
        getGrantedScopes: () => grantedScopes,
      });
      return;
    }

    if (action === "send-case19") {
      await sendPromptCase({
        action,
        caseName: "stage86-case19",
        prompt: CASE19_PROMPT,
        client,
        events,
        getGrantedScopes: () => grantedScopes,
      });
      return;
    }

    if (action === "send-user-like-check") {
      await runUserLikeCheck({
        action,
        client,
        events,
        getGrantedScopes: () => grantedScopes,
      });
      return;
    }

    if (action === "list-bootstrap") {
      const bootstrap = await client.request("platform.bootstrap.list", {});
      console.log(JSON.stringify(bootstrap, null, 2));
      return;
    }

    if (action === "approve-run-latest-pdf") {
      const bootstrap = await client.request<{
        requests?: Array<{
          id: string;
          capabilityId: string;
          state: string;
          createdAt: string;
          updatedAt: string;
        }>;
      }>("platform.bootstrap.list", {});
      const latestPdf = [...(bootstrap.requests ?? [])]
        .filter((entry) => entry.capabilityId === "pdf-renderer")
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
      if (!latestPdf) {
        throw new Error("No pdf-renderer bootstrap request found");
      }
      let detail = await client.request<{ detail?: unknown }>("platform.bootstrap.get", {
        requestId: latestPdf.id,
      });
      if (latestPdf.state === "pending") {
        detail = await client.request("platform.bootstrap.resolve", {
          requestId: latestPdf.id,
          decision: "approve",
        });
      }
      const runResult = await client.request("platform.bootstrap.run", {
        requestId: latestPdf.id,
      });
      await sleep(2_000);
      const after = await client.request("platform.bootstrap.get", {
        requestId: latestPdf.id,
      });
      console.log(
        JSON.stringify(
          {
            action,
            requestId: latestPdf.id,
            before: detail,
            runResult,
            after,
          },
          null,
          2,
        ),
      );
      return;
    }

    throw new Error(`Unknown action: ${action}`);
  } finally {
    await disconnectGatewayClient(client);
  }
}

await main();
