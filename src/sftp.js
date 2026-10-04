import crypto from 'node:crypto';
import { Client } from 'ssh2';
import { createLogger } from './logger.js';
import { pipeline } from 'node:stream/promises';
import { resolveUnder, isWithin, invalidName, withPostfix } from './paths.js';

const log = createLogger('sftp');

// SFTP status codes (draft-ietf-secsh-filexfer-02, section 7).
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;
const FAILURE = 4;

/**
 * Uploads are written here first and moved into place when complete, so a
 * half-finished upload never shows up under its real name. It is a dotfolder
 * inside the public root: never listed, never downloadable, and on the same
 * filesystem as the destination so the final move is a cheap rename.
 */
export const STAGING_DIR = '.uploads';

/** An error with an HTTP status. Below 500 it is the visitor's, not ours. */
export class HttpError extends Error {
  constructor(status, message, options) {
    super(message, options);
    this.name = 'HttpError';
    this.status = status;
  }
}

function translate(err, what, { writing = false } = {}) {
  if (err instanceof HttpError) return err;
  if (err?.code === NO_SUCH_FILE) return new HttpError(404, `${what} does not exist`);
  if (err?.code === PERMISSION_DENIED) {
    // A read the account may not do is the visitor poking somewhere odd; a
    // write it may not do means the SFTP account is set up wrong, which is
    // worth an error report.
    return writing
      ? new HttpError(502, `The SFTP account is not allowed to change ${what.toLowerCase()}`, { cause: err })
      : new HttpError(403, `${what} is not readable`);
  }
  return new HttpError(502, `SFTP server error: ${err?.message ?? err}`, { cause: err });
}

function nameOrThrow(name) {
  const problem = invalidName(name);
  if (problem) throw new HttpError(400, problem);
  return name;
}

/** Rough content category for the storage bar, by extension. */
const CATEGORIES = [
  ['photos', /.(jpe?g|png|gif|heic|heif|webp|tiff?|bmp|raw|cr2|cr3|nef|arw|dng|svg)$/i],
  ['videos', /.(mp4|m4v|mov|mkv|avi|wmv|webm|mpe?g|3gp|mts|m2ts)$/i],
  ['music', /.(mp3|m4a|aac|flac|wav|ogg|opus|wma|aiff?|alac)$/i],
  ['documents', /.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|txt|md|rtf|csv|pages|numbers|key|epub)$/i],
  ['archives', /.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|iso|dmg|img)$/i],
];

