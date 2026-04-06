# Stage 86 Test Cases - Smart Routing & Bootstrap

## Test Protocol - 15 Minute Session

### Pre-flight Check
- [ ] Gateway running (PID: 25176)
- [ ] Ollama available at :11434
- [ ] Hydra/SD1 key configured
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
- [ ] Бот отвечает: "Для генерации PDF нужна capability `pdf-generator`. Установить?"
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
   - [ ] Панель "Planning/Routing Context" показывает `modelRouteTier`
   - [ ] Если был bootstrap request - виден "Blocked Run Resume" callout
   - [ ] Lifecycle transitions отображаются

---

## Test Case 7: Token Usage Tracking
**Purpose:** Проверить что токены считаются и логируются

**Command:** Напиши любой запрос, затем в UI:
- [ ] Sessions → выбери сессию → Usage Stats
- [ ] Проверь что есть поля: `inputTokens`, `outputTokens`, `costEstimate`

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
- 6+ тестов из 8 проходят
- Gateway не упал за 15 минут
- Все fallback сработали без ручного вмешательства
- Bootstrap flow завершился автоматически после approval
