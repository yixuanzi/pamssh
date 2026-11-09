import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ConfigSchema, validateConfig } from '../src/config.js';
import { ConfigStore, ConfigConflictError, ConfigValidationError } from '../src/config-store.js';
import { FIELD_META, GLOBAL_SECTIONS, PAM_FIELDS, TARGET_FIELDS } from '../src/admin/fields.js';
import { lintConfig } from '../src/admin/lint.js';
import { SessionManager } from '../src/session-manager.js';
import { startHttpServer } from '../src/mcp/http-server.js';
import { silentLogger, createLogger } from '../src/logger.js';
import { tmpDir } from './helpers.js';

const ADMIN = 'A'.repeat(24);
const MCP = 'M'.repeat(24);
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function writeConfig(extra = {}) {
  const dir = tmpDir();
  dirs.push(dir);
  const file = path.join(dir, 'config.json');
  const raw = {
    server: { port: 0, authToken: MCP, adminToken: ADMIN },
    audit: { file: path.join(dir, 'audit.jsonl') },
    hostKeys: { file: path.join(dir, 'known.json') },
    pamServers: { pam: { host: '127.0.0.1', port: 1, user: 'alice' } },
    targets: {
      web: { host: 'web-01', account: 'root' },
      db: { host: 'db-01', account: 'ro', policy: { allow: ['^ls\\b'] } },
    },
    ...extra,
  };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  return { dir, file, raw };
}

// ---------- field help coverage ----------
function unwrap(s) {
  let t = s;
  while (t._zod.def.innerType) t = t._zod.def.innerType;
  return t;
}
function keysOf(s) {
  const t = unwrap(s);
  if (t._zod.def.type === 'record') return keysOf(t._zod.def.valueType);
  return t._zod.def.shape ? Object.keys(t._zod.def.shape) : null;
}
function shapeOf(s) {
  const t = unwrap(s);
  return t._zod.def.type === 'record' ? shapeOf(t._zod.def.valueType) : t._zod.def.shape;
}

function checkCoverage(schema, fields, where) {
  const metaKeys = fields.map((f) => f.key);
  for (const k of keysOf(schema)) {
    assert.ok(metaKeys.includes(k), `${where}.${k} has no help entry in src/admin/fields.js`);
    const f = fields.find((x) => x.key === k);
    assert.ok(f.label && f.help && f.help.length > 10, `${where}.${k} needs a label and a real help text`);
    if (f.type === 'group') checkCoverage(shapeOf(schema)[k], f.fields, `${where}.${k}`);
  }
  for (const k of metaKeys) assert.ok(keysOf(schema).includes(k), `${where}.${k} is described but not in the schema`);
}

test('every config field has help metadata (and nothing stale)', () => {
  const top = shapeOf(ConfigSchema);
  for (const sec of GLOBAL_SECTIONS) {
    if (sec.path.length) checkCoverage(top[sec.path[0]], sec.fields, sec.path[0]);
  }
  const misc = GLOBAL_SECTIONS.find((s) => s.id === 'misc').fields.map((f) => f.key);
  const covered = [...GLOBAL_SECTIONS.filter((s) => s.path.length).map((s) => s.path[0]), ...misc, 'pamServers', 'targets', '$schema'];
  for (const k of Object.keys(top)) assert.ok(covered.includes(k), `top-level "${k}" is not shown in the admin UI`);
  checkCoverage(top.pamServers, PAM_FIELDS, 'pamServers.*');
  checkCoverage(top.targets, TARGET_FIELDS, 'targets.*');
  const types = new Set(['string', 'int', 'number', 'bool', 'enum', 'list', 'regexList', 'tags', 'secret', 'json', 'group', 'pamRef', 'stringOrList']);
  const all = (fs_) => fs_.flatMap((f) => (f.fields ? [f, ...all(f.fields)] : [f]));
  for (const f of all([...GLOBAL_SECTIONS.flatMap((s) => s.fields), ...PAM_FIELDS, ...TARGET_FIELDS])) {
    assert.ok(types.has(f.type), `${f.key}: unknown type ${f.type}`);
    if (f.type === 'enum') assert.ok(f.options?.length, `${f.key}: enum needs options`);
  }
  assert.ok(FIELD_META.idPattern && FIELD_META.idHelp);
});

