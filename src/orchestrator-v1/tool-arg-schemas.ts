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

/** Human-readable description per tool — used in Stage-B prompt. */
export const TOOL_ARG_DESCRIPTIONS: Record<ToolName, string> = {
  write: "Создать или перезаписать файл. Поля: path (string), content (string).",
  edit: "Заменить подстроку в файле. Поля: path (string), old_string (string), new_string (string).",
  read: "Прочитать файл. Поля: path (string).",
  image_generate:
    "Сгенерировать изображение. Поля: prompt (string, описание); size (опц., например '1024x1024'); style (опц.).",
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
