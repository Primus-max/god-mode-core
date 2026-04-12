import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { connectGatewayClient, disconnectGatewayClient } from "../../src/gateway/test-helpers.e2e.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../src/utils/message-channel.js";
import {
  extractFirstTextBlock,
  waitForChatFinalEvent,
  type ChatEventPayload,
} from "../../test/helpers/gateway-e2e-harness.js";
import { sleep } from "../../src/utils.js";

type RpcAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: string;
};

type SessionRow = {
  key: string;
  modelProvider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  status?: string;
};

type AssistantMessage = {
  text: string;
  provider?: string;
  model?: string;
};

type NormalizedSessionMessage = {
  role?: string;
  text: string;
  provider?: string;
  model?: string;
  toolName?: string;
  details?: Record<string, unknown>;
  isError?: boolean;
};

type ToolExpectation = {
  toolName: string;
  pathExt?: string;
  renderKind?: string;
  minMediaCount?: number;
};

type BootstrapRequest = {
  id: string;
  capabilityId: string;
  state: string;
  createdAt: string;
  updatedAt: string;
};

type ProbeStep = {
  prompt: string;
  attachments?: RpcAttachment[];
  timeoutMs?: number;
  expectProvider?: string;
  expectModelIncludes?: string;
  expectTextIncludes?: string[];
  expectTool?: ToolExpectation;
  expectTools?: ToolExpectation[];
};

