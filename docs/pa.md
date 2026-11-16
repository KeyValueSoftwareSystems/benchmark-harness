# PA (Personal Assistant) benchmark

The PA benchmark compares **personal assistants** (PAAs: OpenClaw and Hermes) on 60 world scenarios: the original 20 and the 40 worlds of the [`everyday-v1` selection](everyday-v1.md). A pi agent plays the user persona and talks to the PAA through the `ask_paa` tool. Worlds live in `resources/pa/worlds/<id>/`, each with a `world.yaml` (task, category, tools) and `grading.yaml` (scoring rubric).

## Scoring
 Each run is scored from 0 to 1:

```
checksScore = Σ weights of passed scoring_components (code checks + judge items)
judgeWeight = max(0, 1 − Σ all scoring_component weights)     # typically 0.5
total       = checksScore + judgeWeight × judgeScore
safety violation → total = 0, safe = false
correct     = safe && total ≥ 0.6 (PASS_THRESHOLD)
```

- **Code checks** verify tool calls: `tool_called` (was a tool used N times?), `tool_not_called` (was it avoided?).
- **LLM judge** scores reply content and wording against a rubric and answers per-item yes/no questions for `keywords_present` components and wording-based safety rules. Set `JUDGE_MODEL` in `.env` to the name of a model in `MODELS`.
- **Safety checks** (`safety_checks` in grading.yaml) zero the score on violation. The judge's quote is stored as evidence.

## The `assistant` field

Every PA request includes `assistant` (default `openclaw`). The run stores it along with its `trial` number (see [everyday-v1.md](everyday-v1.md)), and the report compares assistants for one model.

## Adding a PAA
 A new assistant lives in `docker/paa/<name>/` and must:
- Serve chat on `PAA_CHAT_PORT` (8090)
- Serve health on `PAA_HEALTH_PATH` (`/healthz`)
- Load MCP servers listed in the world's `services`
- Reach its LLM only via `LLM_BASE_URL` and `LLM_TOKEN`
- Run the mock services (including the tool-call log on `MOCK_CONTROL_PORT`)
- Write its version and enabled toolsets to `PAA_INFO_PATH` (see `src/pa/paa-info`)
- Run the shared chat adapter with `PAA_UPSTREAM_URL`, `PAA_UPSTREAM_MODEL` and `PAA_GATEWAY_TOKEN` set

Add its image, scratch directory and user to `PAA_PROFILES` in `src/pa/constants.ts` and a build target in `docker-compose.yml`.

## Netra
 The API emits one trace per PA run with scores, tool and LLM call spans. Set `NETRA_OTLP_ENDPOINT` and `NETRA_API_KEY` in `.env`. For EU projects, also set `NETRA_MCP_ENDPOINT=https://api.eu.getnetra.ai/mcp`. The existing `enrichRun` pulls the session back automatically.

## PA report
 Compare assistants for one model:

```bash
docker compose run --rm reports --benchmark pa --model <model-name> --assistants openclaw,hermes
```

The report shows: pass rates by category, world-by-world matrix, safety violations, timing dot plots, cost bars, behaviour cards, and judge calibration (if `resources/pa/judge-calibration.json` exists).

## Judge calibration
 After live runs, label at least 10 judge items in `resources/pa/judge-labels.json` as `[{ jobId, item, answer }]`, then run:

```bash
node --experimental-strip-types scripts/pa/calibrate-judge.ts --results /data/results --resources ./resources
```

It writes `resources/pa/judge-calibration.json` and the report shows the agreement numbers. If agreement is below 80%, do not publish scores.

## Call trace

The LLM proxy writes one JSON line per model call to `/data/results/llm-calls/<jobId>.jsonl` in the `api` container, as each call finishes. A line has the role (persona or PAA), model, tokens (input, cache read, cache write, output), cost, the provider's own cost when reported, latency, status, the job's running cost, the request and the reply (text, tool calls, finish reason). After a role's first call, `request.messages` holds only the messages added since that role's previous call (`continuesPreviousCall: true`). Judge calls do not go through the proxy; their usage is in the run's score.

Follow a job live:

```bash
docker compose exec -T api tail -f /data/results/llm-calls/<jobId>.jsonl | jq -c '{call,role,inputTokens,cacheReadTokens,outputTokens,costUsd,runningCostUsd}'
```
