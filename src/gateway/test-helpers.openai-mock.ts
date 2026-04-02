type OpenAIResponsesParams = {
  input?: unknown[];
  instructions?: string;
  tools?: unknown[];
  rawBody?: Record<string, unknown>;
};

export type MockOpenAiResponsesRequest = {
  input: unknown[];
  instructions: string;
  tools: unknown[];
  rawBody: Record<string, unknown>;
  requestIndex: number;
  lastUserText: string;
  allInputText: string;
  toolOutputs: string[];
  toolOutput: string;
};

export type MockOpenAiResponsesDecision =
  | {
      type: "tool_call";
      name: string;
      args: Record<string, unknown>;
      callId?: string;
      itemId?: string;
    }
  | {
      type: "message";
      text: string;
    };

/** One step per OpenAI `/responses` request index (0-based), for deterministic skill/agent evals. */
export type OpenAiScenarioStep = (
  request: MockOpenAiResponsesRequest,
) => MockOpenAiResponsesDecision | Promise<MockOpenAiResponsesDecision>;

/**
 * Builds a `resolveResponse` handler that runs a fixed sequence of scripted model decisions.
 * Throws if the gateway issues more requests than steps (surfaces accidental extra turns).
 */
export function createOpenAiScenarioResolver(
  steps: readonly OpenAiScenarioStep[],
): (request: MockOpenAiResponsesRequest) => Promise<MockOpenAiResponsesDecision> {
  return async (request) => {
    const step = steps[request.requestIndex];
    if (!step) {
      throw new Error(
        `OpenAI mock scenario: no step for requestIndex=${request.requestIndex} (only ${steps.length} steps defined)`,
      );
    }
    return await step(request);
  };
}

type OpenAIResponseStreamEvent =
  | { type: "response.output_item.added"; item: Record<string, unknown> }
  | { type: "response.function_call_arguments.delta"; delta: string }
  | { type: "response.output_item.done"; item: Record<string, unknown> }
  | {
      type: "response.completed";
      response: {
        status: "completed";
        usage: {
          input_tokens: number;
          output_tokens: number;
          total_tokens: number;
          input_tokens_details?: { cached_tokens?: number };
        };
      };
    };

function extractLastUserText(input: unknown[]): string {
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i] as Record<string, unknown> | undefined;
    if (!item || item.role !== "user") {
      continue;
    }
    const content = item.content;
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (c): c is { type: "input_text"; text: string } =>
            !!c &&
            typeof c === "object" &&
            (c as { type?: unknown }).type === "input_text" &&
            typeof (c as { text?: unknown }).text === "string",
        )
        .map((c) => c.text)
        .join("\n")
        .trim();
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function collectInputText(input: unknown[]): string {
  const parts: string[] = [];
  for (const itemRaw of input) {
    const item = itemRaw as Record<string, unknown> | undefined;
    const content = item?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const entry of content) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { text?: unknown }).text === "string"
      ) {
        parts.push((entry as { text: string }).text);
      }
    }
  }
  return parts.join("\n").trim();
}

function extractToolOutputs(input: unknown[]): string[] {
  const outputs: string[] = [];
  for (const itemRaw of input) {
    const item = itemRaw as Record<string, unknown> | undefined;
    if (!item || item.type !== "function_call_output") {
      continue;
    }
    outputs.push(typeof item.output === "string" ? item.output : "");
  }
  return outputs;
}

function defaultOpenAiResponsesDecision(
  request: MockOpenAiResponsesRequest,
): MockOpenAiResponsesDecision {
  const toolOutput = request.toolOutput;
  if (!toolOutput) {
    const prompt = request.lastUserText;
    const quoted = /"([^"]+)"/.exec(prompt)?.[1];
    const toolPath = quoted ?? "package.json";
    return {
      type: "tool_call",
      name: "read",
      args: { path: toolPath },
    };
  }

  const nonceA = /nonceA=([^\s]+)/.exec(toolOutput)?.[1] ?? "";
  const nonceB = /nonceB=([^\s]+)/.exec(toolOutput)?.[1] ?? "";
  return {
    type: "message",
    text: `${nonceA} ${nonceB}`.trim(),
  };
}

