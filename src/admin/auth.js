import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE = 'pamssh_admin';
const MAX_SESSION_MS = 12 * 60 * 60_000;
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

const sha256 = (s) => createHash('sha256').update(String(s)).digest();

export function tokenMatches(given, expected) {
  if (!given || !expected) return false;
  return timingSafeEqual(sha256(given), sha256(expected));
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Admin UI authentication. The token is exchanged once for a random session
 * id kept server-side (HttpOnly, SameSite=Strict cookie), so the token itself
 * never sits in the browser. Failed logins are throttled per client address.
 */
export class AdminAuth {
  constructor({ getToken, getIdleMinutes, logger }) {
    this.getToken = getToken;
    this.getIdleMinutes = getIdleMinutes;
    this.logger = logger;
    this.sessions = new Map();
    this.failures = new Map();
    this._tokenHash = null;
  }

  get enabled() {
    return Boolean(this.getToken());
  }

  /** Drop all sessions (except `keepSid`) when the admin token changes. */
  syncToken(keepSid) {
    const h = this.getToken() ? sha256(this.getToken()).toString('hex') : null;
    if (this._tokenHash !== null && h !== this._tokenHash) {
      for (const sid of this.sessions.keys()) if (sid !== keepSid) this.sessions.delete(sid);
      this.logger?.info('admin token changed: other admin sessions signed out');
    }
    this._tokenHash = h;
  }

  login(token, ip) {
    const now = Date.now();
    const f = this.failures.get(ip);
    if (f?.lockedUntil > now) {
      return { ok: false, status: 429, retryAfter: Math.ceil((f.lockedUntil - now) / 1000), error: '尝试次数过多，请稍后再试' };
    }
    if (!this.enabled) {
      return { ok: false, status: 403, error: '管理页面未启用：配置文件中没有 server.adminToken。运行 `pamssh-mcp token --admin --rotate` 生成后重试。' };
    }
    if (!tokenMatches(token, this.getToken())) {
      const rec = f && now - f.first < FAIL_WINDOW_MS ? f : { first: now, count: 0 };
      rec.count++;
      if (rec.count >= MAX_FAILS) rec.lockedUntil = now + LOCK_MS;
      this.failures.set(ip, rec);
      this.logger?.warn(`admin login failed from ${ip} (${rec.count}/${MAX_FAILS})`);
      return { ok: false, status: 401, error: '令牌不正确' };
    }
    this.failures.delete(ip);
    this.syncToken();
    const sid = randomBytes(32).toString('base64url');
    this.sessions.set(sid, { created: now, lastSeen: now, ip });
    this.logger?.info(`admin login from ${ip}`);
    return { ok: true, sid };
  }

  /** Session for this request, or null. Bearer admin token also works (for scripts). */
  authenticate(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (m) return tokenMatches(m[1].trim(), this.getToken()) ? { sid: null, bearer: true } : null;
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (!sid) return null;
    const s = this.sessions.get(sid);
    if (!s) return null;
    const now = Date.now();
    const idleMs = this.getIdleMinutes() * 60_000;
    if (now - s.lastSeen > idleMs || now - s.created > MAX_SESSION_MS || !this.enabled) {
      this.sessions.delete(sid);
      return null;
    }
    s.lastSeen = now;
    return { sid, bearer: false, expiresAt: Math.min(now + idleMs, s.created + MAX_SESSION_MS) };
  }

  logout(sid) {
    if (sid) this.sessions.delete(sid);
  }

  cookie(sid) {
    return `${COOKIE}=${sid}; Path=/admin; HttpOnly; SameSite=Strict`;
  }

  clearCookie() {
    return `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`;
  }
}

/**
 * State-changing requests authenticated by cookie must come from our own page:
 * a custom header (forces a CORS preflight we never answer) and, when the
 * browser sends Origin, it must be this server.
 */
export function sameOriginWrite(req) {
  if (req.headers['x-pamssh-admin'] !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
