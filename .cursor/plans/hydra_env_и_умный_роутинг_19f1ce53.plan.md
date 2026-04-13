---
name: Hydra env и умный роутинг
overview: Безопасно подключить ключ Hydra через переменные окружения (не в git), согласовать конфиг с официальными endpoint’ами, затем развить роутинг от «жёсткого списка + эвристик» к ранжированию кандидатов по живому каталогу `/v1/models` и статусу `/v1/models/status`, сохраняя local-first и существующую цепочку fallback.
todos:
  - id: security-rotate-key
    content: Ротировать скомпрометированный ключ Hydra; выставить HYDRA_API_KEY только в User env / ~/.openclaw/.env
    status: completed
  - id: env-example-hydra
    content: Добавить в .env.example закомментированный HYDRA_API_KEY и ссылку на docs/providers/sd1-hydra.md
    status: completed
  - id: hydra-catalog-client
    content: Реализовать кэшируемый клиент GET /v1/models (+ опционально /models/status) для baseUrl hydra
    status: completed
  - id: rank-candidates
    content: Ранжировать цепочку fallback по полям каталога (type, active, reasoning, modalities, pricing, health) с сохранением local-first
    status: completed
  - id: wire-preflight-fallback
    content: Подключить ranker к applyModelRoutePreflight / resolveFallbackCandidates; тесты в route-preflight / model-fallback
    status: completed
  - id: release-config-check
    content: "Проверить openclaw.json: imageModel на hydra image ids, memorySearch embeddings, chat fallbacks не сведены к gpt-4o only"
    status: completed
isProject: false
---

# План: Hydra API key и релизный умный роутинг

## Цель релиза

Сегодня нужен не «примерный» роутинг, а рабочая релизная схема:

- `local-first` остаётся базовым правилом;
- локальные модели не единственные, а первый фронт;
- если локаль не подходит, не стартует, уходит в OOM или даёт пустой/негодный ответ, цепочка обязана дойти до Hydra;
- выбор remote-модели должен опираться не на 2-3 вручную указанные модели, а на факты о моделях и их назначении;
- генерация картинок и embeddings идут по отдельным веткам, а не через общий chat default.

## Что в текущем плане было слабым

- Он был слишком общим и больше описывал идею, чем релизную последовательность.
- Недостаточно жёстко зафиксированы конкретные точки входа в код:
`[src/platform/decision/route-preflight.ts](src/platform/decision/route-preflight.ts)`,
`[src/agents/model-fallback.ts](src/agents/model-fallback.ts)`,
`[src/agents/model-catalog.ts](src/agents/model-catalog.ts)`.
- Не было явно сказано, что existing substring/rule scoring в preflight должен стать временным слоем, а источник правды для Hydra нужно подтянуть из `/v1/models` и `/v1/models/status`.
- Не было явно прописано ускорение через сабагентов.

## Наблюдения по текущему коду

- В `[src/platform/decision/route-preflight.ts](src/platform/decision/route-preflight.ts)` уже есть `local-first`, разделение на `cheap | code | strong` и ручное ранжирование remote-хвоста. Это хорошая временная база, но пока это всё ещё policy на строках model id.
- В `[src/agents/model-fallback.ts](src/agents/model-fallback.ts)` уже собрана реальная fallback-цепочка через `resolveFallbackCandidates()` и отдельная image-цепочка через `resolveImageFallbackCandidates()`. Значит не надо изобретать новый раннер, надо улучшать порядок кандидатов и источник данных.
- В `[src/agents/model-catalog.ts](src/agents/model-catalog.ts)` уже есть кэшируемый каталог моделей. Значит правильнее не делать параллельный «ещё один каталог», а расширить существующий слой данными Hydra и использовать его в ранжировании.

## Что говорят доки Hydra и почему это важно

По [api_endpoints-0.md](C:\Users\Tanya.cursor\projects\c-Users-Tanya-source-repos-god-mode-core/uploads/api_endpoints-0.md) и `[docs/providers/sd1-hydra.md](docs/providers/sd1-hydra.md)`:

- `GET /v1/models` даёт тип модели, reasoning, модальности, поддерживаемые файлы, архитектуру, квантизацию, pricing.
- `GET /v1/models/status` даёт success rate, TPS, ART.
- `POST /v1/chat/completions` это чат и function calling.
- `POST /v1/images/generations` это отдельная image-ветка.
- `POST /v1/embeddings` это отдельная ветка памяти.

Из этого следует:

- `gpt-5.4` не должен быть универсальным ответом на всё.
- Image generation должна идти через `agents.defaults.imageModel`.
- Embeddings должны идти только через embedding-модели.
- Remote ranking должен учитывать не только название модели, но и её `type`, `reasoning`, `output_modalities`, `pricing`, `active`, `success_rate`, `tps/art`.

## Теги моделей Hydra

- `Tools`: модель подходит для tool calling и агентных сценариев.
- `Reasoning`: модель имеет усиленный режим рассуждений и лучше подходит для сложных multi-step задач.
- `MoE`: архитектурный признак Mixture of Experts; полезен как сигнал о профиле модели, но не как прямой критерий выбора сам по себе.
- `fp8`: тип квантизации; обычно сигнал скорости/стоимости, а не самостоятельный признак «умности».

Для роутинга это означает:

- `Tools` и `Reasoning` надо учитывать в score.
- `MoE` и `fp8` можно использовать только как вторичный tie-breaker, а не как основной критерий.

## Быстрый релизный порядок работ

