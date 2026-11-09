import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AuditLog } from '../src/audit.js';
import { parseConfig, validateConfig } from '../src/config.js';
import { SessionManager } from '../src/session-manager.js';
import { silentLogger } from '../src/logger.js';
import { tmpDir } from './helpers.js';

const DAY = 24 * 60 * 60_000;
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function auditFile(entries) {
  const dir = tmpDir();
  dirs.push(dir);
  const file = path.join(dir, 'audit.jsonl');
  fs.writeFileSync(file, entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n', { mode: 0o644 });
  return { dir, file };
}
const now = Date.parse('2026-11-10T00:00:00Z');
const iso = (daysAgo) => new Date(now - daysAgo * DAY).toISOString();

test('prune drops entries older than the retention window only', () => {
  const { file } = auditFile([
    { ts: iso(45), event: 'exec', command: 'old-1' },
    { ts: iso(31), event: 'result' },
    'not json at all',
    { ts: iso(29), event: 'exec', command: 'recent-1' },
    { ts: iso(0.1), event: 'exec', command: 'recent-2' },
  ]);
  const log = new AuditLog({ file });
  assert.deepEqual(log.prune(30, now), { removed: 2, kept: 3 });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.deepEqual(lines.map((l) => { try { return JSON.parse(l).command ?? JSON.parse(l).event; } catch { return l; } }),
    ['not json at all', 'recent-1', 'recent-2']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'rewritten file is private');

  const before = fs.statSync(file).mtimeMs;
  assert.deepEqual(log.prune(30, now), { removed: 0, kept: 3 });
  assert.equal(fs.statSync(file).mtimeMs, before, 'no rewrite when nothing expired');
  assert.equal(log.prune(0, now + 1000 * DAY).removed, 0, '0 keeps everything');
  assert.deepEqual(new AuditLog({ file: path.join(path.dirname(file), 'missing.jsonl') }).prune(30, now), { removed: 0, kept: 0 });
  // disabled auditing still expires old data
  assert.equal(new AuditLog({ enabled: false, file }).prune(1, now).removed, 1);
});

test('retentionDays defaults to 30 and is validated', () => {
  const base = { pamServers: { p: { host: 'h', user: 'u' } }, targets: { t: { host: 'x', account: 'a' } } };
  assert.equal(parseConfig(base).audit.retentionDays, 30);
  assert.equal(validateConfig({ ...base, audit: { retentionDays: -1 } }).ok, false);
  assert.equal(validateConfig({ ...base, audit: { retentionDays: 1.5 } }).ok, false);
  assert.equal(parseConfig({ ...base, audit: { retentionDays: 0 } }).audit.retentionDays, 0);
});

test('startMaintenance prunes at once, and again when retention is shortened', () => {
  const { dir, file } = auditFile([{ ts: new Date(Date.now() - 40 * DAY).toISOString() }, { ts: new Date(Date.now() - 5 * DAY).toISOString() }]);
  const cfg = (days) => parseConfig({
    audit: { file, retentionDays: days }, hostKeys: { file: path.join(dir, 'k.json') },
    pamServers: { p: { host: 'h', user: 'u' } }, targets: { t: { host: 'x', account: 'a' } },
  });
  const m = new SessionManager(cfg(30), { logger: silentLogger });
  m.startMaintenance({ intervalMs: 60 * 60_000 });
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1, 'pruned on start');
  m.updateConfig(cfg(2));
  assert.equal(fs.readFileSync(file, 'utf8').trim(), '', 'shorter retention applied immediately');
  m.closeAll();
});
