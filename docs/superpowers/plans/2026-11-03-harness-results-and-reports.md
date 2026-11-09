# Harness results, Netra enrichment and report service: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every settled benchmark job is stored as JSON and in SQLite, enriched with Netra MCP insights, and a separate report service turns chosen models' JSON into one HTML report.

**Architecture:** A benchmark-agnostic `results` pi extension (loaded by every benchmark image) collects each run's outcome and usage and POSTs it to an internal API route. When the job settles, the API finalizer writes a per-model JSON file and a `runs` row in SQLite. A background enricher later pulls the Netra session's data through the Netra MCP and saves it as `netra_metadata`. A separate `reports` CLI service reads the chosen models' JSON and writes an HTML artifact plus a JSON sidecar.

**Tech Stack:** Node 24 (`node:sqlite`, `node:test`, `--experimental-strip-types`), TypeScript ESM with tabs, express 5, ioredis, `@modelcontextprotocol/sdk`, Docker Compose.

**Spec:** `/home/dev/AI_ML/AI Scout/Quartermaster/docs/superpowers/specs/2026-11-03-quartermaster-design.md`. The companion plan for the Slack bot is `Quartermaster/docs/superpowers/plans/2026-11-03-quartermaster-bot.md`; it reads the SQLite schema and the report sidecar defined here.

## Global Constraints

- Branch `feat/run-export-and-reports`, cut from `origin/main`; git author `devkishan@keyvalue.systems`.
- Development is only through Docker Compose; images contain the code (no bind mounts), rebuild after changes (AGENTS.md).
- TypeScript ESM, imports use `.ts` extensions, tabs for indentation, typecheck with `npm run typecheck`.
- Agent processes keep stdout clean; log to stderr with `console.error`.
- Never log or return model API keys or the Netra key; use `redact()` from `src/shared/types.ts`.
- No admin route and no auth layer on the API. The only new route is agent-facing `POST /jobs/:id/result`, on the internal `bench` network like `/register`.
- Result flow must not mention cyber: any extension that emits `benchmark_result` is covered, and benchmarks that emit nothing still get a row (`outcome: null`).
- SQLite uses `journal_mode=DELETE` (not WAL) so a read-only mount of the file works; file path from `DB_PATH` (default `/data/harness.db`).
- Netra MCP: `https://api.getnetra.ai/mcp` (EU: `https://api.eu.getnetra.ai/mcp`), header `x-api-key: $NETRA_API_KEY`; endpoint overridable by `NETRA_MCP_ENDPOINT`.
- Enrichment failure must never block or lose a result.
- Do not run real benchmarks against live models without confirmation (CLAUDE.md); use the mock OpenAI endpoint in `scripts/mock-openai.py`.

## Review Focus

- A job that errors or times out before reporting: a row is still written with `status` set and `outcome: null`, counted as unsolved.
- Result arrives after the container is stopped, or twice: the first one wins, no duplicate rows.
- Two jobs for the same model finish at once: the per-model JSON file is not corrupted (serialize writes per file, write via temp file and rename).
- Netra trace not visible yet, or MCP unreachable: bounded retries, `netra_metadata` stays null, run row unaffected.
- Model names with `/`, spaces or `..`: file paths use a sanitized slug, never the raw name.
- Report requested for a model with no runs: the CLI exits non-zero naming the model; zero challenges never divides by zero.

---

## Shared contracts (used by the tasks below and by the bot plan)

`runs` table (SQLite, created by `openDb()`): `job_id TEXT PRIMARY KEY, benchmark TEXT, model TEXT, model_id TEXT, challenge TEXT, status TEXT, correct INTEGER NULL, outcome TEXT NULL (JSON), metrics TEXT (JSON), session_id TEXT NULL, trace_ids TEXT NULL (JSON array), netra_metadata TEXT NULL (JSON), conditions TEXT (JSON), created_at TEXT, finished_at TEXT`.

`RunMetrics`: `{ turns: number; durationMs: number; inputTokens: number; outputTokens: number; costUsd: number }`.

