const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * Minimal leveled logger. Always writes to stderr so it never corrupts the
 * stdio MCP transport (which owns stdout).
 */
export function createLogger(level = process.env.PAMSSH_LOG_LEVEL || 'info', { stream = process.stderr } = {}) {
  let threshold = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, msg, extra) => {
    if (LEVELS[lvl] > threshold) return;
    let line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}`;
    if (extra !== undefined) {
      line += ' ' + (extra instanceof Error ? (extra.stack || extra.message) : JSON.stringify(extra));
    }
    stream.write(line + '\n');
  };
  return {
    error: (m, e) => write('error', m, e),
    warn: (m, e) => write('warn', m, e),
    info: (m, e) => write('info', m, e),
    debug: (m, e) => write('debug', m, e),
    setLevel(l) { threshold = LEVELS[l] ?? threshold; },
    child(prefix) {
      const parent = this;
      return {
        error: (m, e) => parent.error(`[${prefix}] ${m}`, e),
        warn: (m, e) => parent.warn(`[${prefix}] ${m}`, e),
        info: (m, e) => parent.info(`[${prefix}] ${m}`, e),
        debug: (m, e) => parent.debug(`[${prefix}] ${m}`, e),
        setLevel: parent.setLevel,
        child: (p) => parent.child(`${prefix}:${p}`),
      };
    },
  };
}

export const silentLogger = {
  error() {}, warn() {}, info() {}, debug() {}, setLevel() {},
  child() { return silentLogger; },
};
