import { randomUUID } from 'node:crypto';
import { resolveTarget } from './config.js';
import { buildKeySelector } from './agent.js';
import { HostKeyStore } from './hostkeys.js';
import { AuditLog } from './audit.js';
import { checkPolicy } from './policy.js';
import { resolveAgentSocket } from './paths.js';
import { connectPam } from './ssh/connection.js';
import { ShellSession } from './ssh/shell-session.js';
import { ExecSession } from './ssh/exec-session.js';
import { silentLogger } from './logger.js';

const SESSION_NAME_RE = /^[A-Za-z0-9._-]{1,32}$/;

/** Settings that only take effect when a session (re)connects. */
function connectionKey(t) {
  const p = t.pamServer;
  return JSON.stringify([t.username, t.mode, t.shell, p.host, p.port, p.identity, p.agentSocket,
    p.hostFingerprints, p.algorithms, p.readyTimeoutMs, p.keepaliveIntervalMs, p.keepaliveCountMax]);
}

export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

class ManagedSession {
  constructor(manager, target, name) {
    this.manager = manager;
    this.target = target;
    this.name = name;
    this.key = `${target.id}#${name}`;
    this.state = 'new';
    this.createdAt = new Date();
    this.connectedAt = null;
    this.lastUsedAt = Date.now();
    this.commandCount = 0;
    this.inflight = 0;
    this.lastError = null;
    this.lastCwd = null;
    this.hostKey = null;
    this.everConnected = false;
    this.logger = manager.logger.child(this.key);
    this._connecting = null;
  }

  get alive() {
    return this.state === 'ready' && this.runner?.alive;
  }

  /** Live connection was made with settings that have since changed in the config. */
  get stale() {
    return Boolean(this.alive && this.connectedWith && this.connectedWith.key !== connectionKey(this.target));
  }

  /** Connect if needed. Resolves to true when this call (re)established the session. */
  ensure() {
    if (this.alive) return Promise.resolve(false);
    if (!this._connecting) {
      this._connecting = this._connect().finally(() => { this._connecting = null; });
    }
    return this._connecting.then(() => true);
  }

  async _connect() {
    // Always connect with the current config (it may have been edited since creation).
    const target = this.target = this.manager.target(this.target.id);
    this.state = 'connecting';
    this.logger.info(`connecting via ${target.pamServer.host}:${target.pamServer.port} as "${target.username}"`);
    try {
      const { client, hostKey } = await this.manager.connect({
        target,
        agentSocket: this.manager.agentSocketFor(target.pamServer).path,
        keySelector: await this.manager.keySelectorFor(target.pamServer),
        hostKeys: this.manager.hostKeys,
        logger: this.logger,
      });
      this.client = client;
      this.hostKey = hostKey?.fingerprint ?? null;
      const runner = target.mode === 'exec'
        ? new ExecSession(client, { logger: this.logger })
        : new ShellSession(client, { ...target.shell, logger: this.logger });
      client.on('error', (err) => {
        this.lastError = err.message;
        this.logger.warn(`connection error: ${err.message}`);
      });
      client.on('close', () => runner.close());
      runner.once('close', () => this._onRunnerClose(runner));
      try {
        await runner.start();
      } catch (err) {
        client.end();
        throw err;
      }
      this.runner = runner;
      this.state = 'ready';
      this.connectedWith = {
        key: connectionKey(target),
        login: `${target.username}@${target.pamServer.host}`,
      };
      this.connectedAt = new Date();
      this.everConnected = true;
      this.lastError = null;
      this.logger.info('session ready');
    } catch (err) {
      this.state = 'error';
      this.lastError = err.message;
      this.logger.error(`connect failed: ${err.message}`);
      throw err;
    }
  }

  _onRunnerClose(runner) {
    if (this.runner && this.runner !== runner) return;
    if (this.state === 'ready') this.logger.info('session closed by remote side');
    if (this.state !== 'closed') this.state = 'disconnected';
    this.lastCwd = null;
    try { this.client?.end(); } catch { /* ignore */ }
  }