`ResultPayload` (agent to API): `{ outcome: Record<string, unknown> | null; metrics: RunMetrics; sessionId?: string }`.

Per-model JSON `results/<benchmark>/<slug(model)>.json`: `{ benchmark, model, modelId, runs: RunRecord[] }`, `RunRecord` = row fields camel-cased with `outcome`, `metrics`, `netraMetadata`, `conditions` parsed.

Report sidecar `reports/<id>.json`: `{ id, benchmark, generatedAt, challengeCount, conditions, models: [{ model, solved, total, successRate, medianSolveMs, avgCostUsd }], narrative }`; HTML at `reports/<id>.html`.

---

### Task 1: SQLite store and per-model JSON writer

**Files:**
- Create: `src/api/db/runs.ts`, `src/api/db/modelFiles.ts`, `src/shared/results.ts`
- Test: `test/runs.test.ts`, `test/modelFiles.test.ts`
- Modify: `package.json` (add `"test": "node --experimental-strip-types --test test/*.test.ts"`), `tsconfig.json` (`"include": ["src", "test"]`)

**Interfaces:**
- Produces (`src/shared/results.ts`): `RunMetrics`, `ResultPayload`, `RunRecord`, `slug(name: string): string` (lowercase, `[^a-z0-9._-]` to `-`, no leading dots).
- Produces (`src/api/db/runs.ts`): `openDb(path: string): DatabaseSync`; `insertRun(db, run: RunRecord): boolean` (false if `job_id` exists); `updateNetraMetadata(db, jobId: string, metadata: unknown, traceIds: string[]): void`; `listRuns(db, filter: { benchmark?: string; model?: string }): RunRecord[]`.
- Produces (`src/api/db/modelFiles.ts`): `appendRun(dir: string, run: RunRecord): Promise<void>`; `updateRunInFile(dir, run: RunRecord): Promise<void>`; `readModelFile(dir, benchmark, model): Promise<ModelFile | undefined>`.

- [ ] **Step 1: Write failing tests.** `runs.test.ts`: `insertRun` twice with the same `jobId` returns `true` then `false`; `listRuns` filters by benchmark and model; `openDb` sets `PRAGMA journal_mode` to `delete`. `modelFiles.test.ts`: two concurrent `appendRun` calls for the same model yield a file with both runs; model name `../evil/x y` writes inside `dir` under a sanitized name.
- [ ] **Step 2: Run** `npm test`; expect failures (modules missing).
- [ ] **Step 3: Implement** the modules with the signatures above. Use `node:sqlite` `DatabaseSync`; serialize file writes per path with a promise-chain map; write to `<file>.tmp` then `rename`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat: add runs sqlite store and per-model json files`.

### Task 2: Agent-side `results` extension

**Files:**
- Create: `src/extensions/results/index.ts`
- Modify: `src/extensions/observability/index.ts` (emit `pi.events.emit("observability_session", { sessionId })` at `agent_start`), `docker/Dockerfile.cyber`, `docker/Dockerfile.minimal` (add `COPY src/extensions/results ./extensions/results`)
- Test: `test/results-extension.test.ts`

**Interfaces:**
- Consumes: `ResultPayload`, `RunMetrics` (Task 1). pi events `benchmark_result`, `observability_session`, `turn_start`, `message_end` (assistant `usage.input`, `usage.output`, `usage.cost.total`), `agent_start`, `agent_end`.
- Produces: `buildPayload(state): ResultPayload` exported from the extension file (pure), and a default export `(pi: ExtensionAPI) => void` that POSTs the payload to `${API_URL}/jobs/${JOB_ID}/result` once, on `agent_end`, retrying up to 5 times with backoff, logging to stderr only.

- [ ] **Step 1: Write failing tests** for `buildPayload`: sums input/output tokens and cost across messages, counts turns, `durationMs` from start/end timestamps, `outcome` is the last `benchmark_result` event or `null` if none, `sessionId` passed through.
- [ ] **Step 2: Run** `npm test`; expect FAIL.
- [ ] **Step 3: Implement** the extension. It records state from events, never throws (wrap handlers like `safe` in the observability extension), and posts exactly once.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat: report benchmark results from a shared extension`.

