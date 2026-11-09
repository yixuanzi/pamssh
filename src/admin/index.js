import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ENV_OVERRIDES, resolveTarget } from '../config.js';
import { ConfigConflictError, ConfigValidationError } from '../config-store.js';
import { listAgentIdentities } from '../agent.js';
import { checkPolicy } from '../policy.js';
import { scanHostKey } from '../ssh/scan.js';
import { VERSION } from '../version.js';
import { AdminAuth, sameOriginWrite } from './auth.js';
import { FIELD_META } from './fields.js';
import { lintConfig, previewTargets } from './lint.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC = {
  '/admin': ['index.html', 'text/html; charset=utf-8'],
  '/admin/': ['index.html', 'text/html; charset=utf-8'],
  '/admin/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/admin/app.css': ['app.css', 'text/css; charset=utf-8'],
};
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};
export const SECRET_MASK = '__PAMSSH_UNCHANGED__';
const SECRET_PATHS = [['server', 'authToken'], ['server', 'adminToken']];
const MAX_BODY = 2 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const getIn = (obj, p) => p.reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setIn(obj, p, value) {
  let o = obj;
  for (const k of p.slice(0, -1)) o = o[k] ??= {};
  if (value === undefined) delete o[p.at(-1)];
  else o[p.at(-1)] = value;
}

function maskSecrets(raw) {
  const copy = structuredClone(raw);
  for (const p of SECRET_PATHS) if (typeof getIn(copy, p) === 'string') setIn(copy, p, SECRET_MASK);
  return copy;
}

