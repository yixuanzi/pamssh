import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { configDir, defaultConfigPath, expandPath } from './paths.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]+=*$/;

const positiveInt = () => z.number().int().positive();

const PolicySchema = z.object({
  /** Regexes; when non-empty a command must match at least one of them. */
  allow: z.array(z.string()).default([]),
  /** Regexes; a command matching any of them is rejected. */
  deny: z.array(z.string()).default([]),
}).strict();

const IdentitySchema = z.object({
  /** Full OpenSSH public key line ("ssh-ed25519 AAAA... comment"). */
  publicKey: z.string().min(1).optional(),
  /** OpenSSH SHA256 fingerprint ("SHA256:..."), as shown by `ssh-add -l` / 1Password. */
  fingerprint: z.string().regex(FINGERPRINT_RE, 'must look like SHA256:xxxx').optional(),
  /** Key comment; 1Password reports the item title here. */
  comment: z.string().min(1).optional(),
  /** 1Password secret reference to the public key, resolved with `op read`. */
  opRef: z.string().regex(/^op:\/\//, 'must start with op://').optional(),
}).strict();

const PamServerSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  /** Your personal PAM account (the left-most part of the login string). */
  user: z.string().min(1),
  /**
   * How the SSH login user is composed. Placeholders:
   * {pamUser} {account} {host} {pamHost} {target}
   */
  usernameTemplate: z.string().min(1).default('{pamUser}@{account}@{host}'),
  /** Pinned SSH host key fingerprint(s) of the PAM gateway. */
  hostFingerprint: z.union([z.string(), z.array(z.string())]).optional(),
  identity: IdentitySchema.optional(),
  agentSocket: z.string().optional(),
  /** Covers TCP connect + handshake + auth, including waiting for the 1Password approval prompt. */
  readyTimeoutMs: positiveInt().default(90_000),
  keepaliveIntervalMs: z.number().int().nonnegative().default(15_000),
  keepaliveCountMax: positiveInt().default(4),
  /** Passed through to ssh2 `algorithms` for old gateways. */
  algorithms: z.record(z.string(), z.unknown()).optional(),
}).strict();

const ShellSchema = z.object({
  /** Extra commands run once after the session is prepared (e.g. `export LANG=C.UTF-8`, `cd /srv/app`). */
  init: z.array(z.string()).default([]),
  term: z.string().default('dumb'),
  cols: positiveInt().default(250),
  rows: positiveInt().default(50),
  /** How long to wait for the remote shell to become ready after login. */
  readyTimeoutMs: positiveInt().default(30_000),
  /**
   * Quiet period (no output) after login before the session is initialized,
   * used when no prompt is recognized. Multi-hop gateways can drop input typed
   * before the target shell starts.
   */
  settleMs: positiveInt().default(1500),
}).strict();

const TargetSchema = z.object({
  /** Key in `pamServers`; optional when only one PAM server is configured. */
  pam: z.string().optional(),
  /** Target asset as the PAM gateway knows it (hostname / IP / asset name). */
  host: z.string().min(1),
  /** Account on the target that the PAM gateway logs in as. */
  account: z.string().min(1),
  /** Full SSH login string override; bypasses usernameTemplate. */
  username: z.string().min(1).optional(),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
  /**
   * shell: one persistent PTY shell per session; cwd/env persist; stdout+stderr merged.
   * exec:  one SSH exec channel per command (only if the gateway supports exec); separate stderr.
   */
  mode: z.enum(['shell', 'exec']).default('shell'),
  shell: ShellSchema.prefault({}),
  policy: PolicySchema.prefault({}),
  commandTimeoutMs: positiveInt().optional(),
  maxOutputChars: positiveInt().optional(),
  idleTimeoutMinutes: z.number().nonnegative().optional(),
  maxSessions: positiveInt().optional(),
}).strict();

