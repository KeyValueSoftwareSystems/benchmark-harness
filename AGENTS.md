# AGENTS.md

Benchmark harness on pi agents (`@earendil-works/pi-coding-agent`): per-benchmark Docker images, one replica per model config, an express API that registers replicas and dispatches prompts. See `README.md` for architecture and usage.

## Rules

- **Development is always through Docker Compose.** Build and run with `docker compose` / `npm run up`; don't run the agent or API directly on the host. Images contain the code (no bind mounts), so rebuild after changes.
- **Dockerfiles live in `docker/`, one per benchmark** (`Dockerfile.<benchmark>`, plus `Dockerfile.api`). Each benchmark Dockerfile copies only `observability` and its own extension into `./extensions`, and sets `ENV NETRA_APP_NAME=<benchmark>`.
- **Extension source lives in `src/extensions/<name>/`** (each with an `index.ts`); in the container they sit at `/app/extensions/<name>`. `src/agent/config.ts` loads each subdirectory as its own extension.
- Agent processes keep **stdout clean** for protocol output; log to stderr (`console.error`).
- **Never log or return model API keys.** Use `redact()` from `src/shared/types.ts`. Only the `api` service receives `MODELS`.
- Never commit `.env` (gitignored). Don't overwrite an existing `.env`; it may hold real keys.

## Conventions

- TypeScript ESM, run with `node --experimental-strip-types` (no build step); imports use `.ts` extensions. Tabs for indentation.
- Typecheck with `npx tsc` (`npm run typecheck`).
- Observability spans are created manually from pi events (`src/extensions/observability/index.ts`). Netra's `instruments: new Set()` does NOT disable auto-instrumentation (empty set falls back to all defaults).
- pi docs are installed locally at `node_modules/@earendil-works/pi-coding-agent/docs/` (`sdk.md`, `rpc-commands.md`, `extensions.md`, `models-configuration.md`); prefer them over web docs for the installed version.

## Gotchas

- A pi RPC/session process hosts one session; concurrency comes from compose replicas, which can't see their own index, hence the register handshake with the API.
- `session_start` only fires after `session.bindExtensions()` (done in `src/agent/server.ts`).
- A custom baseUrl/apiKey provider can't be set over RPC; it comes from a generated `models.json` (`writeModelsJson` in `src/agent/config.ts`).
