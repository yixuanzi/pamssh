import fs from 'node:fs';
import path from 'node:path';
import { fingerprintOfBlob } from './agent.js';

/**
 * Host key verification for PAM gateways.
 *
 * 1. If the PAM server config pins `hostFingerprint`, the key must match it.
 * 2. Otherwise the key must match what was recorded in the known-hosts store.
 * 3. Unknown hosts are recorded on first use when `trustOnFirstUse` is on,
 *    and refused otherwise. A changed key is always refused.
 */
export class HostKeyStore {
  constructor(file, { trustOnFirstUse = true, logger } = {}) {
    this.file = file;
    this.trustOnFirstUse = trustOnFirstUse;
    this.logger = logger;
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw new Error(`cannot read host key store ${this.file}: ${err.message}`);
    }
  }

  _write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /**
   * @param {string} hostId  "host:port"
   * @param {Buffer} keyBlob raw SSH host key blob
   * @param {string[]} pinned fingerprints from config
   * @returns {{ok: boolean, fingerprint: string, reason: string}}
   */
  verify(hostId, keyBlob, pinned = []) {
    const fingerprint = fingerprintOfBlob(keyBlob);
    const norm = (f) => f.replace(/=+$/, '');
    if (pinned.length) {
      const ok = pinned.map(norm).includes(fingerprint);
      return {
        ok,
        fingerprint,
        reason: ok ? 'pinned' : `host key ${fingerprint} does not match pinned hostFingerprint ${pinned.join(', ')}`,
      };
    }
    const data = this._read();
    const known = data[hostId];
    if (known) {
      const ok = known.map(norm).includes(fingerprint);
      return {
        ok,
        fingerprint,
        reason: ok ? 'known'
          : `HOST KEY CHANGED for ${hostId}: got ${fingerprint}, expected ${known.join(', ')}. `
            + `If this is expected, remove the entry from ${this.file}.`,
      };
    }
    if (!this.trustOnFirstUse) {
      return {
        ok: false,
        fingerprint,
        reason: `unknown host key ${fingerprint} for ${hostId} and trustOnFirstUse is disabled; `
          + 'pin it with pamServers.<id>.hostFingerprint',
      };
    }
    data[hostId] = [fingerprint];
    this._write(data);
    this.logger?.warn(`recorded new host key for ${hostId}: ${fingerprint} (trust on first use)`);
    return { ok: true, fingerprint, reason: 'first-use' };
  }
}
