#!/bin/bash
set -e

export GITHUB_PERSONAL_ACCESS_TOKEN="${GITHUB_PERSONAL_ACCESS_TOKEN}"

echo "=== Starting Playwright MCP on :3000 ==="
node /app/cli.js \
  --headless \
  --browser chromium \
  --no-sandbox \
  --host 0.0.0.0 \
  --port 3000 \
  --allowed-hosts '*' &

echo "=== Starting GitHub MCP on :3001 ==="
node /app/sse-gateway.js &

echo "=== Both MCP servers started ==="
while true; do
  wait -n || true
  echo "A child process exited, container stays alive"
  sleep 1
done
