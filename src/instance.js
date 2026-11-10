import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { configDir } from './paths.js';

/**
 * Single-instance lock for `pamssh-mcp serve`, one per state directory
 * (configDir(), i.e. per user unless PAMSSH_MCP_HOME / XDG_CONFIG_HOME differ).
 *
 * The lock is a listening IPC endpoint (Unix socket / Windows named pipe)
 * rather than a pid file: the OS drops it when the process dies, so there is
 * no pid-reuse problem, and it doubles as the control channel that `serve
 * stop|status` use (graceful stop also works on Windows, which has no SIGTERM).
 *
 * Protocol: one JSON line each way. Request {"cmd":"status"|"stop"}, reply
 * {"ok":true, pid, version, url, ...}.
 */

const MAX_UNIX_SOCKET_PATH = 100; // sun_path is 104 bytes on macOS, 108 on Linux
const NOT_LISTENING = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK']);

const shortHash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export function controlEndpoint() {
  const dir = configDir();
  if (process.platform === 'win32') {
    // Pipe names are machine-wide: scope them to the user and state directory.
    return `\\\\.\\pipe\\pamssh-mcp-${shortHash(`${os.userInfo().username}\0${dir.toLowerCase()}`)}`;
  }
  const file = path.join(dir, 'serve.sock');
  if (Buffer.byteLength(file) <= MAX_UNIX_SOCKET_PATH) return file;
  // Path too long for a Unix socket: fall back to the per-user runtime / temp dir.
  return path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `pamssh-mcp-${shortHash(dir)}.sock`);
}

export class AlreadyRunningError extends Error {
  constructor(instance) {
    super(describeInstance(instance));
    this.name = 'AlreadyRunningError';
    this.instance = instance;
  }
}

export function describeInstance(inst) {
  if (!inst || inst.unresponsive) return 'pamssh-mcp is already running (the instance did not answer a status request)';
  return `pamssh-mcp is already running (pid ${inst.pid}${inst.url ? `, ${inst.url}` : ', starting'})`;
}

/**
 * Send one command to the running instance.
 * Resolves to its reply, to null when nothing is listening, or to
 * { ok: false, unresponsive: true } when something holds the endpoint but
 * does not answer properly.
 */
export function sendControl(cmd, { endpoint = controlEndpoint(), timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const hung = { ok: false, unresponsive: true };
    const sock = net.connect(endpoint);
    let buf = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(hung), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ cmd })}\n`));
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        finish(JSON.parse(buf.slice(0, nl)));
      } catch {
        finish(hung);
      }
    });
    sock.on('error', (err) => finish(NOT_LISTENING.has(err.code) ? null : hung));
    sock.on('close', () => finish(hung));
  });
}

/** Status of the running instance, or null when there is none. */
export const queryInstance = (opts) => sendControl('status', opts);

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Socket file must be private to the user from the moment it exists.
    const umask = process.platform === 'win32' ? null : process.umask(0o177);
    try {
      server.listen(endpoint, () => {
        server.off('error', reject);
        resolve();
      });
    } finally {
      if (umask !== null) process.umask(umask);
    }
  });
}

/**
 * Become the one running instance, or throw AlreadyRunningError.
 * `info` is what `status` reports; extend it later with update().
 */
export async function acquireInstanceLock(info = {}, { endpoint = controlEndpoint() } = {}) {
  const state = { pid: process.pid, startedAt: new Date().toISOString(), ...info };
  let onStop = () => process.exit(0); // until the server installs its graceful shutdown

  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.setTimeout(5000, () => sock.destroy());
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 4096) return sock.destroy();
      const nl = buf.indexOf('\n');
      if (nl < 0) return undefined;
      let cmd;
      try { cmd = JSON.parse(buf.slice(0, nl)).cmd; } catch { /* reported as unknown below */ }
      buf = '';
      if (cmd === 'status') return sock.end(`${JSON.stringify({ ok: true, ...state })}\n`);
      if (cmd === 'stop') {
        // Reply first: the caller then waits for the endpoint to disappear.
        return sock.end(`${JSON.stringify({ ok: true, ...state })}\n`, () => onStop());
      }
      return sock.end(`${JSON.stringify({ ok: false, error: 'unknown command' })}\n`);
    });
  });

  if (process.platform !== 'win32') fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    try {
      await listen(server, endpoint);
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt >= 2) throw err;
      const other = await queryInstance({ endpoint });
      if (other) throw new AlreadyRunningError(other);
      // Nobody is listening: a socket file left behind by a killed instance.
      // (Two instances cleaning up the same stale socket at the same instant
      // could both get through; the HTTP port bind is the second barrier.)
      if (process.platform !== 'win32') fs.rmSync(endpoint, { force: true });
    }
  }
  server.unref(); // the lock alone must not keep the process alive

  let released = false;
  const removeSocket = () => {
    if (released || process.platform === 'win32') return;
    try { fs.unlinkSync(endpoint); } catch { /* already gone */ }
  };
  process.once('exit', removeSocket); // process.exit() skips server.close()

  return {
    endpoint,
    /** Merge fields into what `status` reports (url, config file, ...). */
    update(patch) { Object.assign(state, patch); },
    /** Called when another process asks this instance to stop. */
    onStop(fn) { onStop = fn; },
    async release() {
      if (released) return;
      await new Promise((resolve) => server.close(() => resolve())); // also unlinks the socket
      released = true;
    },
  };
}
