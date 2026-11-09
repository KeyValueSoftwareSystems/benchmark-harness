# Smithy Harness UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A web page served by the harness API where an admin adds a model, starts or queues benchmarks, watches them run and builds the report.

**Architecture:** The API gains a session-model registry (keys in memory only), read/write model and benchmark routes, run grouping by `runId`, and a guarded docs-page discovery endpoint. The report service gains a small HTTP mode the API proxies. The page is plain HTML/CSS/ES modules in `src/ui/` served by `express.static`; its logic lives in pure modules that `node:test` covers.

**Tech Stack:** Node 24 TypeScript ESM (`--experimental-strip-types`, `.ts` import extensions, tabs), express 5, ioredis, `node:test`. No bundler, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-09-harness-ui-design.md` (mockups in `docs/superpowers/specs/harness-ui-mockups/`, open in a browser)

## Global Constraints

- API keys never reach Redis, SQLite, result JSON, reports, logs, browser storage or a URL. Jobs keep only the model name.
- Development through Docker Compose; images contain code (no bind mounts), rebuild after changes. Only the `api` service receives `MODELS`/keys; the report service never gets a key.
- Typecheck with `npm run typecheck`; tests with `npm test`. Dockerfiles stay in `docker/`.
- Tabs enabled: Models only; Frameworks, Agents, Tools shown disabled.
- Accessibility: contrast ≥ 4.5:1, touch targets ≥ 44px, visible focus rings, labelled fields, gear animation off under `prefers-reduced-motion`.
- Palette: charcoal background, ember-orange accent, serif display face with a plain sans for forms (Witcher 3 is an interaction reference only).
- Discovery: HTTPS only, public addresses only (re-checked per redirect, resolved IP pinned), size and time limits, page text only goes to the extractor, never the key. `DISCOVERY_MODEL` unset hides the Discover button.
- The API refuses an API key over plain HTTP unless the request is from localhost; env `ALLOW_INSECURE_KEYS=1` lifts it.

## Review Focus

- A session model whose name clashes with a `MODELS` entry: refused with 409, the static entry untouched.
- A docs link that redirects to `http://169.254.169.254/` or a hostname resolving to a private address: refused.
- A queued job whose session model lost its key (API restart): ends as `error: needs key again`, not a hang.
- Cancelling a run with some jobs already finished: only unfinished jobs are cancelled, no error.
- A model name containing HTML (`<img onerror=…>`) renders as text everywhere in the page.

---

## File Structure

- `src/api/models/registry.ts` (new): static + session model lookup.
- `src/api/models/guard.ts` (new): insecure-key middleware.
- `src/api/routes/models.ts` (new): `/models*`, `/benchmarks`.
- `src/api/routes/runs.ts` (new): run cancel; `routes/jobs.ts` modified for `runId` and `challenges`.
- `src/api/discovery/fetch.ts`, `extract.ts` (new): guarded fetch, parameter extraction; `src/shared/llm.ts` (new, moved from `narrative.ts`).
- `src/api/routes/reports.ts` (new): proxy to the report service; `src/reports/server.ts` (new): HTTP mode.
- `src/ui/` (new): `index.html`, `styles.css`, `app.js`, `api.js`, `state.js`, `view/*.js`, `logo.svg`.
- Modified: `agents.ts`, `runner.ts`, `benchmarks/types.ts`, `cyber.ts`, `index.ts`, `docker-compose.yml`, `docker/Dockerfile.api`, `docker/Dockerfile.reports`, `README.md`.

---

### Task 1: Model registry

**Files:**
- Create: `src/api/models/registry.ts`
- Modify: `src/api/routes/agents.ts:15`, `src/api/routes/jobs.ts:16`, `src/api/runner.ts:41`, `src/api/index.ts:29`
- Test: `test/registry.test.ts`

**Interfaces:**
- Produces: `createRegistry(statics: ModelConfig[]) => Registry` and a shared `registry`. `Registry`: `list(): ModelConfig[]` (statics first), `find(name): ModelConfig | undefined`, `isSession(name): boolean`, `add(model: ModelConfig): "ok" | "clash"`, `remove(name): boolean` (session only), `setKey(name, key): boolean` (session only), `needsKey(name): boolean` (session model with an empty key).

