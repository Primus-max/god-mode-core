/**
 * V1-CONTRACT-ONLY — web_search + web_fetch tool runners.
 *
 * Thin wrappers around the existing production search + fetch
 * implementations:
 *   - runWebSearch  → src/web-search/runtime.ts
 *   - runWebFetch   → src/agents/tools/web-fetch.ts (createWebFetchTool)
 *
 * Output shape contract (consumed by dispatcher.ts + reply-templates.ts):
 *
 *   web_search:success → { ok: true, output: { query, results } }
 *     `results` MUST be a human-readable, pre-formatted string (numbered
 *     list of title/url/snippet) so the success template
 *     "Найдено по запросу «{query}»:\n\n{results}" renders cleanly.
 *     Returning a JS object would surface as "[object Object]" or raw
 *     JSON in the Telegram reply.
 *
 *   web_fetch:success → { ok: true, output: { url, content } }
 *     `content` is the extracted readable text (HTML stripped),
 *     truncated to ~4 KB with an ellipsis on truncation. The fetch
 *     tool returns markdown by default; that's exactly what we want
 *     for the "Содержимое {url}:\n\n{content}" template.
 *
 *   *:failure → { ok: false, error: <string> }
 *
 * Reply text is rendered by the dispatcher from reply-templates.ts;
 * runners NEVER produce user-facing strings.
 */

import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createWebFetchTool } from "../../agents/tools/web-fetch.js";
import { runWebSearch as runWebSearchRuntime } from "../../web-search/runtime.js";
import type { ToolRunResult } from "../dispatcher.js";

/** Truncate body text to keep Telegram replies readable. ~4 KB ≈ 1 page. */
const FETCH_CONTENT_MAX_CHARS = 4_000;
const SEARCH_DEFAULT_MAX_RESULTS = 5;

/**
 * Test seam: callers (and unit tests) may inject the lower-level
 * implementations to avoid hitting the network or loading runtime
 * config. Production callers leave these undefined and the wrappers
 * fall through to the real `runWebSearchRuntime` / `createWebFetchTool`.
 */
export type WebRunnerDeps = {
  cfg?: OpenClawConfig;
  /** Override the search backend (returns provider's raw `result` object). */
  runSearch?: (args: {
    query: string;
    max_results: number;
    cfg?: OpenClawConfig;
  }) => Promise<Record<string, unknown>>;
  /** Override the fetch backend (returns the AgentTool execute payload). */
  runFetch?: (args: {
    url: string;
    cfg?: OpenClawConfig;
  }) => Promise<Record<string, unknown>>;
};

/** Best-effort hit shape — every provider returns at least these fields. */
type SearchHit = {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  description?: unknown;
  content?: unknown;
};

/**
 * Format provider hits into a numbered "title — url\n   snippet" list.
 * Defensive: every field is checked because providers vary (tavily,
 * brave, perplexity, ...). Empty fields are skipped, not rendered as
 * "undefined".
 */
function formatSearchResults(rawHits: unknown[], max: number): string {
  const lines: string[] = [];
  const limited = rawHits.slice(0, max);
  for (let i = 0; i < limited.length; i++) {
    const hit = (limited[i] ?? {}) as SearchHit;
    const title = typeof hit.title === "string" ? hit.title.trim() : "";
    const url = typeof hit.url === "string" ? hit.url.trim() : "";
    // Different providers use different field names for the body excerpt.
    const snippetRaw =
      (typeof hit.snippet === "string" && hit.snippet) ||
      (typeof hit.description === "string" && hit.description) ||
      (typeof hit.content === "string" && hit.content) ||
      "";
    const snippet = snippetRaw.toString().trim();
    const header = title || url || `Результат ${i + 1}`;
    const parts: string[] = [];
    parts.push(`${i + 1}. ${header}`);
    if (url && url !== header) {
      parts.push(`   ${url}`);
    }
    if (snippet) {
      parts.push(`   ${snippet}`);
    }
    lines.push(parts.join("\n"));
  }
  return lines.join("\n\n");
}

