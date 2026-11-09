import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ConfigError, validateConfig } from './config.js';

const MAX_BACKUPS = 30;
const BACKUP_RE = /^config-\d{8}T\d{6}\d{3}Z(-\d+)?\.json$/;

export class ConfigConflictError extends Error {
  constructor() {
    super('配置文件已被其他人或进程修改，请重新加载后再保存');
    this.name = 'ConfigConflictError';
    this.status = 409;
  }
}

export class ConfigValidationError extends Error {
  constructor(issues) {
    super(`配置校验失败（${issues.length} 处问题）`);
    this.name = 'ConfigValidationError';
    this.status = 400;
    this.issues = issues;
  }
}

const versionOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Owns the config file on disk: validated atomic writes, timestamped backups,
 * optimistic concurrency (a save names the version it was based on) and the
 * current normalized config used by the running server.
 */
export class ConfigStore {
  constructor(file, config, text) {
    this.file = file;
    this.backupDir = path.join(path.dirname(file), 'backups');
    this._config = config;
    this._version = versionOf(text);
  }

  static load(file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new ConfigError(err.code === 'ENOENT' ? 'config file not found; run `pamssh-mcp init`' : err.message, file);
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new ConfigError(`not valid JSON: ${err.message}`, file);
    }
    const r = validateConfig(raw, { file });
    if (!r.ok) {
      throw new ConfigError(`invalid configuration\n${r.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`, file);
    }
    return new ConfigStore(file, r.config, text);
  }

  get config() { return this._config; }
  get version() { return this._version; }

  /** Raw JSON as stored on disk (what the admin UI edits) plus its version. */
  readRaw() {
    const text = fs.readFileSync(this.file, 'utf8');
    return { raw: JSON.parse(text), version: versionOf(text) };
  }

  validate(raw) {
    return validateConfig(raw, { file: this.file, locale: 'zh' });
  }

  /**
   * Validate and write `raw`. `baseVersion` must match the file on disk
   * (pass null to skip the check). Returns the new normalized config.
   */
  save(raw, { baseVersion } = {}) {
    const current = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : null;
    if (baseVersion !== null && baseVersion !== undefined && current !== null && versionOf(current) !== baseVersion) {
      throw new ConfigConflictError();
    }
    const r = this.validate(raw);
    if (!r.ok) throw new ConfigValidationError(r.issues);
    const text = JSON.stringify(raw, null, 2) + '\n';
    if (current !== null && current !== text) this._backup(current);
    writePrivate(this.file, text);
    const previous = this._config;
    this._config = r.config;
    this._version = versionOf(text);
    return { config: r.config, previous, version: this._version, changed: current !== text };
  }

  /** Re-read the file (e.g. after a manual edit) and return the new config if it changed. */
  reload() {
    const { raw, version } = this.readRaw();
    if (version === this._version) return { changed: false, config: this._config, version };
    const r = this.validate(raw);
    if (!r.ok) throw new ConfigValidationError(r.issues);
    const previous = this._config;
    this._config = r.config;
    this._version = version;
    return { changed: true, config: r.config, previous, version };
  }

  _backup(text) {
    fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace(/(\d{6})(\d{3})Z$/, '$1$2Z');
    let name = `config-${stamp}.json`;
    for (let i = 1; fs.existsSync(path.join(this.backupDir, name)); i++) name = `config-${stamp}-${i}.json`;
    fs.writeFileSync(path.join(this.backupDir, name), text, { mode: 0o600 });
    const all = this.listBackups();
    for (const old of all.slice(MAX_BACKUPS)) {
      try { fs.unlinkSync(path.join(this.backupDir, old.name)); } catch { /* ignore */ }
    }
  }

  /** Newest first. */
  listBackups() {
    let names = [];
    try { names = fs.readdirSync(this.backupDir).filter((n) => BACKUP_RE.test(n)); } catch { return []; }
    return names
      .map((name) => {
        const st = fs.statSync(path.join(this.backupDir, name));
        return { name, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.name < b.name ? 1 : -1));
  }

  readBackup(name) {
    if (!BACKUP_RE.test(name)) throw Object.assign(new Error('无效的备份名'), { status: 400 });
    const file = path.join(this.backupDir, name);
    if (!fs.existsSync(file)) throw Object.assign(new Error('备份不存在'), { status: 404 });
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
}
