import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { OutputCollector, TextNormalizer, stripAnsi } from './output.js';

/**
 * Persistent PTY shell over a PAM gateway.
 *
 * PAM gateways reliably support only interactive shells (many reject `exec`
 * requests), so commands are typed into one long-lived shell and their output
 * is framed by unique markers:
 *
 *   printf '%s%s\n' '__PAMSSH_<nonce>_<seq>' '_B__'; eval '<command, single-quoted>' </dev/null; \
 *     printf '\n%s%s:%s:%s\n' '__PAMSSH_<nonce>_<seq>' '_E__' "$?" "$PWD"
 *
 * - The marker is assembled by printf from two halves, so terminal echo of the
 *   typed line can never be mistaken for the marker itself.
 * - The command is sent as readable text (only `'` is escaped as '\''), not
 *   encoded, so PAM session recordings and keystroke audits show what ran.
 * - Our outer single quotes are always balanced whatever the command contains,
 *   so syntax errors / unbalanced quotes surface as an eval error instead of
 *   leaving the shell stuck at a PS2 prompt. (A here-doc inside $(...) was
 *   tried first and hangs bash 3.2 on unbalanced quotes.)
 * - eval runs in the current shell (cd/export persist) and stdin is /dev/null
 *   so commands can't swallow the next command or block on input.
 */

const MAX_LINE_BYTES = 4000; // canonical-mode TTYs truncate lines at 4095 bytes
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CTRL = /[\x00-\x08\x0b-\x1f\x7f]/;

/** Race a promise against a timer that is always cleared afterwards. */
function withTimeout(promise, ms, timeoutValue) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(timeoutValue), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildPrelude(nonce, initLines = []) {
  return [
    'stty -echo -onlcr 2>/dev/null',
    // bash: drop readline (no tab completion / bracketed paste), disable `!` history expansion
    'if [ -n "${BASH_VERSION:-}" ]; then set +o emacs; set +o vi; set +H; fi 2>/dev/null',
    // zsh: drop the line editor, partial-line marker and `!` expansion; freeze tty
    // modes so zsh doesn't turn echo back on after a job is interrupted
    'if [ -n "${ZSH_VERSION:-}" ]; then unsetopt zle prompt_cr prompt_sp bang_hist; RPROMPT=; RPS1=; ttyctl -f; fi 2>/dev/null',
    "unset PROMPT_COMMAND 2>/dev/null; PS1=''; PS2=''; PS3=''; PS4='+ '",
    'export TERM=dumb PAGER=cat GIT_PAGER=cat MANPAGER=cat SYSTEMD_PAGER=cat NO_COLOR=1 LESS=-FRX 2>/dev/null',
    ...initLines,
    `printf '%s%s\\n' '__PAMSSH_${nonce}' '_READY__'`,
  ].join('\n') + '\n';
}

export function validateCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('command must be a non-empty string');
  }
  const normalized = command.replace(/\r\n?/g, '\n');
  if (FORBIDDEN_CTRL.test(normalized)) {
    throw new Error('command contains control characters (only \\n and \\t are allowed)');
  }
  for (const line of normalized.split('\n')) {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      throw new Error(`a command line exceeds ${MAX_LINE_BYTES} bytes; split it into shorter lines `
        + '(terminals silently truncate long lines)');
    }
  }
  return normalized;
}

/** Single-quote a string for POSIX shells: only `'` needs escaping ('\''). */
export function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function wrapCommand(nonce, seq, command) {
  const tag = `__PAMSSH_${nonce}_${seq}`;
  const wire = `printf '%s%s\\n' '${tag}' '_B__'; eval ${shellQuote(command)} </dev/null; `
    + `printf '\\n%s%s:%s:%s\\n' '${tag}' '_E__' "$?" "$PWD"\n`;
  for (const line of wire.split('\n')) {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      throw new Error(`a command line exceeds ${MAX_LINE_BYTES - 200} bytes; split it into shorter lines `
        + '(terminals silently truncate long lines)');
    }
  }
  return wire;
}

/** Sent after Ctrl-C: re-disable echo (some shells restore tty modes) and emit the END marker. */
export function syncLine(nonce, seq, code) {
  return `stty -echo -onlcr 2>/dev/null; printf '\\n%s%s:%s:%s\\n' '__PAMSSH_${nonce}_${seq}' '_E__' ${code} "$PWD"\n`;
}

/**
 * Pure state machine that finds READY / BEGIN / END markers in normalized
 * shell output and streams the bytes in between into an OutputCollector.
 */
export class MarkerParser {
  constructor(nonce) {
    this.nonce = nonce;
    this.state = 'idle';
    this.buf = '';
    this.collector = null;
    this.seq = null;
  }

  expectReady() {
    this.state = 'ready';
    this.readyMarker = `__PAMSSH_${this.nonce}_READY__\n`;
  }

