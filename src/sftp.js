import crypto from 'node:crypto';
import { Client } from 'ssh2';
import { createLogger } from './logger.js';
import { resolveUnder, isWithin } from './paths.js';

const log = createLogger('sftp');

// SFTP status codes (draft-ietf-secsh-filexfer-02, section 7).
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;

/** An error with an HTTP status. Below 500 it is the visitor's, not ours. */
export class HttpError extends Error {
  constructor(status, message, options) {
    super(message, options);
    this.name = 'HttpError';
    this.status = status;
  }
}

function translate(err, what) {
  if (err instanceof HttpError) return err;
  if (err?.code === NO_SUCH_FILE) return new HttpError(404, `${what} does not exist`);
  if (err?.code === PERMISSION_DENIED) return new HttpError(403, `${what} is not readable`);
  return new HttpError(502, `SFTP server error: ${err?.message ?? err}`, { cause: err });
}

export function fingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

const p = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

function kind(attrs) {
  if (attrs.isDirectory()) return 'dir';
  if (attrs.isFile()) return 'file';
  if (attrs.isSymbolicLink()) return 'link';
  return 'other';
}

/**
 * Read-only view of one folder on an SFTP server.
 *
 * Keeps a single connection open while the site is in use and drops it after
 * a quiet spell. A dropped or broken connection is replaced on the next
 * request, so restarting the SFTP server needs no restart here.
 *
 * Every path is resolved with the server's own realpath and checked against
 * the public root, so a symlink inside the folder cannot hand out files from
 * outside it.
 */
