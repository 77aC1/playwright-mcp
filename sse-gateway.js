const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');

const PORT = process.env.PORT || 3001;
const MCP_TIMEOUT = parseInt(process.env.MCP_TIMEOUT || '60000'); // 默认60秒
const TOKEN = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '';

// session 结构: { id, process, sseRes, createdAt, pendingRequests }
const sessions = new Map();

// 清理过期 session（10分钟无活动）
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > 600000) {
      try { s.process.kill(); } catch(e) {}
      sessions.delete(id);
      console.log(`[session] expired: ${id}`);
    }
  }
}, 60000);

function createSession() {
  const id = crypto.randomUUID();
  const child = spawn('npx', ['-y', '@modelcontextprotocol/server-github'], {
    env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: TOKEN },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stderr.on('data', (d) => console.log(`[stderr:${id.slice(0,8)}] ${d.toString().trim()}`));
  child.on('exit', (code) => {
    const s = sessions.get(id);
    if (s) {
      if (s.sseRes && !s.sseRes.writableEnded) {
        s.sseRes.write('event: error\ndata: {"message":"Process exited with code '+code+'"}\n\n');
        s.sseRes.end();
      }
      sessions.delete(id);
    }
    console.log(`[session] ${id.slice(0,8)} process exited: ${code}`);
  });

  const session = {
    id,
    process: child,
    sseRes: null,
    createdAt: Date.now(),
    buffer: '',
    pendingCallback: null,
  };

  // 持续读取 stdout 数据
  child.stdout.on('data', (chunk) => {
    session.buffer += chunk.toString();
    // 如果有等待的请求回调，尝试解析
    if (session.pendingCallback) {
      try {
        const lines = session.buffer.split('\n');
        // 找完整的 JSON-RPC 响应（以换行分隔的 JSON 行）
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && msg.id !== null) {
              // 这是对请求的响应
              session.buffer = lines.slice(i + 1).join('\n');
              const cb = session.pendingCallback;
              session.pendingCallback = null;
              cb(null, msg);
              return;
            }
          } catch(e) { /* 不是完整 JSON，继续等 */ }
        }
      } catch(e) {}
    }
  });

  sessions.set(id, session);
  console.log(`[session] created: ${id}`);
  return session;
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // GET /sse — SSE 连接
  if (req.method === 'GET' && req.url === '/sse') {
    const session = createSession();
    session.sseRes = res;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // 发送 endpoint 事件
    res.write(`event: endpoint\ndata: /message?sessionId=${session.id}\n\n`);

    // 保持连接，定期心跳
    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(heartbeat);
        return;
      }
      res.write(': heartbeat\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      if (session.sseRes === res) session.sseRes = null;
      console.log(`[sse] client disconnected: ${session.id.slice(0,8)}`);
    });

    return;
  }

  // POST /message?sessionId=xxx — 发送 JSON-RPC 请求
  if (req.method === 'POST' && req.url.startsWith('/message')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const sessionId = url.searchParams.get('sessionId');
    
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -1, message: 'Session not found' },
        id: null
      }));
    }

    const session = sessions.get(sessionId);
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      let request;
      try {
        request = JSON.parse(body);
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id: null
        }));
      }

      const timeout = setTimeout(() => {
        if (session.pendingCallback) {
          session.pendingCallback = null;
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -1, message: `Timeout after ${MCP_TIMEOUT}ms` },
            id: request.id || null
          }));
        }
      }, MCP_TIMEOUT);

      session.pendingCallback = (err, response) => {
        clearTimeout(timeout);
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -1, message: err.message },
            id: request.id || null
          }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      };

      // 写入子进程 stdin（JSON-RPC 以换行分隔）
      session.process.stdin.write(JSON.stringify(request) + '\n');
      session.createdAt = Date.now(); // 刷新活动时间
    });
    return;
  }

  // 健康检查
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      sessions: sessions.size,
      uptime: process.uptime()
    }));
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MCP SSE Gateway listening on port ${PORT}`);
  console.log(`MCP timeout: ${MCP_TIMEOUT}ms`);
  console.log(`Token configured: ${TOKEN ? 'yes' : 'no'}`);
});