  expectCommand(seq, collector) {
    this.state = 'begin';
    this.seq = seq;
    this.collector = collector;
    const tag = `__PAMSSH_${this.nonce}_${seq}`;
    this.beginMarker = `${tag}_B__\n`;
    this.endPrefix = `\n${tag}_E__:`;
    this.endRe = new RegExp(`${escapeRe(this.endPrefix)}(\\d+):([^\\n]*)\\n`);
    // Anything already buffered predates this command.
    this.buf = '';
  }

  /** Stop collecting (after an interrupt) but still look for the END marker. */
  drain() {
    if (this.state === 'collect') {
      // Keep output that was only held back as a possible marker prefix.
      if (this.buf.indexOf(this.endPrefix) < 0) {
        this.collector.push(this.buf);
        this.buf = '';
      }
      this.state = 'drain';
    }
    if (this.state === 'drain' || this.state === 'begin') this.collector = null;
  }

  /** @returns {Array<{type:'ready'}|{type:'end',seq:number,exitCode:number,cwd:string}>} */
  feed(text) {
    const events = [];
    this.buf += text;
    for (;;) {
      if (this.state === 'ready') {
        const i = this.buf.indexOf(this.readyMarker);
        if (i < 0) { this._cap(); break; }
        this.buf = this.buf.slice(i + this.readyMarker.length);
        this.state = 'idle';
        events.push({ type: 'ready' });
        continue;
      }
      if (this.state === 'begin') {
        const i = this.buf.indexOf(this.beginMarker);
        const m = this.endRe.exec(this.buf);
        if (i >= 0 && (!m || i < m.index)) {
          this.buf = this.buf.slice(i + this.beginMarker.length);
          this.state = this.collector ? 'collect' : 'drain';
          continue;
        }
        if (m) { // END without BEGIN: interrupted before the command started
          this.buf = this.buf.slice(m.index + m[0].length);
          events.push(this._end(m));
          continue;
        }
        this._cap();
        break;
      }
      if (this.state === 'collect') {
        const m = this.endRe.exec(this.buf);
        if (m) {
          this.collector.push(this.buf.slice(0, m.index));
          this.buf = this.buf.slice(m.index + m[0].length);
          events.push(this._end(m));
          continue;
        }
        const hold = this._holdFrom();
        this.collector.push(this.buf.slice(0, hold));
        this.buf = this.buf.slice(hold);
        break;
      }
      if (this.state === 'drain') {
        const m = this.endRe.exec(this.buf);
        if (m) {
          this.buf = this.buf.slice(m.index + m[0].length);
          events.push(this._end(m));
          continue;
        }
        this.buf = this.buf.slice(this._holdFrom());
        break;
      }
      // idle: nothing expected (prompts, job notices, gateway banners)
      this.buf = '';
      break;
    }
    return events;
  }

  _end(m) {
    this.state = 'idle';
    const ev = { type: 'end', seq: this.seq, exitCode: Number(m[1]), cwd: m[2] };
    this.collector = null;
    return ev;
  }

  /** Index from which the buffer might still be the start of an END marker. */
  _holdFrom() {
    const full = this.buf.indexOf(this.endPrefix);
    if (full >= 0) return full; // marker started, waiting for the rest of its line
    const max = Math.min(this.endPrefix.length - 1, this.buf.length);
    for (let k = max; k > 0; k--) {
      if (this.endPrefix.startsWith(this.buf.slice(this.buf.length - k))) return this.buf.length - k;
    }
    return this.buf.length;
  }

  _cap() {
    if (this.buf.length > 65536) this.buf = this.buf.slice(-4096);
  }
}

