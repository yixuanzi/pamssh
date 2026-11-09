import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './tools.js';
import { VERSION } from '../version.js';

const MAX_BODY = 4 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const sha256 = (s) => createHash('sha256').update(s).digest();

function sendJson(res, status, obj, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
}

function rpcError(res, status, code, message) {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Parse error: body is not valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0];
}

/**
 * Streamable HTTP MCP endpoint (MCP spec 2025-03-26+), stateful: one MCP
 * session (and McpServer instance) per client, all sharing one SessionManager.
 */
export async function startHttpServer({ config, manager, logger, host: hostOverride, port: portOverride }) {
  const opts = config.server;
  const bindHost = hostOverride ?? opts.host;
  const bindPort = portOverride ?? opts.port;
  if (!opts.authToken) {
    throw new Error('server.authToken is not set. Run `pamssh-mcp init` (or `pamssh-mcp token --rotate`) '
      + 'or set PAMSSH_MCP_TOKEN.');
  }
  const tokenHash = sha256(opts.authToken);
  const loopbackBind = LOOPBACK.has(bindHost);
  const sessions = new Map();

  const authorized = (req) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    return Boolean(m) && timingSafeEqual(sha256(m[1].trim()), tokenHash);
  };

  const hostAllowed = (req) => {
    const h = req.headers.host || '';
    if (opts.allowedHosts.length) return opts.allowedHosts.includes(h) || opts.allowedHosts.includes(hostnameOf(h));
    return loopbackBind ? LOOPBACK.has(hostnameOf(h)) : true;
  };

  const originAllowed = (req) => {
    const origin = req.headers.origin;
    return !origin || opts.allowedOrigins.includes(origin);
  };

  async function newSession(req, res, body) {
    let transport;
    const mcp = createMcpServer(manager, { logger });
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, mcp, lastSeen: Date.now() });
        logger.info(`MCP session ${id} opened (${req.socket.remoteAddress})`);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.delete(id)) logger.info(`MCP session ${id} closed`);
    };
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, name: 'pamssh-mcp', version: VERSION });
    }
    if (url.pathname !== opts.path) return sendJson(res, 404, { error: 'not found' });
    if (!hostAllowed(req)) return sendJson(res, 403, { error: `host ${req.headers.host} not allowed` });
    if (!originAllowed(req)) return sendJson(res, 403, { error: `origin ${req.headers.origin} not allowed` });
    if (!authorized(req)) {
      return sendJson(res, 401, { error: 'missing or invalid bearer token' }, { 'www-authenticate': 'Bearer' });
    }

    const sid = req.headers['mcp-session-id'];
    const entry = sid ? sessions.get(sid) : undefined;

    if (req.method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        return rpcError(res, err.status || 400, -32700, err.message);
      }
      if (entry) {
        entry.lastSeen = Date.now();
        return entry.transport.handleRequest(req, res, body);
      }
      if (sid) return rpcError(res, 404, -32001, 'Session not found');
      if (isInitializeRequest(body)) return newSession(req, res, body);
      return rpcError(res, 400, -32000, 'Bad Request: no valid MCP session id; send initialize first');
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!sid) return rpcError(res, 400, -32000, 'Bad Request: missing mcp-session-id header');
      if (!entry) return rpcError(res, 404, -32001, 'Session not found');
      entry.lastSeen = Date.now();
      return entry.transport.handleRequest(req, res);
    }

    res.writeHead(405, { allow: 'GET, POST, DELETE' }).end();
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error(`HTTP handler error: ${err.message}`, err);
      rpcError(res, 500, -32603, 'Internal server error');
    });
  });

  const reaper = setInterval(() => {
    const cutoff = Date.now() - opts.mcpSessionIdleMinutes * 60_000;
    for (const [id, e] of sessions) {
      if (e.lastSeen < cutoff) {
        logger.info(`MCP session ${id} idle, closing`);
        e.transport.close().catch(() => {});
        sessions.delete(id);
      }
    }
  }, 60_000);
  reaper.unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(bindPort, bindHost, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  const shownHost = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  const url = `http://${shownHost}:${addr.port}${opts.path}`;
  if (!loopbackBind) {
    logger.warn(`listening on non-loopback address ${bindHost}: anyone who can reach it with the token gets a `
      + 'privileged shell. Put it behind TLS and restrict network access.');
  }

  return {
    url,
    port: addr.port,
    server,
    sessions,
    async close() {
      clearInterval(reaper);
      await Promise.allSettled([...sessions.values()].map((e) => e.transport.close()));
      sessions.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