  async exec(command, opts) {
    this.inflight++;
    this.lastUsedAt = Date.now();
    try {
      const reconnected = (await this.ensure()) && this.commandCount > 0;
      const result = await this.runner.run(command, opts);
      this.commandCount++;
      if (result.cwd) this.lastCwd = result.cwd;
      return { ...result, reconnected };
    } finally {
      this.inflight--;
      this.lastUsedAt = Date.now();
    }
  }

  close(reason = 'closed') {
    this.state = 'closed';
    this.logger.info(`closing session (${reason})`);
    try { this.runner?.close(); } catch { /* ignore */ }
    try { this.client?.end(); } catch { /* ignore */ }
  }

  status() {
    return {
      target: this.target.id,
      session: this.name,
      state: this.state,
      login: this.alive && this.connectedWith
        ? this.connectedWith.login
        : `${this.target.username}@${this.target.pamServer.host}`,
      stale: this.stale,
      mode: this.target.mode,
      cwd: this.lastCwd,
      commands: this.commandCount,
      busy: this.inflight > 0,
      createdAt: this.createdAt.toISOString(),
      connectedAt: this.connectedAt?.toISOString() ?? null,
      lastUsedAt: new Date(this.lastUsedAt).toISOString(),
      hostKey: this.hostKey,
      lastError: this.lastError,
    };
  }
}

/**
 * Owns all SSH sessions. Sessions are shared by every MCP client connected to
 * this server and addressed by (target id, session name).
 */
export class SessionManager {
  constructor(config, { logger = silentLogger, audit, hostKeys, connect = connectPam, keySelectorBuilder = buildKeySelector } = {}) {
    this.config = config;
    this.logger = logger;
    this.audit = audit ?? new AuditLog(config.audit, { logger });
    this.hostKeys = hostKeys ?? new HostKeyStore(config.hostKeys.file, {
      trustOnFirstUse: config.hostKeys.trustOnFirstUse, logger,
    });
    this._ownAudit = !audit;
    this._ownHostKeys = !hostKeys;
    this.connect = connect;
    this.keySelectorBuilder = keySelectorBuilder;
    this.sessions = new Map();
    this._selectors = new Map();
    this._reaper = setInterval(() => this._reapIdle(), 60_000);
    this._reaper.unref();
  }

  /**
   * Swap in a new (validated, normalized) config without restarting.
   * - policy, timeouts, limits, targets, PAM servers apply to the next command;
   * - sessions of removed targets are closed;
   * - live sessions whose connection settings changed keep running and are
   *   reported as stale (they pick up the new settings when they reconnect).
   */
  updateConfig(config) {
    const old = this.config;
    this.config = config;
    this._selectors.clear();
    if (this._ownAudit && JSON.stringify(old.audit) !== JSON.stringify(config.audit)) {
      this.audit = new AuditLog(config.audit, { logger: this.logger });
    }
    if (this._ownHostKeys && JSON.stringify(old.hostKeys) !== JSON.stringify(config.hostKeys)) {
      this.hostKeys = new HostKeyStore(config.hostKeys.file, {
        trustOnFirstUse: config.hostKeys.trustOnFirstUse, logger: this.logger,
      });
    }
    const closed = [];
    const stale = [];
    for (const s of [...this.sessions.values()]) {
      const next = resolveTarget(config, s.target.id);
      if (!next) {
        s.close('target removed from configuration');
        this.sessions.delete(s.key);
        closed.push(s.key);
        continue;
      }
      s.target = next;
      if (s.stale) stale.push(s.key);
    }
    return { closedSessions: closed, staleSessions: stale };
  }

  agentSocketFor(pam) {
    return resolveAgentSocket(pam.agentSocket ?? this.config.agentSocket);
  }

  keySelectorFor(pam) {
    if (!this._selectors.has(pam.id)) {
      const p = this.keySelectorBuilder(pam.identity);
      p.catch(() => this._selectors.delete(pam.id));
      this._selectors.set(pam.id, p);
    }
    return this._selectors.get(pam.id);
  }

