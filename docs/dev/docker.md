# Local dev in Docker

This document covers the **local dev contour** — running `pnpm gateway:dev`
and `pnpm live:routing:smoke` inside a Linux container so the dev loop
matches production (Linux / Debian / Ubuntu) and avoids Windows-specific
symptoms (file locks on dev logs, Win abort codes from child processes,
slower `tsc`).

The production image is the top-level `Dockerfile` + `docker-compose.yml`.
This guide is for the **dev** counterpart: `Dockerfile.dev` and
`docker-compose.dev.yml`.

## Prerequisites

- Docker Desktop (Windows / macOS) or Docker Engine (Linux).
- A populated `.env` in the repo root with at least one provider key
  (see `.env.example` — typically `HYDRA_API_KEY` or `OPENAI_API_KEY`).

## Start the gateway

```bash
cp .env.example .env          # one-time; edit to add provider keys
docker compose -f docker-compose.dev.yml up --build gateway
```

First boot takes 2–5 minutes: it builds the thin dev image, runs
`pnpm install --frozen-lockfile` inside the container (into a named
volume, not onto your host), and then starts `pnpm gateway:dev`.

Subsequent boots reuse the cached image and the `dev_node_modules`
volume, so they are seconds away from `[gateway] listening on
ws://127.0.0.1:19001`.

## Run the smoke tests

In a second terminal:

```bash
docker compose -f docker-compose.dev.yml run --rm smoke
```

The `smoke` service:

- waits for the gateway healthcheck (TCP on 19001);
- shares the gateway container's network namespace, so the existing
  `ws://127.0.0.1:19001` address in `scripts/live-routing-smoke.mjs`
  keeps working with no code changes;
- runs `pnpm live:routing:smoke` and exits with the driver's status.

## Editing code

The repo is bind-mounted at `/workspace`. Edit any file on the host
(Windows/macOS/Linux) and the running dev gateway will pick up TS
changes via `tsx` on the next request.

If you change `package.json` or `pnpm-lock.yaml`, restart the gateway
service so `pnpm install` runs again:

```bash
docker compose -f docker-compose.dev.yml restart gateway
```

If installs get into a bad state, blow away the deps volume:

```bash
docker compose -f docker-compose.dev.yml down -v
```

## Not in scope (yet)

- UI (Vite) dev server — add a `ui` service when we need browser UX.
- Remote dev (e.g. a shared Ubuntu host) — would reuse `Dockerfile.dev`
  with a different compose file.
- CI integration — GitHub Actions Ubuntu runners can run the exact same
  `docker-compose.dev.yml` for E2E parity.
