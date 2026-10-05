import crypto from 'node:crypto';

export const COOKIE_NAME = 'sftp_proxy_session';
export const ROLES = ['viewer', 'admin'];

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function sameBytes(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Two shared passwords, no users: the download password makes a `viewer`
 * session, the optional admin password an `admin` one. A session is just a
 * signed `<role>.<expiresAtMs>`; nothing is stored server-side, so the
 * container keeps no state and survives a restart (given SESSION_SECRET).
 *
 * Each role signs with a key that mixes in its own password, so changing one
 * password signs out exactly the sessions it created.
 */
export function createAuth({
  password, adminPassword = '', sessionSecret, sessionMaxAgeMs, adminSessionMaxAgeMs,
  now = Date.now,
}) {
  const secret = sessionSecret || crypto.randomBytes(32).toString('hex');
  const roles = {
    viewer: {
      expected: digest(password),
      key: crypto.createHmac('sha256', secret).update(`viewer\0${password}`).digest(),
      maxAgeMs: sessionMaxAgeMs,
    },
    ...(adminPassword ? {
      admin: {
        expected: digest(adminPassword),
        key: crypto.createHmac('sha256', secret).update(`admin\0${adminPassword}`).digest(),
        maxAgeMs: adminSessionMaxAgeMs ?? sessionMaxAgeMs,
      },
    } : {}),
  };

  const sign = (role, payload) =>
    crypto.createHmac('sha256', roles[role].key).update(payload).digest('base64url');

  function verify(token) {
    if (typeof token !== 'string') return null;
    const [role, expires, sig, extra] = token.split('.');
    if (extra !== undefined || !roles[role] || !expires || !sig) return null;
    if (!sameBytes(sig, sign(role, `${role}.${expires}`))) return null;
    const expiresAt = Number(expires);
    return Number.isFinite(expiresAt) && expiresAt > now() ? role : null;
  }

  return {
    ephemeralSecret: !sessionSecret,
    adminEnabled: Boolean(roles.admin),

    /**
     * Constant-time against both passwords, including guesses of a different
     * length. Both comparisons always run, so timing says nothing about which
     * password a guess was close to.
     * @returns {'admin'|'viewer'|null}
     */
    checkPassword(candidate) {
      if (typeof candidate !== 'string' || !candidate) return null;
      const d = digest(candidate);
      let match = null;
      for (const role of ['viewer', 'admin']) {
        if (roles[role] && crypto.timingSafeEqual(d, roles[role].expected)) match = role;
      }
      return match;
    },

    /** @returns {{token: string, maxAgeMs: number}} */
    issue(role) {
      const { maxAgeMs } = roles[role];
      const payload = `${role}.${now() + maxAgeMs}`;
      return { token: `${payload}.${sign(role, payload)}`, maxAgeMs };
    },

    /** @returns {'admin'|'viewer'|null} the session's role, if it is valid */
    verify,

    /**
     * Anti-forgery token, bound to the session cookie. Pages embed it; every
     * request that changes something (admin actions, creating a share link)
     * must send it back in a header, which another site cannot do.
     */
    csrfToken(sessionToken) {
      const role = verify(sessionToken);
      if (!role) return '';
      return crypto.createHmac('sha256', roles[role].key).update(`csrf\0${sessionToken}`).digest('base64url');
    },

    checkCsrf(sessionToken, given) {
      if (typeof given !== 'string' || !given) return false;
      const wanted = this.csrfToken(sessionToken);
      return Boolean(wanted) && sameBytes(given, wanted);
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
