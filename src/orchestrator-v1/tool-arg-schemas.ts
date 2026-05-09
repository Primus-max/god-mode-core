/**
 * V1-CONTRACT-ONLY — Per-tool arg schemas for Stage-B extraction.
 *
 * Each TOOL_NAME from contract.ts maps to a Zod schema describing the
 * arguments Stage B must extract from the user's message. The schemas
 * are intentionally minimal — only fields the dispatcher needs to
 * actually call the tool. No validation knobs (regex constraints, etc.)
 * beyond what's necessary for the dispatcher to refuse invalid input.
 *
 * For tools with optional args, fields are `.optional()` so Stage B can
 * omit them when the user didn't specify; the dispatcher / underlying
 * tool fills defaults.
 */

import { z } from "zod";
import type { ToolName } from "./contract.js";

const WriteArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const EditArgsSchema = z.object({
  path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
});

const ReadArgsSchema = z.object({
  path: z.string().min(1),
});

const ImageGenerateArgsSchema = z.object({
  prompt: z.string().min(1),
  size: z.string().optional(),
  style: z.string().optional(),
});

const PdfArgsSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  images: z.array(z.string().min(1)).optional(),
});

const WebSearchArgsSchema = z.object({
  query: z.string().min(1),
  max_results: z.number().int().positive().optional(),
});

const WebFetchArgsSchema = z.object({
  url: z.string().url(),
});

const SessionsSendArgsSchema = z.object({
  channel: z.string().min(1),
  text: z.string().min(1),
});

const PersistentWorkerPushArgsSchema = z.object({
  worker_name: z.string().min(1),
  schedule: z.string().min(1),
  message_template: z.string().min(1),
  target_chat: z.string().min(1).optional(),
});

const CronArgsSchema = z.object({
  schedule: z.string().min(1),
  prompt: z.string().min(1),
});

const ExecArgsSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
});

export const TOOL_ARG_SCHEMAS = {
  write: WriteArgsSchema,
  edit: EditArgsSchema,
  read: ReadArgsSchema,
  image_generate: ImageGenerateArgsSchema,
  pdf: PdfArgsSchema,
  web_search: WebSearchArgsSchema,
  web_fetch: WebFetchArgsSchema,
  sessions_send: SessionsSendArgsSchema,
  persistent_worker_push: PersistentWorkerPushArgsSchema,
  cron: CronArgsSchema,
  exec: ExecArgsSchema,
} satisfies Record<ToolName, z.ZodType>;

export type ToolArgsByName = {
  [K in ToolName]: z.infer<(typeof TOOL_ARG_SCHEMAS)[K]>;
};

/**
 * Human-readable Russian label per `(tool, field)`.
 *
 * Used by `orchestrator.ts` to render a user-friendly refuse message
 * when Stage B reports `missing_field` — instead of the raw field
 * identifier (e.g. "missing_field: query"), the bot tells the user what
 * piece of information was missing in natural language (e.g. "не хватает
 * запроса для поиска"). This is a static table — NO regex / parsing of
 * user text — and is the data side of refuse rendering.
 *
 * Coverage policy: every required field across every TOOL_ARG_SCHEMA
 * MUST have a label. Missing entries fall back to `"поле <field>"` to
 * avoid crashes; a vitest unit asserts coverage for required fields.
 */
export const TOOL_FIELD_LABELS: Record<ToolName, Record<string, string>> = {
  write: {
    path: "путь к файлу",
    content: "содержимое файла",
  },
  edit: {
    path: "путь к файлу",
    old_string: "что заменить",
    new_string: "на что заменить",
  },
  read: {
    path: "путь к файлу",
  },
  image_generate: {
    prompt: "описание картинки",
    size: "размер",
    style: "стиль",
  },
  pdf: {
    title: "заголовок документа",
    summary: "содержание документа",
    images: "описания иллюстраций",
  },
  web_search: {
    query: "запрос для поиска",
    max_results: "число результатов",
  },
  web_fetch: {
    url: "URL страницы",
  },
  sessions_send: {
    channel: "получатель",
    text: "текст сообщения",
  },
  persistent_worker_push: {
    worker_name: "имя воркера",
    schedule: "расписание",
    message_template: "что присылать",
    target_chat: "куда присылать",
  },
  cron: {
    schedule: "когда напомнить",
    prompt: "что напомнить",
  },
  exec: {
    command: "команда",
    cwd: "рабочая директория",
  },
};

/**
 * Render a friendly Russian label for a `(tool, field)` pair.
 *
 * Used to convert Stage-B `error.detail = "<field>"` into something a
 * human user can act on. Falls back to `"поле <field>"` when the entry
 * is missing so unmapped fields don't crash refuse rendering.
 */
export function describeToolField(tool: ToolName, field: string): string {
  const tab = TOOL_FIELD_LABELS[tool];
  const label = tab?.[field];
  if (label) return label;
  if (!field || field === "(unknown field)") return "обязательное поле";
  return `поле "${field}"`;
}

/** Human-readable description per tool — used in Stage-B prompt. */
export const TOOL_ARG_DESCRIPTIONS: Record<ToolName, string> = {
  write: "Создать или перезаписать файл. Поля: path (string), content (string).",
  edit: "Заменить подстроку в файле. Поля: path (string), old_string (string), new_string (string).",
  read: "Прочитать файл. Поля: path (string).",
  image_generate:
    "Сгенерировать изображение. Поля: prompt (string, описание); size (опц., например '1024x1024'); style (опц.).",
  pdf:
    "Сгенерировать PDF-документ. Поля: title (string, заголовок документа); summary (string, краткое содержание / основной текст); images (опц., массив текстовых описаний инфографики/иллюстраций для встраивания).",
  web_search:
    "Поиск в интернете. Поля: query (string); max_results (опц., целое число > 0).",
  web_fetch: "Скачать страницу. Поля: url (валидный URL).",
  sessions_send:
    "Отправить сообщение в чат. Поля: channel (string, идентификатор чата); text (string).",
  persistent_worker_push:
    "Создать постоянного работника. Поля: worker_name (string); schedule (cron-выражение или 'every N minutes/hours/days'); message_template (string); target_chat (опц., string).",
  cron:
    "Установить отложенное напоминание. Поля: schedule (cron-выражение или 'in N minutes/hours'); prompt (string, что напомнить).",
  exec: "Выполнить команду. Поля: command (string); cwd (опц., рабочая директория).",
};
