#!/bin/bash
# 去掉 set -e，防止子进程退出干爆整个容器
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
# 崩溃自动重启
while true; do
  echo "[$(date -Is)] Starting sse-gateway.js ..."
  node /app/sse-gateway.js 2>&1
  echo "[$(date -Is)] sse-gateway.js exited, restarting in 3s..."
  sleep 3
done &

# 保持容器存活
while true; do
  wait -n || true
  echo "A child process exited, container stays alive"
  sleep 1
done
