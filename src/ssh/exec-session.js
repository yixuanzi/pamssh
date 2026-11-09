import { EventEmitter } from 'node:events';
import { OutputCollector, TextNormalizer } from './output.js';
import { validateCommand } from './shell-session.js';

/**
 * One SSH `exec` channel per command over a persistent authenticated
 * connection. Only usable when the PAM gateway supports exec requests.
 * No shell state is kept between commands; stderr is reported separately.
 */
export class ExecSession extends EventEmitter {
  constructor(client, { logger } = {}) {
    super();
    this.client = client;
    this.logger = logger;
    this.alive = true;
    this.queue = Promise.resolve();
    client.once('close', () => this._onClose());
  }

  async start() {}

  _onClose() {
    if (!this.alive) return;
    this.alive = false;
    this.emit('close');
  }

  run(command, opts = {}) {
    const job = this.queue.then(() => this._run(command, opts));
    this.queue = job.catch(() => {});
    return job;
  }

  /** Signal the running command. Returns false when nothing is running. */
  interrupt() {
    if (!this._current) return false;
    this._current();
    return true;
  }

  _run(command, { timeoutMs = 120_000, maxOutputChars = 20_000, onOutput } = {}) {
    const normalized = validateCommand(command);
    if (!this.alive) return Promise.reject(new Error('connection is closed'));
    const started = Date.now();
    return new Promise((resolve, reject) => {
      this.client.exec(normalized, (err, stream) => {
        if (err) {
          reject(new Error(`gateway refused exec request (${err.message}); try "mode": "shell" for this target`));
          return;
        }
        const out = new OutputCollector(maxOutputChars, { onChunk: onOutput });
        const errOut = new OutputCollector(Math.max(2000, Math.floor(maxOutputChars / 4)), { onChunk: onOutput });
        const outN = new TextNormalizer();
        const errN = new TextNormalizer();
        let exit = { code: null, signal: null };
        let timedOut = false;
        let interrupted = false;
        const stop = (why) => {
          this.logger?.warn(`exec ${why}; signalling remote process`);
          try { stream.signal('INT'); } catch { /* not all servers support signals */ }
          setTimeout(() => { try { stream.close(); } catch { /* ignore */ } }, 2000).unref();
        };
        const timer = setTimeout(() => { timedOut = true; stop(`timed out after ${timeoutMs}ms`); }, timeoutMs);
        timer.unref();
        this._current = () => { interrupted = true; stop('interrupted on request'); };

        stream.on('data', (d) => out.push(outN.push(d)));
        stream.stderr.on('data', (d) => errOut.push(errN.push(d)));
        stream.on('exit', (code, signal) => { exit = { code: code ?? null, signal: signal ?? null }; });
        stream.on('close', () => {
          clearTimeout(timer);
          this._current = null;
          resolve({
            output: out.finish(),
            stderr: errOut.finish(),
            exitCode: exit.code ?? (timedOut || interrupted ? 130 : null),
            signal: exit.signal,
            cwd: null,
            durationMs: Date.now() - started,
            timedOut,
            interrupted,
            truncated: out.truncated || errOut.truncated,
            sessionEnded: false,
          });
        });
      });
    });
  }

  close() {
    this._onClose();
  }
}