const ConfigSchema = z.object({
  $schema: z.string().optional(),
  server: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(8765),
    path: z.string().startsWith('/').default('/mcp'),
    /** Bearer token required on every HTTP request. Env PAMSSH_MCP_TOKEN overrides it. */
    authToken: z.string().min(16).optional(),
    /** Extra Host header values to accept (DNS-rebinding protection). */
    allowedHosts: z.array(z.string()).default([]),
    /** Browser Origins allowed to call the server. Requests without Origin are fine. */
    allowedOrigins: z.array(z.string()).default([]),
    /** Drop MCP (HTTP) sessions idle for this long. SSH sessions are managed separately. */
    mcpSessionIdleMinutes: z.number().positive().default(120),
  }).strict().prefault({}),
  agentSocket: z.string().optional(),
  defaults: z.object({
    commandTimeoutMs: positiveInt().default(120_000),
    maxOutputChars: positiveInt().default(20_000), // keep MCP results well under client token limits
    /** Close SSH sessions that ran nothing for this long (0 = never). */
    idleTimeoutMinutes: z.number().nonnegative().default(30),
    maxSessionsPerTarget: positiveInt().default(4),
  }).strict().prefault({}),
  /** Applied to every target, before the target's own policy. */
  policy: PolicySchema.prefault({}),
  audit: z.object({
    enabled: z.boolean().default(true),
    file: z.string().default(() => path.join(configDir(), 'audit.jsonl')),
  }).strict().prefault({}),
  hostKeys: z.object({
    file: z.string().default(() => path.join(configDir(), 'known_hosts.json')),
    /** Record an unknown PAM host key on first connect instead of refusing. */
    trustOnFirstUse: z.boolean().default(true),
  }).strict().prefault({}),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).optional(),
  pamServers: z.record(z.string().regex(ID_RE, 'invalid id'), PamServerSchema),
  targets: z.record(z.string().regex(ID_RE, 'invalid id'), TargetSchema),
}).strict().superRefine((cfg, ctx) => {
  const pamIds = Object.keys(cfg.pamServers);
  if (pamIds.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['pamServers'], message: 'at least one PAM server is required' });
  }
  for (const [id, pam] of Object.entries(cfg.pamServers)) {
    for (const fp of toArray(pam.hostFingerprint)) {
      if (!FINGERPRINT_RE.test(fp)) {
        ctx.addIssue({ code: 'custom', path: ['pamServers', id, 'hostFingerprint'], message: `"${fp}" must look like SHA256:xxxx` });
      }
    }
    try {
      renderUsername(pam.usernameTemplate, { pamUser: 'u', account: 'a', host: 'h', pamHost: 'p', target: 't' });
    } catch (err) {
      ctx.addIssue({ code: 'custom', path: ['pamServers', id, 'usernameTemplate'], message: err.message });
    }
  }
  for (const [id, t] of Object.entries(cfg.targets)) {
    if (t.pam === undefined && pamIds.length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['targets', id, 'pam'], message: 'required when more than one PAM server is configured' });
    } else if (t.pam !== undefined && !cfg.pamServers[t.pam]) {
      ctx.addIssue({ code: 'custom', path: ['targets', id, 'pam'], message: `unknown PAM server "${t.pam}"` });
    }
  }
  const checkRegexes = (list, p) => list.forEach((src, i) => {
    try { new RegExp(src); } catch (err) {
      ctx.addIssue({ code: 'custom', path: [...p, i], message: `invalid regex: ${err.message}` });
    }
  });
  checkRegexes(cfg.policy.allow, ['policy', 'allow']);
  checkRegexes(cfg.policy.deny, ['policy', 'deny']);
  for (const [id, t] of Object.entries(cfg.targets)) {
    checkRegexes(t.policy.allow, ['targets', id, 'policy', 'allow']);
    checkRegexes(t.policy.deny, ['targets', id, 'policy', 'deny']);
  }
});

function toArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export class ConfigError extends Error {
  constructor(message, file) {
    super(file ? `${file}: ${message}` : message);
    this.name = 'ConfigError';
  }
}

/** Replace {placeholders} in a username template. Throws on unknown placeholders. */
export function renderUsername(template, vars) {
  return template.replace(/\{([A-Za-z]+)\}/g, (_, key) => {
    if (!Object.hasOwn(vars, key)) {
      throw new Error(`unknown placeholder {${key}} (allowed: {pamUser} {account} {host} {pamHost} {target})`);
    }
    return String(vars[key]);
  });
}

