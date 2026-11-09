import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60_000;

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

  /**
   * Remove entries older than `retentionDays` (0 = keep everything).
   * Lines without a readable timestamp are kept. The file is rewritten
   * atomically (0600) only when something was removed. Runs even when
   * auditing is disabled, so old data still expires. Returns { removed, kept }.
   */
  prune(retentionDays, now = Date.now()) {
    if (!this.file || !retentionDays) return { removed: 0, kept: null };
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { removed: 0, kept: 0 };
      this.logger?.error(`audit retention: cannot read ${this.file}: ${err.message}`);
      return { removed: 0, kept: null, error: err.message };
    }
    const cutoff = now - retentionDays * DAY_MS;
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const keep = [];
    let removed = 0;
    for (const line of lines) {
      let ts = NaN;
      try { ts = Date.parse(JSON.parse(line).ts); } catch { /* unreadable line: keep it */ }
      if (!Number.isNaN(ts) && ts < cutoff) removed++;
      else keep.push(line);
    }
    if (removed === 0) return { removed: 0, kept: keep.length };
    try {
      const tmp = `${this.file}.${process.pid}.prune.tmp`;
      fs.writeFileSync(tmp, keep.length ? `${keep.join('\n')}\n` : '', { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.logger?.error(`audit retention: cannot rewrite ${this.file}: ${err.message}`);
      return { removed: 0, kept: null, error: err.message };
    }
    this.logger?.info(`audit retention: removed ${removed} entries older than ${retentionDays} days from ${this.file}`);
    return { removed, kept: keep.length };
  }
}