test('field help examples use only generic placeholder data', () => {
  const text = JSON.stringify(FIELD_META);
  for (const ip of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []) {
    assert.match(ip, /^(10\.0\.0\.\d+|127\.0\.0\.1|0\.0\.0\.0)$/, `example IP ${ip} looks like a real address`);
  }
  for (const m of text.matchAll(/"example":"([^"]*@[^"]*)"/g)) {
    assert.match(m[1], /^(alice|\{pamUser\})@/, `example login ${m[1]} should use the alice placeholder`);
  }
});

// ---------- validation & lint ----------
test('validateConfig gives Chinese messages with array paths', () => {
  const { raw } = writeConfig();
  raw.targets['a.b'] = { host: 'h', account: 'x', mode: 'nope', typo: 1 };
  raw.server.adminToken = MCP;
  const r = validateConfig(raw, { locale: 'zh' });
  assert.equal(r.ok, false);
  const byPath = Object.fromEntries(r.issues.map((i) => [i.path.join('|'), i.message]));
  assert.match(byPath['targets|a.b|mode'], /无效选项/);
  assert.match(byPath['targets|a.b|typo'], /未知字段/);
  delete raw.targets['a.b'];
  const r2 = validateConfig(raw, { locale: 'zh' });
  assert.match(r2.issues.find((i) => i.path.join('.') === 'server.adminToken').message, /不能与/);
  raw.server.adminToken = ADMIN;
  raw.server.path = '/admin';
  assert.match(validateConfig(raw, { locale: 'zh' }).issues[0].message, /冲突/);
});

test('lint flags risky settings', () => {
  const { raw } = writeConfig();
  raw.server.host = '0.0.0.0';
  raw.defaults = { idleTimeoutMinutes: 0, maxOutputChars: 50000 };
  raw.audit.enabled = false;
  raw.hostKeys.trustOnFirstUse = false;
  delete raw.server.adminToken;
  const w = lintConfig(validateConfig(raw).config).map((x) => `${x.level}:${x.path.join('.')}`);
  for (const expected of ['warn:server.host', 'warn:server.adminToken', 'warn:defaults.idleTimeoutMinutes',
    'warn:defaults.maxOutputChars', 'warn:audit.enabled', 'warn:pamServers.pam.hostFingerprint', 'warn:pamServers.pam.identity',
    'info:targets.db.policy.allow.0']) {
    assert.ok(w.includes(expected) || (expected.endsWith('allow.0') && !w.includes(expected)), `missing ${expected}: ${w}`);
  }
  assert.ok(w.includes('info:targets.web.description'));
});

// ---------- config store ----------
test('ConfigStore: atomic save, backups, conflicts, reload', () => {
  const { file, raw } = writeConfig();
  const store = ConfigStore.load(file);
  const v0 = store.version;
  raw.defaults = { idleTimeoutMinutes: 5 };
  const r = store.save(raw, { baseVersion: v0 });
  assert.equal(r.config.defaults.idleTimeoutMinutes, 5);
  assert.notEqual(store.version, v0);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(store.listBackups().length, 1);
  assert.throws(() => store.save(raw, { baseVersion: v0 }), ConfigConflictError);
  raw.targets.web.mode = 'bad';
  assert.throws(() => store.save(raw, { baseVersion: store.version }), (e) => e instanceof ConfigValidationError && e.issues.length === 1);
  // manual edit on disk, then reload
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  disk.defaults.idleTimeoutMinutes = 9;
  fs.writeFileSync(file, JSON.stringify(disk));
  const rl = store.reload();
  assert.equal(rl.changed, true);
  assert.equal(store.config.defaults.idleTimeoutMinutes, 9);
  assert.equal(store.reload().changed, false);
  const restored = store.readBackup(store.listBackups()[0].name);
  assert.equal(restored.defaults, undefined);
  assert.throws(() => store.readBackup('../config.json'), /无效/);
});

