# Smithy: a web UI for starting benchmarks (design)

Branch: `feat/harness-ui` (cut from `main`). Status: design, awaiting approval. No code yet.

## Intent

Today a benchmark is started with a `curl` against `POST /jobs` and the model has to be written into the `MODELS` env var first. Smithy is a web page, served by the harness itself, where an admin picks or adds a model, starts a benchmark, watches it run and builds the report, without touching the shell or `.env`.

The look is inspired by the Witcher 3 crafting menu, for the interaction only (a list of things on one side, the chosen item shown large in the middle with what it needs below, a button to craft). Not its colours or art.

## Goals

- One screen to: add a model, select it, start a benchmark now or queue it, see it run, generate its report.
- Adding a model needs only what the page asks for. Model parameters (thinking levels, token limits, prices) are discovered from a documentation link the admin gives, then confirmed by the admin.
- API keys are never stored anywhere (see "Keys").
- Works on the existing harness (cyber and minimal benchmarks) with small, read-mostly API additions.
- Keyboard and screen-reader usable; works on a laptop-width window, degrades to one column on a phone.

## Non-goals

- Authentication or users. Same trust model as the current API (see "Open risk").
- The Frameworks, Agents and Tools tabs: shown, disabled.
- Editing `MODELS` in `.env`, or persisting added models across an API restart.
- Live per-turn progress inside a challenge (the harness does not expose it today).
- Comparing runs, charts, or editing reports. The existing report service output is what the page links to.

## Anti-goals (a failure even if it works)

- Any path where an API key lands on disk, in Redis, SQLite, JSON result files, logs, the browser's storage or a URL.
- The discovery step fetching arbitrary internal addresses.
- A UI that can start a run without the admin seeing which model, benchmark and how many challenges it will spend credits on.

## The screen

Header: Smithy logo (an anvil, inline SVG) and tabs Models, Frameworks, Agents, Tools. Only Models is enabled.

Three columns on a wide window:

1. **Left, model list.** Collapsible groups, one per benchmark domain (Cyber, Minimal). Models that have been benchmarked appear in their group. Under the Models heading sits a highlighted **Add a new model** button.
2. **Centre, the selected model** shown large, like the weapon in the crafting menu. Below it a section called **Benchmark** with the fields the run needs: model name, base URL, API key, parameters, challenges (all by default, or pick some). Two buttons, **Benchmark now** and **Add to queue**, are enabled only when every field is filled.
3. **Right, queue.** The models waiting, each removable, and a **Benchmark these** button below.

Add a new model opens a card with: model name, base URL, API key, API type, and a docs link. **Discover parameters** reads the link and proposes thinking levels, max output tokens, price per million tokens and temperature range. The admin edits any value, then confirms. The model joins the list for this session.

Benchmark now switches the centre to a running view: a turning gear, a progress bar of challenges done, and one line per challenge (waiting, running with elapsed time, finished with solved or not). **Cancel run** is available. When all challenges settle, the centre shows the result summary with **Generate report** and **Benchmark again**. Once the report exists, the model appears in its group with the report attached and a Benchmark again option.

Mockups: `docs/superpowers/specs/harness-ui-mockups/` (`layout-v2.html`, `flow-v3.html`; open the files in a browser, they are the layout source of truth).

## Keys

The admin types the API key in the page. It is sent over HTTPS or localhost to the API and kept in the API process memory only, tied to the model entry for the session. Rules:

- Never written to Redis, SQLite, result JSON, reports, logs or `.env`. Jobs keep only the model name, as they do now.
- Never put in browser storage or the URL; the field is cleared after the model is added and re-asked after a page reload.
- Dropped from memory when the API restarts. Queued jobs that need a lost key are shown as "needs key again" instead of failing silently.
- Models already in `MODELS` need no key entry.

## What gets added to the API

All additions are small and live next to the existing routes.

| Endpoint | Purpose |
|---|---|
| `GET /models` | Configured and session models with keys removed (`redact`), plus which benchmarks each has been run on. |
| `POST /models` | Adds a session model (name, base URL, API key, API type, parameters). Key kept in memory only. |
| `GET /benchmarks` | Benchmark names and their challenge ids, so the page can offer "all" or a subset. |
| `POST /models/discover` | Takes a docs URL, returns proposed parameters. |
| `POST /reports` and `GET /reports/:id` | Builds and serves the report for chosen models. |

