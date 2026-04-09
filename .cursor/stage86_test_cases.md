# Stage 86 Test Cases - Smart Routing & Bootstrap

Операционные ссылки: stage-план [plans/stage_86_smart_routing_bootstrap.plan.md](plans/stage_86_smart_routing_bootstrap.plan.md), очередь slices [plans/autonomous_v1_active_backlog.md](plans/autonomous_v1_active_backlog.md), протокол подагентов [plans/multi_agent_execution_protocol.md](plans/multi_agent_execution_protocol.md).

## Test Protocol - 15 Minute Session

### Pre-flight Check

- [ ] Gateway running (PID: 25176)
- [ ] Ollama available at :11434
- [ ] Hydra/SD1 key configured (или другой remote OpenAI-compatible provider с моделью `hydra/gpt-4o`, если так настроен current profile)
- [ ] UI connected to http://127.0.0.1:18789
- [ ] Telegram bot @gode_mode_admin_bot responsive

---

## Test Case 1: Preflight Routing - Simple Task → Ollama (Local)

**Purpose:** Проверить что простые задачи идут на Ollama (экономия токенов)

**Command:** В Telegram напиши:

```
Привет! Как дела? Просто поздоровайся.
```

**Expected:**

- [ ] Ответ приходит быстро (< 5 сек)
- [ ] В UI → Sessions видно `model: ollama/qwen2.5-coder:7b`
- [ ] В логе gateway: `preflightMode: local_eligible`

---

## Test Case 2: Preflight Routing - Complex Task → Hydra/GPT-4o

**Purpose:** Проверить что сложные задачи идут на Hydra (качество)

**Command:** В Telegram напиши:

```
Напиши подробный анализ: какие 5 метрик важны для SaaS продукта и почему. С примерами.
```

**Expected:**

- [ ] Ответ приходит (может 10-20 сек)
- [ ] В UI → Sessions видно `model: hydra/gpt-4o`
- [ ] В логе gateway: `preflightMode: remote_required`
- [ ] Ответ содержит структурированный анализ с 5 пунктами

---

## Test Case 3: Fallback Chain - Hydra fails → Ollama

**Purpose:** Проверить цепочку fallback если primary недоступен

**Command:** Временно отключи интернет и напиши:

```
Какая погода сегодня?
```

**Expected:**

- [ ] В логе: `model_fallback: hydra/gpt-4o failed, trying ollama/qwen2.5-coder:7b`
- [ ] Ответ от Ollama (может медленнее, но работает)

**After:** Включи интернет обратно

---

## Test Case 4: Bootstrap Flow - Capability Install

**Purpose:** Проверить flow установки недостающей capability

**Command:** В Telegram напиши:

```
Сгенерируй PDF отчет с таблицей: название, количество, цена. Сохрани на диск.
```

**Expected:**

- [ ] Бот отвечает, что для генерации PDF нужна capability `pdf-renderer` и предлагает установку
- [ ] В UI → Bootstrap panel появляется запрос на approval
- [ ] После твоего "Да" в Telegram или Approval в UI:
  - [ ] Авто-установка capability
  - [ ] Авто-продолжение задачи (resume blocked run)
  - [ ] PDF сгенерирован

---

## Test Case 5: Prompt Optimization

**Purpose:** Проверить что промты оптимизируются перед отправкой

**Command:** В Telegram напиши (с лишними пробелами и пустыми строками):

```



   Привет!     Как работает   routing в OpenClaw?



```

**Expected:**

- [ ] В логе gateway: `promptOptimization: { normalized: true, trimmedWhitespace: 24, collapsedLines: 5 }`
- [ ] Оптимизированный промт уходит в модель (меньше токенов)

---

## Test Case 6: Session Runtime Inspector - Bootstrap Checkpoint

**Purpose:** Проверить UI отображение bootstrap состояний

**Steps:**

1. В UI открой http://127.0.0.1:18789
2. Перейди в Sessions
3. Найди активную или недавнюю сессию
4. Проверь:
   - [ ] Панель "Routing & planning context" показывает `modelRouteTier`
   - [ ] Если был bootstrap request - из runtime inspector есть переход к Bootstrap record, где виден callout о paused task / auto-resume
   - [ ] Lifecycle path отображается в Bootstrap record

---

## Test Case 7: Token Usage Tracking

**Purpose:** Проверить что токены считаются и логируются

**Command:** Напиши любой запрос, затем в UI:

- [ ] Sessions → выбери сессию → Usage Stats
- [ ] Проверь что в UI видны `inputTokens`, `outputTokens` и estimated cost (DTO поле `estimatedCostUsd`)

---

## Test Case 8: Hydra/SD1 Provider Direct Test

**Purpose:** Проверить работу нового провайдера

**Command:** В Telegram:

```
Используй model:hydra/gpt-4o. Переведи на английский: "Умный роутинг экономит токены"
```

**Expected:**

- [ ] Ответ: "Smart routing saves tokens"
- [ ] В UI видно model: hydra/gpt-4o
- [ ] В логе нет ошибок auth (200 OK от api.hydraai.ru)

---

## Log Collection Commands

После всех тестов выполни:

```powershell
# Gateway log
Get-Content "C:\tmp\openclaw\openclaw-2026-04-06.log" -Tail 200

# Или если файл большой:
Select-String -Path "C:\tmp\openclaw\openclaw-2026-04-06.log" -Pattern "preflight|bootstrap|model_fallback|hydra|ollama" -Tail 50
```

## Success Criteria

✅ **Stage 86 работает если:**

- все **8 из 8** тестов Stage 86 проходят
- Gateway не упал за 15 минут
- Все fallback сработали без ручного вмешательства
- Bootstrap flow завершился автоматически после approval
- Этот набор является foundation-блоком для общего live gate `10/10` из [v1_user_acceptance_cases.md](v1_user_acceptance_cases.md)
