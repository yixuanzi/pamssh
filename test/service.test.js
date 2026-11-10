import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildLaunchdPlist, buildTaskXml, launchdLabel, serviceBackend, windowsTaskName, winQuote } from '../src/service.js';
import { tmpDir } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/pamssh-mcp.js', import.meta.url));
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const SPEC = {
  node: '/opt/node/bin/node',
  entry: '/opt/lib/pamssh mcp/bin/pamssh-mcp.js',
  options: ['--config', '/Users/me/a&b/<config>.json', '--port', '9000'],
  env: { HOME: '/Users/me', PAMSSH_MCP_SERVICE: 'launchd' },
  logFile: '/Users/me/Library/Logs/pamssh-mcp.log',
  workingDirectory: '/Users/me',
};

test('service name is per state directory', () => {
  withEnv({ PAMSSH_MCP_HOME: undefined, XDG_CONFIG_HOME: undefined }, () => {
    assert.equal(launchdLabel(), 'io.github.pamssh-mcp');
    assert.equal(windowsTaskName(), 'pamssh-mcp');
  });
  withEnv({ PAMSSH_MCP_HOME: '/tmp/other-home' }, () => {
    assert.match(launchdLabel(), /^io\.github\.pamssh-mcp\.[0-9a-f]{8}$/);
    assert.match(windowsTaskName(), /^pamssh-mcp-[0-9a-f]{8}$/);
  });
});

test('launchd plist runs `serve` at login and only restarts after a crash', () => {
  const plist = buildLaunchdPlist({ ...SPEC, label: 'io.github.pamssh-mcp' });
  const strings = [...plist.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);
  assert.deepEqual(strings.slice(0, 8), ['io.github.pamssh-mcp', SPEC.node, SPEC.entry, 'serve',
    '--config', '/Users/me/a&amp;b/&lt;config&gt;.json', '--port', '9000']);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
  assert.match(plist, /<key>PAMSSH_MCP_SERVICE<\/key>\s*<string>launchd<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/me\/Library\/Logs\/pamssh-mcp\.log<\/string>/);
});

test('launchd plist is well-formed', { skip: process.platform !== 'darwin' }, () => {
  const dir = tmpDir();
  dirs.push(dir);
  const file = path.join(dir, 'test.plist');
  fs.writeFileSync(file, buildLaunchdPlist({ ...SPEC, label: 'io.github.pamssh-mcp' }));
  const r = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('windows argument quoting', () => {
  assert.equal(winQuote('plain'), 'plain');
  assert.equal(winQuote(''), '""');
  assert.equal(winQuote('C:\\Program Files\\x.js'), '"C:\\Program Files\\x.js"');
  assert.equal(winQuote('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
  assert.equal(winQuote('say "hi"'), '"say \\"hi\\""');
  assert.equal(winQuote('x\\"y'), '"x\\\\\\"y"');
});

test('windows task starts the server detached at the user\'s logon', () => {
  const task = buildTaskXml({
    ...SPEC,
    userId: 'S-1-5-21-1-2-3-1001',
    node: 'C:\\Program Files\\nodejs\\node.exe',
    entry: 'C:\\Users\\a b\\npm\\pamssh-mcp.js',
    options: ['--config', 'C:\\Users\\a b\\.config\\pamssh-mcp\\config.json'],
    workingDirectory: 'C:\\Users\\a b',
  });
  assert.match(task, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>S-1-5-21-1-2-3-1001<\/UserId>/);
  assert.match(task, /<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(task, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.ok(task.includes('<Command>C:\\Program Files\\nodejs\\node.exe</Command>'));
  assert.ok(task.includes('<Arguments>"C:\\Users\\a b\\npm\\pamssh-mcp.js" serve start --no-service '
    + '--config "C:\\Users\\a b\\.config\\pamssh-mcp\\config.json"</Arguments>'));
});

test('a backend exists for macOS and Windows only', { skip: process.platform === 'win32' }, () => {
  assert.equal(serviceBackend('linux'), null);
  if (process.platform === 'darwin') {
    const svc = withEnv({ PAMSSH_MCP_HOME: '/tmp/pamssh-not-installed' }, () => serviceBackend());
    assert.equal(svc.name, 'launchd');
    assert.equal(svc.isInstalled(), false);
    assert.match(svc.location, /Library\/LaunchAgents\/io\.github\.pamssh-mcp\.[0-9a-f]{8}\.plist$/);
  }
});

test('install / uninstall explain themselves where no service backend exists',
  { skip: process.platform === 'darwin' || process.platform === 'win32' }, () => {
    const dir = tmpDir();
    dirs.push(dir);
    for (const action of ['install', 'uninstall']) {
      const r = spawnSync(process.execPath, [BIN, 'serve', action], {
        encoding: 'utf8', env: { ...process.env, PAMSSH_MCP_HOME: dir },
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /supported on macOS and Windows/);
    }
  });