### Task 3: Result route and finalizer

**Files:**
- Create: `src/api/routes/results.ts`, `src/api/finalize.ts`
- Modify: `src/api/queue/store.ts` (add `saveResult(redis, id, payload): Promise<boolean>` via `HSETNX job:<id> result`, and `getResult(redis, id): Promise<ResultPayload | undefined>`), `src/api/runner.ts` (call `finalizeRun` after `setStatus`), `src/api/index.ts` (mount the router, open the DB), `src/api/config.ts` (`DB_PATH`, `RESULTS_DIR`, `MAX_TURNS`/`JOB_TIMEOUT_MS` as conditions)
- Test: `test/finalize.test.ts`, `test/results-route.test.ts`

**Interfaces:**
- Consumes: Task 1 store and writers; `Job` from `src/shared/types.ts`; `AgentOutcome` from `src/api/benchmarks/types.ts`.
- Produces: `finalizeRun(deps: { db; resultsDir: string; getResult: (id: string) => Promise<ResultPayload | undefined> }, job: Job, outcome: AgentOutcome, opts?: { waitMs?: number }): Promise<RunRecord>`. It waits up to `waitMs` (default 5000) for a result, then inserts the row (`status` from outcome, `correct` from `outcome.correct === true` else null) and appends to the model file. `createResultsRouter(deps: { saveResult(id, payload): Promise<boolean>; jobExists(id): Promise<boolean> }): Router`; 202 on first save, 409 on repeat, 404 unknown job, 400 bad payload.

- [ ] **Step 1: Write failing tests.** Finalizer: with a result present, row has `correct = 1` when `outcome.correct === true`; with none after `waitMs`, row has `outcome = null`, `status = "error"` for an errored job; a second `finalizeRun` for the same job writes no duplicate (row count stays 1, file runs length stays 1). Route: first POST returns 202, repeat returns 409, unknown job 404, missing `metrics` 400.
- [ ] **Step 2: Run** `npm test`; expect FAIL.
- [ ] **Step 3: Implement.** Store `conditions` as `{ maxTurns, jobTimeoutMs }` from env. `runner.ts` calls `finalizeRun` in a `try/catch` that logs and never changes the job status.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat: persist settled job results to json and sqlite`.

### Task 4: Netra MCP client and enricher

**Files:**
- Create: `src/api/netra/mcp.ts`, `src/api/netra/enrich.ts`
- Modify: `package.json` (add `@modelcontextprotocol/sdk`), `src/api/runner.ts` (schedule `enrichRun` after `finalizeRun`, not awaited), `src/api/config.ts` (`NETRA_MCP_ENDPOINT`, `NETRA_API_KEY`)
- Test: `test/enrich.test.ts`

**Interfaces:**
- Consumes: `updateNetraMetadata`, `updateRunInFile` (Task 1); `RunRecord.sessionId`.
- Produces: `interface NetraClient { sessionDetails(sessionId: string): Promise<{ traceIds: string[]; data: unknown } | undefined> }`; `createNetraClient(endpoint: string, apiKey: string): NetraClient` (MCP streamable-HTTP transport, header `x-api-key`, calls tool `netra_get_session_details` with `{ session_id }`); `enrichRun(deps: { db; resultsDir; client: NetraClient; sleep?: (ms: number) => Promise<void> }, run: RunRecord, opts?: { attempts?: number; delayMs?: number }): Promise<boolean>`.

- [ ] **Step 1: Write failing tests** with a fake `NetraClient`: returns `undefined` twice then data, so `enrichRun` retries and stores `netra_metadata` and `trace_ids` in both SQLite and the model file; a client that always throws leaves `netra_metadata` null and returns `false` without throwing; a run without `sessionId` returns `false` immediately.
- [ ] **Step 2: Run** `npm test`; expect FAIL.
- [ ] **Step 3: Implement.** Defaults `attempts = 10`, `delayMs = 15000`. If `NETRA_API_KEY` is unset, skip enrichment with one stderr log line.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat: enrich runs with Netra MCP session data`.

