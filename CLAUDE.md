@AGENTS.md

## Claude Code notes

- Use `docker compose` for anything that runs the agent or API; verify changes by running a prompt through `POST /benchmarks/<benchmark>/run` (a mock OpenAI-compatible endpoint works for local checks).
- Triggering a run against real models spends real API credits; confirm before sending requests to a live harness.