- [ ] **Step 1: Write failing tests** in `test/registry.test.ts`: `find` returns static and session models; `add` of an existing static name returns `"clash"` and leaves the static entry unchanged; `remove`/`setKey` refuse static names (return `false`); `needsKey` is true after `add` with `apiKey: ""` and false after `setKey("m","k")`; `list()` contains no duplicates.
- [ ] **Step 2: Run** `npm test -- test/registry.test.ts`; expect FAIL (module missing).
- [ ] **Step 3: Implement** `registry.ts` as a `Map` over session models; `registry = createRegistry(MODELS)`.
- [ ] **Step 4: Replace direct `MODELS` lookups** in `agents.ts`, `jobs.ts` (use `registry.list()` for the filter and default), `runner.ts` (`modelIdFor`) and the startup log in `index.ts`. `/register` returns 409 `{error:"needs key again"}` when `registry.needsKey(job.model)`.
- [ ] **Step 5: Run** `npm test && npm run typecheck`; expect all pass.
- [ ] **Step 6: Commit** `feat(api): session model registry`.

### Task 2: Models and benchmarks routes

**Files:**
- Create: `src/api/routes/models.ts`, `src/api/models/guard.ts`
- Modify: `src/api/benchmarks/types.ts` (add optional `challenges?(): Promise<string[]>`), `src/api/benchmarks/cyber.ts` (implement by listing `CHALLENGES_DIR`), `src/api/index.ts` (mount router)
- Test: `test/models-route.test.ts`

**Interfaces:**
- Consumes: `registry` (Task 1), `listRuns` from `src/api/db/runs.ts`.
- Produces: `createModelsRouter(deps: { registry: Registry; db: DatabaseSync; benchmarks: Map<string, Benchmark>; discovery: boolean }): Router` with
  - `GET /models` → `{ discovery: boolean, models: { name, modelId, baseUrl, api, cost?, thinkingLevel?, session: boolean, needsKey: boolean, benchmarked: string[] }[] }` (no `apiKey`; `benchmarked` = distinct benchmarks in SQLite `runs`; models with runs but absent from the registry are included with `session:false, needsKey:true, readOnly:true`)
  - `POST /models` (`name, modelId?, baseUrl, api, apiKey, cost?, thinkingLevel?`) → 201 redacted model, 409 on clash, 400 on missing fields
  - `DELETE /models/:name`, `PUT /models/:name/key` (`{apiKey}`) → 204 / 404 for static or unknown
  - `GET /benchmarks` → `{ name, challenges: string[], needsPrompt: boolean }[]` (`needsPrompt` true for `minimal`)
  - `insecureKeyGuard(env): RequestHandler` rejects `POST /models` and `PUT /models/:name/key` with 403 when `req.protocol !== "https"` and the remote address is not loopback, unless `ALLOW_INSECURE_KEYS=1`.

