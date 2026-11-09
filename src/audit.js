import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only JSONL audit trail of every command an agent asked to run.
 * Command output is deliberately not recorded (it may contain secrets); the
 * PAM gateway's own session recording remains the authoritative audit.
 */
export class AuditLog {
  constructor({ enabled = true, file } = {}, { logger } = {}) {
    this.enabled = enabled && Boolean(file);
    this.file = file;
    this.logger = logger;
    this._ready = false;
  }

  write(entry) {
    if (!this.enabled) return;
    try {
      if (!this._ready) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        this._ready = true;
      }
      fs.appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
    } catch (err) {
      this.logger?.error(`failed to write audit log ${this.file}: ${err.message}`);
    }
  }
}
