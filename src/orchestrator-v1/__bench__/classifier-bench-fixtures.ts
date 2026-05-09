/**
 * Classifier-model bench / regression fixtures.
 *
 * Golden set used both by the live-LLM bench harness (`classifier-bench.ts`)
 * and by the no-LLM vitest coverage check (`classifier-bench-fixtures.test.ts`).
 *
 * Each fixture declares the ideal Stage-A output (intent + tool_names array).
 * The bench scores each candidate model by exact-match on intent + tool_names
 * (sequence match for sequential turns; set match for parallel).
 *
 * Coverage policy (enforced by the vitest test):
 *   1. Every name in TOOL_NAMES from contract.ts has at least one tool_calls
 *      fixture targeting it.
 *   2. The set covers all three intent variants: tool_calls, conversation,
 *      refuse.
 *   3. Includes adversarial / ambiguous prompts to catch hallucination drift.
 *
 * To extend coverage when adding a new tool: append a fixture that targets
 * it, run `pnpm tsx src/orchestrator-v1/__bench__/classifier-bench.ts` and
 * confirm intent+tools accuracy stays at 100% on the chosen winner model.
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
  // ── conversation / refuse path ────────────────────────────────
  {
    id: "F1-greeting",
    prompt: "привет",
    expected: { intent: "conversation", tool_names: [] },
    rationale: "Plain greeting — conversation path.",
  },
  {
    id: "F6-self-introspection",
    prompt: "что ты умеешь?",
    expected: { intent: "conversation", tool_names: [] },
    rationale: "Self-introspection meta-question — conversation path; bot must NOT claim 'я умею делать X' as fake action.",
  },
  {
    id: "F10-conversation-question",
    prompt: "почему небо голубое?",
    expected: { intent: "conversation", tool_names: [] },
    rationale: "Knowledge question — conversation path, no tools needed.",
  },
  {
    id: "F8-ambiguous-save",
    prompt: "сохрани это",
    expected: { intent: "refuse", tool_names: [] },
    rationale: "Ambiguous deixis without referent — classifier should refuse, NOT guess.",
  },
  {
    id: "F23-vague-do-it",
    prompt: "сделай это",
    expected: { intent: "refuse", tool_names: [] },
    rationale: "Bare 'do it' with no referent — classic deixis trap; must refuse, not pick a tool.",
  },
  // ── write ─────────────────────────────────────────────────────
  {
    id: "F2-write-file-russian",
    prompt: "напиши заметку 'тест прошёл' в файл memory.md",
    expected: { intent: "tool_calls", tool_names: ["write"] },
    rationale: "Russian write-to-file imperative.",
  },
  {
    id: "F9-english-mixed",
    prompt: "create a new file called todo.md with content 'buy milk'",
    expected: { intent: "tool_calls", tool_names: ["write"] },
    rationale: "English imperative — bot is Russian-primary, must still classify.",
  },
  // ── edit ──────────────────────────────────────────────────────
  {
    id: "F11-edit-file",
    prompt: "в файле /tmp/notes.md замени строку 'foo' на 'bar'",
    expected: { intent: "tool_calls", tool_names: ["edit"] },
    rationale: "Edit on existing file with explicit search+replace — must NOT route to write.",
  },
  // ── read ──────────────────────────────────────────────────────
  {
    id: "F12-read-file",
    prompt: "покажи что лежит в /tmp/notes.md",
    expected: { intent: "tool_calls", tool_names: ["read"] },
    rationale: "Read content of a file — distinct from edit/write.",
  },
  // ── image_generate ───────────────────────────────────────────
  {
    id: "F3-image-generate",
    prompt: "сгенерируй картинку рыжего кота на крыше",
    expected: { intent: "tool_calls", tool_names: ["image_generate"] },
    rationale: "Single image generation.",
  },
  {
    id: "F13-meme-image",
    prompt: "нарисуй мем с программистом который не спал три дня",
    expected: { intent: "tool_calls", tool_names: ["image_generate"] },
    rationale: "'Нарисуй мем' — synonym of image_generate; must NOT route to pdf.",
  },
  // ── pdf ───────────────────────────────────────────────────────
  {
    id: "F14-pdf-infographic",
    prompt: "создай PDF с инфографикой о городском котике",
    expected: { intent: "tool_calls", tool_names: ["pdf"] },
    rationale: "PDF document with infographic — known regression case (was misrouting to [write, image_generate] before pdf was in the menu).",
  },
  {
    id: "F15-pdf-report",
    prompt: "сделай отчёт за квартал в PDF",
    expected: { intent: "tool_calls", tool_names: ["pdf"] },
    rationale: "Report → pdf trigger.",
  },
  {
    id: "F16-pdf-presentation-en",
    prompt: "make a presentation about climate change",
    expected: { intent: "tool_calls", tool_names: ["pdf"] },
    rationale: "English 'presentation' — must route to pdf, not image_generate.",
  },
  // ── web_search vs web_fetch ──────────────────────────────────
  {
    id: "F5-web-search",
    prompt: "найди мне последние новости про SpaceX за неделю",
    expected: { intent: "tool_calls", tool_names: ["web_search"] },
    rationale: "Search by query — no URL, must NOT route to web_fetch.",
  },
  {
    id: "F17-web-fetch-with-url",
    prompt: "скачай содержимое https://example.com/article",
    expected: { intent: "tool_calls", tool_names: ["web_fetch"] },
    rationale: "Explicit URL present — must route to web_fetch, not web_search. Phrasing avoids 'прочитай' which is the read-tool trigger.",
  },
  // ── sessions_send ────────────────────────────────────────────
  {
    id: "F18-sessions-send",
    prompt: "отправь в чат боссу сообщение «всё готово»",
    expected: { intent: "tool_calls", tool_names: ["sessions_send"] },
    rationale: "Send-to-named-chat single action.",
  },
  // ── persistent_worker_push vs cron ───────────────────────────
  {
    id: "F7-persistent-worker",
    prompt: "создай persistent worker daily-test, который раз в 2 минуты пишет «push fixture» в этот чат",
    expected: { intent: "tool_calls", tool_names: ["persistent_worker_push"] },
    rationale: "Bug F canonical — recurring auto-generated push must route to persistent_worker_push, not sessions_send/cron.",
  },
  {
    id: "F19-worker-digest",
    prompt: "каждый день в 9 утра присылай мне сводку новостей",
    expected: { intent: "tool_calls", tool_names: ["persistent_worker_push"] },
    rationale: "Daily auto-generated digest = persistent_worker_push (bot generates the content), NOT cron (cron only pings).",
  },
  {
    id: "F20-cron-reminder",
    prompt: "напомни мне через час позвонить маме",
    expected: { intent: "tool_calls", tool_names: ["cron"] },
    rationale: "One-shot reminder with no auto-content = cron, NOT persistent_worker_push.",
  },
  // ── exec ──────────────────────────────────────────────────────
  {
    id: "F21-exec-shell",
    prompt: "запусти `git status` в репе",
    expected: { intent: "tool_calls", tool_names: ["exec"] },
    rationale: "Explicit shell command — exec, not write/read.",
  },
  // ── multi-action sequential ──────────────────────────────────
  {
    id: "F4-multi-action-sequential",
    prompt: "создай файл report.md с заголовком 'Итоги' и потом отправь его в чат боссу",
    expected: { intent: "tool_calls", tool_names: ["write", "sessions_send"], sequencing: "sequential" },
    rationale: "Multi-action 'X и потом Y' — must split into two TurnActions, sequential, in order.",
  },
  // ── parallel multi-action ─────────────────────────────────────
  {
    id: "F24-parallel-write-image",
    prompt: "параллельно: сохрани в /tmp/cat.md описание рыжего кота, и одновременно сгенерируй его картинку",
    expected: { intent: "tool_calls", tool_names: ["write", "image_generate"], sequencing: "parallel" },
    rationale: "Explicit 'параллельно' + 'одновременно' triggers parallel sequencing; without these, the bare conjunction defaults to sequential.",
  },
  // ── general expansion (2026-05-09 round 2) ───────────────────
  {
    id: "F25-exec-npm-install",
    prompt: "установи пакет lodash через npm",
    expected: { intent: "tool_calls", tool_names: ["exec"] },
    rationale: "RU 'установи' + npm — must route to exec (CLI), not write/edit.",
  },
  {
    id: "F26-exec-pip-install",
    prompt: "запусти pip install requests",
    expected: { intent: "tool_calls", tool_names: ["exec"] },
    rationale: "Imperative-wrapped CLI string — exec. (Bare 'pip install requests' is ambiguous — could be discussion; an explicit 'запусти' is required to disambiguate.)",
  },
  {
    id: "F27-exec-git-pull",
    prompt: "сделай git pull в проекте",
    expected: { intent: "tool_calls", tool_names: ["exec"] },
    rationale: "VCS command — exec.",
  },
  {
    id: "F28-write-zapishi",
    prompt: "запиши в /tmp/note.txt 'привет всем'",
    expected: { intent: "tool_calls", tool_names: ["write"] },
    rationale: "'Запиши' synonym of 'напиши' for write.",
  },
  {
    id: "F29-edit-append",
    prompt: "добавь в конец /tmp/notes.md строку 'done'",
    expected: { intent: "tool_calls", tool_names: ["edit"] },
    rationale: "Append to existing file — edit, NOT write (write would overwrite the file).",
  },
  {
    id: "F30-edit-typo-fix",
    prompt: "поправь опечатку 'кошькин' на 'кошкин' в /tmp/cat.md",
    expected: { intent: "tool_calls", tool_names: ["edit"] },
    rationale: "Explicit search+replace in existing file — edit.",
  },
  {
    id: "F31-read-what-is-there",
    prompt: "что сейчас лежит в /tmp/notes.md?",
    expected: { intent: "tool_calls", tool_names: ["read"] },
    rationale: "'Что лежит в файле' — read synonym.",
  },
  {
    id: "F32-image-portrait",
    prompt: "сделай портрет в стиле фотореализма: девушка с зонтом",
    expected: { intent: "tool_calls", tool_names: ["image_generate"] },
    rationale: "'Портрет' + style — image_generate.",
  },
  {
    id: "F33-image-logo",
    prompt: "сгенерируй логотип кофейни Bean Stop",
    expected: { intent: "tool_calls", tool_names: ["image_generate"] },
    rationale: "'Логотип' — single image, image_generate (not pdf).",
  },
  {
    id: "F34-pdf-resume",
    prompt: "собери моё резюме в PDF",
    expected: { intent: "tool_calls", tool_names: ["pdf"] },
    rationale: "'Резюме' + PDF — pdf.",
  },
  {
    id: "F35-pdf-handout",
    prompt: "сделай раздаточный материал для лекции про SQL injections",
    expected: { intent: "tool_calls", tool_names: ["pdf"] },
    rationale: "'Раздаточный материал' = handout — pdf, even without explicit 'PDF' word.",
  },
  {
    id: "F36-web-search-news",
    prompt: "найди последние новости про OpenAI за эту неделю",
    expected: { intent: "tool_calls", tool_names: ["web_search"] },
    rationale: "Recency news lookup with explicit 'найди' trigger — web_search. (Bare 'что нового в X?' is borderline — classifier may believe it can answer from training; explicit search verb removes ambiguity.)",
  },
  {
    id: "F37-web-search-howto",
    prompt: "погугли как настроить nginx reverse proxy",
    expected: { intent: "tool_calls", tool_names: ["web_search"] },
    rationale: "'Погугли' — explicit search trigger.",
  },
  {
    id: "F38-web-fetch-raw",
    prompt: "забери https://raw.githubusercontent.com/foo/bar/main/README.md",
    expected: { intent: "tool_calls", tool_names: ["web_fetch"] },
    rationale: "Raw URL given — web_fetch, not web_search.",
  },
  {
    id: "F39-sessions-send-channel",
    prompt: "напиши в канал @teamupdates что сборка готова",
    expected: { intent: "tool_calls", tool_names: ["sessions_send"] },
    rationale: "Send to @-channel — sessions_send.",
  },
  {
    id: "F40-cron-tomorrow",
    prompt: "завтра в 7 утра напомни выпить кофе",
    expected: { intent: "tool_calls", tool_names: ["cron"] },
    rationale: "One-shot reminder at concrete time — cron.",
  },
  {
    id: "F41-worker-static-template",
    prompt: "каждое утро в 8 присылай одно и то же сообщение «Время зарядки»",
    expected: { intent: "tool_calls", tool_names: ["persistent_worker_push"] },
    rationale: "Recurring push of a STATIC message_template — that IS persistent_worker_push (its arg schema is exactly {schedule, message_template}). cron is for recurring LLM-reasoning tasks (its prompt arg is an instruction the LLM acts on each tick), not for static-text push.",
  },
  {
    id: "F42-worker-twitter-trends",
    prompt: "каждые 4 часа делай мне сводку трендов в твиттере",
    expected: { intent: "tool_calls", tool_names: ["persistent_worker_push"] },
    rationale: "Recurring auto-generated digest — persistent_worker_push.",
  },
  {
    id: "F43-multi-search-pdf",
    prompt: "найди статьи про квантовые вычисления и собери из них pdf-обзор",
    expected: { intent: "tool_calls", tool_names: ["web_search", "pdf"], sequencing: "sequential" },
    rationale: "Multi-action search→pdf, sequential (downstream depends on upstream output).",
  },
  {
    id: "F44-refuse-zapomni",
    prompt: "запомни что я переехал в Питер",
    expected: { intent: "refuse", tool_names: [] },
    rationale: "No memory tool in catalog — must refuse, NOT hallucinate write with a guessed path.",
  },
  // ── domain: construction / repair ─────────────────────────────
  {
    id: "F45-construct-write-estimate",
    prompt: "запиши в /tmp/смета.md расчёт: 200р/м2 на 80 квадратов",
    expected: { intent: "tool_calls", tool_names: ["write"] },
    rationale: "Domain: construction estimate to a specific file path — write (not pdf — user wants raw markdown).",
  },
  {
    id: "F46-construct-image-kitchen",
    prompt: "сгенерируй эскиз кухни 4х5 метров с островом",
    expected: { intent: "tool_calls", tool_names: ["image_generate"] },
    rationale: "Domain: 'эскиз' (sketch) — image_generate. Classifier must not balk at 'CAD-like' phrasing.",
  },
  {
    id: "F47-construct-pdf-estimate",
    prompt: "сделай PDF-смету на ремонт ванной",
    expected: { intent: "tool_calls", tool_names: ["pdf"] },
    rationale: "Domain: same 'смета' word as F45 but printable doc — pdf.",
  },
  {
    id: "F48-construct-search-snip",
    prompt: "найди СНиП на устройство стяжки пола",
    expected: { intent: "tool_calls", tool_names: ["web_search"] },
    rationale: "Domain: construction code lookup — web_search.",
  },
  {
    id: "F49-construct-cron-pour",
    prompt: "напомни через 2 часа залить раствор",
    expected: { intent: "tool_calls", tool_names: ["cron"] },
    rationale: "Domain: construction time-bound reminder — cron.",
  },
  // ── domain: sales / business ──────────────────────────────────
  {
    id: "F50-sales-pdf-pricelist",
    prompt: "сделай PDF-прайс на наши услуги",
    expected: { intent: "tool_calls", tool_names: ["pdf"] },
    rationale: "Domain: sales pricelist as document — pdf.",
  },
  {
    id: "F51-sales-worker-daily-report",
    prompt: "каждое утро в 9 присылай отчёт по продажам за вчера",
    expected: { intent: "tool_calls", tool_names: ["persistent_worker_push"] },
    rationale: "Domain: recurring auto-generated sales report — persistent_worker_push.",
  },
  {
    id: "F52-sales-sessions-send-client",
    prompt: "отправь клиенту @ivan_sales 'заказ принят, отгрузка завтра'",
    expected: { intent: "tool_calls", tool_names: ["sessions_send"] },
    rationale: "Domain: client message to @-handle — sessions_send.",
  },
  {
    id: "F53-sales-search-suppliers",
    prompt: "найди оптовых поставщиков светильников в Москве",
    expected: { intent: "tool_calls", tool_names: ["web_search"] },
    rationale: "Domain: B2B supplier lookup — web_search.",
  },
  {
    id: "F54-sales-write-clients-md",
    prompt: "запиши в /tmp/clients.md контакт: Иван +79991234567",
    expected: { intent: "tool_calls", tool_names: ["write"] },
    rationale: "Domain: contact note to file — write (not pdf, not edit since file may not exist yet).",
  },
  // ── domain: hobby / household ─────────────────────────────────
  {
    id: "F55-hobby-image-cross-stitch",
    prompt: "сгенерируй схему вышивки крестом — котик на подушке",
    expected: { intent: "tool_calls", tool_names: ["image_generate"] },
    rationale: "Domain: craft pattern as visual — image_generate.",
  },
  {
    id: "F56-hobby-cron-fishing",
    prompt: "напомни в субботу в 10 утра ехать на рыбалку",
    expected: { intent: "tool_calls", tool_names: ["cron"] },
    rationale: "Domain: hobby-event reminder — cron.",
  },
  {
    id: "F57-hobby-pdf-recipes",
    prompt: "собери в PDF мою коллекцию рецептов борща",
    expected: { intent: "tool_calls", tool_names: ["pdf"] },
    rationale: "Domain: recipe collection as printable doc — pdf.",
  },
  {
    id: "F58-hobby-write-training",
    prompt: "запиши в /tmp/training.md план тренировки на неделю: пн-ноги, вт-кардио",
    expected: { intent: "tool_calls", tool_names: ["write"] },
    rationale: "Domain: training plan note — write.",
  },
  {
    id: "F59-hobby-search-vintage-camera",
    prompt: "погугли как обновить винтажный фотоаппарат Зенит-Е",
    expected: { intent: "tool_calls", tool_names: ["web_search"] },
    rationale: "Domain: hobby how-to lookup — web_search.",
  },
];
