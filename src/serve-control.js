import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, resolveConfigPath } from './config.js';
import { describeInstance, queryInstance, sendControl } from './instance.js';
import { logFile } from './paths.js';
import { serviceBackend } from './service.js';

/**
 * `pamssh-mcp serve start|stop|restart|status|install|uninstall`:
 * control the single background server through its control endpoint
 * (instance.js) and the platform's user-level service manager (service.js).
 */

const ENTRY = fileURLToPath(new URL('../bin/pamssh-mcp.js', import.meta.url));
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 20_000;
// Environment the server reads; a launchd service gets these copied (tokens are not).
const SERVICE_ENV = ['PAMSSH_MCP_HOME', 'XDG_CONFIG_HOME', 'PAMSSH_AGENT_SOCK', 'PAMSSH_LOG_LEVEL'];
const TOKEN_ENV = ['PAMSSH_MCP_TOKEN', 'PAMSSH_ADMIN_TOKEN'];

/** The `serve` options to hand to a server started on the user's behalf. */
export function serveOptions(values, { pinConfig = false } = {}) {
  const out = [];
  // Absolute path: the background server does not share our working directory.
  if (values.config || pinConfig) out.push('--config', resolveConfigPath(values.config));
  if (values.host) out.push('--host', values.host);
  if (values.port !== undefined) out.push('--port', String(values.port));
  if (values['log-level']) out.push('--log-level', values['log-level']);
  return out;
}

async function waitFor(check, timeoutMs, { abort } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (abort?.() || Date.now() >= deadline) return null;
    await delay(150);
  }
}

/** Running and listening (the HTTP server is up once `url` is reported). */
const ready = async () => {
  const st = await queryInstance();
  return st?.url ? st : null;
};
const gone = async () => !(await queryInstance());

const sizeOf = (file) => {
  try { return fs.statSync(file).size; } catch { return 0; }
};

function logSince(file, offset) {
  try {
    const buf = fs.readFileSync(file);
    return buf.subarray(Math.min(offset, buf.length)).toString('utf8').trim().split('\n').slice(-15).join('\n');
  } catch {
    return '';
  }
}

function installedService() {
  const svc = serviceBackend();
  return svc?.isInstalled() ? svc : null;
}

function requireService() {
  const svc = serviceBackend();
  if (!svc) {
    throw new Error(`installing a user service is supported on macOS and Windows; on ${process.platform} use `
      + '`pamssh-mcp serve start` (for example from a systemd --user unit)');
  }
  return svc;
}

function spawnDetached(options, log) {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'a', 0o600);
  try {
    // detached + no inherited console: survives this process and its terminal,
    // and shows no window on Windows.
    const child = spawn(process.execPath, [ENTRY, 'serve', ...options], {
      detached: true, stdio: ['ignore', fd, fd], windowsHide: true, cwd: os.homedir(),
    });
    child.unref();
    return child;
  } finally {
    fs.closeSync(fd);
  }
}

function printRunning(verb, st, log) {
  console.log(`pamssh-mcp ${verb} (pid ${st.pid}${st.service ? `, ${st.service} service` : ''})
  MCP:    ${st.url}${st.adminUrl ? `\n  admin:  ${st.adminUrl}` : ''}
  config: ${st.config}
  log:    ${st.foreground ? '(stderr of the foreground process)' : log}`);
}

async function waitStarted(log, offset, { exited = () => null } = {}) {
  const st = await waitFor(ready, START_TIMEOUT_MS, { abort: () => exited() !== null });
  if (st) return st;
  const tail = logSince(log, offset);
  const why = exited() !== null ? `exited (${exited()})` : `did not come up within ${START_TIMEOUT_MS / 1000}s`;
  throw new Error(`pamssh-mcp ${why}; log: ${log}${tail ? `\n${tail}` : ''}`);
}

