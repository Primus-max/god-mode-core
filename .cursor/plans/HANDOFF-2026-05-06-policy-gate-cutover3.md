# HANDOFF: продолжить v1 commitment-kernel по master plan
## Создан 2026-05-06 для следующей сессии (auto-loop mode)

---

## Старт-prompt для нового чата (скопируй и вставь в новую сессию)

```
Запусти /loop в auto mode. Цель — закрыть commitment-kernel v1 на проде до точки «бот в Telegram умно делает PDF/DOCX-задачи end-to-end». Двигаешься строго по master plan, без само-настройки конфигов и инфры.

КОНТЕКСТ
========
- dev SHA: 985e9a1d2648c751a6b13251dd939945f41f0dbb (post PR #190)
- Slices CLOSED: D (PR #146-#151), E (PR #154/#156/#160/#165/#168/#169/#170/#172/#177/#178), F (PR #181-#187, B7 closed), I (PR #152/#157/#161/#162/#166 + revert #174 + #175 wrapper temp-disabled, #186)
- Slice H: P3+P4 done (PR #153/#155/#163), P5 stress + P6 live-verify deferred (non-blockers)
- B1 (memory across /new), B5 (English meta-leak), B7 (tasks across /new) closed architecturally
- Vladimir granted blanket maintainer-signoff for v1 commitment-kernel slices on 2026-05-05 (memory: feedback_signoff_blanket_authorization.md). НЕ спрашивай per-phase signoff. Действуй автономно.

4 production bugs surfaced 2026-05-06 live test (см master plan §0 row 2026-05-06):
1. closure-outcome-dispatcher false-positive «bootstrap pending» когда capability уже verified (`src/auto-reply/reply/closure-outcome-dispatcher.ts:863`)
2. image_generate не передаёт reference image (нет img2img через Hydra `/images/edits`)
3. PDF subagent hardcoded timeoutMs=2000 — слишком короткий
4. per-channel `streaming: "off"` не блокирует partials в `pi-embedded-subscribe.ts:385 stripBlockTags`

Эти 4 = NEXT 3 forward slices в master plan'е, НЕ отдельные patches:
- bug 1+3 → `commitment_kernel_policy_gate_full.plan.md` (PolicyGate Stages 2-6: approvals/budgets/role-based/retry/escalation; обязателен до cutover-4)
- bug 2 → `commitment_kernel_cutover3_artifacts.plan.md` (cutover-3 для repo_operation/artifact effects через AffordanceRegistry; PDF/DOCX/code-patch routing)
- bug 4 → minor outbound follow-up (Slice I Phase 7 ИЛИ standalone)

Плюс открытый task: Search-Composer Phase 4c (см master plan §0 row 2026-05-02 — flip `intent-contractor-impl.ts:472` 3-family allowlist на включение `web_research`).

ДЕЙСТВИЯ ПО ПОРЯДКУ
====================
1. plan-reader агент → bootstrap report (frontier confirmation + last 5 merges + recommended next slice).
2. Plan-агент в фоне → пишет `.cursor/plans/commitment_kernel_policy_gate_full.plan.md` (PolicyGate Stages 2-6 sub-plan; шаблон по slice E/F sub-plans). Параллельно — Plan-агент пишет `.cursor/plans/commitment_kernel_cutover3_artifacts.plan.md` (cutover-3 artifacts sub-plan; шаблон по PR-4b cutover-2 + Search-Composer phases). Оба должны включать §0 maintainer-signoff поле «GRANTED via blanket authorization».
3. После того как оба sub-plan'а merged как `docs(plan):` PR'ы — запустить slice-implementer'ов параллельно на Phase 1 (audit) обоих slices. По мере landing'а Phase 1 → Phase 2 → ... через slice-implementer (worktree) → gate-runner → admin-merge → handoff drift fix → next phase.
4. Loop'ом сам прокатить: PolicyGate Full Phases 1-N + Cutover-3 Artifacts Phases 1-M.
5. После того как оба slice'а COMPLETE — Search-Composer Phase 4c (flip allowlist + live verify).
6. После Phase 4c — рестарт gateway, попросить Vladimir прислать в TG конкретные prompt'ы:
   - «привет»
   - «запомни X» → /new → «что я запомнил?»
   - (JPG attachment) «сделай PDF из этого эскиза»
   - (DOCX attachment) «сделай КП по этому шаблону»
7. live-verifier агент парсит лог `C:\tmp\openclaw\openclaw-<date>.log` против acceptance criteria каждого slice'а.

ЖЁСТКИЕ ОГРАНИЧЕНИЯ
====================
- НИКОГДА не править `~/.openclaw-dev/openclaw.json` или `~/.openclaw/openclaw.json` wholesale (Vladimir теряет токены). Только Edit на конкретные строки. Backup до каждого edit'а.
- НЕ делать «зелёные unit-тесты» как доказательство. Только live verify в Telegram.
- НЕ писать костыли per-provider (типа Anthropic-thinking-wrapper PR #175). Архитектурные решения only.
- НЕ revert'ить slice E/F/I — они работают архитектурно (доказано B1/B5/B7 fixture acceptance). Текущие 4 bugs — отдельные orchestration-layer проблемы, не регрессии.
- 16 hard invariants в `.cursor/rules/commitment-kernel-invariants.mdc` соблюдать на каждом phase. Frozen layer (`src/platform/commitment/`) трогать только additively (constructor extension), как делали в slice E P6 / slice F P6.
- Для НОВЫХ effect-families (artifact.* и т.п.) — расширять `EFFECT_FAMILY_REGISTRY` + `EpisodicEffectFamily` discriminated union (slice E P2 шаблон).
- Hydra modeles: primary должна оставаться `hydra/gpt-5.4` (видит images: `input_modalities=["text","image"]`). НЕ переключать на `claude-opus-4.6` (он `["text"]` только через Hydra).

ССЫЛКИ
======
- Master plan: `.cursor/plans/commitment_kernel_v1_master.plan.md`
- Roadmap: `.cursor/plans/commitment_kernel_v1_release_roadmap.plan.md`
- Smart orchestrator: `.cursor/plans/commitment_kernel_smart_orchestrator_roadmap.plan.md`
- Slice E sub-plan (template): `.cursor/plans/commitment_kernel_memory_layer.plan.md`
- Slice F sub-plan (template): `.cursor/plans/commitment_kernel_task_ledger.plan.md`
- Hard invariants: `.cursor/rules/commitment-kernel-invariants.mdc`
- This handoff doc: `.cursor/plans/HANDOFF-2026-05-06-policy-gate-cutover3.md`
- Live config (DO NOT OVERWRITE): `~/.openclaw-dev/openclaw.json` (dev profile, primary = hydra/gpt-5.4)

Старт: spawn plan-reader, потом два Plan-агента в фоне для двух sub-plans. Не задавай мне вопросов — иди.
```

---

## Что Vladimir хочет видеть в новой сессии

1. plan-reader выдаёт bootstrap.
2. Сразу — два Plan-агента запущены в фоне (PolicyGate Full + Cutover-3 Artifacts sub-plans).
3. По мере landing'а sub-plan'ов → slice-implementer'ы phase by phase.
4. Drift fix после каждого мёрж.
5. После всех phases — live verify в Telegram.

Никаких вопросов по signoff. Никаких config-перезаписей. Только code.
