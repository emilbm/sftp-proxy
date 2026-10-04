import fs from 'node:fs';
import { parseDsn } from './sentry.js';

function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  throw new Error(`${name} must be a boolean (true/false), got "${v}"`);
}

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${v}"`);
  }
  return n;
}

/**
 * `SHA256:abc...` as printed by `ssh-keygen -lf`, with or without the prefix
 * and trailing padding, normalised to the bare unpadded base64 we compare.
 */
export function parseFingerprint(raw) {
  if (!raw) return null;
  const bare = raw.trim().replace(/^SHA256:/i, '').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]{43}$/.test(bare)) {
    throw new Error(
      `SFTP_HOST_KEY_SHA256 must be a SHA256 fingerprint like "SHA256:abc...", got "${raw}"`,
    );
  }
  return bare;
}

export function loadConfig(env = process.env) {
  const previous = process.env;
  process.env = env;
  try {
    const problems = [];
    const need = (name) => {
      const v = str(name, '');
      if (!v) problems.push(`${name} is required`);
      return v;
    };

    const keyPath = str('SFTP_PRIVATE_KEY_PATH', '');
    let privateKey = null;
    if (keyPath) {
      try {
        privateKey = fs.readFileSync(keyPath);
      } catch (err) {
        problems.push(`SFTP_PRIVATE_KEY_PATH "${keyPath}" could not be read: ${err.message}`);
      }
    }

    const cfg = {
      tz: str('TZ', 'Europe/Copenhagen'),
      logLevel: str('LOG_LEVEL', 'info'),

      sftp: {
        host: need('SFTP_HOST'),
        port: int('SFTP_PORT', 22, { min: 1, max: 65535 }),
        username: need('SFTP_USERNAME'),
        password: str('SFTP_PASSWORD', ''),
        privateKey,
        passphrase: str('SFTP_PRIVATE_KEY_PASSPHRASE', ''),
        hostKeySha256: parseFingerprint(str('SFTP_HOST_KEY_SHA256', '')),
        // Relative paths resolve against the SFTP user's login directory.
        root: str('SFTP_PUBLIC_DIR', 'public'),
        connectTimeoutMs: int('SFTP_CONNECT_TIMEOUT_SECONDS', 10, { min: 1 }) * 1000,
        // Dropped after this long unused, so an idle site holds no connection.
        idleCloseMs: int('SFTP_IDLE_CLOSE_SECONDS', 300, { min: 0 }) * 1000,
      },

      web: {
        port: int('WEB_PORT', 8080, { min: 1, max: 65535 }),
        address: str('WEB_ADDRESS', '0.0.0.0'),
        title: str('SITE_TITLE', 'Files'),
        showHidden: bool('SHOW_HIDDEN', false),
        // Only behind a proxy you control (Cloudflare tunnel, Caddy). Otherwise
        // any client could pick its own address for the login rate limit.
        trustProxy: bool('TRUST_PROXY', false),
      },

      auth: {
        password: need('SITE_PASSWORD'),
        // Without one, a random key is made at startup and every restart signs
        // everyone out. Harmless, but set it if that gets annoying.
        sessionSecret: str('SESSION_SECRET', ''),
        sessionMaxAgeMs: int('SESSION_DAYS', 30, { min: 1, max: 3650 }) * 86_400_000,
        // Optional. Unlocks upload, new folder, rename and delete. Empty
        // leaves the site download-only.
        adminPassword: str('ADMIN_PASSWORD', ''),
        // Short, so a forgotten signed-in browser is not an open door.
        adminSessionMaxAgeMs: int('ADMIN_SESSION_HOURS', 12, { min: 1, max: 24 * 90 }) * 3_600_000,
        maxFailures: int('LOGIN_MAX_FAILURES', 10, { min: 1 }),
        failureWindowMs: int('LOGIN_LOCKOUT_MINUTES', 15, { min: 1 }) * 60_000,
      },

      sentry: {
        // Empty disables reporting entirely. Works with GlitchTip, which
        // ingests the same envelope protocol.
        dsn: str('SENTRY_DSN', ''),
        environment: str('SENTRY_ENVIRONMENT', 'production'),
        release: str('SENTRY_RELEASE', ''),
        serverName: str('SENTRY_SERVER_NAME', ''),
        maxEventsPerMinute: int('SENTRY_MAX_EVENTS_PER_MINUTE', 30, { min: 1 }),
      },
    };

    if (cfg.sftp.host && cfg.sftp.username && !cfg.sftp.password && !keyPath) {
      problems.push('set SFTP_PASSWORD or SFTP_PRIVATE_KEY_PATH so the proxy can log in');
    }
    if (cfg.auth.password && cfg.auth.password.length < 8) {
      problems.push('SITE_PASSWORD must be at least 8 characters');
    }
    if (cfg.auth.adminPassword) {
      if (cfg.auth.adminPassword.length < 16) {
        problems.push('ADMIN_PASSWORD must be at least 16 characters');
      }
      if (cfg.auth.adminPassword === cfg.auth.password) {
        problems.push('ADMIN_PASSWORD must differ from SITE_PASSWORD');
      }
    }

    try {
      new Intl.DateTimeFormat('en-US', { timeZone: cfg.tz });
    } catch {
      problems.push(`TZ "${cfg.tz}" is not a recognised IANA time zone`);
    }

    // Fail at startup on a malformed DSN, rather than silently dropping the
    // first real error weeks later.
    if (cfg.sentry.dsn) {
      try {
        parseDsn(cfg.sentry.dsn);
      } catch (err) {
        problems.push(err.message);
      }
    }

    if (problems.length) {
      throw new Error(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    }
    return cfg;
  } finally {
    process.env = previous;
  }
}
