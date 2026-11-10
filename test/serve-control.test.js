/**
 * `pamssh-mcp serve start|stop|restart|status` and the single-instance limit,
 * driven through the real CLI in an isolated state directory (PAMSSH_MCP_HOME),
 * so neither a running server nor an installed service of the user is touched.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/pamssh-mcp.js', import.meta.url));
const home = tmpDir();
const configFile = path.join(home, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({
  server: { port: 0, authToken: 'M'.repeat(24), adminToken: 'A'.repeat(24) },
  audit: { file: path.join(home, 'audit.jsonl') },
  hostKeys: { file: path.join(home, 'known.json') },
  pamServers: { pam: { host: '127.0.0.1', port: 1, user: 'alice' } },
  targets: { web: { host: 'web-01', account: 'root' } },
}));

const env = { ...process.env, PAMSSH_MCP_HOME: home, PAMSSH_MCP_CONFIG: configFile };
for (const k of ['PAMSSH_MCP_SERVICE', 'PAMSSH_MCP_TOKEN', 'PAMSSH_ADMIN_TOKEN', 'PAMSSH_LOG_LEVEL']) delete env[k];

function cli(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...env, ...extraEnv } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const pidOf = (text) => Number(/pid (\d+)/.exec(text)?.[1]);
const urlOf = (text) => /MCP:\s+(\S+)/.exec(text)?.[1];

after(() => {
  cli(['serve', 'stop']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('serve start / status / stop and the single-instance limit', async () => {
  let r = cli(['serve', 'status']);
  assert.equal(r.code, 3, r.out + r.err);
  assert.match(r.out, /is not running/);

  r = cli(['serve', 'stop']);
  assert.equal(r.code, 0);
  assert.match(r.out, /is not running/);

  r = cli(['serve', 'start']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /pamssh-mcp started \(pid \d+\)/);
  const pid = pidOf(r.out);
  const url = urlOf(r.out);
  const health = await fetch(new URL('/healthz', url));
  assert.equal((await health.json()).ok, true);

  r = cli(['serve', 'status']);
  assert.equal(r.code, 0);
  assert.equal(pidOf(r.out), pid);
  assert.equal(urlOf(r.out), url);

  // start again: reminded, nothing new started
  r = cli(['serve', 'start']);
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`already running \\(pid ${pid}, `));

  // a second foreground server is refused
  r = cli(['serve']);
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`already running \\(pid ${pid}, .*Only one instance`));

  // ... and exits cleanly under a service manager, so it is not restarted in a loop
  r = cli(['serve'], { PAMSSH_MCP_SERVICE: 'launchd' });
  assert.equal(r.code, 0);
  assert.match(r.err, /already running/);

  r = cli(['serve', 'stop']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, new RegExp(`stopped \\(pid ${pid}\\)`));
  assert.equal(cli(['serve', 'status']).code, 3);
  await assert.rejects(fetch(new URL('/healthz', url)));
  assert.match(fs.readFileSync(path.join(home, 'pamssh-mcp.log'), 'utf8'), /stop requested: closing SSH sessions/);
});

test('serve restart keeps the options of the running instance', async () => {
  // Find a free port, then run on it explicitly.
  let r = cli(['serve', 'start']);
  const port = new URL(urlOf(r.out)).port;
  cli(['serve', 'stop']);

  r = cli(['serve', 'start', '--port', port]);
  assert.equal(r.code, 0, r.out + r.err);
  const pid = pidOf(r.out);

  r = cli(['serve', 'restart']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, new RegExp(`stopped \\(pid ${pid}\\)`));
  assert.notEqual(pidOf(r.out.split('\n').slice(1).join('\n')), pid);
  assert.equal(new URL(urlOf(r.out)).port, port);

  // restart when nothing runs just starts
  cli(['serve', 'stop']);
  r = cli(['serve', 'restart']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /is not running\npamssh-mcp started/);
  assert.equal(cli(['serve', 'stop']).code, 0);
});

test('a server that fails to start is reported with its log', () => {
  const bad = path.join(home, 'missing.json');
  const r = cli(['serve', 'start', '--config', bad]);
  assert.equal(r.code, 1);
  assert.match(r.err, /exited \(code 1\)/);
  assert.match(r.err, /config file not found/);
  assert.equal(cli(['serve', 'status']).code, 3);
});

test('unknown serve action', () => {
  const r = cli(['serve', 'bogus']);
  assert.equal(r.code, 1);
  assert.match(r.err, /usage: pamssh-mcp serve \[start\|stop\|restart\|status\|install\|uninstall\]/);
});
