---
summary: "OpenAI-compatible API from ai.sd1.su (HydraAI endpoints)"
read_when:
  - You use SD1 / HydraAI keys and need the correct base URL for OpenClaw
title: "SD1 / HydraAI (OpenAI-compatible)"
---

# SD1 / HydraAI (OpenAI-compatible)

The public integration docs on [ai.sd1.su](https://ai.sd1.su/pages/integration-lang-curl.php) use the **HydraAI OpenAI-compatible API**:

- **Base URL (primary):** `https://api.hydraai.ru/v1`
- **Base URL (Russia fallback):** `https://api-ru.hydraai.ru/v1`
- **Auth:** `Authorization: Bearer <API_KEY>`
- **Chat:** `POST /v1/chat/completions`
- **Models list:** `GET /v1/models`

Full endpoint reference: [HydraAI API docs](https://docs.hydraai.ru/main_documentation/api_endpoints/).

## OpenClaw config

Use `api: "openai-completions"` under `models.providers` (same pattern as other OpenAI-compatible proxies). Store the key in an env var, not in git.

```json5
{
  env: { HYDRA_API_KEY: "YOUR_KEY_HERE" },
  agents: {
    defaults: {
      model: {
        primary: "hydra/gpt-4o",
        fallbacks: ["hydra/gpt-4o-mini"],
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      hydra: {
        baseUrl: "https://api.hydraai.ru/v1",
        apiKey: "${HYDRA_API_KEY}",
        api: "openai-completions",
        models: [
          { id: "gpt-4o", name: "GPT-4o (Hydra)" },
          { id: "gpt-4o-mini", name: "GPT-4o mini (Hydra)" },
        ],
      },
    },
  },
}
```

Adjust `models` entries to match what `GET https://api.hydraai.ru/v1/models` returns for your key.

To prefer the Russia endpoint, set `baseUrl` to `https://api-ru.hydraai.ru/v1` instead.

## Related

- [Model providers](/concepts/model-providers)
- [Configuration reference](/gateway/configuration-reference)
