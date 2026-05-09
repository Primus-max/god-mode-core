/**
 * Hour 0-1 — Classifier-model bench fixtures.
 *
 * 10 prompts covering the 3 intent variants and the multi-action,
 * Russian, and ambiguous cases that broke the kernel-runtime classifier
 * during 2026-05-08 T1 live-verify.
 *
 * For each fixture, `expected` declares the ideal Stage-A output
 * (intent + tool_names array). The bench harness scores each candidate
 * model by exact-match on intent and on tool_names (set equality, order
 * insensitive within sequencing semantic).
 */

export type ExpectedTurnRouting = {
  intent: "tool_calls" | "conversation" | "refuse";
  tool_names: string[];
  // sequencing is informational here — bench focuses on intent + tool_names
  sequencing?: "sequential" | "parallel";
};

export type ClassifierFixture = {
  id: string;
  prompt: string;
  expected: ExpectedTurnRouting;
  /** Short comment on what this prompt is testing. */
  rationale: string;
};

export const CLASSIFIER_FIXTURES: ReadonlyArray<ClassifierFixture> = [
  {
    id: "F1-greeting",
    prompt: "привет",
    expected: { intent: "conversation", tool_names: [] },
    rationale: "Plain greeting — no action, no tool. Conversation path.",
  },
  {
    id: "F2-write-file-russian",
    prompt: "напиши заметку 'тест прошёл' в файл memory.md",
    expected: { intent: "tool_calls", tool_names: ["write"] },
    rationale: "Single tool call — Russian write-to-file imperative.",
  },
  {
    id: "F3-image-generate",
    prompt: "сгенерируй картинку рыжего кота на крыше",
    expected: { intent: "tool_calls", tool_names: ["image_generate"] },
    rationale: "Single tool call — image generation.",
  },
  {
    id: "F4-multi-action-sequential",
    prompt: "создай файл report.md с заголовком 'Итоги' и потом отправь его в чат боссу",
    expected: { intent: "tool_calls", tool_names: ["write", "sessions_send"], sequencing: "sequential" },
    rationale: "Multi-action 'X и потом Y' — must split into two TurnActions, sequential.",
  },
  {
    id: "F5-web-search",
    prompt: "найди мне последние новости про SpaceX за неделю",
    expected: { intent: "tool_calls", tool_names: ["web_search"] },
    rationale: "Web search — distinct from web_fetch (no URL).",
  },
  {
    id: "F6-self-introspection",
    prompt: "что ты умеешь?",
    expected: { intent: "conversation", tool_names: [] },
    rationale: "Self-introspection meta-question — conversation path; bot must NOT claim 'я умею делать X' as fake action.",
  },
  {
    id: "F7-persistent-worker",
    prompt: "создай persistent worker daily-test, который раз в 2 минуты пишет «push fixture» в этот чат",
    expected: { intent: "tool_calls", tool_names: ["persistent_worker_push"] },
    rationale: "Bug F canonical prompt — must NOT route to sessions_spawn (the previous classifier mis-routed this).",
  },
  {
    id: "F8-ambiguous-save",
    prompt: "сохрани это",
    expected: { intent: "refuse", tool_names: [] },
    rationale: "Ambiguous deixis without referent — classifier should refuse, NOT guess. (Reasoned over hallucination per design.)",
  },
  {
    id: "F9-english-mixed",
    prompt: "create a new file called todo.md with content 'buy milk'",
    expected: { intent: "tool_calls", tool_names: ["write"] },
    rationale: "Mixed language — bot is Russian-primary, must still classify English imperative correctly.",
  },
  {
    id: "F10-conversation-question",
    prompt: "почему небо голубое?",
    expected: { intent: "conversation", tool_names: [] },
    rationale: "Knowledge question — conversation path, no tools needed.",
  },
];

/** The set of tool names referenced by fixtures (Stage-A menu must include all of these). */
export const FIXTURE_TOOL_MENU: ReadonlyArray<string> = [
  "write",
  "edit",
  "read",
  "image_generate",
  "web_search",
  "web_fetch",
  "sessions_send",
  "persistent_worker_push",
  "cron",
  "exec",
];
