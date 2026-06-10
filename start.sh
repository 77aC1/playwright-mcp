#!/bin/bash
set -e

# Export the token so all child processes inherit it
export GITHUB_PERSONAL_ACCESS_TOKEN="${GITHUB_PERSONAL_ACCESS_TOKEN}"

echo "=== Starting Playwright MCP on :3000 ==="
node /app/cli.js   --headless   --browser chromium   --no-sandbox   --host 0.0.0.0   --port 3000   --allowed-hosts '*' &

echo "=== Starting GitHub MCP on :3001 via supergateway ==="
# Wrap in a restart loop to survive crashes
(
  while true; do
    echo "Launching GitHub MCP..."
    supergateway       --stdio "mcp-server-github"       --port 3001       --host 0.0.0.0
    echo "GitHub MCP exited, restarting in 2s..."
    sleep 2
  done
) &

echo "=== Both MCP servers started ==="
while true; do
  wait -n || true
  echo "A child process exited, container stays alive"
  sleep 1
done
