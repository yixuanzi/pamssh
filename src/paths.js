import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Expand a leading `~` and environment variables like `$HOME` / `${HOME}`. */
export function expandPath(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  let out = p.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_, a, b) => process.env[a || b] ?? '');
  if (out === '~') out = os.homedir();
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = path.join(os.homedir(), out.slice(2));
  return out;
}

export function configDir() {
  if (process.env.PAMSSH_MCP_HOME) return expandPath(process.env.PAMSSH_MCP_HOME);
  const base = process.env.XDG_CONFIG_HOME
    ? expandPath(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), '.config');
  return path.join(base, 'pamssh-mcp');
}

export function defaultConfigPath() {
  return path.join(configDir(), 'config.json');
}

/** Log file of a background / service `serve` (the foreground server logs to stderr). */
export function logFile() {
  if (process.env.PAMSSH_MCP_HOME) return path.join(configDir(), 'pamssh-mcp.log');
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Logs', 'pamssh-mcp.log');
    case 'win32':
      return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'pamssh-mcp', 'pamssh-mcp.log');
    default:
      return path.join(process.env.XDG_STATE_HOME
        ? expandPath(process.env.XDG_STATE_HOME)
        : path.join(os.homedir(), '.local', 'state'), 'pamssh-mcp', 'pamssh-mcp.log');
  }
}

/** Where the 1Password desktop app exposes its SSH agent on each platform. */
export function onePasswordAgentSocket() {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Group Containers',
        '2BUA8C4S2C.com.1password', 't', 'agent.sock');
    case 'win32':
      return '\\\\.\\pipe\\openssh-ssh-agent';
    default:
      return path.join(os.homedir(), '.1password', 'agent.sock');
  }
}

function socketExists(p) {
  if (process.platform === 'win32') return true; // named pipes can't be stat'ed reliably
  try {
    fs.statSync(p);
    return true;
  } catch (err) {
    // The 1Password group container is TCC-protected on macOS: stat() may fail
    // with EPERM even though connect() works. Treat "exists but not readable" as present.
    return err.code === 'EPERM' || err.code === 'EACCES';
  }
}

/**
 * Pick the SSH agent socket. Order: explicit value > PAMSSH_AGENT_SOCK >
 * 1Password default location (if present) > SSH_AUTH_SOCK.
 */
export function resolveAgentSocket(explicit) {
  const candidates = [
    explicit && { source: 'config', path: expandPath(explicit) },
    process.env.PAMSSH_AGENT_SOCK && { source: 'PAMSSH_AGENT_SOCK', path: expandPath(process.env.PAMSSH_AGENT_SOCK) },
  ].filter(Boolean);
  if (candidates.length) return candidates[0];

  const op = onePasswordAgentSocket();
  if (socketExists(op)) return { source: '1password', path: op };
  if (process.env.SSH_AUTH_SOCK) return { source: 'SSH_AUTH_SOCK', path: process.env.SSH_AUTH_SOCK };
  return { source: '1password (not found)', path: op };
}