test('SessionManager.updateConfig applies policy live and closes removed targets', async () => {
  const { file, raw } = writeConfig();
  const store = ConfigStore.load(file);
  const m = new SessionManager(store.config, { logger: silentLogger });
  m._session('web', 'default'); // created, not connected
  await assert.rejects(m.exec('db', 'rm -rf /x'), /blocked by policy/);
  raw.targets.db.policy = { allow: ['^rm\\b'] };
  delete raw.targets.web;
  const res = m.updateConfig(store.save(raw).config);
  assert.deepEqual(res.closedSessions, ['web#default']);
  assert.equal(m.listSessions().length, 0);
  await assert.rejects(m.exec('web', 'id'), /unknown target "web"/);
  // db now allows rm: fails later on connect (port 1), not on policy
  await assert.rejects(m.exec('db', 'rm -rf /x'), (e) => !/blocked by policy/.test(e.message));
  await m.closeAll();
});

// ---------- admin HTTP API ----------
async function startAdmin(extra) {
  const cfg = writeConfig(extra);
  const store = ConfigStore.load(cfg.file);
  const logger = createLogger('error', { stream: { write() {} } });
  const manager = new SessionManager(store.config, { logger });
  const http = await startHttpServer({ store, manager, logger });
  const base = `http://127.0.0.1:${http.port}`;
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', 'x-pamssh-admin': '1', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return {
    ...cfg, store, manager, http, base, call,
    clearCookie: () => { cookie = ''; },
    async close() { await manager.closeAll(); await http.close(); },
  };
}

