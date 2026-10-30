# AGENTS.md

Benchmark harness on pi agents (`@earendil-works/pi-coding-agent`): per-benchmark Docker images, an express API that queues jobs (Redis streams) and provisions an agent container, plus any benchmark services, per job. See `README.md` for architecture and usage.

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

- A pi session process hosts one session, so every job gets its own agent container, started by the API (`src/api/docker/agent.ts`). The agent learns its model by calling `/register {jobId}`; keys never go in container env.
- Each benchmark has a handler in `src/api/benchmarks/` that owns everything it provisions and must tear it down. Cyber challenges live in `resources/cyber/challenges/` and must stay self-contained (no `container_name`, published ports or external networks).
- The API shells out to the docker CLI through the mounted socket (never give agents the socket) and mounts `resources/` at its host path, because compose projects run against the host daemon.
- `session_start` only fires after `session.bindExtensions()` (done in `src/agent/server.ts`).
- A custom baseUrl/apiKey provider can't be set over RPC; it comes from a generated `models.json` (`writeModelsJson` in `src/agent/config.ts`).
