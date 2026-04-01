---
summary: "Browser-based control UI for the Gateway (chat, nodes, config)"
read_when:
  - You want to operate the Gateway from a browser
  - You want Tailnet access without SSH tunnels
title: "Control UI"
---

# Control UI (browser)

The Control UI is a small **Vite + Lit** single-page app served by the Gateway:

- default: `http://<host>:18789/`
- optional prefix: set `gateway.controlUi.basePath` (e.g. `/openclaw`)

It speaks **directly to the Gateway WebSocket** on the same port.

## Quick open (local)

If the Gateway is running on the same computer, open:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (or [http://localhost:18789/](http://localhost:18789/))

If the page fails to load, start the Gateway first: `openclaw gateway`.

Auth is supplied during the WebSocket handshake via:

- `connect.params.auth.token`
- `connect.params.auth.password`
  The dashboard settings panel keeps a token for the current browser tab session and selected gateway URL; passwords are not persisted.
  Onboarding generates a gateway token by default, so paste it here on first connect.

## Device pairing (first connection)

When you connect to the Control UI from a new browser or device, the Gateway
requires a **one-time pairing approval** — even if you're on the same Tailnet
with `gateway.auth.allowTailscale: true`. This is a security measure to prevent
unauthorized access.

**What you'll see:** "disconnected (1008): pairing required"

**To approve the device:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

If the browser retries pairing with changed auth details (role/scopes/public
key), the previous pending request is superseded and a new `requestId` is
created. Re-run `openclaw devices list` before approval.

Once approved, the device is remembered and won't require re-approval unless
you revoke it with `openclaw devices revoke --device <id> --role <role>`. See
[Devices CLI](/cli/devices) for token rotation and revocation.

**Notes:**

- Local connections (`127.0.0.1`) are auto-approved.
- Remote connections (LAN, Tailnet, etc.) require explicit approval.
- Each browser profile generates a unique device ID, so switching browsers or
  clearing browser data will require re-pairing.

## Language support

The Control UI can localize itself on first load based on your browser locale, and you can override it later from the language picker in the Access card.

- Supported locales: `en`, `zh-CN`, `zh-TW`, `pt-BR`, `de`, `es`
- Non-English translations are lazy-loaded in the browser.
- The selected locale is saved in browser storage and reused on future visits.
- Missing translation keys fall back to English.

## What it can do (today)

- Chat with the model via Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Stream tool calls + live tool output cards in Chat (agent events)
- Channels: WhatsApp/Telegram/Discord/Slack + plugin channels (Mattermost, etc.) status + QR login + per-channel config (`channels.status`, `web.login.*`, `config.patch`)
- Instances: presence list + refresh (`system-presence`)
- Sessions: list + per-session thinking/fast/verbose/reasoning overrides (`sessions.list`, `sessions.patch`)
- Sessions runtime inspector: inspect recovery checkpoints, linked actions/closures, and operator recovery controls for the current session or a global runtime scope (`platform.runtime.checkpoints.*`, `platform.runtime.actions.*`, `platform.runtime.closures.*`)
- Cron jobs: list/add/edit/run/enable/disable + run history (`cron.*`)
- Skills: status, enable/disable, install, API key updates (`skills.*`)
- Nodes: list + caps (`node.list`)
- Exec approvals: edit gateway or node allowlists + ask policy for `exec host=gateway/node` (`exec.approvals.*`)
- Config: view/edit `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- Config: apply + restart with validation (`config.apply`) and wake the last active session
- Config writes include a base-hash guard to prevent clobbering concurrent edits
- Config schema + form rendering (`config.schema`, including plugin + channel schemas); Raw JSON editor remains available
- Debug: status/health/models snapshots + event log + manual RPC calls (`status`, `health`, `models.list`)
- Logs: live tail of gateway file logs with filter/export (`logs.tail`)
- Update: run a package/git update + restart (`update.run`) with a restart report

Logs panel notes:

- Overview attention can now route gateway-level errors into the Logs surface, so operators can jump from a generic failure signal into the canonical investigation view instead of manually switching tabs.
- The Logs filter can now persist through a shareable `logQ` query, so refresh/popstate no longer drops the current text-based log search context.

Usage panel notes:

- The Usage surface now restores a minimal investigation context from URL state: `usageFrom`, `usageTo`, `usageTz`, `usageSession`, and `usageQ` can survive refresh/popstate without serializing every local analytics toggle.
- When a single `usageSession` is present in the link, the usage summary reload path reopens the same time-series and session-log detail flow after refresh, so operators can share one session investigation path instead of reselecting it manually.

Channels panel notes:

- Overview attention can now route channel-specific failures into the Channels surface with a persisted `channel` query, so operators can refresh or share the link without losing which channel needs attention.
- The Channels grid restores and highlights the selected channel card from URL state, keeping the same drill-down context across refresh/popstate.

Instances panel notes:

- The Instances surface now persists its privacy toggle too: `instancesReveal` survives refresh/popstate, so operators can reopen the same masked-vs-revealed host/IP mode without relying on module-local UI state.
- The shareable instances link intentionally restores only that visibility intent; presence rows, counters, and other transient beacon payloads still reload normally instead of being serialized into the URL.

Settings panel notes:

- The settings-family surfaces (`config`, `communications`, `appearance`, `automation`, `infrastructure`, `aiAgents`) now persist their navigation context too: each tab restores its own `*Mode`, `*Q`, `*Section`, and `*Subsection` query state after refresh/popstate instead of reopening a generic top-level config view.
- The shareable settings links intentionally restore only that navigation context; raw JSON payloads, dirty editor state, validation issues, and other transient form details are still reloaded from the gateway rather than serialized into the URL.

Debug panel notes:

- The Debug surface now persists the manual RPC draft too: `debugMethod` and `debugParams` survive refresh/popstate, so operators can reopen the same prepared gateway call without retyping the method name or JSON payload.
- The shareable debug link intentionally restores only the manual RPC intent; snapshot payloads and prior call results/errors are reloaded or cleared normally instead of being serialized into the URL.

Bootstrap and artifacts panel notes:

- The Bootstrap surface now persists a minimal list-level query too: `bootstrapQ` survives refresh/popstate alongside `bootstrapRequest`, so operators can share the same filtered install queue instead of retyping the request search.
- The Artifacts surface now does the same with `artifactQ` alongside `artifact`, keeping the same filtered artifact list and selected record after refresh or when a link is opened elsewhere.

Cron jobs panel notes:

- For isolated jobs, delivery defaults to announce summary. You can switch to none if you want internal-only runs.
- Channel/target fields appear when announce is selected.
- Webhook mode uses `delivery.mode = "webhook"` with `delivery.to` set to a valid HTTP(S) webhook URL.
- For main-session jobs, webhook and none delivery modes are available.
- Advanced edit controls include delete-after-run, clear agent override, cron exact/stagger options,
  agent model/thinking overrides, and best-effort delivery toggles.
- Form validation is inline with field-level errors; invalid values disable the save button until fixed.
- Set `cron.webhookToken` to send a dedicated bearer token, if omitted the webhook is sent without an auth header.
- Deprecated fallback: stored legacy jobs with `notify: true` can still use `cron.webhook` until migrated.
- Overview attention now routes failed and overdue cron jobs back into the Cron surface with the relevant job preselected instead of leaving the operator to search manually.
- The Cron surface now persists its list-level investigation state too: `cronQ`, `cronEnabled`, `cronSchedule`, `cronStatus`, `cronSort`, and `cronDir` survive refresh/popstate alongside the existing `cronJob` drill-down.
- Cron run history (runs explorer) also persists a minimal shareable contract: `cronRunsScope`, `cronRunsQ`, `cronRunsSort`, `cronRunsStatus`, and `cronRunsDelivery` (comma-separated multi-selects where applicable) alongside `cronJob` when the scope is job-scoped. Invalid or stale `cronJob` values with `cronRunsScope=job` fall back to `all` after refresh without dropping the jobs list filters.
- Cron run history can jump into the linked session context directly: operators can still open the run chat, and can also open the Sessions runtime inspector when a `sessionKey` is available.

Skills panel notes:

- Overview attention now routes skill dependency and allowlist problems into the Skills surface with a persisted `skillFilter`, so operators can refresh or share the link without losing the same blocked/missing context.
- The Skills search box now matches derived state as well as metadata, so filters such as `missing` and `blocked by allowlist` surface the same problem set that overview attention points at.

Agents panel notes:

- The Agents surface now restores the selected `agent`, active `agentsPanel`, and `agentFile` drill-down from URL state, so refresh/popstate can return operators to the same per-agent context instead of reopening a generic shell.
- When the Skills panel is active inside Agents, the existing `skillFilter` query is reused there too, keeping the per-agent skills investigation flow shareable without inventing a second filter contract.

Nodes / exec approvals panel notes:

- Overview attention can now route pending exec approvals into the Nodes surface with persisted `execTarget`, `execNode`, and `execAgent` query state, so operators can refresh or share the link without losing the same approvals scope.
- The Nodes exec approvals panel restores the selected gateway-vs-node target and agent scope from URL state, keeping approvals review aligned with the same operator drill-down flow used by cron, skills, and channels.

Sessions list notes:

- The Sessions surface now persists its list-level investigation state as well as runtime scope: filters, search, sort, and pagination can survive refresh/popstate together with `runtimeSession` / `runtimeRun` / `checkpoint`.
- The Sessions runtime inspector now persists its selected detail drill-down too: `runtimeAction` and `runtimeClosure` can survive refresh/popstate alongside the existing runtime scope, so operators can reopen the same action/closure detail instead of only the parent checkpoint.
- If a shared sessions link points at a page that no longer exists after the latest list reload, the UI clamps only the pagination state instead of dropping the rest of the sessions investigation context.

Runtime / recovery notes:

- The Sessions tab now doubles as the operator runtime inspector: blocked checkpoints, related actions, and closure outcomes all come from the canonical runtime ledgers rather than a separate UI cache.
- Shareable runtime-inspector links still restore only routing intent; action receipts, closure payloads, loading state, and recovery errors are reloaded from the gateway rather than serialized into the URL.
- High-risk recovery actions such as deny or manual continuation dispatch require an explicit confirmation in the UI before the RPC is sent.
- When a recovery decision is sent through the Control UI, the inspector shows the latest operator decision context (`what`, `who`, `when`) so operators can verify who approved, denied, dispatched, or retried the flow.
- Session rows also surface the current handoff truth used for runtime inspection: `handoffTruthSource` tells the operator whether the active target follows durable closure history or an in-flight recovery branch.
- When handoff truth is `recovery`, the runtime inspect action follows `handoffRunId` / `handoffRequestRunId` instead of stale closure history, so operators land on the current recovery target rather than an older completed run.
- Overview recovery attention now reuses that same handoff-aware runtime target, including `runtimeRun` in deep links when available, so overview and sessions open the same recovery branch instead of diverging by session-only scope.

## Chat behavior

- `chat.send` is **non-blocking**: it acks immediately with `{ runId, status: "started" }` and the response streams via `chat` events.
- Re-sending with the same `idempotencyKey` returns `{ status: "in_flight" }` while running, and `{ status: "ok" }` after completion.
- `chat.history` responses are size-bounded for UI safety. When transcript entries are too large, Gateway may truncate long text fields, omit heavy metadata blocks, and replace oversized messages with a placeholder (`[chat.history omitted: message too large]`).
- `chat.inject` appends an assistant note to the session transcript and broadcasts a `chat` event for UI-only updates (no agent run, no channel delivery).
- Stop:
  - Click **Stop** (calls `chat.abort`)
  - Type `/stop` (or standalone abort phrases like `stop`, `stop action`, `stop run`, `stop openclaw`, `please stop`) to abort out-of-band
  - `chat.abort` supports `{ sessionKey }` (no `runId`) to abort all active runs for that session
- Abort partial retention:
  - When a run is aborted, partial assistant text can still be shown in the UI
  - Gateway persists aborted partial assistant text into transcript history when buffered output exists
  - Persisted entries include abort metadata so transcript consumers can tell abort partials from normal completion output

## Tailnet access (recommended)

### Integrated Tailscale Serve (preferred)

Keep the Gateway on loopback and let Tailscale Serve proxy it with HTTPS:

```bash
openclaw gateway --tailscale serve
```

Open:

- `https://<magicdns>/` (or your configured `gateway.controlUi.basePath`)

By default, Control UI/WebSocket Serve requests can authenticate via Tailscale identity headers
(`tailscale-user-login`) when `gateway.auth.allowTailscale` is `true`. OpenClaw
verifies the identity by resolving the `x-forwarded-for` address with
`tailscale whois` and matching it to the header, and only accepts these when the
request hits loopback with Tailscale’s `x-forwarded-*` headers. Set
`gateway.auth.allowTailscale: false` (or force `gateway.auth.mode: "password"`)
if you want to require a token/password even for Serve traffic.
Tokenless Serve auth assumes the gateway host is trusted. If untrusted local
code may run on that host, require token/password auth.

### Bind to tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Then open:

- `http://<tailscale-ip>:18789/` (or your configured `gateway.controlUi.basePath`)

Paste the token into the UI settings (sent as `connect.params.auth.token`).

## Insecure HTTP

If you open the dashboard over plain HTTP (`http://<lan-ip>` or `http://<tailscale-ip>`),
the browser runs in a **non-secure context** and blocks WebCrypto. By default,
OpenClaw **blocks** Control UI connections without device identity.

**Recommended fix:** use HTTPS (Tailscale Serve) or open the UI locally:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (on the gateway host)

**Insecure-auth toggle behavior:**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

`allowInsecureAuth` is a local compatibility toggle only:

- It allows localhost Control UI sessions to proceed without device identity in
  non-secure HTTP contexts.
- It does not bypass pairing checks.
- It does not relax remote (non-localhost) device identity requirements.

**Break-glass only:**

```json5
{
  gateway: {
    controlUi: { dangerouslyDisableDeviceAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

`dangerouslyDisableDeviceAuth` disables Control UI device identity checks and is a
severe security downgrade. Revert quickly after emergency use.

See [Tailscale](/gateway/tailscale) for HTTPS setup guidance.

## Building the UI

The Gateway serves static files from `dist/control-ui`. Build them with:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

Optional absolute base (when you want fixed asset URLs):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

For local development (separate dev server):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

Then point the UI at your Gateway WS URL (e.g. `ws://127.0.0.1:18789`).

## Debugging/testing: dev server + remote Gateway

The Control UI is static files; the WebSocket target is configurable and can be
different from the HTTP origin. This is handy when you want the Vite dev server
locally but the Gateway runs elsewhere.

1. Start the UI dev server: `pnpm ui:dev`
2. Open a URL like:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

Optional one-time auth (if needed):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789#token=<gateway-token>
```

Notes:

- `gatewayUrl` is stored in localStorage after load and removed from the URL.
- `token` should be passed via the URL fragment (`#token=...`) whenever possible. Fragments are not sent to the server, which avoids request-log and Referer leakage. Legacy `?token=` query params are still imported once for compatibility, but only as a fallback, and are stripped immediately after bootstrap.
- `password` is kept in memory only.
- When `gatewayUrl` is set, the UI does not fall back to config or environment credentials.
  Provide `token` (or `password`) explicitly. Missing explicit credentials is an error.
- Use `wss://` when the Gateway is behind TLS (Tailscale Serve, HTTPS proxy, etc.).
- `gatewayUrl` is only accepted in a top-level window (not embedded) to prevent clickjacking.
- Non-loopback Control UI deployments must set `gateway.controlUi.allowedOrigins`
  explicitly (full origins). This includes remote dev setups.
- Do not use `gateway.controlUi.allowedOrigins: ["*"]` except for tightly controlled
  local testing. It means allow any browser origin, not “match whatever host I am
  using.”
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` enables
  Host-header origin fallback mode, but it is a dangerous security mode.

Example:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Remote access setup details: [Remote access](/gateway/remote).
