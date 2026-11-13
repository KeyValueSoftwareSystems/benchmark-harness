#!/usr/bin/env bash
# Entrypoint for the Hermes PAA container.
#
# Starts mock services, writes Hermes' config and launches its API server, then starts
# the chat adapter.  All children run in background; the script waits for any one of
# them to exit and then tears everything down.
#
# Required env:
#   WORLD_DIR          – world directory; the API copies world.yaml + agent/ in, then creates .ready
#   LLM_BASE_URL       – API proxy URL for model calls
#   LLM_TOKEN          – job-scoped bearer token for model calls
#   LLM_API            – model API format (e.g. openai-completions, anthropic-messages)
#   PAA_GATEWAY_TOKEN  – bearer token for the Hermes API server
# Optional env:
#   LLM_CONTEXT_WINDOW – model context window, when MODELS sets it (Hermes owns output-token limits)

set -euo pipefail

log() { echo "[paa-entrypoint] $*" >&2; }

: "${WORLD_DIR:?}" "${LLM_BASE_URL:?}" "${LLM_TOKEN:?}" "${LLM_API:?}" "${PAA_GATEWAY_TOKEN:?}"

HERMES_API_PORT=8642
export HERMES_HOME="${HERMES_HOME:-/opt/data}"
export API_SERVER_ENABLED=true
export API_SERVER_KEY="$PAA_GATEWAY_TOKEN"
export PAA_UPSTREAM_URL="http://127.0.0.1:${HERMES_API_PORT}/v1/chat/completions"
export PAA_UPSTREAM_MODEL="hermes-agent"
export XDG_RUNTIME_DIR=/tmp/hermes-runtime

MOCK_PID=""
HERMES_PID=""
ADAPTER_PID=""

cleanup() {
	log "Shutting down..."
	[ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
	[ -n "$HERMES_PID" ] && kill "$HERMES_PID" 2>/dev/null || true
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

# ---------- 2. Configure Hermes ----------
log "Configuring Hermes..."
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
node --experimental-strip-types /paa/src/pa/hermes-config/index.ts

# What ran, for the run record: the version and the toolsets Hermes enabled.
HERMES_VERSION_OUTPUT=$(hermes --version 2>/dev/null)
HERMES_VERSION="${HERMES_VERSION_OUTPUT%%$'\n'*}"
HERMES_TOOLSETS=$(hermes tools list --platform api_server | awk '/✓ enabled/ { print $3 }')
# shellcheck disable=SC2086
node --experimental-strip-types /paa/src/pa/paa-info/index.ts "$HERMES_VERSION" $HERMES_TOOLSETS > /tmp/paa-info.json

# ---------- 3. Start the Hermes API server ----------
log "Starting Hermes API server..."
hermes gateway run &
HERMES_PID=$!

for i in $(seq 1 120); do
	if curl -sf "http://127.0.0.1:${HERMES_API_PORT}/health" >/dev/null 2>&1; then
		log "Hermes API server is healthy"
		break
	fi
	if [ "$i" -eq 120 ]; then
		log "ERROR: Hermes did not become healthy within 60 s"
		exit 1
	fi
	sleep 0.5
done

# ---------- 4. Start chat adapter ----------
log "Starting chat adapter on :8090..."
node --experimental-strip-types /paa/src/pa/chat-adapter/index.ts &
ADAPTER_PID=$!

for i in $(seq 1 20); do
	if curl -sf http://localhost:8090/healthz >/dev/null 2>&1; then
		log "Chat adapter is healthy"
		break
	fi
	sleep 0.5
done

log "PAA container fully started"

wait -n
EXIT_CODE=$?
log "A child process exited with code ${EXIT_CODE}"
exit "${EXIT_CODE}"