  target(targetId) {
    const t = resolveTarget(this.config, targetId);
    if (!t) {
      const known = Object.keys(this.config.targets).join(', ') || '(none)';
      throw new UserError(`unknown target "${targetId}". Configured targets: ${known}`);
    }
    return t;
  }

  listTargets({ tag } = {}) {
    return Object.keys(this.config.targets)
      .map((id) => this.target(id))
      .filter((t) => !tag || t.tags.includes(tag))
      .map((t) => ({
        id: t.id,
        description: t.description,
        account: t.account,
        host: t.host,
        pam: t.pam,
        mode: t.mode,
        tags: t.tags,
        sessions: [...this.sessions.values()]
          .filter((s) => s.target.id === t.id && s.state !== 'closed')
          .map((s) => ({ name: s.name, state: s.state, cwd: s.lastCwd })),
      }));
  }

  _session(targetId, name = 'default', { create = true } = {}) {
    if (!SESSION_NAME_RE.test(name)) {
      throw new UserError('session name must match [A-Za-z0-9._-]{1,32}');
    }
    const target = this.target(targetId);
    const key = `${target.id}#${name}`;
    let s = this.sessions.get(key);
    if (s && s.state === 'closed') {
      this.sessions.delete(key);
      s = undefined;
    }
    if (!s && create) {
      const open = [...this.sessions.values()].filter((x) => x.target.id === target.id && x.state !== 'closed');
      if (open.length >= target.maxSessions) {
        throw new UserError(`target "${target.id}" already has ${open.length} sessions (max ${target.maxSessions}); `
          + `close one first: ${open.map((x) => x.name).join(', ')}`);
      }
      s = new ManagedSession(this, target, name);
      this.sessions.set(key, s);
    }
    return s;
  }

  async openSession(targetId, name = 'default') {
    const s = this._session(targetId, name);
    await s.ensure();
    return s.status();
  }

  async exec(targetId, command, { session = 'default', timeoutMs, actor } = {}) {
    const target = this.target(targetId);
    const id = randomUUID();
    const base = {
      id, actor, target: target.id, session, login: target.username, pam: `${target.pamServer.host}:${target.pamServer.port}`,
    };
    const verdict = checkPolicy(command, target.policies);
    if (!verdict.allowed) {
      this.audit.write({ ...base, event: 'denied', command, reason: verdict.reason });
      throw new UserError(`blocked by policy: ${verdict.reason}`);
    }
    const s = this._session(target.id, session);
    this.audit.write({ ...base, event: 'exec', command });
    try {
      const result = await s.exec(command, {
        timeoutMs: Math.min(timeoutMs ?? target.commandTimeoutMs, 3_600_000),
        maxOutputChars: target.maxOutputChars,
      });
      this.audit.write({
        ...base,
        event: 'result',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        outputChars: result.output.length,
        sessionEnded: result.sessionEnded,
      });
      return { target: target.id, session: s.name, ...result };
    } catch (err) {
      this.audit.write({ ...base, event: 'error', error: err.message });
      throw err;
    }
  }

  listSessions() {
    return [...this.sessions.values()].filter((s) => s.state !== 'closed').map((s) => s.status());
  }

  closeSession(targetId, name = 'default') {
    const s = this._session(targetId, name, { create: false });
    if (!s) return false;
    s.close('closed by request');
    this.sessions.delete(s.key);
    return true;
  }

  _reapIdle() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      const idleMin = s.target.idleTimeoutMinutes;
      if (s.state === 'ready' && idleMin > 0 && s.inflight === 0 && now - s.lastUsedAt > idleMin * 60_000) {
        s.close(`idle for more than ${idleMin} minutes`);
        this.sessions.delete(s.key);
      }
    }
  }

  async closeAll() {
    clearInterval(this._reaper);
    for (const s of this.sessions.values()) s.close('server shutting down');
    this.sessions.clear();
  }
}
