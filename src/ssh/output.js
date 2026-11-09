import { StringDecoder } from 'node:string_decoder';

// CSI / OSC / single-char escape sequences emitted by shells and TUIs.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function stripAnsi(s) {
  return s.replace(ANSI_RE, '');
}

/**
 * Decodes a byte stream to text and normalizes CRLF -> LF, keeping a dangling
 * CR (or partial UTF-8 sequence) until the next chunk arrives.
 */
export class TextNormalizer {
  constructor() {
    this.decoder = new StringDecoder('utf8');
    this.pendingCR = false;
  }

  push(chunk) {
    let s = (this.pendingCR ? '\r' : '') + this.decoder.write(chunk);
    this.pendingCR = s.endsWith('\r');
    if (this.pendingCR) s = s.slice(0, -1);
    return s.replace(/\r+\n/g, '\n');
  }
}

/**
 * Bounded output accumulator: keeps the first ~30% and last ~70% of the
 * allowed size and records how much was dropped in between.
 */
export class OutputCollector {
  /** @param {(text: string) => void} [onChunk] receives each piece of output as it arrives (ANSI stripped) */
  constructor(limit, { onChunk } = {}) {
    this.onChunk = onChunk;
    this.limit = Math.max(1000, limit);
    this.headLimit = Math.floor(this.limit * 0.3);
    this.tailLimit = this.limit - this.headLimit;
    this.head = '';
    this.tail = '';
    this.dropped = 0;
    this.total = 0;
  }

  push(s) {
    if (!s) return;
    if (this.onChunk) {
      try { this.onChunk(stripAnsi(s)); } catch { /* a listener must not break collection */ }
    }
    this.total += s.length;
    if (this.head.length < this.headLimit) {
      const take = this.headLimit - this.head.length;
      this.head += s.slice(0, take);
      s = s.slice(take);
      if (!s) return;
    }
    this.tail += s;
    if (this.tail.length > this.tailLimit * 2) this._trimTail();
  }

  _trimTail() {
    const cut = this.tail.length - this.tailLimit;
    if (cut > 0) {
      this.dropped += cut;
      this.tail = this.tail.slice(cut);
    }
  }

  get truncated() {
    return this.dropped > 0 || this.tail.length > this.tailLimit;
  }

  finish() {
    this._trimTail();
    const text = this.dropped > 0
      ? `${this.head}\n…[${this.dropped} characters truncated]…\n${this.tail}`
      : this.head + this.tail;
    return collapseCarriageReturns(stripAnsi(text));
  }
}

/**
 * Render `\r` the way a terminal shows it, keeping only the last non-empty
 * segment of each line ("10%\r50%\r100%" -> "100%"), so progress bars don't
 * flood the agent with intermediate states.
 */
export function collapseCarriageReturns(s) {
  if (!s.includes('\r')) return s;
  return s.split('\n').map((line) => {
    if (!line.includes('\r')) return line;
    const parts = line.split('\r');
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i] !== '') return parts[i];
    return '';
  }).join('\n');
}