- [ ] **Step 1: Write failing tests** serving the router on an ephemeral port (pattern of `test/results-route.test.ts`): no response body ever contains the submitted key (assert on the JSON text); clash → 409; name `<img onerror=1>` round-trips as plain data; `PUT …/key` clears `needsKey`; static model delete → 404; guard returns 403 for a non-loopback plain-HTTP request (simulate with `x-forwarded-for` disabled and a stubbed `req.socket.remoteAddress`) and passes with the env flag; a model with SQLite runs but no registry entry is listed read-only.
- [ ] **Step 2: Run** the test file; expect FAIL.
- [ ] **Step 3: Implement** router, guard and `cyber.challenges`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`; expect pass.
- [ ] **Step 5: Commit** `feat(api): models and benchmarks routes`.

### Task 3: Runs (runId, challenge subsets, cancel)

**Files:**
- Create: `src/api/routes/runs.ts`
- Modify: `src/api/routes/jobs.ts`, `src/api/queue/store.ts` (only if a helper is needed), `src/api/index.ts`
- Test: `test/runs-route.test.ts`

**Interfaces:**
- Consumes: `registry`, `createJob`, `enqueue`, `requestCancel`, `listJobs`, `benchmark.parse`.
- Produces:
  - `POST /jobs` additionally accepts `challenges: string[]` (cyber: one job per id; absent means current behaviour) and returns `{ runId, jobs }`; every created job has `params.runId`. Returns 409 `{error:"needs key again"}` when a selected model `needsKey`.
  - `POST /runs/:runId/cancel` → 202 `{ cancelled: string[] }`: cancels jobs with that `runId` whose status is queued, provisioning or running; 404 when no job has the id.
  - `createRunsRouter(deps: { listJobs: () => Promise<Job[]>; requestCancel: (id: string) => Promise<void> }): Router` (injected so it tests without Redis).

- [ ] **Step 1: Write failing tests** for `createRunsRouter` with fake deps: cancels only unfinished jobs of the run; unknown run → 404; a run whose jobs are all done → 202 with `cancelled: []`.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement** the router and the `jobs.ts` changes (generate `runId` with `crypto.randomUUID()`, validate each requested challenge against `benchmark.challenges()` when present).
- [ ] **Step 4: Runner needs-key path:** in `runner.ts`, before provisioning, if `registry.needsKey(job.model)` mark the job `error` with message `needs key again` and return without starting an agent. Add a test with a fake registry.
- [ ] **Step 5: Run** `npm test && npm run typecheck`; expect pass. **Commit** `feat(api): grouped runs and cancel`.

### Task 4: Guarded fetch and parameter discovery

**Files:**
- Create: `src/shared/llm.ts` (move the chat-completion call out of `src/reports/narrative.ts`; `narrative.ts` imports it), `src/api/discovery/fetch.ts`, `src/api/discovery/extract.ts`
- Modify: `src/api/routes/models.ts` (add `POST /models/discover`), `src/api/config.ts` (`DISCOVERY_MODEL`)
- Test: `test/discovery-fetch.test.ts`, `test/discovery-extract.test.ts`

**Interfaces:**
- Produces:
  - `chatComplete(model: ModelConfig, messages: {role:"system"|"user"; content:string}[], timeoutMs?: number): Promise<string | undefined>` in `src/shared/llm.ts` (same request as today's narrator, failure returns `undefined`, logs only the error name).
  - `fetchDocsText(url: string, deps?: { lookup?: typeof dns.lookup; fetchImpl?: typeof fetch }): Promise<string>` throws `DiscoveryError` (message safe to show) for: non-HTTPS, private/loopback/link-local/unique-local addresses (v4 and v6), redirects beyond 3 or to a refused target, body over 1 MB, timeout over 10 s, non-text content type. Pins the resolved IP for the connection. Returns the page text with tags stripped.
  - `discoverParameters(text: string, model: ModelConfig, llm = chatComplete): Promise<{ thinkingLevels: string[]; cost?: { input: number; output: number } }>`; output is validated (levels must be from `off|minimal|low|medium|high|xhigh|max`, prices non-negative numbers) and anything invalid is dropped.
  - `POST /models/discover` `{ docsUrl }` → 200 with the parameters; 404 when `DISCOVERY_MODEL` is unset; 400 with the `DiscoveryError` message.

- [ ] **Step 1: Write failing fetch tests** with an injected `lookup`/`fetchImpl`: `http://` refused; `https://internal.test` resolving to `10.0.0.5`, `127.0.0.1`, `::1`, `169.254.169.254`, `fd00::1` refused; a 302 to `http://169.254.169.254/` refused; a redirect to a public host followed; a 2 MB body refused; the connection uses the resolved address, not a second lookup.
- [ ] **Step 2: Write failing extract tests** with a stub `llm`: valid JSON reply parsed; a reply with `thinkingLevels: ["off","turbo"]` keeps only `off`; garbage reply → empty result, no throw; the text passed to `llm` never contains the model's `apiKey`.
- [ ] **Step 3: Run**; expect FAIL.
- [ ] **Step 4: Implement** the three modules and the route; keep the narrator's behaviour (existing `test/report-cli.test.ts` must still pass).
- [ ] **Step 5: Run** `npm test && npm run typecheck`; expect pass. **Commit** `feat(api): guarded docs fetch and parameter discovery`.

### Task 5: Report HTTP mode and API proxy

**Files:**
- Create: `src/reports/server.ts`, `src/api/routes/reports.ts`
- Modify: `docker-compose.yml` (new service `reports-api`, no profile, same image, `command: ["--experimental-strip-types","src/reports/server.ts"]` via a second entrypoint, volumes `harness-data:/data:ro` for results and a writable reports dir), `docker/Dockerfile.reports` (copy nothing new if `src/reports` already copied; confirm), `src/api/config.ts` (`REPORTS_URL`, default `http://reports-api:3001`), `src/api/index.ts`
- Test: `test/reports-server.test.ts`

