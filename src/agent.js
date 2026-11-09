import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import ssh2 from 'ssh2';

const { BaseAgent, createAgent, utils } = ssh2;

/** OpenSSH-style fingerprint ("SHA256:base64-without-padding") of a public key blob. */
export function fingerprintOfBlob(blob) {
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

export function describeKey(key) {
  const blob = key.getPublicSSH();
  return {
    type: key.type,
    fingerprint: fingerprintOfBlob(blob),
    comment: key.comment || '',
    publicKey: `${key.type} ${blob.toString('base64')}${key.comment ? ' ' + key.comment : ''}`,
  };
}

function parsePublicKeyLine(line) {
  const parsed = utils.parseKey(line.trim());
  if (parsed instanceof Error) throw new Error(`cannot parse public key: ${parsed.message}`);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  return key.getPublicSSH();
}

/** Run `op read <ref>` (1Password CLI) and return stdout. */
export function opRead(ref, { bin = process.env.PAMSSH_OP_BIN || 'op', timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, ['read', '--no-newline', ref], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const hint = err.code === 'ENOENT' ? ' (1Password CLI `op` not installed or not on PATH)' : '';
        reject(new Error(`op read ${ref} failed${hint}: ${(stderr || err.message).trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Turn an `identity` config block into a predicate over agent keys.
 * Returns null when no identity is configured (all agent keys are offered).
 */
export async function buildKeySelector(identity, { opReader = opRead } = {}) {
  if (!identity) return null;
  const checks = [];
  if (identity.publicKey) {
    const blob = parsePublicKeyLine(identity.publicKey);
    checks.push((k) => k.getPublicSSH().equals(blob));
  }
  if (identity.opRef) {
    const blob = parsePublicKeyLine(await opReader(identity.opRef));
    checks.push((k) => k.getPublicSSH().equals(blob));
  }
  if (identity.fingerprint) {
    const fp = identity.fingerprint.replace(/=+$/, '');
    checks.push((k) => fingerprintOfBlob(k.getPublicSSH()) === fp);
  }
  if (identity.comment) {
    checks.push((k) => (k.comment || '') === identity.comment);
  }
  if (checks.length === 0) return null;
  const selector = (key) => checks.every((c) => c(key));
  selector.description = Object.entries(identity)
    .map(([k, v]) => `${k}=${k === 'publicKey' ? v.slice(0, 24) + '…' : v}`)
    .join(', ');
  return selector;
}

/**
 * Wraps an SSH agent (1Password, OpenSSH, Pageant…) so that only the
 * configured key is offered to the server. 1Password usually holds many keys
 * and gateways typically drop the connection after ~6 failed offers
 * ("Too many authentication failures"), so pinning the key matters.
 *
 * The private key never leaves the agent: ssh2 asks the agent to sign the
 * session's auth challenge and 1Password shows its approval prompt then.
 */
export class SelectiveAgent extends BaseAgent {
  constructor(inner, { selector = null, onSignRequest } = {}) {
    super();
    this.inner = typeof inner === 'string' ? createAgent(inner) : inner;
    this.selector = selector;
    this.onSignRequest = onSignRequest;
  }

  getIdentities(cb) {
    this.inner.getIdentities((err, keys) => {
      if (err) return cb(err);
      if (!this.selector) return cb(null, keys);
      const parsed = keys
        .map((k) => (Buffer.isBuffer(k) ? utils.parseKey(k) : k))
        .filter((k) => !(k instanceof Error));
      const chosen = parsed.filter(this.selector);
      if (chosen.length === 0) {
        const available = parsed.map((k) => describeKey(k))
          .map((d) => `  ${d.fingerprint}  ${d.type}  ${d.comment}`).join('\n') || '  (none)';
        return cb(new Error(
          `no key in the SSH agent matches identity {${this.selector.description}}.\n`
          + `Keys offered by the agent:\n${available}`));
      }
      cb(null, chosen);
    });
  }

  sign(pubKey, data, options, cb) {
    if (typeof options === 'function') {
      cb = options;
      options = undefined;
    }
    try { this.onSignRequest?.(pubKey); } catch { /* ignore listener errors */ }
    this.inner.sign(pubKey, data, options, cb);
  }
}

/** List identities held by an agent (used by `pamssh-mcp keys`). */
export function listAgentIdentities(socketPath) {
  const agent = createAgent(socketPath);
  return new Promise((resolve, reject) => {
    agent.getIdentities((err, keys) => {
      if (err) return reject(new Error(`cannot talk to SSH agent at ${socketPath}: ${err.message}`));
      resolve(keys
        .map((k) => (Buffer.isBuffer(k) ? utils.parseKey(k) : k))
        .filter((k) => !(k instanceof Error))
        .map(describeKey));
    });
  });
}
