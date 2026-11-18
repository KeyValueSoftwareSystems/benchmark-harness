## Summary

Every settled benchmark job is now stored, enriched with Netra data, and can be turned into a report. This is the harness half of the AI Scout Slack bot; the bot itself lives in a separate `Quartermaster` project.

- **Result flow, any benchmark.** A new `results` extension (loaded by every agent image) collects each run's `benchmark_result` outcome and usage (turns, tokens, cost, duration) and reports it to the API. Benchmarks that emit no result still get a row with `outcome: null`.
- **Storage.** When a job settles, the API writes a row to the SQLite `runs` table (`/data/harness.db`, `journal_mode=DELETE` so readers can mount it read-only) and appends it to `/data/results/<benchmark>/<model>.json` (one file per model, one entry per run).
- **Netra insights.** Once the trace is visible, the API pulls the session through the Netra MCP (`netra_get_session_details`) and saves it as `netra_metadata` in both places. Needs `NETRA_API_KEY` (and `NETRA_MCP_ENDPOINT` for EU); skipped without a key, and a failure never affects the stored result.
- **Report service.** `docker compose run --rm reports --benchmark <b> --models a,b` builds a self-contained HTML report (title card with bars, benchmark metrics table, Netra insights table) plus a JSON sidecar with the numbers. Optional `NARRATIVE_MODEL` adds a short LLM summary; it never sees API keys from `MODELS`.
- **Pricing.** `MODELS` entries accept an optional `cost` (`{input, output, cacheRead?, cacheWrite?}`, USD per million tokens). Without it pi cannot price the model and runs report a cost of 0.
- **Compose.** New `harness-data` volume shared by `api`, `reports` and the bot; new `reports` (profile `tools`) and `quartermaster` (profile `bot`) services.

## Security note

The agent's model has a shell and `API_URL`/`JOB_ID` in its environment, so an unauthenticated `POST /jobs/:id/result` would let it forge its own "solved" verdict. The route therefore requires a one-time token: the extension fetches it from `GET /jobs/:id/result-token` at session start (served once, never in env), and a re-run clears the previous attempt's result and token.

## How reports count

Re-runs of a challenge count once (the latest wins); runs that never reported are excluded from the average cost; a model that attempted fewer challenges than the benchmark has is labelled "(partial)"; mixed run conditions are labelled as such.

## Test plan

- [x] `npm test` (59+ tests, run in a `node:24` container) and `npm run typecheck`
- [x] Images build (`api`, `reports`, `minimal`, `cyber`)
- [x] Mock-model `minimal` job: row in SQLite and JSON, result token flow works
- [x] Real model (`deepseek/deepseek-v4.1-flash`) `minimal` job: real token counts, trace IDs and Netra insights stored
- [x] Three cyber challenges (`dynastic`, `makeshift`, `lootstash`) solved: verdicts, metrics and Netra insights stored; report generated and published to Slack through the bot
- [ ] Not verified: the EU Netra endpoint, benchmarks other than `minimal` and `cyber`, and a restart mid-job

## Notes for reviewers

- The `quartermaster` compose service builds from `../Quartermaster`, which is not in this repo; it is profile-gated (`bot`) so nothing else is affected.
- Known minors left out on purpose: slug collisions between model names (`GPT-X` vs `gpt-x`), a crash between the SQLite insert and the JSON append can leave them out of step, and enrichment is fire-and-forget (lost on API restart).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