function extractHitsFromProviderResult(result: Record<string, unknown>): unknown[] {
  // Common shapes:
  //   { results: [...] }     ← tavily, brave, perplexity, generic
  //   { hits: [...] }        ← some providers
  //   { items: [...] }       ← google CSE
  if (Array.isArray(result.results)) {return result.results;}
  if (Array.isArray(result.hits)) {return result.hits;}
  if (Array.isArray(result.items)) {return result.items;}
  return [];
}

function extractFetchTextFromPayload(payload: Record<string, unknown>): string {
  // createWebFetchTool's runtime payload has `text` for the extracted
  // body. wrapWebFetchContent already strips control chars; we still
  // truncate hard for Telegram readability.
  const candidates: unknown[] = [payload.text, payload.content, payload.markdown];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) {
      return c;
    }
  }
  return "";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {return text;}
  return `${text.slice(0, max).trimEnd()}…`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {return err.message || err.name || "unknown error";}
  if (typeof err === "string") {return err;}
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Run web_search and shape the result for the dispatcher.
 *
 * Args are pre-validated by Stage B against WebSearchArgsSchema;
 * `query` is non-empty and `max_results` (if set) is a positive int.
 */
export async function runWebSearch(
  args: { query: string; max_results?: number },
  deps: WebRunnerDeps = {},
): Promise<ToolRunResult> {
  const max = Math.max(1, args.max_results ?? SEARCH_DEFAULT_MAX_RESULTS);
  try {
    const searchImpl =
      deps.runSearch ??
      (async (p) => {
        const r = await runWebSearchRuntime({
          args: { query: p.query, count: p.max_results },
          config: p.cfg,
          preferRuntimeProviders: true,
        });
        return r.result;
      });

    const result = await searchImpl({ query: args.query, max_results: max, cfg: deps.cfg });
    const hits = extractHitsFromProviderResult(result);

    if (hits.length === 0) {
      // Truthful "no hits" — still success, but the formatted results
      // string makes that clear in the rendered template.
      return {
        ok: true,
        output: {
          query: args.query,
          results: "(ничего не найдено)",
        },
      };
    }

    return {
      ok: true,
      output: {
        query: args.query,
        results: formatSearchResults(hits, max),
      },
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Run web_fetch and shape the result for the dispatcher.
 *
 * Reuses the production `createWebFetchTool` so SSRF guard, redirect
 * handling, readability extraction, firecrawl fallback, and caching
 * all stay in one place. We only pass `url` — the tool fills sensible
 * defaults from config (extract mode, max chars, timeouts, etc.).
 */
export async function runWebFetch(
  args: { url: string },
  deps: WebRunnerDeps = {},
): Promise<ToolRunResult> {
  try {
    const fetchImpl =
      deps.runFetch ??
      (async (p) => {
        const cfg = p.cfg ?? loadConfig();
        const tool = createWebFetchTool({ config: cfg });
        if (!tool) {
          throw new Error("web_fetch is disabled");
        }
        const result = await tool.execute("orchestrator-v1-web-fetch", { url: p.url });
        // jsonResult attaches the raw payload as `details`; fall back
        // to parsing the text body if a non-standard tool wrapper omits it.
        const r = result as { details?: unknown; content?: Array<{ type: string; text?: string }> };
        if (r.details && typeof r.details === "object") {
          return r.details as Record<string, unknown>;
        }
        const firstText = Array.isArray(r.content)
          ? r.content.find((b) => b.type === "text")?.text ?? ""
          : "";
        try {
          return JSON.parse(firstText) as Record<string, unknown>;
        } catch {
          return { text: firstText };
        }
      });

    const payload = await fetchImpl({ url: args.url, cfg: deps.cfg });

    // Fetch tool throws on non-2xx (see web-fetch.ts:600). If a
    // fetch backend returns a payload with a `status` outside 2xx
    // anyway (custom backend / future), treat as failure.
    const status = typeof payload.status === "number" ? payload.status : undefined;
    if (status !== undefined && (status < 200 || status >= 300)) {
      return { ok: false, error: `HTTP ${status}` };
    }

    const rawText = extractFetchTextFromPayload(payload);
    if (rawText.length === 0) {
      return { ok: false, error: "Пустой ответ" };
    }

    return {
      ok: true,
      output: {
        url: args.url,
        content: truncate(rawText, FETCH_CONTENT_MAX_CHARS),
      },
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