// End of a typical interactive prompt: "$ ", "# ", "% ", "> " (after ANSI stripping).
const PROMPT_RE = /[$#%>❯]\s?$/;

export class ShellSession extends EventEmitter {
  constructor(client, {
    term = 'dumb', cols = 250, rows = 50, init = [], readyTimeoutMs = 30_000,
    settleMs = 1500, retryMs = 4000, logger,
  } = {}) {
    super();
    this.client = client;
    this.opts = { term, cols, rows, init, readyTimeoutMs, settleMs, retryMs };
    this.logger = logger;
    this.nonce = randomBytes(6).toString('hex');
    this.parser = new MarkerParser(this.nonce);
    this.normalizer = new TextNormalizer();
    this.seq = 0;
    this.queue = Promise.resolve();
    this.alive = false;
    this.transcriptTail = '';
    this.exitInfo = null;
    this._waiter = null;
  }

  async start() {
    const { term, cols, rows, init, readyTimeoutMs, settleMs, retryMs } = this.opts;
    this.stream = await new Promise((resolve, reject) => {
      this.client.shell({ term, cols, rows, modes: { ECHO: 0, ONLCR: 0 } }, (err, stream) => {
        if (err) reject(new Error(`gateway refused to open a shell: ${err.message}`));
        else resolve(stream);
      });
    });
    this.alive = true;
    this.openedAt = Date.now();
    this.lastDataAt = null;
    this.stream.on('data', (d) => this._onData(d));
    this.stream.stderr.on('data', (d) => this._onData(d));
    this.stream.on('exit', (code, signal) => { this.exitInfo = { code, signal }; });
    this.stream.on('close', () => this._onClose());

    // PAM gateways often chain logins (gateway host -> recorder -> target sshd).
    // Input typed before the final shell is up can be flushed on the way, so
    // wait for the login output to settle, and re-send the (idempotent)
    // prelude until the READY marker comes back.
    const deadline = this.openedAt + readyTimeoutMs;
    this.parser.expectReady();
    const ready = this._waitFor((ev) => ev.type === 'ready');
    let outcome = false;
    let attempts = 0;
    while (this.alive && Date.now() < deadline) {
      await this._settle(deadline, attempts === 0 ? settleMs : 500);
      if (!this.alive || Date.now() >= deadline) break;
      attempts++;
      if (attempts > 1) this.logger?.debug(`no READY from remote shell yet; re-sending prelude (attempt ${attempts})`);
      this.stream.write(buildPrelude(this.nonce, init));
      outcome = await withTimeout(ready, Math.max(1, Math.min(retryMs, deadline - Date.now())), false);
      if (outcome !== false) break;
    }
    if (outcome !== true) {
      this._waiter = null;
      const closedByRemote = !this.alive;
      const seen = stripAnsi(this.transcriptTail).trim().slice(-600);
      this.close();
      throw new Error(`remote side did not become a usable POSIX shell within ${readyTimeoutMs}ms `
        + `(${attempts} attempt(s)${closedByRemote ? ', channel closed by remote' : ''}). `
        + `Last output from gateway:\n${seen || '(nothing)'}`);
    }
    this.logger?.debug(`remote shell ready after ${Date.now() - this.openedAt}ms (${attempts} attempt(s))`);
  }

  /**
   * Resolve once login output has gone quiet: shortly after a prompt-looking
   * line, or after `quietMs` without output (shells with empty prompts).
   */
  async _settle(deadline, quietMs) {
    while (this.alive && Date.now() < deadline) {
      const since = Date.now() - (this.lastDataAt ?? this.openedAt);
      const promptLike = PROMPT_RE.test(stripAnsi(this.transcriptTail.slice(-200)).trimEnd() + ' ');
      if (since >= (promptLike ? 300 : quietMs)) return;
      await delay(100);
    }
  }

  _onData(chunk) {
    const text = this.normalizer.push(chunk);
    if (!text) return;
    this.lastDataAt = Date.now();
    this.transcriptTail = (this.transcriptTail + text).slice(-4096);
    for (const ev of this.parser.feed(text)) {
      if (this._waiter && this._waiter.match(ev)) {
        const w = this._waiter;
        this._waiter = null;
        w.resolve(ev.type === 'ready' ? true : ev);
      }
    }
  }

  _onClose() {
    if (!this.alive) return;
    this.alive = false;
    this.logger?.debug('shell channel closed', this.exitInfo || undefined);
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      w.resolve({ type: 'closed' });
    }
    this.emit('close', this.exitInfo);
  }

  _waitFor(match) {
    return new Promise((resolve) => { this._waiter = { match, resolve }; });
  }

  /** Run one command; calls are serialized per session. */
  run(command, opts = {}) {
    const job = this.queue.then(() => this._run(command, opts));
    this.queue = job.catch(() => {});
    return job;
  }

  async _run(command, { timeoutMs = 120_000, maxOutputChars = 20_000 } = {}) {
    const normalized = validateCommand(command);
    if (!this.alive) throw new Error('shell session is closed');
    const seq = ++this.seq;
    const collector = new OutputCollector(maxOutputChars);
    const started = Date.now();
    this.parser.expectCommand(seq, collector);
    const done = this._waitFor((ev) => ev.type === 'closed' || (ev.type === 'end' && ev.seq === seq));
    this.stream.write(wrapCommand(this.nonce, seq, normalized));

    let ev = await withTimeout(done, timeoutMs, null);
    let timedOut = false;
    if (ev === null) {
      timedOut = true;
      this.logger?.warn(`command #${seq} timed out after ${timeoutMs}ms; sending Ctrl-C`);
      this.parser.drain();
      this.stream.write('\x03');
      await delay(300);
      if (this.alive) this.stream.write(syncLine(this.nonce, seq, 130));
      ev = await withTimeout(done, 5000, null);
      if (ev === null) {
        this._waiter = null;
        this.logger?.warn('shell did not recover after Ctrl-C; closing session');
        this.close();
        ev = { type: 'closed' };
      }
    }

    const sessionEnded = ev.type === 'closed';
    return {
      output: collector.finish(),
      exitCode: sessionEnded ? (this.exitInfo?.code ?? null) : ev.exitCode,
      cwd: sessionEnded ? null : ev.cwd,
      durationMs: Date.now() - started,
      timedOut,
      truncated: collector.truncated,
      sessionEnded,
    };
  }

  close() {
    if (this.stream) {
      try { this.stream.end('exit\n'); } catch { /* ignore */ }
      try { this.stream.close(); } catch { /* ignore */ }
    }
    this._onClose();
  }
}
