const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');

const PORT = process.env.PORT || 3001;
const MCP_TIMEOUT = parseInt(process.env.MCP_TIMEOUT || '60000');
const TOKEN = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '';

const sessions = new Map();

// 过期清理
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > 600000) {
      try { s.process.kill(); } catch(e) {}
      sessions.delete(id);
    }
  }
}, 60000);

function createSession() {
  const id = crypto.randomUUID();
  
  let child;
  try {
    child = spawn('npx', ['-y', '@modelcontextprotocol/server-github'], {
      env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: TOKEN },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,
    });
  } catch(e) {
    console.error(`[session] spawn failed: ${e.message}`);
    return null;
  }

  const session = {
    id, process: child, sseRes: null,
    createdAt: Date.now(), buffer: '', pendingCallback: null,
  };

  child.on('error', (err) => {
    console.error(`[session:${id.slice(0,8)}] spawn error: ${err.message}`);
    sessions.delete(id);
  });

  child.stderr.on('data', (d) => {
    console.log(`[stderr:${id.slice(0,8)}] ${d.toString().trim()}`);
  });

  child.on('exit', (code) => {
    const s = sessions.get(id);
    if (s) {
      if (s.sseRes && !s.sseRes.writableEnded) {
        try { s.sseRes.write(`event: error\ndata: {"message":"Process exited ${code}"}\n\n`); } catch(e) {}
        try { s.sseRes.end(); } catch(e) {}
      }
      if (s.pendingCallback) {
        try {
          s.pendingCallback(new Error(`Process exited ${code}`), null);
        } catch(e) {}
      }
      sessions.delete(id);
    }
  });

  child.stdout.on('data', (chunk) => {
    session.buffer += chunk.toString();
    if (session.pendingCallback) {
      try {
        const lines = session.buffer.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && msg.id !== null) {
              session.buffer = lines.slice(i + 1).join('\n');
              const cb = session.pendingCallback;
              session.pendingCallback = null;
              cb(null, msg);
              return;
            }
          } catch(e) {}
        }
      } catch(e) {}
    }
  });

  sessions.set(id, session);
  console.log(`[session] created: ${id.slice(0,8)}`);
  return session;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  // GET /sse
  if (req.method === 'GET' && req.url === '/sse') {
    const session = createSession();
    if (!session) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc:'2.0', error:{code:-1, message:'Failed to start MCP server'}, id: null }));
    }
    session.sseRes = res;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.write(`event: endpoint\ndata: /message?sessionId=${session.id}\n\n`);

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        try { res.write(': heartbeat\n\n'); } catch(e) { clearInterval(heartbeat); }
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      if (session.sseRes === res) session.sseRes = null;
    });

    return;
  }

  // POST /message?sessionId=xxx
  if (req.method === 'POST' && req.url.startsWith('/message')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const sessionId = url.searchParams.get('sessionId');
    const session = sessions.get(sessionId);

    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc:'2.0', error:{code:-1, message:'Session not found'}, id: null }));
    }

    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let request;
      try { request = JSON.parse(body); } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc:'2.0', error:{code:-32700, message:'Parse error'}, id: null }));
      }

      const timeout = setTimeout(() => {
        if (session.pendingCallback) {
          session.pendingCallback = null;
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc:'2.0', error:{code:-1, message:`Timeout after ${MCP_TIMEOUT}ms`}, id:request.id||null }));
        }
      }, MCP_TIMEOUT);

      session.pendingCallback = (err, response) => {
        clearTimeout(timeout);
        if (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ jsonrpc:'2.0', error:{code:-1, message:err.message}, id:request.id||null }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      };

      try {
        session.process.stdin.write(JSON.stringify(request) + '\n');
        session.createdAt = Date.now();
      } catch(e) {
        clearTimeout(timeout);
        session.pendingCallback = null;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc:'2.0', error:{code:-1, message:'stdin write failed: '+e.message}, id:request.id||null }));
      }
    });
    return;
  }

  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status:'ok', sessions: sessions.size, uptime: process.uptime() }));
  }

  res.writeHead(404); res.end('Not Found');
});

// 全局错误捥莽，防止未处理异常权歰授进程
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED:', reason);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MCP SSE Gateway v2 on :${PORT}`);
  console.log(`Timeout: ${MCP_TIMEOUT}ms | Token: ${TOKEN ? 'yes' : 'no'}`);
});