export async function start(values, { options = serveOptions(values) } = {}) {
  const running = await queryInstance();
  if (running) {
    console.log(`${describeInstance(running)}; not starting another one`);
    return;
  }
  const svc = values['no-service'] ? null : installedService();
  const log = logFile();
  const offset = sizeOf(log);
  let st;
  if (svc) {
    if (options.length) {
      console.error(`note: the installed service (${svc.id}) runs with the options it was installed with; `
        + `ignoring ${options.join(' ')}. Re-run \`pamssh-mcp serve install\` to change them.`);
    }
    await svc.start();
    st = await waitStarted(log, offset);
  } else {
    let exit = null;
    const child = spawnDetached(options, log);
    child.once('error', (err) => { exit = err.message; });
    child.once('exit', (code, signal) => { exit = signal || `code ${code}`; });
    st = await waitStarted(log, offset, { exited: () => exit });
  }
  printRunning('started', st, log);
}

/** Returns the status of the instance that was stopped, or null if none was running. */
export async function stop() {
  const running = await queryInstance();
  if (!running) {
    console.log('pamssh-mcp is not running');
    return null;
  }
  if (!running.pid) throw new Error(`${describeInstance(running)}; stop that process manually`);
  await sendControl('stop'); // graceful: closes SSH sessions (releases the PAM logins), then exits 0
  if (await waitFor(gone, STOP_TIMEOUT_MS)) {
    console.log(`pamssh-mcp stopped (pid ${running.pid})`);
    return running;
  }
  await installedService()?.unload(); // or the service manager restarts what we kill
  try {
    process.kill(running.pid, 'SIGKILL');
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
  if (!(await waitFor(gone, 5000))) throw new Error(`could not stop pamssh-mcp (pid ${running.pid})`);
  console.log(`pamssh-mcp did not shut down within ${STOP_TIMEOUT_MS / 1000}s and was killed (pid ${running.pid})`);
  return running;
}

export async function restart(values) {
  const previous = await stop();
  // No options given: bring it back the way it was running (a service has its own).
  const given = serveOptions(values);
  const reuse = !given.length && previous?.options && !installedService();
  await start(values, { options: reuse ? previous.options : given });
}

export async function status() {
  const st = await queryInstance();
  const svc = serviceBackend();
  if (st?.url) printRunning('is running', st, logFile());
  else console.log(st ? describeInstance(st) : 'pamssh-mcp is not running');
  if (svc) {
    console.log(svc.isInstalled()
      ? `user service: installed (${svc.name}: ${svc.location})`
      : 'user service: not installed (pamssh-mcp serve install)');
  }
  if (!st) process.exitCode = 3;
}

export async function install(values) {
  const svc = requireService();
  loadConfig(values.config); // fail here, not in a service that keeps getting restarted
  const options = serveOptions(values, { pinConfig: true });
  const log = logFile();
  const env = Object.fromEntries(SERVICE_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  const existed = svc.isInstalled();
  const before = await queryInstance();
  const offset = sizeOf(log);

  await svc.install({ node: process.execPath, entry: ENTRY, options, env, logFile: log, workingDirectory: os.homedir() });
  console.log(`${existed ? 'updated' : 'installed'} user service ${svc.id} (${svc.name}), starts at login
  ${svc.location}
  runs: pamssh-mcp serve ${options.join(' ')}`);
  const tokens = TOKEN_ENV.filter((k) => process.env[k]);
  if (tokens.length) {
    console.error(`note: ${tokens.join(', ')} from this shell ${tokens.length > 1 ? 'are' : 'is'} not passed to the service; `
      + 'it uses the tokens in the config file');
  }
  if (svc.name !== 'launchd' && Object.keys(env).length) {
    console.error(`note: ${Object.keys(env).join(', ')} must be set as user environment variables for the service to see them`);
  }

  if (!svc.startsOnInstall && !before) await svc.start();
  const st = await waitStarted(log, offset);
  if (before && st.pid === before.pid) {
    console.log(`${describeInstance(st)} and was left running as it is; `
      + '`pamssh-mcp serve restart` restarts it as the service');
  } else {
    printRunning('started', st, log);
  }
}

export async function uninstall() {
  const svc = requireService();
  if (!svc.isInstalled()) {
    console.log(`no user service installed (${svc.location})`);
    return;
  }
  await stop();
  await svc.uninstall();
  console.log(`removed user service ${svc.id} (${svc.location})`);
}

export const serveActions = { start, stop, restart, status, install, uninstall };