test('admin: static page, security headers, login, CSRF, masking', async () => {
  const a = await startAdmin();
  try {
    const page = await fetch(`${a.base}/admin`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal((await fetch(`${a.base}/admin/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
    // Host header check (DNS rebinding) also covers /admin
    const evil = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: a.http.port, path: '/admin/api/session', headers: { host: 'evil.example' } },
        (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(evil, 403);

    assert.equal((await a.call('GET', '/admin/api/config')).status, 401);
    assert.equal((await a.call('POST', '/admin/api/login', { token: ADMIN }, { 'x-pamssh-admin': '' })).status, 403);
    assert.equal((await a.call('POST', '/admin/api/login', { token: MCP })).status, 401, 'MCP token must not open the admin UI');
    const ok = await a.call('POST', '/admin/api/login', { token: ADMIN });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await a.call('GET', '/admin/api/session')).json.authenticated, true);

    const cfg = await a.call('GET', '/admin/api/config');
    assert.equal(cfg.json.raw.server.authToken, '__PAMSSH_UNCHANGED__');
    assert.equal(cfg.json.raw.server.adminToken, '__PAMSSH_UNCHANGED__');
    assert.ok(!cfg.text.includes(MCP) && !cfg.text.includes(ADMIN), 'tokens never sent unless revealed');

    // cross-site write: wrong Origin
    const cross = await a.call('PUT', '/admin/api/config', { raw: cfg.json.raw, baseVersion: cfg.json.version }, { origin: 'https://evil.example' });
    assert.equal(cross.status, 403);
    // MCP endpoint still rejects the admin token
    const mcp = await fetch(`${a.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(mcp.status, 401);

    // bearer admin token works for scripts without CSRF header
    const bearer = await fetch(`${a.base}/admin/api/status`, { headers: { authorization: `Bearer ${ADMIN}` } });
    assert.equal(bearer.status, 200);
    assert.equal((await a.call('POST', '/admin/api/secret/reveal', { name: 'authToken' })).json.value, MCP);
  } finally {
    await a.close();
  }
});

test('admin: save keeps masked secrets, applies live, reports restart and conflicts', async () => {
  const a = await startAdmin();
  try {
    await a.call('POST', '/admin/api/login', { token: ADMIN });
    const cfg = (await a.call('GET', '/admin/api/config')).json;
    const draft = cfg.raw;
    draft.targets.web.idleTimeoutMinutes = 7;
    draft.server.port = 9999;
    const bad = structuredClone(draft);
    bad.targets.web.mode = 'nope';
    const v = await a.call('POST', '/admin/api/config/validate', { raw: bad });
    assert.equal(v.json.ok, false);
    assert.deepEqual(v.json.issues[0].path, ['targets', 'web', 'mode']);
    assert.equal((await a.call('PUT', '/admin/api/config', { raw: bad, baseVersion: cfg.version })).status, 400);

    const saved = await a.call('PUT', '/admin/api/config', { raw: draft, baseVersion: cfg.version });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.applied.restartRequired.map((r) => r.path.join('.')), ['server.port']);
    const disk = JSON.parse(fs.readFileSync(a.file, 'utf8'));
    assert.equal(disk.server.authToken, MCP);
    assert.equal(disk.server.adminToken, ADMIN);
    assert.equal(disk.targets.web.idleTimeoutMinutes, 7);
    assert.equal(a.manager.target('web').idleTimeoutMinutes, 7, 'applied without restart');
    assert.equal((await a.call('PUT', '/admin/api/config', { raw: draft, baseVersion: cfg.version })).status, 409);

    // policy test against a draft
    const p = await a.call('POST', '/admin/api/policy/test', { raw: draft, target: 'db', command: 'rm -rf /' });
    assert.equal(p.json.allowed, false);
    assert.equal(p.json.kind, 'allow');

    // backups + restore
    const backups = (await a.call('GET', '/admin/api/backups')).json.backups;
    assert.equal(backups.length, 1);
    const cur = (await a.call('GET', '/admin/api/config')).json;
    const restored = await a.call('POST', '/admin/api/backup/restore', { name: backups[0].name, baseVersion: cur.version });
    assert.equal(restored.status, 200);
    assert.equal(a.manager.target('web').idleTimeoutMinutes, 30);

    // rotating the admin token signs out other admin sessions but keeps this one
    const other = await fetch(`${a.base}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pamssh-admin': '1' }, body: JSON.stringify({ token: ADMIN }) });
    const otherCookie = other.headers.get('set-cookie').split(';')[0];
    const c2 = (await a.call('GET', '/admin/api/config')).json;
    c2.raw.server.adminToken = 'N'.repeat(24);
    assert.equal((await a.call('PUT', '/admin/api/config', { raw: c2.raw, baseVersion: c2.version })).status, 200);
    assert.equal((await a.call('GET', '/admin/api/session')).json.authenticated, true);
    const otherCheck = await fetch(`${a.base}/admin/api/session`, { headers: { cookie: otherCookie } });
    assert.equal((await otherCheck.json()).authenticated, false);
    const status = (await a.call('GET', '/admin/api/status')).json;
    assert.equal(status.counts.targets, 2);
    assert.ok(Array.isArray(status.warnings));

    await a.call('POST', '/admin/api/logout');
    assert.equal((await a.call('GET', '/admin/api/config')).status, 401);
  } finally {
    await a.close();
  }
});

test('admin: login throttling and disabled state', async () => {
  const a = await startAdmin();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await a.call('POST', '/admin/api/login', { token: 'wrong-token' })).status, 401);
    const locked = await a.call('POST', '/admin/api/login', { token: ADMIN });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
  } finally {
    await a.close();
  }
  const b = await startAdmin({ server: { port: 0, authToken: MCP } });
  try {
    assert.equal((await b.call('GET', '/admin/api/session')).json.enabled, false);
    assert.match((await b.call('POST', '/admin/api/login', { token: ADMIN })).json.error, /未启用/);
  } finally {
    await b.close();
  }
});

test('failed sessions do not count toward maxSessions and are dropped later', async () => {
  const { file } = writeConfig({ defaults: { maxSessionsPerTarget: 2 } }); // PAM on port 1: every login fails
  const m = new SessionManager(ConfigStore.load(file).config, { logger: silentLogger });
  try {
    for (const name of ['a', 'b', 'c']) {
      await assert.rejects(m.exec('web', 'true', { session: name }), /network error/, `session ${name} must fail on connect, not on the limit`);
    }
    const listed = m.listSessions();
    assert.deepEqual(listed.map((s) => `${s.session}:${s.state}:${s.active}`), ['a:error:false', 'b:error:false', 'c:error:false']);
    m._reapIdle(Date.now() + 5 * 60_000);
    assert.equal(m.listSessions().length, 3, 'kept for a while so the last error stays visible');
    m._reapIdle(Date.now() + 11 * 60_000);
    assert.equal(m.listSessions().length, 0);
  } finally {
    await m.closeAll();
  }
});
