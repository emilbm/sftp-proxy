import crypto from 'node:crypto';

export const COOKIE_NAME = 'sftp_proxy_session';

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

/**
 * One shared password, no users. A session is just a signed expiry time:
 * `<expiresAtMs>.<hmac>`. There is nothing stored server-side to look up, so
 * the container keeps no state and survives a restart (given SESSION_SECRET).
 *
 * The signing key mixes in the site password, so changing SITE_PASSWORD signs
 * every existing session out.
 */
export function createAuth({ password, sessionSecret, sessionMaxAgeMs, now = Date.now }) {
  const secret = sessionSecret || crypto.randomBytes(32).toString('hex');
  const key = crypto.createHmac('sha256', secret).update(password).digest();
  const expected = digest(password);

  const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');

  return {
    ephemeralSecret: !sessionSecret,

    /** Constant-time, including for a guess of a different length. */
    checkPassword(candidate) {
      if (typeof candidate !== 'string' || !candidate) return false;
      return crypto.timingSafeEqual(digest(candidate), expected);
    },

    issue() {
      const payload = String(now() + sessionMaxAgeMs);
      return `${payload}.${sign(payload)}`;
    },

    verify(token) {
      if (typeof token !== 'string') return false;
      const dot = token.indexOf('.');
      if (dot <= 0) return false;
      const payload = token.slice(0, dot);
      const given = Buffer.from(token.slice(dot + 1));
      const wanted = Buffer.from(sign(payload));
      if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return false;
      const expiresAt = Number(payload);
      return Number.isFinite(expiresAt) && expiresAt > now();
    },
  };
}

/**
 * Counts failed logins per client and refuses further attempts once a client
 * hits the limit, until its oldest failure ages out of the window. Successful
 * logins clear the count.
 */
export function createLoginLimiter({ maxFailures, windowMs, now = Date.now }) {
  const failures = new Map();

  function recent(key) {
    const cutoff = now() - windowMs;
    const list = (failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) failures.set(key, list);
    else failures.delete(key);
    return list;
  }

  return {
    /** @returns {number} seconds until the client may try again; 0 if allowed now */
    retryAfter(key) {
      const list = recent(key);
      if (list.length < maxFailures) return 0;
      return Math.max(1, Math.ceil((list[0] + windowMs - now()) / 1000));
    },
    fail(key) {
      const list = recent(key);
      list.push(now());
      failures.set(key, list);
      // Bound memory if someone sprays from many addresses.
      if (failures.size > 10_000) failures.delete(failures.keys().next().value);
    },
    succeed(key) {
      failures.delete(key);
    },
  };
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch { /* keep raw */ }
    if (!(name in out)) out[name] = value;
  }
  return out;
}
