#!/bin/bash
set -e

echo "=== Starting Playwright MCP on :3000 ==="
node /app/cli.js \
  --headless \
  --browser chromium \
  --no-sandbox \
  --host 0.0.0.0 \
  --port 3000 \
  --allowed-hosts '*' &

echo "=== Starting GitHub MCP on :3001 via supergateway ==="
supergateway \
  --stdio "mcp-server-github" \
  --port 3001 \
  --host 0.0.0.0 &

echo "=== Both MCP servers started ==="
# Wait for any process to exit
wait -n
