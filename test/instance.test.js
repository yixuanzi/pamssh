import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AlreadyRunningError, acquireInstanceLock, controlEndpoint, queryInstance, sendControl } from '../src/instance.js';
import { tmpDir } from './helpers.js';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function endpointFor() {
  if (process.platform === 'win32') return `\\\\.\\pipe\\pamssh-mcp-test-${randomBytes(6).toString('hex')}`;
  const dir = tmpDir();
  dirs.push(dir);
  return path.join(dir, 'serve.sock');
}

test('second instance is refused and told who holds the lock', async () => {
  const endpoint = endpointFor();
  assert.equal(await queryInstance({ endpoint }), null);
  const lock = await acquireInstanceLock({ version: 'x' }, { endpoint });
  try {
    lock.update({ url: 'http://127.0.0.1:1/mcp' });
    const st = await queryInstance({ endpoint });
    assert.equal(st.pid, process.pid);
    assert.equal(st.version, 'x');
    assert.equal(st.url, 'http://127.0.0.1:1/mcp');
    await assert.rejects(acquireInstanceLock({}, { endpoint }), (err) => {
      assert.ok(err instanceof AlreadyRunningError);
      assert.equal(err.instance.pid, process.pid);
      assert.match(err.message, new RegExp(`already running \\(pid ${process.pid}, http://127.0.0.1:1/mcp\\)`));
      return true;
    });
    assert.deepEqual(await sendControl('bogus', { endpoint }), { ok: false, error: 'unknown command' });
  } finally {
    await lock.release();
  }
  assert.equal(await queryInstance({ endpoint }), null);
  if (process.platform !== 'win32') assert.equal(fs.existsSync(endpoint), false);
});

test('stop command reaches the running instance', async () => {
  const endpoint = endpointFor();
  const lock = await acquireInstanceLock({}, { endpoint });
  try {
    const stopped = new Promise((resolve) => lock.onStop(resolve));
    const reply = await sendControl('stop', { endpoint });
    assert.equal(reply.ok, true);
    assert.equal(reply.pid, process.pid);
    await stopped;
  } finally {
    await lock.release();
  }
});

test('lock can be taken again after release', async () => {
  const endpoint = endpointFor();
  await (await acquireInstanceLock({}, { endpoint })).release();
  await (await acquireInstanceLock({}, { endpoint })).release();
});

test('stale socket file from a killed instance is replaced', { skip: process.platform === 'win32' }, async () => {
  const endpoint = endpointFor();
  fs.writeFileSync(endpoint, ''); // nothing listens on it
  const lock = await acquireInstanceLock({}, { endpoint });
  try {
    assert.equal((await queryInstance({ endpoint })).pid, process.pid);
    assert.equal(fs.statSync(endpoint).mode & 0o077, 0, 'socket is private to the user');
  } finally {
    await lock.release();
  }
});

test('control endpoint lives in the state directory', { skip: process.platform === 'win32' }, () => {
  const saved = process.env.PAMSSH_MCP_HOME;
  try {
    process.env.PAMSSH_MCP_HOME = '/tmp/pamssh-x';
    assert.equal(controlEndpoint(), '/tmp/pamssh-x/serve.sock');
    process.env.PAMSSH_MCP_HOME = `/tmp/${'long/'.repeat(30)}`;
    const fallback = controlEndpoint();
    assert.ok(Buffer.byteLength(fallback) <= 104, fallback);
    assert.match(fallback, /pamssh-mcp-[0-9a-f]{16}\.sock$/);
  } finally {
    if (saved === undefined) delete process.env.PAMSSH_MCP_HOME;
    else process.env.PAMSSH_MCP_HOME = saved;
  }
});