### Task 5: Report metrics and HTML renderer

**Files:**
- Create: `src/reports/metrics.ts`, `src/reports/render.ts`
- Test: `test/metrics.test.ts`, `test/render.test.ts`

**Interfaces:**
- Consumes: `ModelFile`, `RunRecord` (Task 1).
- Produces: `computeMetrics(file: ModelFile): ModelMetrics` where `ModelMetrics = { model: string; solved: number; total: number; successRate: number; medianSolveMs: number | null; avgCostUsd: number | null }` (solved = runs with `correct === true`; `total` = all runs; median over solved runs only; zero runs gives rate 0). `renderReport(input: { title: string; benchmark: string; challengeCount: number; conditions: string; models: ModelMetrics[]; narrative?: string }): string` returns one self-contained HTML document (inline CSS, no external assets): title card with subtitle line, one bar per model sorted by rate descending (best bar green, others slate, label `solved/total · rate%`), footnote "Primary metric: successful challenges ÷ total valid challenges × 100.", a metrics table with rows Challenges solved, Success rate, Median solve time, Average cost per task, Repeat-run reliability ("To measure" for every model), and the narrative section if provided. All text HTML-escaped.

- [ ] **Step 1: Write failing tests.** Metrics: 3 runs (2 correct, durations 3 min and 5 min, one failed) gives `solved 2, total 3, successRate 66.7`, median 4 min; empty file gives rate 0 and null median. Render: output contains `32/40 · 80%` for that input, the footnote text, `To measure`, and escapes `<script>` in a model name and in the narrative.
- [ ] **Step 2: Run** `npm test`; expect FAIL.
- [ ] **Step 3: Implement** both pure functions.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** `feat: compute report metrics and render the html report`.

### Task 6: Report service CLI and compose wiring

**Files:**
- Create: `src/reports/index.ts`, `src/reports/narrative.ts`, `docker/Dockerfile.reports`
- Modify: `docker-compose.yml` (named volumes `harness-data` mounted at `/data` on `api` and `reports`; service `reports` under profile `tools`), `package.json` (script `"report"`), `README.md` and `.env.example`-style docs for new env vars (`DB_PATH`, `RESULTS_DIR`, `REPORTS_DIR`, `NETRA_MCP_ENDPOINT`)
- Test: `test/report-cli.test.ts`

**Interfaces:**
- Consumes: `readModelFile` (Task 1), `computeMetrics`, `renderReport` (Task 5), `MODELS` config.
- Produces: `generateReport(args: { benchmark: string; models: string[]; resultsDir: string; reportsDir: string; narrate?: (metrics: ModelMetrics[]) => Promise<string | undefined> }): Promise<{ id: string; htmlPath: string; jsonPath: string }>`; CLI `node --experimental-strip-types src/reports/index.ts --benchmark <b> --models a,b` that prints the two paths; `narrateWithModel(model: ModelConfig): (m: ModelMetrics[]) => Promise<string | undefined>` calling the model's OpenAI-compatible `/chat/completions` with only the computed metrics as input (the model writes prose, never numbers); failure returns `undefined`.

- [ ] **Step 1: Write failing tests.** With two fixture model files, `generateReport` writes the HTML and the sidecar matching the contract above; a model with no file rejects with an error naming that model and writes nothing; a `narrate` that throws still produces a report without narrative.
- [ ] **Step 2: Run** `npm test`; expect FAIL.
- [ ] **Step 3: Implement** and add the compose `reports` service (`profiles: ["tools"]`, `entrypoint` the CLI, `harness-data` volume). The API container also mounts `harness-data`.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, then `docker compose build api reports` (expect success). Run one job against `scripts/mock-openai.py` through `POST /jobs`, confirm a row in `/data/harness.db` and a file under `/data/results/`, then `docker compose run --rm reports --benchmark minimal --models <name>` and confirm `reports/<id>.html` exists.
- [ ] **Step 5: Commit** `feat: add report service and compose wiring`.
