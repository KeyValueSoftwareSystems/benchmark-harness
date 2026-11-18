#!/usr/bin/env bash
# Smoke test for PA mock services.
# Usage: bash scripts/pa/smoke_mocks.sh <world-id>
# Starts the mock services for one world, curls every tool_endpoint, and reports.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORLD_ID="${1:?Usage: smoke_mocks.sh <world-id>}"
WORLD_DIR="$REPO_ROOT/resources/pa/worlds/$WORLD_ID"

if [ ! -d "$WORLD_DIR" ]; then
  echo "ERROR: world directory not found: $WORLD_DIR"
  exit 1
fi

# Start mock services in background
WORLD_DIR="$WORLD_DIR" node --experimental-strip-types \
  "$REPO_ROOT/src/pa/mock-services/start.ts" &
MOCK_PID=$!

cleanup() { kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT

# Wait for services to start
sleep 3

# Extract tool_endpoints from world.yaml and test each
FAIL=0
PASS=0

while IFS='|' read -r tool_name method url; do
  tool_name=$(echo "$tool_name" | xargs)
  method=$(echo "$method" | xargs)
  url=$(echo "$url" | xargs)

  HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "$url" \
    -H 'Content-Type: application/json' \
    -d '{}' 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    echo "  PASS  $tool_name ($url)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $tool_name ($url) → HTTP $HTTP_CODE"
    FAIL=$((FAIL + 1))
  fi
done < <(python3 -c "
import yaml, sys
world = yaml.safe_load(open('$WORLD_DIR/world.yaml'))
for ep in world.get('tool_endpoints', []):
    print(f\"{ep['tool_name']}|{ep['method']}|{ep['url']}\")
")

echo ""
echo "Results for $WORLD_ID: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
