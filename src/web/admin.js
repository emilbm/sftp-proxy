import crypto from 'node:crypto';
import { createLogger } from '../logger.js';
import { HttpError } from '../sftp.js';
import { invalidName } from '../paths.js';

const log = createLogger('admin');

// Browsers send 16 MB chunks; this is the ceiling, kept under Cloudflare's
// 100 MB request limit so a tunnel never rejects a chunk.
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
const MAX_OPEN_UPLOADS = 50;
// An upload nobody has sent a byte to for this long is abandoned; its staged
// file is swept from the server.
const ABANDONED_AFTER_MS = 24 * 3600 * 1000;
const SWEEP_EVERY_MS = 3600 * 1000;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON_BYTES) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Upload, new folder, rename and delete. Every route lives under /admin/ so a
 * single Cloudflare Access rule (or any proxy rule) can guard all writes;
 * the caller has already checked the admin session and the CSRF token.
 *
 * Uploads are chunked so a file of any size gets through a proxy with a
 * per-request limit, and an interrupted chunk resumes rather than restarting:
 *   POST   /admin/uploads               {dir, name, size} -> {id}
 *   PUT    /admin/uploads/:id?offset=N  raw bytes          -> {received}
 *   GET    /admin/uploads/:id                              -> {received, size}
 *   POST   /admin/uploads/:id/complete                     -> {name}
 *   DELETE /admin/uploads/:id
 */
export function createAdmin({ store, relOrThrow, onChange, clientKey }) {
  const uploads = new Map();

  async function sweep() {
    const now = Date.now();
    for (const [id, u] of uploads) {
      if (!u.busy && now - u.touchedAt > ABANDONED_AFTER_MS) uploads.delete(id);
    }
    try {
      const removed = await store.sweepUploads(ABANDONED_AFTER_MS);
      if (removed) log.info('removed abandoned uploads', { count: removed });
    } catch (err) {
      log.debug('could not sweep abandoned uploads', { error: err.message });
    }
  }
  const sweeper = setInterval(sweep, SWEEP_EVERY_MS);
  sweeper.unref?.();

  function upload(id) {
    const u = uploads.get(id);
    if (!u) throw new HttpError(404, 'That upload is no longer known - start it again');
    u.touchedAt = Date.now();
    return u;
  }

  async function receiveChunk(req, id, url) {
    const u = upload(id);
    const offset = Number(url.searchParams.get('offset'));
    const length = Number(req.headers['content-length']);
    if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, 'offset must be a whole number');
    if (!Number.isInteger(length)) throw new HttpError(411, 'Content-Length is required');
    if (length > MAX_CHUNK_BYTES) throw new HttpError(413, `Chunks may be at most ${MAX_CHUNK_BYTES} bytes`);
    if (offset + length > u.size) throw new HttpError(400, 'That chunk goes past the end of the file');
    if (u.busy) {
      const err = new HttpError(409, 'A chunk for this upload is already being received');
      err.body = { received: u.received };
      throw err;
    }
    // Only accept the next bytes, or a resend of ones we may have half-kept.
    if (offset > u.received) {
      const err = new HttpError(409, 'Bytes are missing before that offset');
      err.body = { received: u.received };
      throw err;
    }

    u.busy = true;
    let counted = 0;
    // Count as the bytes flow through, not with a 'data' listener: that would
    // start the request flowing before the SFTP stream is ready, and lose it.
    async function* counting(source) {
      for await (const chunk of source) {
        counted += chunk.length;
        yield chunk;
      }
    }
    try {
      await store.writeUpload(id, offset, counting(req));
      if (counted !== length) throw new HttpError(400, 'The chunk was cut short');
      u.received = Math.max(u.received, offset + counted);
      return { received: u.received };
    } catch (err) {
      // Trust the file on the server over our bookkeeping: whatever made it
      // into the staged file is where the browser should resume from.
      u.received = await store.uploadedBytes(id).catch(() => u.received);
      err.body = { received: u.received };
      throw err;
    } finally {
      u.busy = false;
      u.touchedAt = Date.now();
    }
  }

  async function route(req, res, url, send) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "admin"
    const [what, id, action] = parts;
    const m = req.method;
    const who = clientKey(req);

    if (what === 'folders' && parts.length === 1 && m === 'POST') {
      const body = await readJson(req);
      const dir = relOrThrow(body.dir);
      const name = await store.mkdir(dir, body.name);
      log.info('created folder', { dir, name, client: who });
      onChange();
      return send(201, { name });
    }

    if (what === 'rename' && parts.length === 1 && m === 'POST') {
      const body = await readJson(req);
      const target = relOrThrow(body.path);
      const name = await store.rename(target, body.name);
      log.info('renamed', { from: target, to: name, client: who });
      onChange();
      return send(200, { name });
    }

    if (what === 'delete' && parts.length === 1 && m === 'POST') {
      const body = await readJson(req);
      const target = relOrThrow(body.path);
      await store.remove(target);
      log.info('deleted', { path: target, client: who });
      onChange();
      return send(200, {});
    }

    if (what === 'uploads') {
      if (parts.length === 1 && m === 'POST') {
        const body = await readJson(req);
        const dir = relOrThrow(body.dir);
        const size = Number(body.size);
        if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'size must be a whole number of bytes');
        if (typeof body.name !== 'string') throw new HttpError(400, 'A file name is required');
        if (uploads.size >= MAX_OPEN_UPLOADS) throw new HttpError(429, 'Too many uploads in progress');
        // Validates the folder exists and the name is acceptable up front,
        // rather than after the whole file has been sent.
        await store.list(dir);
        const problem = invalidName(body.name);
        if (problem) throw new HttpError(400, problem);

        const newId = crypto.randomBytes(16).toString('hex');
        await store.beginUpload(newId);
        uploads.set(newId, {
          dir, name: body.name, size, received: 0, busy: false, touchedAt: Date.now(),
        });
        log.info('upload started', { dir, name: body.name, size, client: who });
        return send(201, { id: newId });
      }

      if (parts.length === 2 && m === 'PUT') return send(200, await receiveChunk(req, id, url));

      if (parts.length === 2 && m === 'GET') {
        const u = upload(id);
        if (!u.busy) u.received = await store.uploadedBytes(id);
        return send(200, { received: u.received, size: u.size });
      }

      if (parts.length === 3 && action === 'complete' && m === 'POST') {
        const u = upload(id);
        if (u.busy) throw new HttpError(409, 'A chunk is still being received');
        const onDisk = await store.uploadedBytes(id);
        if (onDisk !== u.size) {
          const err = new HttpError(409, `Only ${onDisk} of ${u.size} bytes have arrived`);
          err.body = { received: onDisk };
          throw err;
        }
        const name = await store.finishUpload(id, u.dir, u.name);
        uploads.delete(id);
        log.info('upload finished', { dir: u.dir, name, size: u.size, client: who });
        onChange();
        return send(200, { name });
      }

      if (parts.length === 2 && m === 'DELETE') {
        uploads.delete(id);
        await store.discardUpload(id);
        return send(200, {});
      }
    }

    throw new HttpError(404, 'No such admin action');
  }

  return {
    route,
    sweep,
    close: () => clearInterval(sweeper),
  };
}
