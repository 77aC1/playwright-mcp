const { spawn } = require("child_process");
const http = require("http");
const crypto = require("crypto");

const PORT = 3001;
const TOKEN = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "";
const sessions = new Map();

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /sse — 建立 SSE 长连接
  if (req.method === "GET" && req.url === "/sse") {
    const sessionId = crypto.randomUUID();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    // 发送 endpoint 事件，告知客户端 JSON-RPC 端点
    res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);

    // 启动 mcp-server-github 子进程
    const child = spawn("npx", ["-y", "@modelcontextprotocol/server-github"], {
      env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: TOKEN },
      stdio: ["pipe", "pipe", "pipe"]
    });

    sessions.set(sessionId, { child });

    // 转发子进程 stdout 到 SSE（notification/response）
    child.stdout.on("data", (data) => {
      const text = data.toString().trim();
      if (text) {
        res.write(`event: message\ndata: ${text}\n\n`);
      }
    });

    // 子进程退出通知
    child.on("exit", (code) => {
      sessions.delete(sessionId);
      res.write(`event: close\ndata: process exited ${code}\n\n`);
      res.end();
    });

    // 客户端断开时清理
    req.on("close", () => {
      child.kill();
      sessions.delete(sessionId);
    });

    return;
  }

  // POST /message?sessionId=xxx — JSON-RPC 请求入口
  if (req.method === "POST" && req.url.startsWith("/message")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId");
    const session = sessions.get(sessionId);

    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -1, message: "Session not found" }, id: null }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      // 检查子进程是否还活着
      if (session.child.killed || session.child.exitCode !== null) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -1, message: "Process not running" }, id: null }));
        return;
      }

      let responded = false;
      const timer = setTimeout(() => {
        if (!responded) {
          responded = true;
          session.child.stdout.removeListener("data", handler);
          res.writeHead(504, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -1, message: "Timeout" }, id: null }));
        }
      }, 30000);

      const handler = (data) => {
        if (responded) return;
        const lines = data.toString().split("\n").filter(l => l.trim());
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            // 只响应有 id 的（即 response，不是 notification）
            if (msg.id !== undefined && msg.id !== null) {
              responded = true;
              clearTimeout(timer);
              session.child.stdout.removeListener("data", handler);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(line);
              return;
            }
          } catch (e) {
            // 非 JSON 行，忽略
          }
        }
      };
      session.child.stdout.on("data", handler);

      // 写入子进程 stdin
      try {
        session.child.stdin.write(body + "\n");
      } catch (e) {
        clearTimeout(timer);
        session.child.stdout.removeListener("data", handler);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -1, message: e.message }, id: null }));
      }
    });
    return;
  }

  // 健康检查
  if (req.url === "/health") {
    res.writeHead(200);
    res.end("OK");
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`GitHub MCP SSE gateway on :${PORT}`);
});
