#!/bin/bash
set -e

echo "=== Starting Playwright MCP on :3000 ==="
node /app/cli.js   --headless   --browser chromium   --no-sandbox   --host 0.0.0.0   --port 3000   --allowed-hosts '*' &

echo "=== Starting GitHub MCP on :3001 via supergateway ==="
GITHUB_PERSONAL_ACCESS_TOKEN="${GITHUB_PERSONAL_ACCESS_TOKEN}" supergateway   --stdio "mcp-server-github"   --port 3001   --host 0.0.0.0 &

echo "=== Both MCP servers started ==="
# Wait all background jobs, restart any that crash
while true; do
  wait -n || true
  echo "A process exited, but container stays alive"
  sleep 1
done