export function createSftpStore(cfg, { ClientImpl = Client } = {}) {
  let session = null; // Promise<{ conn, sftp, root }>
  let active = 0;
  let idleTimer = null;
  let warnedHostKey = false;
  const state = { connected: false, lastError: null, lastConnectedAt: null };

  function drop(s) {
    if (session !== s) return;
    session = null;
    state.connected = false;
  }

  function connect() {
    const conn = new ClientImpl();
    let hostKeyRejected = null;

    const ready = new Promise((resolve, reject) => {
      conn.once('ready', resolve);
      conn.once('error', reject);
      conn.once('close', () => reject(new Error('connection closed during handshake')));
    });

    conn.connect({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      ...(cfg.password ? { password: cfg.password } : {}),
      ...(cfg.privateKey ? { privateKey: cfg.privateKey } : {}),
      ...(cfg.passphrase ? { passphrase: cfg.passphrase } : {}),
      readyTimeout: cfg.connectTimeoutMs,
      keepaliveInterval: 30_000,
      hostVerifier: (key) => {
        const seen = fingerprint(key);
        if (!cfg.hostKeySha256) {
          if (!warnedHostKey) {
            warnedHostKey = true;
            log.warn('SFTP host key is not pinned - set SFTP_HOST_KEY_SHA256 to this value', {
              fingerprint: `SHA256:${seen}`,
            });
          }
          return true;
        }
        if (seen === cfg.hostKeySha256) return true;
        hostKeyRejected = `SHA256:${seen}`;
        return false;
      },
    });

    const s = (async () => {
      try {
        await ready;
      } catch (err) {
        conn.end();
        if (hostKeyRejected) {
          throw new Error(
            `SFTP host key mismatch: server presented ${hostKeyRejected}, ` +
            `expected SHA256:${cfg.hostKeySha256}`,
            { cause: err },
          );
        }
        throw err;
      }
      const sftp = await p((cb) => conn.sftp(cb));
      let root;
      try {
        root = await p((cb) => sftp.realpath(cfg.root, cb));
      } catch (err) {
        conn.end();
        throw new Error(`the public folder "${cfg.root}" could not be resolved on the SFTP server`, { cause: err });
      }
      return { conn, sftp, root };
    })();

    s.then(() => {
      state.connected = true;
      state.lastError = null;
      state.lastConnectedAt = new Date().toISOString();
      log.info('connected', { host: cfg.host, port: cfg.port });
    }, (err) => {
      drop(s);
      state.lastError = err.message;
    });

    const forget = () => {
      if (session === s && state.connected) log.info('connection closed');
      drop(s);
    };
    conn.on('close', forget);
    conn.on('error', (err) => {
      state.lastError = err.message;
      forget();
    });

    return s;
  }

  function touch() {
    clearTimeout(idleTimer);
    if (!cfg.idleCloseMs || active > 0 || !session) return;
    idleTimer = setTimeout(() => {
      if (active > 0 || !session) return;
      const s = session;
      drop(s);
      s.then(({ conn }) => conn.end(), () => {});
      log.debug('closed idle connection');
    }, cfg.idleCloseMs);
    idleTimer.unref?.();
  }

  async function acquire() {
    if (!session) session = connect();
    const s = session;
    try {
      return { s, ...(await s) };
    } catch (err) {
      throw new HttpError(502, `Could not reach the SFTP server: ${err.message}`, { cause: err });
    }
  }

  /**
   * Run `fn` against a live session. If the session died underneath us (the
   * server restarted, the network blipped) retry once on a fresh one.
   */
  async function use(fn) {
    active += 1;
    clearTimeout(idleTimer);
    try {
      for (let attempt = 0; ; attempt += 1) {
        const ctx = await acquire();
        try {
          return await fn(ctx);
        } catch (err) {
          // Only a connection-level failure is worth a retry; a missing file
          // is missing on a fresh connection too.
          if (attempt === 0 && session !== ctx.s && !(err.status < 500)) continue;
          throw err;
        }
      }
    } finally {
      active -= 1;
      touch();
    }
  }

  /** Absolute, symlink-free path for `rel`, guaranteed inside the root. */
  async function locate({ sftp, root }, rel, what) {
    let real;
    try {
      real = await p((cb) => sftp.realpath(resolveUnder(root, rel), cb));
    } catch (err) {
      throw translate(err, what);
    }
    if (!isWithin(root, real)) throw new HttpError(404, `${what} does not exist`);
    return real;
  }

  return {
    status: () => ({ ...state }),

    /** @returns {Promise<Array<{name, type: 'dir'|'file', size, mtime}>>} */
    list(rel) {
      return use(async (ctx) => {
        const dir = await locate(ctx, rel, 'That folder');
        let entries;
        try {
          entries = await p((cb) => ctx.sftp.readdir(dir, cb));
        } catch (err) {
          throw translate(err, 'That folder');
        }

        const out = [];
        for (const e of entries) {
          if (e.filename === '.' || e.filename === '..') continue;
          let attrs = e.attrs;
          if (kind(attrs) === 'link') {
            // Follow the link, but only list it if it stays inside the root
            // and points at something real.
            try {
              const real = await p((cb) => ctx.sftp.realpath(`${dir}/${e.filename}`, cb));
              if (!isWithin(ctx.root, real)) continue;
              attrs = await p((cb) => ctx.sftp.stat(real, cb));
            } catch {
              continue;
            }
          }
          const type = kind(attrs);
          if (type !== 'dir' && type !== 'file') continue;
          out.push({
            name: e.filename,
            type,
            size: type === 'file' ? Number(attrs.size) : null,
            mtime: attrs.mtime ? new Date(attrs.mtime * 1000) : null,
          });
        }
        return out;
      });
    },

    /**
     * Stat a file and hand back a way to stream it. The caller must call
     * `stream()` (or `release()`) exactly once, so the connection is not
     * closed under an in-progress download.
     */
    open(rel) {
      return new Promise((resolve, reject) => {
        use(async (ctx) => {
          const real = await locate(ctx, rel, 'That file');
          let attrs;
          try {
            attrs = await p((cb) => ctx.sftp.stat(real, cb));
          } catch (err) {
            throw translate(err, 'That file');
          }
          if (!attrs.isFile()) throw new HttpError(404, 'That is not a file');

          let release;
          const held = new Promise((r) => { release = r; });
          resolve({
            size: Number(attrs.size),
            mtime: attrs.mtime ? new Date(attrs.mtime * 1000) : null,
            stream: ({ start, end } = {}) => {
              const s = ctx.sftp.createReadStream(real, {
                ...(start !== undefined ? { start } : {}),
                ...(end !== undefined ? { end } : {}),
              });
              s.once('close', release);
              s.once('error', release);
              return s;
            },
            release: () => release(),
          });
          // Hold the connection busy until the download finishes.
          await held;
        }).catch(reject);
      });
    },

    async close() {
      clearTimeout(idleTimer);
      const s = session;
      session = null;
      if (s) await s.then(({ conn }) => conn.end(), () => {});
    },
  };
}
