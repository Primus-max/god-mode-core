Scoring gpt-5-mini...
  intent 100% | both 100% | p95 3438ms
Scoring claude-haiku-4.5...
  intent 0% | both 0% | p95 0ms | ❌ Unknown model: hydra/claude-haiku-4-5
Scoring gemini-2.5-flash...
  intent 0% | both 0% | p95 0ms | ❌ Unknown model: hydra/gemini-2.5-flash
Scoring grok-3-mini...
  intent 0% | both 0% | p95 0ms | ❌ Unknown model: hydra/grok-3-mini

# Classifier-Model Bench — V1-CONTRACT-ONLY Hour 0-1

Date: 2026-05-09T06:08:08.313Z
Fixtures: 10

## Summary table

| Model | Intent acc | Intent+Tools acc | p50 ms | p95 ms | Parse fails | Notes |
|---|---|---|---|---|---|---|
| gpt-5-mini | 100% | 100% | 1944 | 3438 | 0 |  |
| claude-haiku-4.5 | 0% | 0% | 0 | 0 | 0 | ❌ Unknown model: hydra/claude-haiku-4-5 |
| gemini-2.5-flash | 0% | 0% | 0 | 0 | 0 | ❌ Unknown model: hydra/gemini-2.5-flash |
| grok-3-mini | 0% | 0% | 0 | 0 | 0 | ❌ Unknown model: hydra/grok-3-mini |

## Verdict

✅ Winner: **gpt-5-mini** — intent 100%, intent+tools 100%, p95 3438ms.

## Per-fixture breakdown

### gpt-5-mini

| Fixture | Intent | Tools | Seq | Latency | Failure | Raw (first 80c) |
|---|---|---|---|---|---|---|
| F1-greeting | ✓ | ✓ | ✓ | 4951ms | - | `{"intent":"conversation","tool_names":[]}` |
| F2-write-file-russian | ✓ | ✓ | ✓ | 2777ms | - | `{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}` |
| F3-image-generate | ✓ | ✓ | ✓ | 1839ms | - | `{"intent":"tool_calls","tool_names":["image_generate"],"sequencing":"sequential"` |
| F4-multi-action-sequential | ✓ | ✓ | ✓ | 3438ms | - | `{"intent":"tool_calls","tool_names":["write","sessions_send"],"sequencing":"sequ` |
| F5-web-search | ✓ | ✓ | ✓ | 1625ms | - | `{"intent":"tool_calls","tool_names":["web_search"],"sequencing":"sequential"}` |
| F6-self-introspection | ✓ | ✓ | ✓ | 1421ms | - | `{"intent":"conversation","tool_names":[]}` |
| F7-persistent-worker | ✓ | ✓ | ✓ | 2370ms | - | `{"intent":"tool_calls","tool_names":["persistent_worker_push"],"sequencing":"seq` |
| F8-ambiguous-save | ✓ | ✓ | ✓ | 2283ms | - | `{"intent":"refuse","tool_names":[]}` |
| F9-english-mixed | ✓ | ✓ | ✓ | 1876ms | - | `{"intent":"tool_calls","tool_names":["write"],"sequencing":"sequential"}` |
| F10-conversation-question | ✓ | ✓ | ✓ | 1944ms | - | `{"intent":"conversation","tool_names":[]}` |