/** Validate a plain object and return the normalized config. */
export function parseConfig(raw, { file } = {}) {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`invalid configuration\n${z.prettifyError(result.error)}`, file);
  }
  const cfg = result.data;
  const pamIds = Object.keys(cfg.pamServers);

  for (const pam of Object.values(cfg.pamServers)) {
    pam.hostFingerprints = toArray(pam.hostFingerprint);
    delete pam.hostFingerprint;
  }
  for (const [id, t] of Object.entries(cfg.targets)) {
    t.id = id;
    t.pam = t.pam ?? pamIds[0];
  }
  for (const [id, pam] of Object.entries(cfg.pamServers)) pam.id = id;

  cfg.audit.file = expandPath(cfg.audit.file);
  cfg.hostKeys.file = expandPath(cfg.hostKeys.file);
  if (process.env.PAMSSH_MCP_TOKEN) cfg.server.authToken = process.env.PAMSSH_MCP_TOKEN;
  if (process.env.PAMSSH_LOG_LEVEL) cfg.logLevel = process.env.PAMSSH_LOG_LEVEL;
  cfg.file = file;
  return cfg;
}

export function resolveConfigPath(explicit) {
  return path.resolve(expandPath(explicit || process.env.PAMSSH_MCP_CONFIG || defaultConfigPath()));
}

export function loadConfig(explicit) {
  const file = resolveConfigPath(explicit);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ConfigError('config file not found; run `pamssh-mcp init` to create one', file);
    }
    throw new ConfigError(err.message, file);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`not valid JSON: ${err.message}`, file);
  }
  return parseConfig(raw, { file });
}

/** Effective settings for one target, with defaults applied. */
export function resolveTarget(cfg, targetId) {
  const target = cfg.targets[targetId];
  if (!target) return undefined;
  const pam = cfg.pamServers[target.pam];
  const d = cfg.defaults;
  const username = target.username ?? renderUsername(pam.usernameTemplate, {
    pamUser: pam.user,
    account: target.account,
    host: target.host,
    pamHost: pam.host,
    target: target.id,
  });
  return {
    ...target,
    pamServer: pam,
    username,
    commandTimeoutMs: target.commandTimeoutMs ?? d.commandTimeoutMs,
    maxOutputChars: target.maxOutputChars ?? d.maxOutputChars,
    idleTimeoutMinutes: target.idleTimeoutMinutes ?? d.idleTimeoutMinutes,
    maxSessions: target.maxSessions ?? d.maxSessionsPerTarget,
    policies: [cfg.policy, target.policy],
  };
}

/** Starter config written by `pamssh-mcp init`. */
export function exampleConfig({ authToken }) {
  return {
    server: {
      host: '127.0.0.1',
      port: 8765,
      path: '/mcp',
      authToken,
    },
    defaults: {
      commandTimeoutMs: 120000,
      maxOutputChars: 20000,
      idleTimeoutMinutes: 30,
      maxSessionsPerTarget: 4,
    },
    policy: {
      deny: [
        '(^|[;&|\\s])rm\\s+(-[A-Za-z]*[rRf][A-Za-z]*\\s+)+(/|/\\*|~)(\\s|$)',
        '(^|[;&|\\s])(mkfs(\\.\\w+)?|fdisk|parted|wipefs)\\s',
        '(^|[;&|\\s])dd\\s+.*\\bof=/dev/',
        '(^|[;&|(]\\s*|\\bsudo\\s+)(shutdown|reboot|halt|poweroff|init\\s+[06])(\\s|;|$)',
        '\\bsystemctl\\s+(reboot|poweroff|halt)\\b',
        ':\\(\\)\\s*\\{\\s*:\\|:&\\s*\\};:',
      ],
    },
    pamServers: {
      'pam-prod': {
        host: 'pam.example.com',
        port: 22,
        user: 'your.pam.user',
        usernameTemplate: '{pamUser}@{account}@{host}',
        identity: {
          comment: 'PAM SSH Key',
        },
      },
    },
    targets: {
      'web-01': {
        pam: 'pam-prod',
        host: '10.0.0.11',
        account: 'root',
        description: 'Production web server #1',
        tags: ['prod', 'web'],
        mode: 'shell',
        shell: { init: ['export LANG=C.UTF-8'] },
      },
    },
  };
}