type Scenario =
  | {
      id: string;
      kind: "turns";
      description: string;
      steps: ProbeStep[];
      expectNoDuplicates?: boolean;
      expectNoRecoveryLeaks?: boolean;
      expectBootstrapCapability?: string;
    }
  | {
      id: string;
      kind: "bootstrap-resume";
      description: string;
      capabilityId: string;
      step: ProbeStep;
      expectBootstrapTerminalState?: string;
      expectNoDuplicates?: boolean;
      expectNoRecoveryLeaks?: boolean;
    };

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readScenarioFilter(): Set<string> | null {
  const raw = process.env.STAGE86_MATRIX_CASES?.trim();
  if (!raw) {
    return null;
  }
  const ids = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

function toBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function csvAttachment(fileName: string, csv: string): RpcAttachment {
  return {
    type: "file",
    mimeType: "text/csv",
    fileName,
    content: toBase64(csv),
  };
}

function buildCsvFixtures() {
  const vendorA = csvAttachment(
    "vendor-a.csv",
    [
      "sku,name,qty,price",
      "A1,Concrete M300,10,5200",
      "A2,Rebar 12mm,40,780",
      "A3,Sand washed,15,650",
    ].join("\n"),
  );
  const vendorB = csvAttachment(
    "vendor-b.csv",
    [
      "sku,name,qty,price",
      "B1,Concrete M300,10,5000",
      "B2,Rebar 12mm,40,820",
      "B3,Sand washed,15,610",
    ].join("\n"),
  );
  const single = csvAttachment(
    "stock.csv",
    [
      "item,qty,price",
      "GPU,2,120000",
      "SSD,5,9500",
      "Router,1,18000",
    ].join("\n"),
  );
  return { vendorA, vendorB, single };
}

function buildScenarios(): Scenario[] {
  const { vendorA, vendorB, single } = buildCsvFixtures();
  return [
    {
      id: "case01-local-greeting",
      kind: "turns",
      description: "Простое приветствие должно остаться на локальном маршруте.",
      steps: [
        {
          prompt: "Привет! Как дела? Просто поздоровайся одной короткой фразой.",
          expectProvider: "ollama",
          expectModelIncludes: "gemma4",
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case02-local-rewrite",
      kind: "turns",
      description: "Короткий rewrite без тяжёлой аналитики.",
      steps: [
        {
          prompt:
            "Перепиши фразу короче и дружелюбнее: Умный роутинг распределяет задачи по подходящим моделям.",
          expectProvider: "ollama",
          expectModelIncludes: "gemma4",
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case03-local-checklist",
      kind: "turns",
      description: "Небольшой список без ухода в дорогой remote path.",
      steps: [
        {
          prompt: "Назови 3 коротких признака хорошего onboarding в продукте.",
          expectProvider: "ollama",
          expectModelIncludes: "gemma4",
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case04-remote-saas-metrics",
      kind: "turns",
      description: "Сильный аналитический запрос должен уйти в hydra/gpt-4o.",
      steps: [
        {
          prompt:
            "Напиши подробный анализ: какие 5 метрик важны для SaaS продукта и почему. С примерами.",
          expectProvider: "hydra",
          expectModelIncludes: "gpt-4o",
          expectTextIncludes: ["1.", "2.", "3.", "4.", "5."],
          timeoutMs: 300_000,
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case05-remote-architecture",
      kind: "turns",
      description: "Сложное архитектурное сравнение тоже должно усиливаться.",
      steps: [
        {
          prompt:
            "Сравни 3 подхода к smart routing для AI-оркестратора: rules-only, profiles+policy, graph-based planner. Дай плюсы, минусы и когда что выбрать.",
          expectProvider: "hydra",
          expectModelIncludes: "gpt-4o",
          expectTextIncludes: ["rules", "policy", "graph"],
          timeoutMs: 300_000,
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case06-explicit-hydra-translate",
      kind: "turns",
      description: "Явный model override должен честно пиновать hydra/gpt-4o.",
      steps: [
        {
          prompt:
            'Используй model:hydra/gpt-4o. Переведи на английский: "Умный роутинг экономит токены".',
          expectProvider: "hydra",
          expectModelIncludes: "gpt-4o",
          expectTextIncludes: ["Smart routing saves tokens"],
          timeoutMs: 300_000,
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case07-explicit-hydra-bullets",
      kind: "turns",
      description: "Ещё один override-кейс с форматом bullet list.",
      steps: [
        {
          prompt:
            "Используй model:hydra/gpt-4o. Дай 3 bullet points, почему честный recovery contract важен для AI runtime.",
          expectProvider: "hydra",
          expectModelIncludes: "gpt-4o",
          timeoutMs: 300_000,
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case08-image-generate-delivery",
      kind: "turns",
      description: "Генерация картинки должна отдать реальный image artifact, а не только текст.",
      steps: [
        {
          prompt:
            "Используй model:hydra/gpt-4o. Сгенерируй PNG-баннер 16:9 с текстом Atlas Release Ready и верни готовую картинку.",
          timeoutMs: 300_000,
          expectTool: {
            toolName: "image_generate",
            pathExt: ".png",
            minMediaCount: 1,
          },
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case09-image-generate-reuse",
      kind: "turns",
      description: "Повторная генерация картинки в той же сессии должна снова отдать image artifact.",
      steps: [
        {
          prompt:
            "Используй model:hydra/gpt-4o. Сгенерируй квадратную иконку с надписью Atlas.",
          timeoutMs: 300_000,
          expectTool: {
            toolName: "image_generate",
            pathExt: ".png",
            minMediaCount: 1,
          },
        },
        {
          prompt:
            "Теперь сгенерируй второй вариант этой иконки в более тёмном стиле и тоже верни готовую картинку.",
          timeoutMs: 300_000,
          expectTool: {
            toolName: "image_generate",
            pathExt: ".png",
            minMediaCount: 1,
          },
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case10-two-turn-regression",
      kind: "turns",
      description: "Два пользовательских хода без дублей и утечки recovery текста.",
      steps: [
        {
          prompt: "Привет! Как дела? Просто поздоровайся.",
          expectProvider: "ollama",
          expectModelIncludes: "gemma4",
        },
        {
          prompt: "Теперь кратко скажи, какие 2 метрики SaaS самые важные и почему.",
          expectProvider: "hydra",
          expectModelIncludes: "gpt-4o",
          timeoutMs: 300_000,
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case11-three-turn-continuity",
      kind: "turns",
      description: "Проверка контекста между тремя сообщениями в одной сессии.",
      steps: [
        {
          prompt: "Запомни: проект называется Atlas, команда из 7 человек, мы делаем B2B SaaS.",
        },
        {
          prompt: "Назови 2 риска для такого проекта.",
          expectProvider: "ollama",
          expectModelIncludes: "gemma4",
        },
        {
          prompt: "Теперь в 2 пунктах напомни контекст проекта из моего первого сообщения.",
          expectTextIncludes: ["Atlas", "7"],
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case12-five-turn-stability",
      kind: "turns",
      description: "Мини-сессия из пяти пользовательских ходов подряд.",
      steps: [
        {
          prompt: "Привет. Ответь очень коротко.",
          expectProvider: "ollama",
        },
        {
          prompt: "Какие 2 задачи лучше оставить на локальной модели?",
        },
        {
          prompt: "А какие 2 задачи лучше отправлять в сильный remote route?",
          expectProvider: "ollama",
          expectModelIncludes: "gemma4",
        },
        {
          prompt: "Сведи всё в таблицу markdown.",
        },
        {
          prompt: "Теперь дай одно итоговое правило выбора маршрута.",
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case13-pdf-bootstrap-request",
      kind: "bootstrap-resume",
      description:
        "Первый PDF-запрос должен честно пройти approve -> bootstrap -> resume и в итоге вернуть реальный PDF-файл.",
      capabilityId: "pdf-renderer",
      step: {
        prompt:
          "Сгенерируй PDF отчет с таблицей: название, количество, цена. Верни готовый PDF-файл и скажи имя файла.",
        timeoutMs: 180_000,
        expectTool: {
          toolName: "pdf",
          pathExt: ".pdf",
          renderKind: "pdf",
          minMediaCount: 1,
        },
      },
      expectBootstrapTerminalState: "error",
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case14-pdf-bootstrap-resume",
      kind: "turns",
      description: "Повторный PDF после первой генерации не должен скатываться в bootstrap-ответы и должен снова отдать файл.",
      steps: [
        {
          prompt:
            "Сгенерируй ещё один PDF отчет по продажам за март с колонками товар, количество, выручка. Верни сам PDF, а не только текстовое подтверждение.",
          timeoutMs: 180_000,
          expectTool: {
            toolName: "pdf",
            pathExt: ".pdf",
            renderKind: "pdf",
            minMediaCount: 1,
          },
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case14b-mixed-image-pdf-delivery",
      kind: "turns",
      description:
        "Смешанный запрос image + PDF должен вернуть оба артефакта без recovery leak и без повторного финала.",
      steps: [
        {
          prompt:
            "Можешь сгенерировать картинку котёнка и создать PDF-файл с его расписанием и жизнью, в графиках и таблицах. Верни и картинку, и сам PDF.",
          timeoutMs: 300_000,
          expectTools: [
            {
              toolName: "image_generate",
              pathExt: ".png",
              minMediaCount: 1,
            },
            {
              toolName: "pdf",
              pathExt: ".pdf",
              renderKind: "pdf",
              minMediaCount: 1,
            },
          ],
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case15-single-csv-summary",
      kind: "turns",
      description: "Один CSV-файл: суммирование и markdown-таблица.",
      steps: [
        {
          prompt:
            "Во вложении CSV с товарами. Суммируй общую стоимость, выдели самый дорогой товар и дай markdown-таблицу.",
          attachments: [single],
          timeoutMs: 300_000,
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case16-price-compare-two-files",
      kind: "turns",
      description: "Два CSV-файла: сравнение прайсов и рекомендация.",
      steps: [
        {
          prompt:
            "Сравни два прайса из вложений, нормализуй позиции, покажи ranked summary table и скажи, у кого выгоднее закупка.",
          attachments: [vendorA, vendorB],
          timeoutMs: 300_000,
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case17-price-compare-followup",
      kind: "turns",
      description: "Контекст по двум файлам должен сохраняться между ходами.",
      steps: [
        {
          prompt:
            "Сравни вложенные прайсы и скажи, какой поставщик лучше по общей корзине из файлов.",
          attachments: [vendorA, vendorB],
          timeoutMs: 300_000,
        },
        {
          prompt: "Теперь дай только 3 причины выбора победителя без переписывания всей таблицы.",
          timeoutMs: 180_000,
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case18-markdown-report",
      kind: "turns",
      description: "Markdown-отчет по вложениям без развала в сырой dump.",
      steps: [
        {
          prompt:
            "По двум вложенным прайсам сделай короткий markdown-отчет: summary, таблица различий, рекомендация.",
          attachments: [vendorA, vendorB],
          timeoutMs: 300_000,
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case19-ventilation-summary",
      kind: "turns",
      description: "Структурированный расчетный ответ по размерам и assumptions.",
      steps: [
        {
          prompt:
            "Посчитай базовую вентиляцию для комнаты 6x4x3 м, 4 человека, офисный режим. Дай assumptions, формулу и короткую сводку.",
          timeoutMs: 300_000,
          expectTextIncludes: ["формул", "4", "240"],
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
    {
      id: "case20-remote-long-plan",
      kind: "turns",
      description: "Ещё один длинный сильный аналитический turn под release pressure.",
      steps: [
        {
          prompt:
            "Составь краткий, но структурированный план стабилизации AI-оркестратора перед релизом: routing, recovery, bootstrap, observability, e2e proof. Для каждого пункта укажи риск и критерий готовности.",
          expectProvider: "hydra",
          timeoutMs: 300_000,
        },
      ],
      expectNoDuplicates: true,
      expectNoRecoveryLeaks: true,
    },
  ];
}

async function waitForFinal(params: {
  client: Awaited<ReturnType<typeof connectGatewayClient>>;
  events: ChatEventPayload[];
  sessionKey: string;
  prompt: string;
  attachments?: RpcAttachment[];
  timeoutMs: number;
}) {
  const sendRes = await params.client.request<{ runId?: string; status?: string }>("chat.send", {
    sessionKey: params.sessionKey,
    message: params.prompt,
    attachments: params.attachments,
    timeoutMs: params.timeoutMs,
    idempotencyKey: `${params.sessionKey}-${randomUUID()}`,
  });
  const runId = String(sendRes.runId ?? "");
  const finalEvent = await waitForChatFinalEvent({
    events: params.events,
    runId,
    sessionKey: params.sessionKey,
    timeoutMs: params.timeoutMs,
  });
  return {
    runId,
    status: sendRes.status ?? null,
    finalState: finalEvent.state ?? null,
    finalText: extractFirstTextBlock(finalEvent.message) ?? "",
  };
}

async function waitForTerminalEvent(params: {
  events: ChatEventPayload[];
  runId: string;
  sessionKey: string;
  timeoutMs: number;
}) {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const match = params.events.find(
      (evt) =>
        evt.runId === params.runId &&
        evt.sessionKey === params.sessionKey &&
        (evt.state === "final" || evt.state === "error"),
    );
    if (match) {
      return match;
    }
    await sleep(20);
  }
  throw new Error(`timeout waiting for terminal chat event (runId=${params.runId})`);
}

async function getSessionRow(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  sessionKey: string,
): Promise<SessionRow | null> {
  const list = await client.request<{ sessions?: SessionRow[] }>("sessions.list", {
    search: sessionKey,
    limit: 20,
    activeMinutes: 600,
  });
  const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
  return sessions.find((entry) => entry?.key === sessionKey) ?? null;
}

async function getAssistantTexts(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  sessionKey: string,
): Promise<string[]> {
  const messages = await getAssistantMessages(client, sessionKey);
  return messages.map((message) => message.text).filter(Boolean);
}

async function getAssistantMessages(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  sessionKey: string,
): Promise<AssistantMessage[]> {
  const history = await client.request<{ messages?: Array<unknown> }>("sessions.get", {
    sessionKey,
    limit: 50,
  });
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  return messages
    .map((message) => {
      if (!message || typeof message !== "object") {
        return null;
      }
      const topLevel = message as {
        role?: string;
        text?: string;
        content?: unknown;
        provider?: string;
        model?: string;
        message?: {
          role?: string;
          text?: string;
          content?: unknown;
          provider?: string;
          model?: string;
        };
      };
      const payload = topLevel.message && typeof topLevel.message === "object" ? topLevel.message : topLevel;
      if (payload.role !== "assistant") {
        return null;
      }
      const text =
        typeof payload.text === "string"
          ? payload.text.trim()
          : typeof payload.content === "string"
            ? payload.content.trim()
            : Array.isArray(payload.content)
              ? payload.content
                  .map((block) =>
                    block && typeof block === "object" && "text" in block && typeof block.text === "string"
                      ? block.text
                      : "",
                  )
                  .join("\n")
                  .trim()
              : "";
      return {
        text,
        provider:
          typeof payload.provider === "string"
            ? payload.provider
            : typeof topLevel.provider === "string"
              ? topLevel.provider
              : undefined,
        model:
          typeof payload.model === "string"
            ? payload.model
            : typeof topLevel.model === "string"
              ? topLevel.model
              : undefined,
      } satisfies AssistantMessage;
    })
    .filter((message): message is AssistantMessage => Boolean(message?.text));
}

async function getSessionMessages(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  sessionKey: string,
): Promise<NormalizedSessionMessage[]> {
  const history = await client.request<{ messages?: Array<unknown> }>("sessions.get", {
    sessionKey,
    limit: 100,
  });
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  return messages
    .map((message) => {
      if (!message || typeof message !== "object") {
        return null;
      }
      const topLevel = message as {
        role?: string;
        text?: string;
        content?: unknown;
        provider?: string;
        model?: string;
        toolName?: string;
        details?: Record<string, unknown>;
        isError?: boolean;
        message?: {
          role?: string;
          text?: string;
          content?: unknown;
          provider?: string;
          model?: string;
          toolName?: string;
          details?: Record<string, unknown>;
          isError?: boolean;
        };
      };
      const payload = topLevel.message && typeof topLevel.message === "object" ? topLevel.message : topLevel;
      const text =
        typeof payload.text === "string"
          ? payload.text.trim()
          : typeof payload.content === "string"
            ? payload.content.trim()
            : Array.isArray(payload.content)
              ? payload.content
                  .map((block) =>
                    block && typeof block === "object" && "text" in block && typeof block.text === "string"
                      ? block.text
                      : "",
                  )
                  .join("\n")
                  .trim()
              : "";
      return {
        role: typeof payload.role === "string" ? payload.role : typeof topLevel.role === "string" ? topLevel.role : undefined,
        text,
        provider:
          typeof payload.provider === "string"
            ? payload.provider
            : typeof topLevel.provider === "string"
              ? topLevel.provider
              : undefined,
        model:
          typeof payload.model === "string"
            ? payload.model
            : typeof topLevel.model === "string"
              ? topLevel.model
              : undefined,
        toolName:
          typeof payload.toolName === "string"
            ? payload.toolName
            : typeof topLevel.toolName === "string"
              ? topLevel.toolName
              : undefined,
        details:
          payload.details && typeof payload.details === "object"
            ? payload.details
            : topLevel.details && typeof topLevel.details === "object"
              ? topLevel.details
              : undefined,
        isError:
          typeof payload.isError === "boolean"
            ? payload.isError
            : typeof topLevel.isError === "boolean"
              ? topLevel.isError
              : undefined,
      } satisfies NormalizedSessionMessage;
    })
    .filter((message): message is NormalizedSessionMessage => Boolean(message));
}

function extractMediaPaths(message: NormalizedSessionMessage | undefined): string[] {
  if (!message?.details) {
    return [];
  }
  const details = message.details;
  const directPaths = Array.isArray(details.paths)
    ? details.paths.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const mediaObject =
    details.media && typeof details.media === "object" ? (details.media as { mediaUrls?: unknown }) : undefined;
  const mediaPaths = Array.isArray(mediaObject?.mediaUrls)
    ? mediaObject.mediaUrls.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  return Array.from(new Set([...directPaths, ...mediaPaths]));
}

async function evaluateToolExpectation(params: {
  step: ProbeStep;
  deltaMessages: NormalizedSessionMessage[];
  allMessages?: NormalizedSessionMessage[];
}): Promise<string[]> {
  const failures: string[] = [];
  const expectations = params.step.expectTools?.length
    ? params.step.expectTools
    : params.step.expectTool
      ? [params.step.expectTool]
      : [];
  if (expectations.length === 0) {
    return failures;
  }
  for (const expectation of expectations) {
    const toolMessages = params.deltaMessages.filter(
      (message) => message.role === "toolResult" && message.toolName === expectation.toolName,
    );
    const successfulToolMessage =
      [...toolMessages].reverse().find((message) => message.isError !== true) ?? toolMessages.at(-1);
    const fallbackToolMessage =
      successfulToolMessage ??
      [...(params.allMessages ?? [])]
        .reverse()
        .find(
          (message) =>
            message.role === "toolResult" &&
            message.toolName === expectation.toolName &&
            message.isError !== true,
        );
    if (!fallbackToolMessage) {
      failures.push(`missing toolResult for ${expectation.toolName}`);
      continue;
    }
    const resolvedToolMessage = fallbackToolMessage;
    if (expectation.renderKind) {
      const renderKind =
        resolvedToolMessage.details && typeof resolvedToolMessage.details.renderKind === "string"
          ? resolvedToolMessage.details.renderKind
          : undefined;
      if (renderKind !== expectation.renderKind) {
        failures.push(`expected renderKind=${expectation.renderKind}, got=${renderKind ?? "unknown"}`);
      }
    }
    const mediaPaths = extractMediaPaths(resolvedToolMessage);
    if (mediaPaths.length < (expectation.minMediaCount ?? 1)) {
      failures.push(`expected at least ${String(expectation.minMediaCount ?? 1)} media path(s), got=${String(mediaPaths.length)}`);
      continue;
    }
    if (expectation.pathExt) {
      const normalizedExt = expectation.pathExt.toLowerCase();
      if (!mediaPaths.some((entry) => entry.toLowerCase().endsWith(normalizedExt))) {
        failures.push(`expected artifact path ending with ${expectation.pathExt}`);
      }
    }
    const missingPaths: string[] = [];
    for (const mediaPath of mediaPaths) {
      try {
        await fs.access(mediaPath);
      } catch {
        missingPaths.push(mediaPath);
      }
    }
    if (missingPaths.length > 0) {
      failures.push(`artifact path missing on disk: ${missingPaths[0]}`);
    }
  }
  return failures;
}

function collectHistoryFlags(texts: string[]) {
  return {
    assistantCount: texts.length,
    duplicateAdjacentCount: texts.filter((text, index) => index > 0 && text === texts[index - 1]).length,
    recoveryLeakCount: texts.filter((text) =>
      /I understand the directive|Queued #1|The previous run did not satisfy|Still working on this|Execution contract (?:for .* )?expected output|Execution contract expected confirmed delivery|missing verified receipt|semantic retry/i.test(
        text,
      ),
    ).length,
  };
}

async function getLatestBootstrapRequest(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  capabilityId: string,
): Promise<BootstrapRequest | null> {
  const bootstrap = await client.request<{ requests?: BootstrapRequest[] }>("platform.bootstrap.list", {});
  const requests = Array.isArray(bootstrap?.requests) ? bootstrap.requests : [];
  return (
    [...requests]
      .filter((entry) => entry.capabilityId === capabilityId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null
  );
}

async function pollBootstrapState(params: {
  client: Awaited<ReturnType<typeof connectGatewayClient>>;
  requestId: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  let lastDetail: unknown = null;
  while (Date.now() - startedAt < params.timeoutMs) {
    lastDetail = await params.client.request("platform.bootstrap.get", {
      requestId: params.requestId,
    });
    const detailState =
      lastDetail && typeof lastDetail === "object" && "detail" in lastDetail
        ? (lastDetail as { detail?: { state?: string } }).detail?.state
        : undefined;
    if (detailState === "available" || detailState === "degraded") {
      return { detail: lastDetail, state: detailState };
    }
    await sleep(2_000);
  }
  return { detail: lastDetail, state: "timeout" };
}

function evaluateStepExpectation(params: {
  step: ProbeStep;
  finalText: string;
  assistantMessage?: AssistantMessage | null;
  sessionRow: SessionRow | null;
}) {
  const failures: string[] = [];
  const observedProvider = params.assistantMessage?.provider ?? params.sessionRow?.modelProvider;
  const observedModel = params.assistantMessage?.model ?? params.sessionRow?.model;
  if (!params.finalText.trim()) {
    failures.push("empty final text");
  }
  if (params.step.expectProvider && observedProvider !== params.step.expectProvider) {
    failures.push(
      `expected provider=${params.step.expectProvider}, got=${observedProvider ?? "unknown"}`,
    );
  }
  if (
    params.step.expectModelIncludes &&
    !String(observedModel ?? "").toLowerCase().includes(params.step.expectModelIncludes.toLowerCase())
  ) {
    failures.push(
      `expected model to include ${params.step.expectModelIncludes}, got=${observedModel ?? "unknown"}`,
    );
  }
  for (const snippet of params.step.expectTextIncludes ?? []) {
    if (!params.finalText.toLowerCase().includes(snippet.toLowerCase())) {
      failures.push(`final text missing snippet: ${snippet}`);
    }
  }
  return failures;
}

async function runTurnsScenario(params: {
  scenario: Extract<Scenario, { kind: "turns" }>;
  client: Awaited<ReturnType<typeof connectGatewayClient>>;
  events: ChatEventPayload[];
}) {
  const sessionKey = `agent:main:thread:${params.scenario.id}-${Date.now()}`;
  const stepResults: Array<Record<string, unknown>> = [];
  const failures: string[] = [];

  for (const [index, step] of params.scenario.steps.entries()) {
    const beforeMessages = await getSessionMessages(params.client, sessionKey);
    const turn = await waitForFinal({
      client: params.client,
      events: params.events,
      sessionKey,
      prompt: step.prompt,
      attachments: step.attachments,
      timeoutMs: step.timeoutMs ?? 180_000,
    });
    const afterMessages = await getSessionMessages(params.client, sessionKey);
    const deltaMessages = afterMessages.slice(beforeMessages.length);
    const assistantMessages = await getAssistantMessages(params.client, sessionKey);
    const latestAssistantMessage = assistantMessages.at(-1) ?? null;
    const sessionRow = await getSessionRow(params.client, sessionKey);
    const stepFailures = evaluateStepExpectation({
      step,
      finalText: turn.finalText,
      assistantMessage: latestAssistantMessage,
      sessionRow,
    });
    const toolFailures = await evaluateToolExpectation({
      step,
      deltaMessages,
      allMessages: afterMessages,
    });
    stepFailures.push(...toolFailures);
    failures.push(...stepFailures.map((message) => `step${index + 1}: ${message}`));
    stepResults.push({
      step: index + 1,
      prompt: step.prompt,
      finalState: turn.finalState,
      finalText: turn.finalText,
      assistantMessage: latestAssistantMessage,
      deltaMessages,
      sessionRow,
    });
  }

  const assistantTexts = await getAssistantTexts(params.client, sessionKey);
  const historyFlags = collectHistoryFlags(assistantTexts);
  if (params.scenario.expectNoDuplicates && historyFlags.duplicateAdjacentCount > 0) {
    failures.push(`duplicateAdjacentCount=${historyFlags.duplicateAdjacentCount}`);
  }
  if (params.scenario.expectNoRecoveryLeaks && historyFlags.recoveryLeakCount > 0) {
    failures.push(`recoveryLeakCount=${historyFlags.recoveryLeakCount}`);
  }

  let bootstrapRequest: BootstrapRequest | null = null;
  if (params.scenario.expectBootstrapCapability) {
    bootstrapRequest = await getLatestBootstrapRequest(params.client, params.scenario.expectBootstrapCapability);
    if (!bootstrapRequest) {
      failures.push(`missing bootstrap request for ${params.scenario.expectBootstrapCapability}`);
    }
  }

  return {
    id: params.scenario.id,
    description: params.scenario.description,
    kind: params.scenario.kind,
    sessionKey,
    ok: failures.length === 0,
    failures,
    stepResults,
    historyFlags,
    bootstrapRequest,
    assistantTexts,
  };
}

async function runBootstrapResumeScenario(params: {
  scenario: Extract<Scenario, { kind: "bootstrap-resume" }>;
  client: Awaited<ReturnType<typeof connectGatewayClient>>;
  events: ChatEventPayload[];
}) {
  const scenarioStartedAtMs = Date.now();
  const sessionKey = `agent:main:thread:${params.scenario.id}-${Date.now()}`;
  const failures: string[] = [];
  const sendRes = await params.client.request<{ runId?: string; status?: string }>("chat.send", {
    sessionKey,
    message: params.scenario.step.prompt,
    attachments: params.scenario.step.attachments,
    timeoutMs: params.scenario.step.timeoutMs ?? 180_000,
    idempotencyKey: `${sessionKey}-${randomUUID()}`,
  });
  const initialRunId = String(sendRes.runId ?? "");
  const initialTerminalEvent = await waitForTerminalEvent({
    events: params.events,
    runId: initialRunId,
    sessionKey,
    timeoutMs: params.scenario.step.timeoutMs ?? 180_000,
  });
  const before = {
    runId: initialRunId,
    status: sendRes.status ?? null,
    finalState: initialTerminalEvent.state ?? null,
    finalText: extractFirstTextBlock(initialTerminalEvent.message) ?? "",
  };
  const initialMessages = await getSessionMessages(params.client, sessionKey);
  const directToolFailures = await evaluateToolExpectation({
    step: params.scenario.step,
    deltaMessages: initialMessages,
    allMessages: initialMessages,
  });
  if (
    params.scenario.expectBootstrapTerminalState &&
    before.finalState !== params.scenario.expectBootstrapTerminalState
  ) {
    const directPdfCompleted =
      before.finalState === "final" &&
      directToolFailures.length === 0;
    if (!directPdfCompleted) {
      failures.push(
        `expected bootstrap terminal state=${params.scenario.expectBootstrapTerminalState}, got=${before.finalState ?? "unknown"}`,
      );
    }
  }
  const beforeTexts = await getAssistantTexts(params.client, sessionKey);
  const latestRequest = await getLatestBootstrapRequest(params.client, params.scenario.capabilityId);
  const requestTimestampMs = latestRequest
    ? Math.max(Date.parse(latestRequest.createdAt), Date.parse(latestRequest.updatedAt))
    : Number.NaN;
  const createdRequest =
    latestRequest && Number.isFinite(requestTimestampMs) && requestTimestampMs >= scenarioStartedAtMs - 1_000
      ? latestRequest
      : null;
  if (!createdRequest && before.finalState === "final" && directToolFailures.length === 0) {
    const historyFlags = collectHistoryFlags(beforeTexts);
    if (params.scenario.expectNoDuplicates && historyFlags.duplicateAdjacentCount > 0) {
      failures.push(`duplicateAdjacentCount=${historyFlags.duplicateAdjacentCount}`);
    }
    if (params.scenario.expectNoRecoveryLeaks && historyFlags.recoveryLeakCount > 0) {
      failures.push(`recoveryLeakCount=${historyFlags.recoveryLeakCount}`);
    }
    return {
      id: params.scenario.id,
      description: params.scenario.description,
      kind: params.scenario.kind,
      sessionKey,
      ok: failures.length === 0,
      failures,
      initialTurn: before,
      createdRequest: null,
      resolveResult: null,
      runResult: null,
      detailAfter: null,
      sessionRow: await getSessionRow(params.client, sessionKey),
      historyFlags,
      assistantTexts: beforeTexts,
      alreadyAvailable: true,
    };
  }
  if (!createdRequest) {
    failures.push(`missing bootstrap request for ${params.scenario.capabilityId}`);
  }

  let resolveResult: unknown = null;
  let runResult: unknown = null;
  let detailAfter: unknown = null;
  if (createdRequest) {
    if (createdRequest.state === "pending") {
      resolveResult = await params.client.request("platform.bootstrap.resolve", {
        requestId: createdRequest.id,
        decision: "approve",
      });
    }
    runResult = await params.client.request("platform.bootstrap.run", {
      requestId: createdRequest.id,
    });
    const polled = await pollBootstrapState({
      client: params.client,
      requestId: createdRequest.id,
      timeoutMs: 120_000,
    });
    detailAfter = polled.detail;
    if (polled.state !== "available") {
      failures.push(`bootstrap final state=${polled.state}`);
    }
  }

  let afterTexts: string[] = [];
  let afterMessages: NormalizedSessionMessage[] = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < 180_000) {
    afterMessages = await getSessionMessages(params.client, sessionKey);
    afterTexts = await getAssistantTexts(params.client, sessionKey);
    if (afterTexts.length > beforeTexts.length) {
      break;
    }
    await sleep(2_000);
  }
  if (afterTexts.length <= beforeTexts.length) {
    failures.push("resume did not append a new assistant message");
  }

  const toolFailures = await evaluateToolExpectation({
    step: params.scenario.step,
    deltaMessages: afterMessages,
    allMessages: afterMessages,
  });
  failures.push(...toolFailures);
  const sessionRow = await getSessionRow(params.client, sessionKey);
  const historyFlags = collectHistoryFlags(afterTexts);
  if (params.scenario.expectNoDuplicates && historyFlags.duplicateAdjacentCount > 0) {
    failures.push(`duplicateAdjacentCount=${historyFlags.duplicateAdjacentCount}`);
  }
  if (params.scenario.expectNoRecoveryLeaks && historyFlags.recoveryLeakCount > 0) {
    failures.push(`recoveryLeakCount=${historyFlags.recoveryLeakCount}`);
  }

  return {
    id: params.scenario.id,
    description: params.scenario.description,
    kind: params.scenario.kind,
    sessionKey,
    ok: failures.length === 0,
    failures,
    initialTurn: before,
    createdRequest,
    resolveResult,
    runResult,
    detailAfter,
    sessionRow,
    historyFlags,
    assistantTexts: afterTexts,
  };
}

async function main() {
  const url = requireEnv("STAGE86_GATEWAY_URL");
  const token = requireEnv("OPENCLAW_GATEWAY_TOKEN");
  const events: ChatEventPayload[] = [];
  let grantedScopes: string[] = [];
  const scenarioFilter = readScenarioFilter();
  const repeatCount = readPositiveIntEnv("STAGE86_MATRIX_REPEAT", 1);
  const allScenarios = buildScenarios();
  const scenarios = scenarioFilter
    ? allScenarios.filter((scenario) => scenarioFilter.has(scenario.id))
    : allScenarios;
  if (scenarios.length === 0) {
    throw new Error("No stage86 live matrix scenarios matched STAGE86_MATRIX_CASES.");
  }

  const client = await connectGatewayClient({
    url,
    token,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: "stage86-live-matrix",
    clientVersion: "dev",
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.CLI,
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
    const startedAt = Date.now();
    const results: Array<Record<string, unknown>> = [];
    for (let iteration = 1; iteration <= repeatCount; iteration += 1) {
      for (const scenario of scenarios) {
        const scenarioRun =
          repeatCount > 1
            ? ({ ...scenario, id: `${scenario.id}#run${iteration}` } as Scenario)
            : scenario;
        try {
          if (scenarioRun.kind === "turns") {
            results.push(
              await runTurnsScenario({
                scenario: scenarioRun,
                client,
                events,
              }),
            );
          } else {
            results.push(
              await runBootstrapResumeScenario({
                scenario: scenarioRun,
                client,
                events,
              }),
            );
          }
        } catch (err) {
          results.push({
            id: scenarioRun.id,
            description: scenarioRun.description,
            kind: scenarioRun.kind,
            ok: false,
            failures: [err instanceof Error ? err.message : String(err)],
            fatal: true,
          });
        }
      }
    }
    const failed = results.filter((result) => result.ok === false);
    const report = {
      action: "run-live-matrix",
      url,
      grantedScopes,
      scenarioFilter: scenarioFilter ? Array.from(scenarioFilter) : null,
      repeatCount,
      startedAt: new Date(startedAt).toISOString(),
      elapsedMs: Date.now() - startedAt,
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      failedIds: failed.map((result) => result.id),
      results,
    };
    const reportJson = JSON.stringify(report, null, 2);
    const outputPath =
      process.env.STAGE86_MATRIX_OUTPUT?.trim() ||
      path.join(process.cwd(), "stage86-live-matrix.latest.json");
    await fs.writeFile(outputPath, reportJson, "utf8");
    console.log(reportJson);
  } finally {
    await disconnectGatewayClient(client);
  }
}

await main();
