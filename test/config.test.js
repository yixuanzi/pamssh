import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, resolveTarget, renderUsername, exampleConfig, ConfigError } from '../src/config.js';

const base = () => ({
  server: { authToken: 'a'.repeat(32) },
  pamServers: { pam: { host: 'pam.example.com', user: 'alice' } },
  targets: { web: { host: '10.0.0.1', account: 'root' } },
});

test('applies defaults and implicit PAM server', () => {
  const cfg = parseConfig(base());
  assert.equal(cfg.server.host, '127.0.0.1');
  assert.equal(cfg.server.port, 8765);
  assert.equal(cfg.server.path, '/mcp');
  assert.equal(cfg.pamServers.pam.port, 22);
  assert.deepEqual(cfg.pamServers.pam.hostFingerprints, []);
  const t = resolveTarget(cfg, 'web');
  assert.equal(t.pam, 'pam');
  assert.equal(t.mode, 'shell');
  assert.equal(t.username, 'alice@root@10.0.0.1');
  assert.equal(t.commandTimeoutMs, 120_000);
  assert.equal(t.shell.term, 'dumb');
  assert.equal(resolveTarget(cfg, 'nope'), undefined);
});

test('username template and explicit username override', () => {
  const raw = base();
  raw.pamServers.pam.usernameTemplate = '{pamUser}#{account}#{host}';
  raw.pamServers.pam.hostFingerprint = 'SHA256:abcdEFGH+/12';
  raw.targets.db = { host: 'db-1', account: 'postgres', username: 'custom-login' };
  const cfg = parseConfig(raw);
  assert.equal(resolveTarget(cfg, 'web').username, 'alice#root#10.0.0.1');
  assert.equal(resolveTarget(cfg, 'db').username, 'custom-login');
  assert.deepEqual(cfg.pamServers.pam.hostFingerprints, ['SHA256:abcdEFGH+/12']);
});

test('requires target.pam when several PAM servers exist', () => {
  const raw = base();
  raw.pamServers.other = { host: 'pam2', user: 'bob' };
  assert.throws(() => parseConfig(raw), /required when more than one PAM server/);
  raw.targets.web.pam = 'missing';
  assert.throws(() => parseConfig(raw), /unknown PAM server "missing"/);
  raw.targets.web.pam = 'other';
  assert.equal(resolveTarget(parseConfig(raw), 'web').username, 'bob@root@10.0.0.1');
});

test('rejects bad regexes, placeholders, fingerprints and unknown keys', () => {
  const r1 = base();
  r1.policy = { deny: ['(unclosed'] };
  assert.throws(() => parseConfig(r1), /invalid regex/);
  const r2 = base();
  r2.pamServers.pam.usernameTemplate = '{pamUser}@{nope}';
  assert.throws(() => parseConfig(r2), /unknown placeholder \{nope\}/);
  const r3 = base();
  r3.pamServers.pam.hostFingerprint = 'MD5:aa:bb';
  assert.throws(() => parseConfig(r3), /SHA256/);
  const r4 = base();
  r4.targets.web.typo = true;
  assert.throws(() => parseConfig(r4), ConfigError);
  const r5 = base();
  r5.targets['bad id!'] = { host: 'h', account: 'a' };
  assert.throws(() => parseConfig(r5), /invalid id|Invalid key/);
});

test('renderUsername', () => {
  assert.equal(renderUsername('{pamUser}@{account}@{host}', { pamUser: 'u', account: 'a', host: 'h' }), 'u@a@h');
  assert.throws(() => renderUsername('{x}', {}), /unknown placeholder/);
});

test('example config is valid', () => {
  const cfg = parseConfig(exampleConfig({ authToken: 'b'.repeat(40) }));
  assert.equal(resolveTarget(cfg, 'web-01').username, 'your.pam.user@root@10.0.0.11');
});

test('examples/config.example.json is valid', async () => {
  const fs = await import('node:fs');
  const raw = JSON.parse(fs.readFileSync(new URL('../examples/config.example.json', import.meta.url), 'utf8'));
  const cfg = parseConfig(raw);
  assert.equal(resolveTarget(cfg, 'web-01').username, 'alice@root@10.0.0.11');
  assert.equal(resolveTarget(cfg, 'build-01').mode, 'exec');
});