Starting a run uses the existing `POST /jobs` (one call per challenge when a subset is chosen). Run state comes from the existing `GET /jobs`.

## Discovery

The API fetches the given page and has a language model read it and return the parameters. Guardrails: HTTPS only, the host must resolve to a public address (private, loopback and link-local refused, checked again on every redirect), size and time limits, the text sent to the model is the page text only, never the API key. The extractor model is set by an optional `DISCOVERY_MODEL` setting. When it is unset, the Discover button is hidden and the parameter fields are filled by hand.

## Parts decided by the builder (my calls, not agreed)

- **Stack:** plain HTML, CSS and ES modules in `src/ui/`, served by the API with `express.static`. No bundler, in line with the repo's no-build-step rule and Docker-only workflow.
- **Domain groups:** a model's domain is the benchmark it was run on (`cyber`, `minimal`). A model never run yet sits under "Not benchmarked".
- **Progress:** from the job status the harness already keeps (queued, provisioning, running, done, error) plus elapsed time and challenges finished. No turn counts.
- **Reports:** the report service gains a small HTTP mode so the API can request a report and the page can open it. It stays a separate service.
- **Look:** dark forge palette (charcoal, ember orange accent), a serif display face with a clean sans for forms. Contrast at least 4.5:1, touch targets at least 44px, visible focus rings, labelled fields, the gear animation turned off for reduced-motion users.
- **Tests:** `node:test` for the API additions (keys never persisted, discovery URL guard, model listing); the page checked by hand through Docker Compose.

## Open risk

The API has no authentication today, and the page makes it easy to spend credits and to submit API keys. It must stay on localhost or a trusted network. The design keeps that unchanged and says so in the README; adding a login is a separate piece of work.

## Calls made after the builder check (my calls, not agreed)

- **Benchmark choice.** The Benchmark section has a benchmark selector (cyber or minimal). A model can appear in several domain groups. "Benchmark again" repeats the same benchmark with the same settings.
- **Session models.** One global in-memory registry in the API, consulted next to `MODELS` wherever the worker and agent resolve a model by name (there is no auth, so it is shared by every browser). A name that clashes with a `MODELS` entry is refused. A session model can be removed, and its key re-supplied with `PUT /models/:name/key`; the page does not remember keys.
- **Queue.** The right-hand queue is a staging list kept in the browser. "Add to queue" creates no jobs. "Benchmark these" first shows a confirmation panel listing each model, its benchmark and challenge count, then creates the jobs. A reload clears the staging list but not runs that have already started.
- **Runs.** Each click of Benchmark creates a `runId` stored in the job params. The page groups jobs by `runId` for progress and for "Cancel run", and rebuilds the running view from `GET /jobs` after a reload.
- **Reports.** The report service gets a long-running HTTP mode under its compose profile; the API calls it over the compose network and serves the HTML. The narrator is only the existing `NARRATIVE_MODEL` setting; no session key ever goes to the report service. A report covers the models in the run it was generated from.
- **Benchmarked history** comes from SQLite `runs`. A model with stored results but no session entry still shows in its group, read-only, with "add the model again to re-run".
- **Parameters.** The model card has name, an optional provider model id (defaults to the name), base URL, API type, key and docs link. Only parameters the harness can use are kept: thinking level (one select, default off) and price per million tokens. Max tokens and temperature are not in `ModelConfig`, so they are left out of the first version and the mockup's rows for them are dropped.
- **Discovery details.** `DISCOVERY_MODEL` is a full model entry in the same JSON shape as a `MODELS` item, set in the API's environment. Plain HTML pages only, no JavaScript rendering. The fetch pins the resolved IP address so a redirect or DNS rebinding cannot reach a private address.
- **Same origin.** The page is served by the API on its own port, so there is no CORS. The API refuses to accept an API key over plain HTTP unless the request comes from localhost, with an environment switch to allow it on a trusted network.
- **Name and logo.** Smithy and an anvil mark, as asked.