export function categorise(name) {
  for (const [category, re] of CATEGORIES) if (re.test(name)) return category;
  return 'other';
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
   * server restarted, the network blipped) retry once on a fresh one - unless
   * `retry` is off, for work like consuming an upload body that cannot be
   * replayed.
   */
  async function use(fn, { retry = true } = {}) {
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
          if (retry && attempt === 0 && session !== ctx.s && !(err.status < 500)) continue;
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

  async function lstatOrNull(sftp, path) {
    try {
      return await p((cb) => sftp.lstat(path, cb));
    } catch (err) {
      if (err?.code === NO_SUCH_FILE) return null;
      throw err;
    }
  }

  /**
   * The real parent folder and the final component of `rel`. The last
   * component is deliberately not resolved: renaming or deleting a symlink
   * must act on the link, never on whatever it points at.
   */
  async function locateEntry(ctx, rel) {
    if (!rel) throw new HttpError(400, 'The public folder itself cannot be changed');
    const parts = rel.split('/');
    const name = parts.pop();
    if (invalidName(name)) throw new HttpError(404, 'That does not exist');
    const parent = await locate(ctx, parts.join('/'), 'That folder');
    return { parent, name, path: `${parent}/${name}` };
  }

  /**
   * Try `attempt(candidate)` with `name`, then `name (1)`, `name (2)`...
   * until one does not collide. OpenSSH refuses to mkdir or rename onto an
   * existing name with a generic failure, so a collision that slips in
   * between our check and the operation is caught and retried too.
   */
  async function withFreeName(ctx, dir, name, isDir, attempt) {
    for (let n = 0; n < 1000; n += 1) {
      const candidate = withPostfix(name, n, { isDir });
      if (await lstatOrNull(ctx.sftp, `${dir}/${candidate}`)) continue;
      try {
        await attempt(`${dir}/${candidate}`);
        return candidate;
      } catch (err) {
        if (err?.code === FAILURE && await lstatOrNull(ctx.sftp, `${dir}/${candidate}`)) continue;
        throw err;
      }
    }
    throw new HttpError(409, `Too many files are already called "${name}"`);
  }

  async function removeTree(sftp, path, attrs) {
    if (!attrs.isDirectory()) {
      await p((cb) => sftp.unlink(path, cb));
      return;
    }
    // readdir returns lstat attributes, so a symlink to a folder is removed
    // as a link and never followed out of the tree.
    const entries = await p((cb) => sftp.readdir(path, cb));
    for (const e of entries) {
      if (e.filename === '.' || e.filename === '..') continue;
      await removeTree(sftp, `${path}/${e.filename}`, e.attrs);
    }
    await p((cb) => sftp.rmdir(path, cb));
  }

  async function staging(ctx) {
    const dir = `${ctx.root}/${STAGING_DIR}`;
    if (!await lstatOrNull(ctx.sftp, dir)) {
      try {
        await p((cb) => ctx.sftp.mkdir(dir, cb));
      } catch (err) {
        // Two uploads starting at once may both try to create it.
        if (!await lstatOrNull(ctx.sftp, dir)) throw translate(err, 'The upload folder', { writing: true });
      }
    }
    return dir;
  }

  const stagedPath = (ctx, id) => {
    if (!/^[0-9a-f]{32}$/.test(id)) throw new HttpError(404, 'No such upload');
    return `${ctx.root}/${STAGING_DIR}/${id}.part`;
  };

  /** Bytes per category under `dir`, not following symlinks. */
  async function tally(sftp, dir, totals, budget) {
    const entries = await p((cb) => sftp.readdir(dir, cb));
    for (const e of entries) {
      if (e.filename === '.' || e.filename === '..') continue;
      if (--budget.left < 0) return;
      if (e.attrs.isDirectory()) await tally(sftp, `${dir}/${e.filename}`, totals, budget);
      else if (e.attrs.isFile()) {
        const c = categorise(e.filename);
        totals[c] = (totals[c] ?? 0) + Number(e.attrs.size);
      }
    }
  }

  return {
    status: () => ({ ...state }),

    /**
     * Disk usage for the storage bar: what the public folder holds, by
     * category, and - when the server supports the OpenSSH statvfs extension -
     * the size and free space of the disk it lives on. Walks the whole tree,
     * so callers should cache it.
     *
     * @returns {Promise<{categories: Record<string, number>, disk: {total, free}|null, partial: boolean}>}
     */
    usage({ maxEntries = 200_000 } = {}) {
      return use(async (ctx) => {
        const categories = {};
        const budget = { left: maxEntries };
        await tally(ctx.sftp, ctx.root, categories, budget);
        let disk = null;
        try {
          const v = await p((cb) => ctx.sftp.ext_openssh_statvfs(ctx.root, cb));
          const unit = Number(v.f_frsize || v.f_bsize);
          disk = { total: Number(v.f_blocks) * unit, free: Number(v.f_bavail) * unit };
        } catch {
          // Not OpenSSH, or the extension is disabled: show the folder alone.
        }
        return { categories, disk, partial: budget.left < 0 };
      });
    },

    /** @returns {Promise<string>} the name actually used, postfixed on a clash */
    async mkdir(dirRel, name) {
      nameOrThrow(name);
      return use(async (ctx) => {
        const dir = await locate(ctx, dirRel, 'That folder');
        try {
          return await withFreeName(ctx, dir, name, true, (target) => p((cb) => ctx.sftp.mkdir(target, cb)));
        } catch (err) {
          throw translate(err, 'That folder', { writing: true });
        }
      });
    },

    /** Rename in place. @returns {Promise<string>} the name actually used */
    async rename(rel, newName) {
      nameOrThrow(newName);
      return use(async (ctx) => {
        const entry = await locateEntry(ctx, rel);
        const attrs = await lstatOrNull(ctx.sftp, entry.path);
        if (!attrs) throw new HttpError(404, 'That does not exist');
        if (newName === entry.name) return newName;
        try {
          return await withFreeName(ctx, entry.parent, newName, attrs.isDirectory(),
            (target) => p((cb) => ctx.sftp.rename(entry.path, target, cb)));
        } catch (err) {
          throw translate(err, 'That', { writing: true });
        }
      });
    },

    /** Delete a file, a link, or a folder and everything in it. */
    remove(rel) {
      return use(async (ctx) => {
        const entry = await locateEntry(ctx, rel);
        const attrs = await lstatOrNull(ctx.sftp, entry.path);
        if (!attrs) throw new HttpError(404, 'That does not exist');
        try {
          await removeTree(ctx.sftp, entry.path, attrs);
        } catch (err) {
          throw translate(err, 'That', { writing: true });
        }
      });
    },

    /** Create an empty staged file for upload `id`. */
    beginUpload(id) {
      return use(async (ctx) => {
        await staging(ctx);
        try {
          const handle = await p((cb) => ctx.sftp.open(stagedPath(ctx, id), 'w', 0o644, cb));
          await p((cb) => ctx.sftp.close(handle, cb));
        } catch (err) {
          throw translate(err, 'The upload folder', { writing: true });
        }
      });
    },

    /** Bytes received so far for upload `id`, from the staged file itself. */
    uploadedBytes(id) {
      return use(async (ctx) => {
        const attrs = await lstatOrNull(ctx.sftp, stagedPath(ctx, id));
        if (!attrs) throw new HttpError(404, 'No such upload');
        return Number(attrs.size);
      });
    },

    /**
     * Write `source` into upload `id` starting at `offset`. Not retried on a
     * dropped connection: the body cannot be replayed, so the caller reports
     * how far it got and the browser resumes from there.
     */
    writeUpload(id, offset, source) {
      return use(async (ctx) => {
        const target = ctx.sftp.createWriteStream(stagedPath(ctx, id), {
          flags: 'r+', start: offset, mode: 0o644,
        });
        try {
          await pipeline(source, target);
        } catch (err) {
          throw translate(err, 'The upload', { writing: true });
        }
      }, { retry: false });
    },

    /** Move a finished upload into `dirRel`. @returns {Promise<string>} final name */
    async finishUpload(id, dirRel, name) {
      nameOrThrow(name);
      return use(async (ctx) => {
        const dir = await locate(ctx, dirRel, 'That folder');
        const staged = stagedPath(ctx, id);
        try {
          return await withFreeName(ctx, dir, name, false,
            (target) => p((cb) => ctx.sftp.rename(staged, target, cb)));
        } catch (err) {
          throw translate(err, 'That folder', { writing: true });
        }
      });
    },

    discardUpload(id) {
      return use(async (ctx) => {
        try {
          await p((cb) => ctx.sftp.unlink(stagedPath(ctx, id), cb));
        } catch (err) {
          if (err?.code !== NO_SUCH_FILE) throw translate(err, 'The upload', { writing: true });
        }
      });
    },

    /** Remove staged uploads nobody has touched for `maxAgeMs`. */
    sweepUploads(maxAgeMs, now = Date.now()) {
      return use(async (ctx) => {
        const dir = `${ctx.root}/${STAGING_DIR}`;
        if (!await lstatOrNull(ctx.sftp, dir)) return 0;
        const entries = await p((cb) => ctx.sftp.readdir(dir, cb));
        let removed = 0;
        for (const e of entries) {
          if (!e.filename.endsWith('.part')) continue;
          if (now - e.attrs.mtime * 1000 < maxAgeMs) continue;
          await p((cb) => ctx.sftp.unlink(`${dir}/${e.filename}`, cb)).catch(() => {});
          removed += 1;
        }
        return removed;
      });
    },

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
          if (!rel && e.filename === STAGING_DIR) continue;
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
