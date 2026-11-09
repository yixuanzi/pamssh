/**
 * End-to-end: real OpenSSH agent (stands in for 1Password) -> ssh2 client ->
 * mock PAM gateway (examples/mock-pam-server.js) -> real shell in a PTY,
 * driven through SessionManager and through the Streamable HTTP MCP endpoint.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMockPam } from '../examples/mock-pam-server.js';
import { parseConfig } from '../src/config.js';
import { SessionManager } from '../src/session-manager.js';
import { startHttpServer } from '../src/mcp/http-server.js';
import { listAgentIdentities } from '../src/agent.js';
import { silentLogger } from '../src/logger.js';
import { canRunAgent, canRunPty, genKey, startAgent, tmpDir } from './helpers.js';

const skip = !(canRunAgent && canRunPty) && 'needs ssh-agent, ssh-keygen, script and bash';
const TOKEN = 't'.repeat(43);
let dir; let agent; let mock; let pamKey; let otherKey;

function makeConfig(overrides = {}) {
  return parseConfig({
    server: { host: '127.0.0.1', port: 0, authToken: TOKEN },
    agentSocket: agent.sock,
    audit: { file: path.join(dir, 'audit.jsonl') },
    hostKeys: { file: path.join(dir, 'known_hosts.json') },
    pamServers: {
      mock: {
        host: '127.0.0.1', port: mock.port, user: 'alice', hostFingerprint: mock.hostKeyFingerprint,
        identity: { comment: 'PAM Key' }, readyTimeoutMs: 15000,
      },
    },
    targets: {
      web: { host: 'web-01', account: 'root', description: 'web server', tags: ['prod'], commandTimeoutMs: 10000 },
      'web-exec': { host: 'web-01', account: 'deploy', mode: 'exec' },
      locked: { host: 'db-01', account: 'root', policy: { allow: ['^(ls|cat)\\b'], deny: [] } },
    },
    ...overrides,
  });
}

before(async () => {
  if (skip) return;
  dir = tmpDir();
  // Two keys in the agent: the "PAM Key" is NOT first, to prove key selection works
  // (mock only authorizes the PAM key, like a gateway with one registered key).
  otherKey = genKey(dir, 'other', 'Some Other Key');
  pamKey = genKey(dir, 'pam', 'PAM Key');
  agent = await startAgent(dir, [otherKey.file, pamKey.file]);
  mock = await startMockPam({ authorizedKeys: [pamKey.publicKey], pamUsers: ['alice'] });
});

after(async () => {
  await mock?.close();
  agent?.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('agent lists identities with fingerprints', { skip }, async () => {
  const ids = await listAgentIdentities(agent.sock);
  assert.deepEqual(ids.map((k) => k.comment).sort(), ['PAM Key', 'Some Other Key']);
  assert.ok(ids.every((k) => k.fingerprint.startsWith('SHA256:')));
});

test('persistent shell session through the PAM gateway', { skip }, async () => {
  const m = new SessionManager(makeConfig(), { logger: silentLogger });
  try {
    let r = await m.exec('web', 'cd /tmp && export DEMO=42 && echo ok');
    assert.equal(r.output, 'ok\n');
    assert.equal(r.exitCode, 0);
    assert.match(r.cwd, /\/tmp$/);
    r = await m.exec('web', 'echo "$DEMO" "$PWD"; ls /nonexistent-path');
    assert.match(r.output, /^42 .*tmp\n.*nonexistent-path/s);
    assert.notEqual(r.exitCode, 0);
    assert.equal(r.reconnected, false);

    // named sessions are independent logins
    r = await m.exec('web', 'echo "[$DEMO]"', { session: 'second' });
    assert.equal(r.output, '[]\n');
    assert.equal(m.listSessions().length, 2);

    // timeout -> Ctrl-C -> session still usable
    r = await m.exec('web', 'echo start; sleep 20', { timeoutMs: 1000 });
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, 130);
    assert.equal(r.output, 'start\n');
    r = await m.exec('web', 'echo "$DEMO"');
    assert.equal(r.output, '42\n');

    // remote exit ends the session; next call reconnects
    r = await m.exec('web', 'exit 3');
    assert.equal(r.sessionEnded, true);
    assert.equal(r.exitCode, 3);
    r = await m.exec('web', 'echo "[$DEMO]"');
    assert.equal(r.reconnected, true);
    assert.equal(r.output, '[]\n');

    assert.ok(mock.logins.every((l) => l.pamUser === 'alice' && l.account === 'root' && l.target === 'web-01'));
    const audit = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(audit.some((e) => e.event === 'result' && e.exitCode === 3));
    assert.ok(audit.every((e) => e.login === 'alice@root@web-01'));
  } finally {
    await m.closeAll();
  }
});

test('exec mode keeps stdout and stderr apart', { skip }, async () => {
  const m = new SessionManager(makeConfig(), { logger: silentLogger });
  try {
    const r = await m.exec('web-exec', 'echo out; echo err >&2; exit 4');
    assert.equal(r.output, 'out\n');
    assert.equal(r.stderr, 'err\n');
    assert.equal(r.exitCode, 4);
  } finally {
    await m.closeAll();
  }
});

test('policy blocks commands before anything is sent', { skip }, async () => {
  const m = new SessionManager(makeConfig(), { logger: silentLogger });
  const before = mock.logins.length;
  await assert.rejects(m.exec('locked', 'rm -rf /var/lib/mysql'), /blocked by policy/);
  assert.equal(mock.logins.length, before);
  await m.closeAll();
});

test('clear errors for wrong key, wrong host key and unknown target', { skip }, async () => {
  const wrongKey = makeConfig();
  wrongKey.pamServers.mock.identity = { comment: 'Missing Key' };
  let m = new SessionManager(wrongKey, { logger: silentLogger });
  await assert.rejects(m.exec('web', 'true'), /no key in the SSH agent matches[\s\S]*PAM Key/);
  await m.closeAll();

  const notRegistered = makeConfig();
  notRegistered.pamServers.mock.identity = { comment: 'Some Other Key' };
  m = new SessionManager(notRegistered, { logger: silentLogger });
  await assert.rejects(m.exec('web', 'true'), /PAM authentication failed/);
  await m.closeAll();

  const badHost = makeConfig();
  badHost.pamServers.mock.hostFingerprints = ['SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'];
  m = new SessionManager(badHost, { logger: silentLogger });
  await assert.rejects(m.exec('web', 'true'), /host key verification failed/);
  await assert.rejects(m.exec('nope', 'true'), /unknown target "nope"/);
  await m.closeAll();
});

test('publickey + keyboard-interactive gateways (AuthenticationMethods)', { skip }, async () => {
  // Empty keyboard-interactive round after the key: must log in.
  const empty = await startMockPam({ authorizedKeys: [pamKey.publicKey], secondFactor: 'empty' });
  // OTP prompt after the key: must refuse without sending an answer.
  const otp = await startMockPam({ authorizedKeys: [pamKey.publicKey], secondFactor: 'otp' });
  const withPort = (port, fp) => {
    const c = makeConfig();
    Object.assign(c.pamServers.mock, { port, hostFingerprints: [fp] });
    return c;
  };
  try {
    let m = new SessionManager(withPort(empty.port, empty.hostKeyFingerprint), { logger: silentLogger });
    const r = await m.exec('web', 'echo two-step-ok');
    assert.equal(r.output, 'two-step-ok\n');
    assert.equal(empty.logins.length, 1);
    await m.closeAll();

    m = new SessionManager(withPort(otp.port, otp.hostKeyFingerprint), { logger: silentLogger });
    await assert.rejects(m.exec('web', 'true'), /keyboard-interactive input \("Verification code: "\)[\s\S]*nothing was sent/);
    assert.equal(otp.logins.length, 0);
    assert.deepEqual(otp.kbdAnswers, [], 'must not answer OTP prompts');
    await m.closeAll();
  } finally {
    await empty.close();
    await otp.close();
  }
});

test('multi-hop gateway that drops input typed before the target shell starts', { skip }, async () => {
  // Target shell comes up 2.5s after login; anything typed earlier is discarded
  // (seen on a real gateway: jump host MOTD -> recorder -> target sshd).
  const hop = await startMockPam({ authorizedKeys: [pamKey.publicKey], loginDelayMs: 2500 });
  const c = makeConfig();
  Object.assign(c.pamServers.mock, { port: hop.port, hostFingerprints: [hop.hostKeyFingerprint] });
  const m = new SessionManager(c, { logger: silentLogger });
  try {
    const r = await m.exec('web', 'cd /tmp; echo "after-hop $PWD"');
    assert.match(r.output, /^after-hop .*tmp\n$/);
    assert.ok(hop.droppedInput.length > 0, 'first prelude should have been dropped and re-sent');
    assert.match((await m.exec('web', 'pwd')).output, /tmp\n$/);
  } finally {
    await m.closeAll();
    await hop.close();
  }
});

test('Streamable HTTP MCP endpoint', { skip }, async () => {
  const config = makeConfig();
  const manager = new SessionManager(config, { logger: silentLogger });
  const http = await startHttpServer({ config, manager, logger: silentLogger });
  const base = `http://127.0.0.1:${http.port}`;
  try {
    // auth and DNS-rebinding guards
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } };
    const post = (headers) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(init),
    });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ authorization: 'Bearer wrong-token-wrong-token' })).status, 401);
    assert.equal((await post({ authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' })).status, 403);

    const client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(),
      ['pam_close_session', 'pam_exec', 'pam_list_sessions', 'pam_list_targets', 'pam_open_session']);
    assert.match(client.getInstructions(), /pam_list_targets/);

    const targets = JSON.parse((await client.callTool({ name: 'pam_list_targets', arguments: { tag: 'prod' } })).content[0].text);
    assert.deepEqual(targets.map((t) => t.id), ['web']);

    let res = await client.callTool({ name: 'pam_exec', arguments: { target: 'web', command: 'cd /tmp; echo "hi from $(hostname)"' } });
    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /^\[exit=0 \| \d+ms \| cwd=.*tmp \| session=web\/default\]\nhi from /);

    res = await client.callTool({ name: 'pam_exec', arguments: { target: 'web', command: 'pwd' } });
    assert.match(res.content[0].text, /tmp\n$/);

    res = await client.callTool({ name: 'pam_exec', arguments: { target: 'locked', command: 'reboot' } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /blocked by policy/);

    const sessions = JSON.parse((await client.callTool({ name: 'pam_list_sessions', arguments: {} })).content[0].text);
    assert.equal(sessions[0].target, 'web');
    assert.equal(sessions[0].login, 'alice@root@web-01@127.0.0.1');

    res = await client.callTool({ name: 'pam_close_session', arguments: { target: 'web' } });
    assert.match(res.content[0].text, /closed web\/default/);
    await client.close();
  } finally {
    await manager.closeAll();
    await http.close();
  }
});

test('hot reload: live sessions go stale and reconnect with the new settings', { skip }, async () => {
  const m = new SessionManager(makeConfig(), { logger: silentLogger });
  try {
    await m.exec('web', 'echo first');
    assert.equal(m.listSessions()[0].stale, false);
    const next = makeConfig();
    next.pamServers.mock.usernameTemplate = '{pamUser}@{account}@{host}';
    next.targets.web.account = 'deploy';
    const res = m.updateConfig(next);
    assert.deepEqual(res.staleSessions, ['web#default']);
    const s = m.listSessions()[0];
    assert.equal(s.stale, true);
    assert.equal(s.login, `alice@root@web-01@127.0.0.1`, 'live session still shows the login it used');
    // policy edits apply immediately even to the live session
    next.targets.web.policy = { allow: [], deny: ['^echo blocked'] };
    m.updateConfig(next);
    await assert.rejects(m.exec('web', 'echo blocked'), /blocked by policy/);
    m.closeSession('web');
    const before = mock.logins.length;
    await m.exec('web', 'true');
    assert.equal(mock.logins.at(-1).account, 'deploy', 'reconnected with the new account');
    assert.equal(mock.logins.length, before + 1);
    assert.equal(m.listSessions()[0].stale, false);
  } finally {
    await m.closeAll();
  }
});

test('admin API: agent keys, host key scan, connection test', { skip }, async () => {
  const { ConfigStore } = await import('../src/config-store.js');
  const file = path.join(dir, 'admin-config.json');
  const ADMIN = 'x'.repeat(24);
  fs.writeFileSync(file, JSON.stringify({
    server: { port: 0, authToken: TOKEN, adminToken: ADMIN },
    agentSocket: agent.sock,
    audit: { file: path.join(dir, 'audit-admin.jsonl') },
    hostKeys: { file: path.join(dir, 'known-admin.json') },
    pamServers: { mock: { host: '127.0.0.1', port: mock.port, user: 'alice', identity: { comment: 'PAM Key' } } },
    targets: { web: { host: 'web-01', account: 'root' }, locked: { host: 'web-01', account: 'root', policy: { allow: ['^ls'] } } },
  }));
  const store = ConfigStore.load(file);
  const manager = new SessionManager(store.config, { logger: silentLogger });
  const http = await startHttpServer({ store, manager, logger: silentLogger });
  const get = (p) => fetch(`http://127.0.0.1:${http.port}/admin/api${p}`, { headers: { authorization: `Bearer ${ADMIN}` } }).then((r) => r.json());
  const post = (p, body) => fetch(`http://127.0.0.1:${http.port}/admin/api${p}`, {
    method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());
  try {
    const keys = await get('/agent/keys');
    assert.deepEqual(keys.keys.map((k) => k.comment).sort(), ['PAM Key', 'Some Other Key']);

    const loginsBefore = mock.logins.length;
    const scan = await post('/hostkeys/scan', { host: '127.0.0.1', port: mock.port });
    assert.equal(scan.fingerprint, mock.hostKeyFingerprint);
    assert.equal(scan.type, 'ssh-ed25519');
    assert.equal(mock.logins.length, loginsBefore, 'scan must not log in');

    const ok = await post('/targets/test', { target: 'web' });
    assert.equal(ok.ok, true, ok.error);
    assert.match(ok.output, /\n/);
    assert.equal(ok.hostKey, mock.hostKeyFingerprint);
    assert.equal(manager.listSessions().length, 0, 'test session is closed afterwards');

    const blocked = await post('/targets/test', { target: 'locked' });
    assert.equal(blocked.ok, true);
    assert.match(blocked.note, /blocked by policy/);

    const known = await get('/hostkeys');
    assert.deepEqual(known.known['127.0.0.1:' + mock.port], [mock.hostKeyFingerprint]);
    assert.equal((await post('/hostkeys/delete', { hostId: `127.0.0.1:${mock.port}` })).ok, true);

    const audit = await get('/audit?limit=50');
    assert.ok(audit.entries.some((e) => e.actor?.client === 'admin-ui'));
    const logs = await get('/logs');
    assert.ok(Array.isArray(logs.entries));
  } finally {
    await manager.closeAll();
    await http.close();
  }
});
