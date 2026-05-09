/**
 * V1-CONTRACT-ONLY — Fixed reply template catalog.
 *
 * **Critical:** templates are dispatcher-owned. The classifier never
 * emits a `reply_template` field. Reply text is rendered from this
 * catalog by interpolating placeholders with REAL tool output.
 *
 * Per the 3-critic review (red-team #4, plan-agent #1):
 * if templates were classifier-emitted, the LLM could put attacker-
 * influenced text into the reply, defeating the "bot cannot lie"
 * guarantee. Owning templates here closes that injection surface.
 *
 * Placeholder substitution is escape-aware: nested `{...}` from tool
 * output is rendered as text, not interpreted as a new placeholder.
 */

import type { ToolName } from "./contract.js";

export type Outcome = "success" | "failure";

type TemplateKey = `${ToolName}:${Outcome}` | "refuse:default" | "multi:success" | "multi:partial";

const TEMPLATES: Record<TemplateKey, string> = {
  // single-tool success/failure
  "write:success": "Записал в {path}.",
  "write:failure": "Не получилось записать в {path}: {error}",
  "edit:success": "Изменил {path}.",
  "edit:failure": "Не получилось изменить {path}: {error}",
  "read:success": "Содержимое {path}:\n\n{content}",
  "read:failure": "Не получилось прочитать {path}: {error}",
  "image_generate:success": "Сгенерировал: {url}",
  "image_generate:failure": "Не получилось сгенерировать: {error}",
  "web_search:success": "Найдено по запросу «{query}»:\n\n{results}",
  "web_search:failure": "Поиск не удался: {error}",
  "web_fetch:success": "Содержимое {url}:\n\n{content}",
  "web_fetch:failure": "Не получилось скачать {url}: {error}",
  "sessions_send:success": "Отправил в {channel}.",
  "sessions_send:failure": "Не удалось отправить в {channel}: {error}",
  "persistent_worker_push:success":
    "Создал воркера «{worker_name}» с расписанием «{schedule}».",
  "persistent_worker_push:failure":
    "Не получилось создать воркера «{worker_name}»: {error}",
  "cron:success": "Поставил напоминание на «{schedule}».",
  "cron:failure": "Не удалось поставить напоминание: {error}",
  "exec:success": "Выполнил `{command}`. Вывод:\n\n{output}",
  "exec:failure": "Команда `{command}` упала: {error}",

  // multi-action and refuse
  "multi:success": "Готово:\n\n{summary}",
  "multi:partial": "Часть шагов не удалась:\n\n{summary}",
  "refuse:default": "Не могу: {refusal_reason}",
};

/**
 * Render a template by substituting `{var}` placeholders with values.
 * Unfilled placeholders fall through to the literal `{var}` token, which
 * is then detected by the dispatcher (see `hasUnfilledPlaceholders`) and
 * triggers the safe fallback. The substitution does NOT recurse — values
 * containing `{x}` are kept as-is.
 */
export function renderTemplate(
  template: string,
  values: Record<string, unknown>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      const v = values[key];
      if (v === null || v === undefined) return match;
      if (typeof v === "string") return v;
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      try {
        return JSON.stringify(v);
      } catch {
        return match;
      }
    }
    return match;
  });
}

/** Detect any `{var}` placeholders that survived rendering. */
export function hasUnfilledPlaceholders(rendered: string): boolean {
  return /\{[\w]+\}/.test(rendered);
}

/**
 * Look up a template by (tool, outcome). Returns the template string;
 * caller renders it with values. If the key isn't in the catalog
 * (shouldn't happen given the type-level Key constraint, but defensive),
 * returns the multi:success template as a last resort.
 */
export function lookupTemplate(tool: ToolName, outcome: Outcome): string {
  const key: TemplateKey = `${tool}:${outcome}`;
  return TEMPLATES[key] ?? TEMPLATES["multi:success"];
}

export function refuseTemplate(): string {
  return TEMPLATES["refuse:default"];
}

export function multiTemplate(allSuccess: boolean): string {
  return allSuccess ? TEMPLATES["multi:success"] : TEMPLATES["multi:partial"];
}

export const REPLY_TEMPLATE_CATALOG = TEMPLATES;
