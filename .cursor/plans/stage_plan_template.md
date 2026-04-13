# Stage XX — шаблон плана исполнения

Скопируй в новый файл `stage_XX_<slug>.plan.md` и заполни блоки. Все stage-планы в автономном цикле v1 следуют этой структуре.

Дополнительно в frontmatter (опционально): `name`, `overview`, `todos` с `id` / `content` / `status`.

---

## Goal

Одна-две фразы: что должно измениться для пользователя или для релизной уверенности.

## Out of scope

Явный список того, что **не** делаем в этом stage (чтобы агент не раздувал scope).

## Ordered backlog slices

Ссылка на строки в [autonomous_v1_active_backlog.md](autonomous_v1_active_backlog.md) **или** встроенная таблица с теми же полями (`id`, `priority`, `status`, `dependsOn`, `userValue`, `ownedFiles`, `requiredValidation`, `doneWhen`).

Правило: порядок = порядок исполнения; агент берёт верхний `open` с удовлетворёнными `dependsOn`.

## Validation ladder

Для **каждого** slice указать обязательные tier’ы:

| Tier | Команда / действие                              | Когда обязателен                                       |
| ---- | ----------------------------------------------- | ------------------------------------------------------ |
| T1   | `pnpm test -- <paths>`                          | Всегда для затронутых модулей                          |
| T2   | `pnpm check` (+ `pnpm build` при необходимости) | При изменении типов, сборки, широкого wiring           |
| T3   | `pnpm test:e2e:smoke`                           | Gateway/chat/runtime boot paths                        |
| T4   | `pnpm test:v1-gate`                             | Recovery/session-event surfaces; всегда перед v1 ready |
| T5   | Ручной протокол (ссылка на файл)                | Продуктовая приёмка трека                              |

Полная расшифровка: [master_v1_roadmap.md](master_v1_roadmap.md) (Release Ladder), [docs/help/testing.md](../../docs/help/testing.md).

## Hard stop conditions

Агент **останавливается** и пишет отчёт, если:

- нельзя сделать зелёными обязательные проверки текущего slice без несогласованного расширения scope;
- следующий шаг — только live/секрет/инфра (ручной gate);
- обнаружены противоречивые продуктовые требования;
- нужно действие вне репозитория (ключи, аккаунты, внешние сервисы).

## Continue conditions

Агент **продолжает** без нового пинга пользователя, если:

- текущий slice закрыт: код готов, обязательные tier’ы для slice зелёные;
- нет hard stop;
- в backlog есть следующий `open` slice с выполненными зависимостями.

Не останавливаться после «маленького зелёного патча», если выше по приоритету остаётся невыполненный slice.

## User-facing test protocol

Ссылка на чеклист (например [../stage86_test_cases.md](../stage86_test_cases.md)) + какие номера кейсов относятся к каким slice’ам.

## Next stage handoff

Что обновить в [master_v1_roadmap.md](master_v1_roadmap.md) после завершения: статус stage, ссылка на следующий план, что переносится в follow-up.
