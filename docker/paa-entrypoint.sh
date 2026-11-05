#!/usr/bin/env bash
# Entrypoint for the PAA container.
#
# Starts mock services, configures and launches OpenClaw, then starts
# the chat adapter.  All children run in background; the script waits
# for any one of them to exit and then tears everything down.
#
# Required env:
#   WORLD_DIR          – world directory; the API copies world.yaml + agent/ in, then creates .ready
#   LLM_BASE_URL       – API proxy URL for model calls
#   LLM_TOKEN          – job-scoped bearer token for model calls
#   LLM_API            – model API format (e.g. openai-completions, anthropic-messages)
#   OPENCLAW_GATEWAY_TOKEN – bearer token for OpenClaw gateway
# Optional env:
#   LLM_CONTEXT_WINDOW, LLM_MAX_TOKENS – model limits, when MODELS sets them

set -euo pipefail

log() { echo "[paa-entrypoint] $*" >&2; }

: "${WORLD_DIR:?}" "${LLM_BASE_URL:?}" "${LLM_TOKEN:?}" "${LLM_API:?}" "${OPENCLAW_GATEWAY_TOKEN:?}"

MOCK_PID=""
OPENCLAW_PID=""
ADAPTER_PID=""

cleanup() {
	log "Shutting down..."
	[ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
	[ -n "$OPENCLAW_PID" ] && kill "$OPENCLAW_PID" 2>/dev/null || true
	[ -n "$ADAPTER_PID" ] && kill "$ADAPTER_PID" 2>/dev/null || true
	wait 2>/dev/null || true
}
trap cleanup EXIT SIGTERM SIGINT

# ---------- 0. Wait for the world files ----------
for i in $(seq 1 60); do
	[ -f "${WORLD_DIR}/.ready" ] && break
	if [ "$i" -eq 60 ]; then
		log "ERROR: world files were not delivered to ${WORLD_DIR} within 30 s"
		exit 1
	fi
	sleep 0.5
done

# ---------- 1. Start mock services ----------
log "Starting mock services..."
node --experimental-strip-types /paa/src/pa/mock-services/start.ts &
MOCK_PID=$!

# Wait until at least one mock service is listening (simple poll on first port)
FIRST_PORT=$(node --experimental-strip-types -e "
  import { readFileSync } from 'node:fs';
  import YAML from 'yaml';
  const w = YAML.parse(readFileSync(process.env.WORLD_DIR + '/world.yaml', 'utf8'));
  console.log((w.services || [])[0]?.port || 9100);
")
for i in $(seq 1 30); do
	if curl -sf "http://localhost:${FIRST_PORT}/" >/dev/null 2>&1 ||
	   curl -sf "http://localhost:${FIRST_PORT}/healthz" >/dev/null 2>&1; then
		break
	fi
	sleep 0.5
done
log "Mock services ready"

# ---------- 2. Configure OpenClaw ----------
log "Configuring OpenClaw..."
mkdir -p -m 700 "${XDG_CACHE_HOME:-$HOME/.cache}"
openclaw config set gateway.http.endpoints.chatCompletions.enabled true
openclaw config set update.checkOnStart false
PROVIDER_JSON=$(node -e '
  const e = process.env;
  const model = { id: "proxy-model", name: "Proxy Model" };
  if (e.LLM_CONTEXT_WINDOW) model.contextWindow = Number(e.LLM_CONTEXT_WINDOW);
  if (e.LLM_MAX_TOKENS) model.maxTokens = Number(e.LLM_MAX_TOKENS);
  console.log(JSON.stringify({ baseUrl: e.LLM_BASE_URL, apiKey: e.LLM_TOKEN, api: e.LLM_API, models: [model] }));
')
openclaw config set models.providers.benchmark "$PROVIDER_JSON"

# Register each mock service as an MCP server
log "Registering MCP servers..."
node --experimental-strip-types -e "
  import { readFileSync } from 'node:fs';
  import YAML from 'yaml';
  const w = YAML.parse(readFileSync(process.env.WORLD_DIR + '/world.yaml', 'utf8'));
  for (const svc of w.services || [])
    console.log(svc.name + ' ' + svc.port);
" | while read -r name port; do
	openclaw config set "mcp.servers.${name}" \
		"{\"transport\":\"streamable-http\",\"url\":\"http://localhost:${port}/mcp\"}"
	log "  registered ${name} → :${port}"
done

# ---------- 3. Start OpenClaw gateway ----------
log "Starting OpenClaw gateway..."
openclaw gateway run --allow-unconfigured &
OPENCLAW_PID=$!

# Wait for OpenClaw to become healthy
for i in $(seq 1 60); do
	if curl -sf http://localhost:18789/healthz >/dev/null 2>&1; then
		log "OpenClaw gateway is healthy"
		break
	fi
	if [ "$i" -eq 60 ]; then
		log "ERROR: OpenClaw did not become healthy within 30 s"
		exit 1
	fi
	sleep 0.5
done

# ---------- 4. Start chat adapter ----------
log "Starting chat adapter on :8090..."
node --experimental-strip-types /paa/src/pa/chat-adapter/index.ts &
ADAPTER_PID=$!

# Wait for chat adapter to be ready
for i in $(seq 1 20); do
	if curl -sf http://localhost:8090/healthz >/dev/null 2>&1; then
		log "Chat adapter is healthy"
		break
	fi
	sleep 0.5
done

log "PAA container fully started"

# Wait for any child to exit — if one crashes, bring everything down.
wait -n
EXIT_CODE=$?
log "A child process exited with code ${EXIT_CODE}"
exit "${EXIT_CODE}"