/** Put real secret values back where the browser sent the mask. */
function unmaskSecrets(raw, onDisk) {
  const copy = structuredClone(raw);
  for (const p of SECRET_PATHS) {
    if (getIn(copy, p) === SECRET_MASK) setIn(copy, p, getIn(onDisk, p));
  }
  return copy;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function tailFile(file, maxBytes = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // partial first line
    return lines.filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Admin web UI + JSON API mounted under /admin on the HTTP server.
 * @returns {(req, res, url) => Promise<boolean>} true when the request was handled
 */
export function createAdmin({ store, manager, logger, running, mcpSessions, startedAt = Date.now(), cliLogLevel }) {
  const getConfig = () => store.config;
  const auth = new AdminAuth({
    getToken: () => getConfig().server.adminToken,
    getIdleMinutes: () => getConfig().server.adminSessionMinutes,
    logger: logger.child('admin'),
  });
  auth.syncToken();
  const log = logger.child('admin');

  function restartRequired(cfg = getConfig()) {
    const out = [];
    for (const k of ['host', 'port', 'path']) {
      if (cfg.server[k] !== running.configured[k]) {
        out.push({ path: ['server', k], running: running[k], configured: cfg.server[k] });
      }
    }
    return out;
  }

  function apply(config, keepSid) {
    const result = manager.updateConfig(config);
    if (!cliLogLevel && !process.env.PAMSSH_LOG_LEVEL) logger.setLevel(config.logLevel ?? 'info');
    auth.syncToken(keepSid);
    return { ...result, restartRequired: restartRequired(config) };
  }

  function envOverrides() {
    return Object.entries(ENV_OVERRIDES)
      .filter(([name]) => process.env[name])
      .map(([name, p]) => ({ name, path: p.split('.') }));
  }

  function validateDraft(raw) {
    const { raw: onDisk } = store.readRaw();
    const full = unmaskSecrets(raw, onDisk);
    const r = store.validate(full);
    return {
      ok: r.ok,
      issues: r.issues,
      warnings: r.ok ? lintConfig(r.config) : [],
      preview: r.ok ? previewTargets(r.config) : null,
      restartRequired: r.ok ? restartRequired(r.config) : [],
      config: r.config,
    };
  }

  const routes = {
    'GET /api/session': (req, ctx) => ({
      enabled: auth.enabled,
      authenticated: Boolean(ctx.session),
      version: VERSION,
      expiresAt: ctx.session?.expiresAt ?? null,
    }),

    'POST /api/login': async (req) => {
      const { token } = await readJson(req);
      const r = auth.login(typeof token === 'string' ? token.trim() : '', req.socket.remoteAddress);
      if (!r.ok) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        throw new HttpError(r.status, r.error, r.retryAfter ? { headers: { 'retry-after': String(r.retryAfter) } } : {});
      }
      return { body: { ok: true }, headers: { 'set-cookie': auth.cookie(r.sid) } };
    },

    'POST /api/logout': (req, ctx) => {
      auth.logout(ctx.session?.sid);
      return { body: { ok: true }, headers: { 'set-cookie': auth.clearCookie() } };
    },

    'GET /api/meta': () => ({
      version: VERSION,
      fields: FIELD_META,
      secretMask: SECRET_MASK,
      envOverrides: envOverrides(),
      configFile: store.file,
      running,
    }),

    'GET /api/config': () => {
      const { raw, version } = store.readRaw();
      return { raw: maskSecrets(raw), version, file: store.file };
    },

    'POST /api/config/validate': async (req) => {
      const { raw } = await readJson(req);
      if (!raw || typeof raw !== 'object') throw new HttpError(400, '缺少 raw');
      const r = validateDraft(raw);
      delete r.config;
      return r;
    },

    'PUT /api/config': async (req, ctx) => {
      const { raw, baseVersion } = await readJson(req);
      if (!raw || typeof raw !== 'object') throw new HttpError(400, '缺少 raw');
      const { raw: onDisk } = store.readRaw();
      const full = unmaskSecrets(raw, onDisk);
      const saved = store.save(full, { baseVersion });
      const applied = apply(saved.config, ctx.session?.sid);
      log.info(`configuration saved and applied (version ${saved.version})`);
      return { ok: true, version: saved.version, applied, warnings: lintConfig(saved.config) };
    },

    'POST /api/config/reload': (req, ctx) => {
      const r = store.reload();
      const applied = r.changed ? apply(r.config, ctx.session?.sid) : null;
      if (r.changed) log.info('configuration reloaded from disk');
      return { ok: true, changed: r.changed, version: r.version, applied };
    },

    'GET /api/backups': () => ({ backups: store.listBackups() }),

    'GET /api/backup': (req, ctx, url) => ({ raw: maskSecrets(store.readBackup(url.searchParams.get('name') || '')) }),

    'POST /api/backup/restore': async (req, ctx) => {
      const { name, baseVersion } = await readJson(req);
      const raw = store.readBackup(String(name || ''));
      const saved = store.save(raw, { baseVersion });
      const applied = apply(saved.config, ctx.session?.sid);
      log.info(`configuration restored from backup ${name}`);
      return { ok: true, version: saved.version, applied };
    },

    'POST /api/secret/reveal': async (req) => {
      const { name } = await readJson(req);
      const p = SECRET_PATHS.find((sp) => sp.at(-1) === name);
      if (!p) throw new HttpError(400, '未知的令牌名');
      const { raw } = store.readRaw();
      log.info(`admin revealed ${name}`);
      return { value: getIn(raw, p) ?? null, envOverride: Boolean(process.env[name === 'authToken' ? 'PAMSSH_MCP_TOKEN' : 'PAMSSH_ADMIN_TOKEN']) };
    },

    'POST /api/token/generate': () => ({ value: randomBytes(32).toString('base64url') }),

    'GET /api/status': async () => {
      const cfg = getConfig();
      const sock = manager.agentSocketFor({});
      let agent = { path: sock.path, source: sock.source, reachable: false, keys: 0, error: null };
      try {
        const keys = await listAgentIdentities(sock.path);
        agent = { ...agent, reachable: true, keys: keys.length };
      } catch (err) {
        agent.error = err.message;
      }
      const sessions = manager.listSessions();
      return {
        version: VERSION,
        pid: process.pid,
        node: process.version,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        configFile: store.file,
        configVersion: store.version,
        running,
        mcpUrl: `http://${running.host.includes(':') ? `[${running.host}]` : running.host}:${running.port}${running.path}`,
        restartRequired: restartRequired(),
        logLevel: logger.level,
        agent,
        counts: {
          pamServers: Object.keys(cfg.pamServers).length,
          targets: Object.keys(cfg.targets).length,
          sessions: sessions.length,
          activeSessions: sessions.filter((s) => s.state === 'ready').length,
          staleSessions: sessions.filter((s) => s.stale).length,
          mcpClients: mcpSessions.size,
          adminSessions: auth.sessions.size,
        },
        envOverrides: envOverrides(),
        warnings: lintConfig(cfg),
      };
    },

    'GET /api/agent/keys': async (req, ctx, url) => {
      const socket = url.searchParams.get('socket');
      const sock = manager.agentSocketFor(socket ? { agentSocket: socket } : {});
      try {
        return { socket: sock, keys: await listAgentIdentities(sock.path) };
      } catch (err) {
        throw new HttpError(502, err.message);
      }
    },

    'GET /api/sessions': () => ({
      sessions: manager.listSessions().map((s) => {
        const t = resolveTarget(getConfig(), s.target);
        const idleMin = t?.idleTimeoutMinutes ?? 0;
        return { ...s, idleTimeoutMinutes: idleMin };
      }),
    }),

    'POST /api/sessions/close': async (req) => {
      const { target, session } = await readJson(req);
      const closed = manager.closeSession(String(target), String(session || 'default'));
      log.info(`admin closed session ${target}/${session || 'default'}`);
      return { ok: true, closed };
    },

    'POST /api/targets/test': async (req) => {
      const { target } = await readJson(req);
      const session = 'admin-test';
      const started = Date.now();
      try {
        const status = await manager.openSession(String(target), session);
        let output = null;
        let policyError = null;
        try {
          const r = await manager.exec(String(target), 'id; hostname; pwd', {
            session, timeoutMs: 20000, actor: { client: 'admin-ui' },
          });
          output = r.output;
        } catch (err) {
          policyError = err.message;
        }
        return { ok: true, durationMs: Date.now() - started, login: status.login, hostKey: status.hostKey, output, note: policyError };
      } catch (err) {
        return { ok: false, durationMs: Date.now() - started, error: err.message };
      } finally {
        manager.closeSession(String(target), session);
      }
    },

    'POST /api/policy/test': async (req) => {
      const { raw, target, command } = await readJson(req);
      if (typeof command !== 'string' || !command.trim()) throw new HttpError(400, '请输入要测试的命令');
      let cfg = getConfig();
      if (raw) {
        const r = validateDraft(raw);
        if (!r.ok) throw new HttpError(400, '当前草稿有错误，先修正后再测试', { issues: r.issues });
        cfg = r.config;
      }
      const layers = [{ name: '全局策略', policy: cfg.policy }];
      if (target) {
        const t = cfg.targets[target];
        if (!t) throw new HttpError(404, `目标 "${target}" 不存在`);
        layers.push({ name: `目标 ${target} 的策略`, policy: t.policy });
      }
      const v = checkPolicy(command, layers.map((l) => l.policy));
      return {
        allowed: v.allowed,
        decidedBy: v.layer !== undefined ? layers[v.layer].name : null,
        kind: v.kind ?? null,
        rule: v.rule ?? null,
        matched: (v.matched ?? []).map((m) => ({ layer: layers[m.layer].name, rule: m.rule })),
      };
    },

    'GET /api/audit': (req, ctx, url) => {
      const cfg = getConfig();
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 2000);
      const target = url.searchParams.get('target') || '';
      const event = url.searchParams.get('event') || '';
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const out = [];
      const lines = tailFile(cfg.audit.file);
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        let e;
        try { e = JSON.parse(lines[i]); } catch { continue; }
        if (target && e.target !== target) continue;
        if (event && e.event !== event) continue;
        if (q && !JSON.stringify(e).toLowerCase().includes(q)) continue;
        out.push(e);
      }
      return { file: cfg.audit.file, enabled: cfg.audit.enabled, entries: out };
    },

    'GET /api/hostkeys': () => {
      const cfg = getConfig();
      let known = {};
      try { known = JSON.parse(fs.readFileSync(cfg.hostKeys.file, 'utf8')); } catch { /* none yet */ }
      const pinned = Object.values(cfg.pamServers).map((p) => ({
        pam: p.id, hostId: `${p.host}:${p.port}`, fingerprints: p.hostFingerprints,
      }));
      return { file: cfg.hostKeys.file, trustOnFirstUse: cfg.hostKeys.trustOnFirstUse, known, pinned };
    },

    'POST /api/hostkeys/delete': async (req) => {
      const { hostId } = await readJson(req);
      const file = getConfig().hostKeys.file;
      let known = {};
      try { known = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none */ }
      if (!Object.hasOwn(known, hostId)) throw new HttpError(404, '没有这条记录');
      delete known[hostId];
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(known, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
      log.info(`admin removed recorded host key for ${hostId}`);
      return { ok: true };
    },

    'POST /api/hostkeys/scan': async (req) => {
      const { host, port } = await readJson(req);
      if (typeof host !== 'string' || !host.trim()) throw new HttpError(400, '请输入主机');
      const p = Number(port) || 22;
      try {
        const r = await scanHostKey(host.trim(), p);
        let known = {};
        try { known = JSON.parse(fs.readFileSync(getConfig().hostKeys.file, 'utf8')); } catch { /* none */ }
        return { ...r, hostId: `${host.trim()}:${p}`, recorded: known[`${host.trim()}:${p}`] ?? [] };
      } catch (err) {
        throw new HttpError(502, err.message);
      }
    },

    'GET /api/logs': (req, ctx, url) => ({
      level: logger.level,
      entries: logger.recent({ limit: 500, afterSeq: Number(url.searchParams.get('after')) || 0 }),
    }),
  };

  const PUBLIC_ROUTES = new Set(['GET /api/session', 'POST /api/login']);

  return async function handleAdmin(req, res, url) {
    const p = url.pathname;
    if (p !== '/admin' && !p.startsWith('/admin/')) return false;

    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      const body = fs.readFileSync(path.join(PUBLIC_DIR, file));
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type });
      res.end(body);
      return true;
    }

    const key = `${req.method} ${p.slice('/admin'.length)}`;
    const handler = routes[key];
    if (!handler) {
      send(res, 404, { error: '未找到' });
      return true;
    }
    try {
      const session = auth.authenticate(req);
      if (!PUBLIC_ROUTES.has(key)) {
        if (!session) throw new HttpError(401, '未登录或登录已过期');
        if (req.method !== 'GET' && !session.bearer && !sameOriginWrite(req)) {
          throw new HttpError(403, '请求来源校验失败');
        }
      } else if (req.method === 'POST' && !sameOriginWrite(req)) {
        throw new HttpError(403, '请求来源校验失败');
      }
      const out = await handler(req, { session }, url);
      if (out && out.body !== undefined && out.headers) send(res, 200, out.body, out.headers);
      else send(res, 200, out);
    } catch (err) {
      if (err instanceof ConfigValidationError) return send(res, 400, { error: err.message, issues: err.issues }), true;
      if (err instanceof ConfigConflictError) return send(res, 409, { error: err.message }), true;
      const status = err.status || 500;
      if (status >= 500) log.error(`admin API ${key} failed: ${err.message}`);
      send(res, status, { error: status >= 500 && !err.status ? '服务器内部错误' : err.message, ...(err.issues ? { issues: err.issues } : {}) },
        err.headers || {});
    }
    return true;
  };
}