**Interfaces:**
- Produces:
  - `createReportsServer(deps: { generate: typeof generateReport; reportsDir: string; resultsDir: string }): express.Express` with `POST /reports` `{ benchmark: string; models: string[] }` → 201 `{ id }` (400 when empty), `GET /reports/:id` → the HTML (404 when missing; id must match `^[\w.-]+$`).
  - API `createReportsRouter(deps: { baseUrl: string; fetchImpl?: typeof fetch }): Router` forwarding `POST /reports` and `GET /reports/:id` and returning the upstream status; upstream failure → 502 `{error:"report service unavailable"}`.
  - The report service reads only `NARRATIVE_MODEL`; it never receives a session key.

- [ ] **Step 1: Write failing tests** for the report server with a stub `generate`: POST returns the id; GET returns the HTML file; an id like `../x` → 400; unknown id → 404; empty `models` → 400. For the proxy, a stub `fetchImpl` that rejects → 502.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement** server, proxy and compose service (health: the API's report calls fail soft; the UI shows "report service not running" on 502).
- [ ] **Step 4: Run** `npm test && npm run typecheck`; then `docker compose build reports-api api` and `docker compose up -d reports-api`; expect `curl localhost:3001/reports/none` → 404.
- [ ] **Step 5: Commit** `feat(reports): http mode and api proxy`.

### Task 6: UI shell, logo, state module

**Files:**
- Create: `src/ui/index.html`, `src/ui/styles.css`, `src/ui/logo.svg`, `src/ui/app.js`, `src/ui/api.js`, `src/ui/state.js`
- Modify: `src/api/index.ts` (`app.use(express.static(<src/ui>))` after the routers, resolved relative to the module), `docker/Dockerfile.api` (`COPY src/ui ./src/ui`)
- Test: `test/ui-state.test.ts`

**Interfaces:**
- Produces in `state.js` (pure, no DOM): `createState()`, `selectModel(state, name)`, `canStart(state): { ok: boolean; missing: string[] }` (needs model, key present or not needed, benchmark, prompt when `needsPrompt`, challenges non-empty), `stageRun(state): Staged[]` (adds the current form as a queue item, one item per model+benchmark), `removeStaged(state, index)`, `groupModels(models: ApiModel[]): { domain: string; models: ApiModel[] }[]` (domain = benchmark; unrun models under "Not benchmarked"; a model appears in each benchmark it ran), `groupRuns(jobs: Job[]): Run[]` where `Run = { runId, model, benchmark, jobs, total, finished, status }` and `status` is `running | done | error | cancelled`.
- `api.js` wraps `fetch` for every endpoint above and never touches `localStorage`/`sessionStorage`/`location`.
- `escapeHtml`/text-node rendering helper `h(tag, attrs, children)` in `app.js`; no `innerHTML` with data anywhere.

- [ ] **Step 1: Write failing tests** for `state.js` (import as ESM from `src/ui/state.js`): `canStart` lists exactly the missing fields; `groupModels` puts a never-run model under "Not benchmarked" and a model run on two benchmarks in both groups; `groupRuns` reports `running` while any job is queued/provisioning/running, `error` when all settled and any errored, `cancelled` when all cancelled; `stageRun` then `removeStaged` leaves an empty queue.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement** `state.js`, `api.js`, the static shell (header with logo and tabs, three empty columns) and the stylesheet with the palette and accessibility rules from Global Constraints. The anvil logo is an inline SVG using `currentColor`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`; rebuild and `docker compose up -d --build api redis`; open `http://localhost:3000/` in the browser; expect the shell with only the Models tab enabled and no console errors.
- [ ] **Step 5: Commit** `feat(ui): shell, logo and state`.

### Task 7: Model list and Add-a-model card

**Files:**
- Create: `src/ui/view/modelList.js`, `src/ui/view/addModel.js`
- Modify: `src/ui/app.js`, `src/ui/styles.css`
- Test: extend `test/ui-state.test.ts` for `validateNewModel`

**Interfaces:**
- Produces in `state.js`: `validateNewModel(form): { ok: boolean; errors: Record<string,string> }` (name, baseUrl `https?://`, api type, apiKey required; modelId defaults to name).
- `modelList.js`: collapsible groups (`<button aria-expanded>`), the selected model highlighted, the **Add a new model** button directly under the Models heading, read-only models labelled "add the model again to re-run".
- `addModel.js`: the card from the mockup. **Discover parameters** is shown only when `GET /models` says `discovery: true`; results fill a thinking-level select (default `off`) and price fields, all editable; the key field is cleared and the card closed after a successful `POST /models`; field errors sit beside their field.

- [ ] **Step 1: Write failing tests** for `validateNewModel`: empty form lists all required fields; `ftp://x` base URL rejected; valid form ok with `modelId` defaulted.
- [ ] **Step 2: Run**; expect FAIL. **Step 3: Implement** the two views and wire them in `app.js`.
- [ ] **Step 4: Verify in the browser:** add a model without discovery set (button hidden), see it in the list; a model named `<img src=x onerror=alert(1)>` shows as text; tab order reaches every control.
- [ ] **Step 5: Commit** `feat(ui): model list and add-a-model card`.

### Task 8: Benchmark panel, queue and confirmation

**Files:**
- Create: `src/ui/view/benchmark.js`, `src/ui/view/queue.js`, `src/ui/view/confirm.js`
- Modify: `src/ui/app.js`, `src/ui/styles.css`

**Interfaces:**
- Consumes: `canStart`, `stageRun`, `removeStaged`, `api.startRun`, `api.listBenchmarks`.
- `benchmark.js`: the selected model drawn large, then the **Benchmark** section: benchmark selector, challenges (all by default, or a checklist), a prompt textarea when `needsPrompt`, key field when the model `needsKey`. **Benchmark now** and **Add to queue** are `disabled` until `canStart().ok`, with the missing fields named in a visible hint.
- `queue.js`: staged items with remove buttons and **Benchmark these**. `confirm.js`: a panel listing each model, benchmark and challenge count with **Confirm** and **Back**; Confirm calls `POST /jobs` once per staged item, then the page switches to the running view. **Benchmark now** goes through the same confirmation.

- [ ] **Step 1: Verify state tests still cover `canStart`/`stageRun`**; add a test that two staged items for the same model but different benchmarks stay separate.
- [ ] **Step 2: Implement** the three views and wiring.
- [ ] **Step 3: Verify in the browser** (minimal benchmark needs no containers for the form, but do not click Confirm against a real model without the user's go-ahead because it spends credits): buttons disabled until complete, hint names what is missing, confirmation lists what will run, queue removal works, reload clears the queue.
- [ ] **Step 4: Commit** `feat(ui): benchmark panel, queue and confirmation`.

### Task 9: Running view, report and docs

**Files:**
- Create: `src/ui/view/running.js`
- Modify: `src/ui/app.js`, `src/ui/styles.css`, `README.md`

**Interfaces:**
- Consumes: `groupRuns`, `GET /jobs` (polled every 3 s while any run is `running`, stopped otherwise and when the tab is hidden), `POST /runs/:runId/cancel`, `POST /reports`, `GET /reports/:id`.
- `running.js`: turning gear (CSS, off under reduced motion), progress bar `finished/total`, one line per challenge (waiting, running with elapsed time from `createdAt`, solved or not once settled), **Cancel run**. When settled: result summary, **Generate report** (opens `GET /reports/:id` in a new tab; 502 shows "report service not running"), **Benchmark again** (re-opens the Benchmark panel with the same benchmark and challenges, asking for the key again for session models). After a reload the view is rebuilt from `GET /jobs` by `runId`.
- README: a "Smithy UI" section (how to open, the no-auth warning, `DISCOVERY_MODEL`, `ALLOW_INSECURE_KEYS`, keys held in memory only).

- [ ] **Step 1: Add failing tests** to `test/ui-state.test.ts`: `groupRuns` computes `finished` and elapsed-ready fields; a run recovered from jobs alone (no browser state) has the same grouping.
- [ ] **Step 2: Implement** the view, polling and README section.
- [ ] **Step 3: Verify end to end with the user's go-ahead** (this spends credits): run one `minimal` job with a configured model, watch the gear and lines, cancel a second run, generate and open the report, use Benchmark again; confirm the key appears in no `docker compose logs api` output and in none of `/data/harness.db`, `/data/results`, `/data/reports` (`grep -r` for the key value returns nothing).
- [ ] **Step 4: Run** `npm test && npm run typecheck`; expect pass. **Commit** `feat(ui): running view, reports and docs`.
