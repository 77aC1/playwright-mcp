const { spawn } = require("child_process");
const http = require("http");

const PORT = process.env.PORT || 3001;
const TOKEN = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "";

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  if (req.url === "/sse") {
    // SSE 握手头
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });

    // 启动 mcp-server-github 子进程
    const child = spawn("npx", ["-y", "@modelcontextprotocol/server-github"], {
      env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: TOKEN },
      stdio: ["pipe", "pipe", "pipe"]
    });

    // 将 MCP 的 stdout 转成 SSE 发给客户端
    child.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter(l => l.trim());
      for (const line of lines) {
        res.write(`data: ${line}\n\n`);
      }
    });

    // 将客户端的 SSE 输入转成 stdin 给 MCP
    req.on("data", (chunk) => {
      try {
        const msg = JSON.parse(chunk.toString());
        child.stdin.write(JSON.stringify(msg) + "\n");
      } catch (e) {
        // 忽略非 JSON 输入
      }
    });

    child.stderr.on("data", (d) => console.error("[github-mcp]", d.toString()));

    req.on("close", () => {
      child.kill();
      res.end();
    });

    child.on("exit", (code) => {
      res.write(`event: close\ndata: process exited with code ${code}\n\n`);
      res.end();
    });
  } else if (req.url === "/health") {
    res.writeHead(200);
    res.end("OK");
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`GitHub MCP SSE gateway listening on :${PORT}`);
});
