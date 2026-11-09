const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const RING_SIZE = 1000;

/**
 * Minimal leveled logger. Always writes to stderr so it never corrupts the
 * stdio MCP transport (which owns stdout). The last lines are also kept in
 * memory for the admin UI (`recent()`).
 */
export function createLogger(level = process.env.PAMSSH_LOG_LEVEL || 'info', { stream = process.stderr } = {}) {
  let threshold = LEVELS[level] ?? LEVELS.info;
  const ring = [];
  let seq = 0;
  const write = (lvl, msg, extra) => {
    if (LEVELS[lvl] > threshold) return;
    const ts = new Date().toISOString();
    let detail;
    if (extra !== undefined) {
      detail = extra instanceof Error ? (extra.stack || extra.message) : JSON.stringify(extra);
    }
    stream.write(`${ts} ${lvl.toUpperCase().padEnd(5)} ${msg}${detail ? ' ' + detail : ''}\n`);
    ring.push({ seq: ++seq, ts, level: lvl, msg: detail ? `${msg} ${detail}` : msg });
    if (ring.length > RING_SIZE) ring.shift();
  };
  const root = {
    error: (m, e) => write('error', m, e),
    warn: (m, e) => write('warn', m, e),
    info: (m, e) => write('info', m, e),
    debug: (m, e) => write('debug', m, e),
    setLevel(l) { if (LEVELS[l] !== undefined) threshold = LEVELS[l]; },
    get level() { return Object.keys(LEVELS).find((k) => LEVELS[k] === threshold); },
    /** Most recent entries, newest last; `afterSeq` returns only newer ones. */
    recent({ limit = 200, afterSeq = 0 } = {}) {
      return ring.filter((e) => e.seq > afterSeq).slice(-limit);
    },
    child(prefix) {
      return makeChild(root, prefix);
    },
  };
  return root;
}

function makeChild(root, prefix) {
  return {
    error: (m, e) => root.error(`[${prefix}] ${m}`, e),
    warn: (m, e) => root.warn(`[${prefix}] ${m}`, e),
    info: (m, e) => root.info(`[${prefix}] ${m}`, e),
    debug: (m, e) => root.debug(`[${prefix}] ${m}`, e),
    setLevel: (l) => root.setLevel(l),
    recent: (o) => root.recent(o),
    child: (p) => makeChild(root, `${prefix}:${p}`),
  };
}

export const silentLogger = {
  error() {}, warn() {}, info() {}, debug() {}, setLevel() {},
  recent() { return []; },
  child() { return silentLogger; },
};