### 1. Секрет и env

- Не коммитить ключ в репозиторий.
- Добавить только документированный плейсхолдер `HYDRA_API_KEY` в `[.env.example](.env.example)`.
- Рабочее значение держать в пользовательском env или в локальном `.env` / `~/.openclaw/.env`.
- Ключ из чата считать скомпрометированным и после проверки ротировать.
- Для `dogmode`: в репозитории такого отдельного профиля не найдено, значит в плане трактуем это как локальный runtime/env вашего форка, а не как отдельный кодовый модуль.

### 2. Закрепить источник правды для Hydra

- Не ограничиваться статическим списком моделей из документации.
- Подтянуть живой Hydra-каталог в существующий `[src/agents/model-catalog.ts](src/agents/model-catalog.ts)`.
- Добавить нормализованный слой поверх `/v1/models` и `/v1/models/status` с коротким TTL-кэшем.
- Использовать эти данные как capability snapshot для ранжирования.

### 3. Не переписывать fallback engine, а усилить его

- Сохранить текущий `resolveFallbackCandidates()` в `[src/agents/model-fallback.ts](src/agents/model-fallback.ts)`.
- Сохранить `applyModelRoutePreflight()` в `[src/platform/decision/route-preflight.ts](src/platform/decision/route-preflight.ts)`.
- Заменить ручное «угадывание по substrings» на вычисление score из capability snapshot.
- Local-кандидаты по-прежнему идут первыми.
- Remote-хвост сортируется не жёстко по конфигу, а по score под конкретный task profile.

### 4. Ввести нормальный task profile

Минимальный релизный профиль должен различать:

- `chat-cheap`
- `chat-tools`
- `code-tools`
- `reasoning-strong`
- `image-generation`
- `embedding`
- `vision/document`

Источники сигналов:

- уже существующий planner input;
- requested tools;
- artifact kinds;
- наличие файлов и модальностей;
- необходимость ответа картинкой/документом;
- необходимость memory embeddings.

### 5. Правила маршрутизации

#### Local-first

- Простые чатовые и часть tool-задач сначала идут в локальные модели.
- Сильные локальные модели остаются первым тяжёлым уровнем, если реально доступны и не перегружены.
- Ошибки запуска, OOM, timeout, refusal и semantic no-op не должны останавливать цепочку.

#### Remote escalation

- `cheap` профиль должен сначала идти в дешёвые chat/tool remote-модели.
- `code` профиль должен поднимать code/reasoning/tool-capable модели выше.
- `strong` профиль должен поднимать сильные reasoning-модели выше.
- `image-generation` идёт отдельно через image-модели Hydra.
- `embedding` идёт отдельно через embedding-модели Hydra.

### 6. Наблюдаемость

- Добавить debug-объяснение: почему выбрана модель, какие capability и какие штрафы/бонусы сработали.
- Это критично для сегодняшнего релиза, иначе тестировать роутинг будет слишком медленно и вслепую.

## Где именно менять код после подтверждения

- `[.env.example](.env.example)`
добавить закомментированный `HYDRA_API_KEY` и короткую подсказку на `[docs/providers/sd1-hydra.md](docs/providers/sd1-hydra.md)`
- `[src/agents/model-catalog.ts](src/agents/model-catalog.ts)`
расширить каталог capability-данными Hydra
- `[src/platform/decision/route-preflight.ts](src/platform/decision/route-preflight.ts)`
заменить часть ручного ranking на capability-aware ranking
- `[src/agents/model-fallback.ts](src/agents/model-fallback.ts)`
использовать улучшенный порядок кандидатов без поломки текущего fallback engine
- `[src/commands/models/list.status-command.ts](src/commands/models/list.status-command.ts)`
при необходимости использовать для человекочитаемой проверки статуса и explain/debug surface
- tests рядом с:
`[src/platform/decision/route-preflight.test.ts](src/platform/decision/route-preflight.test.ts)`
`[src/agents/model-fallback.test.ts](src/agents/model-fallback.test.ts)`
`[src/agents/model-catalog.test.ts](src/agents/model-catalog.test.ts)`

## Сабагенты

Сабагенты разрешены и желательны, если это ускоряет релиз без распыления контекста.

- Один сабагент на Hydra docs / capability mapping.
- Один сабагент на audit текущего routing path: catalog → preflight → fallback.
- Один сабагент на тесты и регрессию по route-preflight / model-fallback.

Главный агент остаётся владельцем решения и финальной интеграции. Сабагенты не должны самостоятельно менять архитектурный курс, только быстро собирать факты, тестовые пробелы и узкие места.

## Критерии готовности

- Ключ подключается через env, без утечки в git.
- В конфиге нет сценария, где Hydra сводится к `gpt-4o/gpt-4o-mini only`.
- Image generation не висит на chat default модели.
- Embeddings не висят на chat default модели.
- Routing explain/debug показывает, почему выбран именно этот кандидат.
- При падении local цепочка доходит до remote и пользователь не остаётся без ответа.
- Есть быстрый набор тестов на `cheap`, `code`, `strong`, `image`, `embedding`.

## Релизный fast path

Если времени совсем мало, делаем в таком порядке:

1. env и безопасное подключение Hydra
2. capability snapshot для Hydra
3. ranking remote-хвоста по capability snapshot
4. отдельная фиксация imageModel и memory embeddings
5. debug/explain
6. targeted tests и live smoke

Это самый короткий путь к «бот выбирает модели умнее прямо сегодня», без переписывания всей платформы перед релизом.
