# benchmark-harness

Pi agent running in RPC mode (JSONL over stdin/stdout), loading extensions from `src/extensions` (copied to `./extensions` in the container). Dev is done through Docker Compose; one Dockerfile per benchmark lives in `docker/`.

```sh
docker compose build minimal
echo '{"id":"1","type":"get_state"}' | docker compose run --rm -T minimal
```

Provider credentials go in a gitignored `.env`.

## Running benchmarks

1. Copy `.env.example` to `.env` and list your model configs in `MODELS`.
2. `npm run up -- minimal` starts the API plus one replica of `minimal` per model; each replica registers with the API and receives its model.
3. `curl -XPOST localhost:3000/benchmarks/minimal/run -H "content-type: application/json" -d '{"prompt":"...","models":["name"]}'` (omit `models` for all) dispatches to the replicas one after the other.
4. `GET /benchmarks` lists replicas; `GET /benchmarks/minimal/status` shows their state.

## Observability

The `observability` extension sends Netra traces (agent run > turn > generation/tool spans). Set `NETRA_OTLP_ENDPOINT` and `NETRA_API_KEY` in `.env` (shared by all agents); each benchmark Dockerfile sets `ENV NETRA_APP_NAME=<benchmark>` as the agent name. Tracing is skipped when the endpoint is unset; `NETRA_DEBUG=true` enables SDK debug logs.
