/**
 * Stage-A classifier prompt builder for the bench.
 *
 * The Stage-A prompt presents a TOOL MENU (names + 1-line descriptions only —
 * no arg schemas, that's Stage-B's job) and asks the LLM to emit a strict
 * JSON object: { intent, tool_names, sequencing }.
 *
 * Critical anti-bloat: the prompt does NOT contain few-shot examples for
 * each tool, because the legacy task-classifier did exactly that with 30+
 * examples and still drifted on minute-interval persistent_worker prompts
 * (Bug F, T1 2026-05-08). Instead we trust the model to reason over the
 * one-line tool descriptions + one explicit guard rule for ambiguity.
 */

import type { ExpectedTurnRouting } from "./classifier-bench-fixtures.js";
import { FIXTURE_TOOL_MENU } from "./classifier-bench-fixtures.js";

const TOOL_DESCRIPTIONS: Record<string, string> = {
  write: "Создать или перезаписать файл с заданным содержимым.",
  edit: "Изменить существующий файл (поиск+замена или append).",
  read: "Прочитать содержимое файла.",
  image_generate: "Сгенерировать изображение из текстового описания.",
  web_search: "Найти страницы в интернете по поисковому запросу.",
  web_fetch: "Скачать содержимое страницы по конкретному URL.",
  sessions_send: "Отправить сообщение в указанный чат / сессию.",
  persistent_worker_push: "Создать постоянного работника, который периодически выполняет действие (cron-расписание + push в чат).",
  cron: "Установить отложенное напоминание / разовое или повторяющееся действие по расписанию.",
  exec: "Выполнить shell-команду (только когда явно нужно вычисление, не для манипуляции файлами).",
};

export function buildStageAPrompt(): string {
  const toolMenu = FIXTURE_TOOL_MENU
    .map((tool) => `  - ${tool}: ${TOOL_DESCRIPTIONS[tool] ?? "(no description)"}`)
    .join("\n");

  return `Ты классификатор намерений. Твоя ЕДИНСТВЕННАЯ задача — посмотреть на сообщение пользователя и выдать СТРОГИЙ JSON в одном из трёх форматов:

1. Если пользователь просит выполнить действие(я):
{"intent":"tool_calls","tool_names":["<name1>","<name2>",...],"sequencing":"sequential"|"parallel"}

2. Если пользователь хочет поговорить, задаёт вопрос, здоровается:
{"intent":"conversation","tool_names":[]}

3. Если запрос неоднозначен, не хватает информации, нет конкретного объекта действия:
{"intent":"refuse","tool_names":[]}

Доступные инструменты:
${toolMenu}

ПРАВИЛА:
- Если в сообщении два действия через "и потом", "затем", "после этого" — sequencing="sequential", оба tool_names в массиве в правильном порядке.
- Если действия независимы и могут идти параллельно — sequencing="parallel".
- Для одиночного действия sequencing="sequential" (default).
- Если пользователь говорит "сделай это", "сохрани это", "отправь это" БЕЗ конкретного объекта в текущем сообщении — intent="refuse".
- Не выдумывай инструменты вне списка. Если ни один не подходит — intent="refuse".
- Не задавай уточняющих вопросов в JSON — это работа другого слоя. Просто классифицируй.
- ОТВЕЧАЙ ТОЛЬКО JSON. Без markdown, без префиксов, без объяснений.

Сообщение пользователя:`;
}

/**
 * Try to parse the candidate model's response into an ExpectedTurnRouting shape.
 * Returns null if the response is not valid JSON or doesn't match the schema.
 *
 * Defensive parser — Stage-A in production will use Zod, but for the bench
 * we want to record HOW models fail (malformed JSON / missing fields / wrong
 * enum) so we report failure mode in the score rather than silent throw.
 */
export function parseStageAResponse(raw: string): {
  parsed?: ExpectedTurnRouting;
  failureMode?: "non_json" | "wrong_shape" | "wrong_enum";
} {
  // strip common LLM prefixes / code fences
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  }
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return { failureMode: "non_json" };
  }
  if (typeof obj !== "object" || obj === null) return { failureMode: "wrong_shape" };
  const o = obj as Record<string, unknown>;
  if (typeof o.intent !== "string") return { failureMode: "wrong_shape" };
  if (!["tool_calls", "conversation", "refuse"].includes(o.intent)) return { failureMode: "wrong_enum" };
  if (!Array.isArray(o.tool_names)) return { failureMode: "wrong_shape" };
  if (!o.tool_names.every((s) => typeof s === "string")) return { failureMode: "wrong_shape" };
  const seq = o.sequencing;
  if (seq !== undefined && seq !== "sequential" && seq !== "parallel") {
    return { failureMode: "wrong_enum" };
  }
  return {
    parsed: {
      intent: o.intent as ExpectedTurnRouting["intent"],
      tool_names: o.tool_names as string[],
      sequencing: seq as ExpectedTurnRouting["sequencing"],
    },
  };
}