function buildToolCallEvents(decision: Extract<MockOpenAiResponsesDecision, { type: "tool_call" }>) {
  const argsJson = JSON.stringify(decision.args);
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: decision.itemId ?? "fc_test_1",
        call_id: decision.callId ?? "call_test_1",
        name: decision.name,
        arguments: "",
      },
    },
    { type: "response.function_call_arguments.delta", delta: argsJson },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: decision.itemId ?? "fc_test_1",
        call_id: decision.callId ?? "call_test_1",
        name: decision.name,
        arguments: argsJson,
      },
    },
    {
      type: "response.completed",
      response: {
        status: "completed" as const,
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ] satisfies OpenAIResponseStreamEvent[];
}

function buildMessageEvents(decision: Extract<MockOpenAiResponsesDecision, { type: "message" }>) {
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "message",
        id: "msg_test_1",
        role: "assistant",
        content: [],
        status: "in_progress",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "msg_test_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: decision.text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        status: "completed" as const,
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ] satisfies OpenAIResponseStreamEvent[];
}

function decodeBodyText(body: unknown): string {
  if (!body) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString("utf8");
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(body)).toString("utf8");
  }
  return "";
}

function buildSseResponse(events: unknown[]): Response {
  const sse = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sse));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function buildOpenAIResponsesTextSse(text: string): Response {
  return buildSseResponse([
    {
      type: "response.output_item.added",
      item: {
        type: "message",
        id: "msg_test_1",
        role: "assistant",
        content: [],
        status: "in_progress",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "msg_test_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ]);
}

async function buildOpenAIResponsesSse(params: OpenAIResponsesParams): Promise<Response> {
  return buildSseResponse([]);
}

export function installOpenAiResponsesMock(params?: {
  baseUrl?: string;
  resolveResponse?: (
    request: MockOpenAiResponsesRequest,
  ) => MockOpenAiResponsesDecision | Promise<MockOpenAiResponsesDecision>;
}) {
  const originalFetch = globalThis.fetch;
  const baseUrl = params?.baseUrl ?? "https://api.openai.com/v1";
  const requests: MockOpenAiResponsesRequest[] = [];
  const responsesUrl = `${baseUrl}/responses`;
  const isResponsesRequest = (url: string) =>
    url === responsesUrl ||
    url.startsWith(`${responsesUrl}/`) ||
    url.startsWith(`${responsesUrl}?`);
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (isResponsesRequest(url)) {
      const bodyText =
        typeof (init as { body?: unknown } | undefined)?.body !== "undefined"
          ? decodeBodyText((init as { body?: unknown }).body)
          : input instanceof Request
            ? await input.clone().text()
            : "";

      const parsed = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
      const inputItems = Array.isArray(parsed.input) ? parsed.input : [];
      const toolOutputs = extractToolOutputs(inputItems);
      const request: MockOpenAiResponsesRequest = {
        input: inputItems,
        instructions: typeof parsed.instructions === "string" ? parsed.instructions : "",
        tools: Array.isArray(parsed.tools) ? parsed.tools : [],
        rawBody: parsed,
        requestIndex: requests.length,
        lastUserText: extractLastUserText(inputItems),
        allInputText: collectInputText(inputItems),
        toolOutputs,
        toolOutput: toolOutputs.at(-1) ?? "",
      };
      requests.push(request);
      const decision = params?.resolveResponse
        ? await params.resolveResponse(request)
        : defaultOpenAiResponsesDecision(request);
      const events =
        decision.type === "tool_call" ? buildToolCallEvents(decision) : buildMessageEvents(decision);
      return buildSseResponse(events);
    }
    if (url.startsWith(baseUrl)) {
      throw new Error(`unexpected OpenAI request in mock test: ${url}`);
    }

    if (!originalFetch) {
      throw new Error(`fetch is not available (url=${url})`);
    }
    return await originalFetch(input, init);
  };
  (globalThis as unknown as { fetch: unknown }).fetch = fetchImpl;
  return {
    baseUrl,
    requests,
    restore: () => {
      (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
    },
  };
}
