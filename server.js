const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const state = {
  mode: 'fail',
  requests: 0,
  attempts: 0,
  flakyThreshold: 2,
  startedAt: Date.now()
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname === '/api/health') {
      handleHealth(request, response);
      return;
    }

    if (url.pathname === '/api/mode' && request.method === 'POST') {
      await handleMode(request, response);
      return;
    }

    if (url.pathname === '/api/reset' && request.method === 'POST') {
      state.requests = 0;
      state.attempts = 0;
      sendJson(response, 200, { ok: true, state: snapshot() });
      return;
    }

    if (url.pathname === '/api/status') {
      sendJson(response, 200, { ok: true, state: snapshot() });
      return;
    }

    serveStatic(url.pathname, response);
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error.message
    });
  }
});

function handleHealth(request, response) {
  state.requests += 1;
  state.attempts += Number(request.headers['x-attempt'] || 0);

  if (state.mode === 'timeout') {
    const timer = setTimeout(() => {
      if (!response.writableEnded) {
        try {
          sendJson(response, 200, {
            ok: true,
            delayed: true,
            server: snapshot()
          });
        } catch {
          // Client may have aborted while the delayed response was pending.
        }
      }
    }, 7000);
    response.once('close', () => clearTimeout(timer));
    return;
  }

  if (state.mode === 'flaky') {
    const callNumber = state.requests;
    if (callNumber % state.flakyThreshold !== 1) {
      sendJson(response, 503, {
        ok: false,
        error: 'FLAKY_FAILURE',
        server: snapshot()
      });
      return;
    }
  }

  if (state.mode === 'fail') {
    sendJson(response, 500, {
      ok: false,
      error: 'DEPENDENCY_FAILURE',
      server: snapshot()
    });
    return;
  }

  sendJson(response, 200, {
    ok: true,
    mode: state.mode,
    at: new Date().toISOString(),
    server: snapshot()
  });
}

async function handleMode(request, response) {
  const body = await readJson(request);
  if (!['success', 'fail', 'flaky', 'timeout'].includes(body.mode)) {
    sendJson(response, 400, {
      ok: false,
      error: 'invalid mode'
    });
    return;
  }
  state.mode = body.mode;
  sendJson(response, 200, {
    ok: true,
    state: snapshot()
  });
}

function serveStatic(pathname, response) {
  const safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const relativePath = safePath === '/' ? '/index.html' : safePath;
  const filePath = path.join(ROOT, relativePath);

  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    sendJson(response, 403, { ok: false, error: 'forbidden' });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(response, 404, { ok: false, error: 'not found' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream'
    });
    response.end(data);
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        reject(new Error('payload too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function snapshot() {
  return {
    mode: state.mode,
    requests: state.requests,
    attempts: state.attempts,
    uptimeMs: Date.now() - state.startedAt
  };
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT=xxxx npm start.`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
