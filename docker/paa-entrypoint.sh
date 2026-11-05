#!/usr/bin/env bash
# Entrypoint for the PAA container.
#
# Starts mock services, configures and launches OpenClaw, then starts
# the chat adapter.  All children run in background; the script waits
# for any one of them to exit and then tears everything down.
#
# Required env:
#   WORLD_DIR          – path to the world directory (contains world.yaml + agent/)
#   LLM_BASE_URL       – API proxy URL for model calls
#   LLM_TOKEN          – job-scoped bearer token for model calls
#   OPENCLAW_GATEWAY_TOKEN – bearer token for OpenClaw gateway

set -euo pipefail

log() { echo "[paa-entrypoint] $*" >&2; }

cleanup() {
	log "Shutting down..."
	kill "$MOCK_PID" "$OPENCLAW_PID" "$ADAPTER_PID" 2>/dev/null || true
	wait 2>/dev/null || true
}
trap cleanup EXIT SIGTERM SIGINT

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
openclaw config set gateway.http.endpoints.chatCompletions.enabled true
openclaw config set update.checkOnStart false
openclaw config set models.providers.benchmark \
	"{\"baseUrl\":\"${LLM_BASE_URL}\",\"apiKey\":\"${LLM_TOKEN}\",\"models\":[{\"id\":\"proxy-model\",\"name\":\"Proxy Model\"}]}"

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
		"{\"type\":\"http\",\"url\":\"http://localhost:${port}/mcp\"}"
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
