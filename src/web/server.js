import http from 'node:http';
import { pipeline } from 'node:stream';
import { createLogger } from '../logger.js';
import { COOKIE_NAME, parseCookies } from '../auth.js';
import { cleanRelative } from '../paths.js';
import { HttpError, STAGING_DIR } from '../sftp.js';
import { loginPage, listingPage, errorPage } from './views.js';
import { createAdmin } from './admin.js';
import { ASSETS } from './assets.js';

const log = createLogger('web');

// The storage bar walks the whole public tree, so it is cached and refreshed
// in the background rather than recomputed on every page view.
const USAGE_FRESH_MS = 5 * 60 * 1000;
const USAGE_WAIT_MS = 1500;
const MAX_FORM_BYTES = 8 * 1024;

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

/**
 * `bytes=a-b`, `bytes=a-` or `bytes=-n` against a file of `size` bytes.
 * Multiple ranges are answered with the whole file, which RFC 9110 allows.
 * @returns {{start, end}|null|'unsatisfiable'} null means "send it all"
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;

  let start;
  let end;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** RFC 6266: an ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_FORM_BYTES) {
        reject(new HttpError(413, 'That form was too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

/** Only ever send people back into the site, never to another origin. */
function safeNext(next) {
  if (typeof next !== 'string') return '/browse/';
  return /^\/(browse|download)\//.test(next) && !next.startsWith('//') ? next : '/browse/';
}

function relFromPath(pathname, prefix) {
  const encoded = pathname.slice(prefix.length);
  let decoded;
  try {
    decoded = encoded.split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
  return cleanRelative(decoded);
}

/**
 * The website: a login form, a folder listing and downloads, all streamed
 * straight from the SFTP server. Nothing is cached or written locally.
 */
export function createWebServer({ cfg, store, auth, limiter, reporter }) {
  const siteTitle = cfg.web.title;
  const dateFormat = new Intl.DateTimeFormat('en-GB', {
    timeZone: cfg.tz, dateStyle: 'medium', timeStyle: 'short',
  });
  const formatDate = (d) => dateFormat.format(d);

  /**
   * A cleaned relative path the visitor may touch: inside the root, never the
   * upload staging folder, and no dot-segments unless hidden files are shown.
   */
  function allowed(rel) {
    if (rel === null) return false;
    const segments = rel ? rel.split('/') : [];
    if (segments[0] === STAGING_DIR) return false;
    return cfg.web.showHidden || !segments.some((seg) => seg.startsWith('.'));
  }
  function relOrThrow(input) {
    const rel = cleanRelative(typeof input === 'string' ? input : '');
    if (!allowed(rel)) throw new HttpError(404, 'That does not exist');
    return rel;
  }

  // `changed` is set by an admin action, so the admin's next page waits for
  // the recount instead of showing the figure from before their upload.
  let usage = { value: null, at: 0, pending: null, changed: false };
  function refreshUsage() {
    usage.pending ??= store.usage()
      .then((value) => { usage = { value, at: Date.now(), pending: null, changed: false }; })
      .catch((err) => {
        usage.pending = null;
        log.warn('could not measure storage', { error: err.message });
      });
    return usage.pending;
  }
  /** Current usage if known; a stale value is served while a fresh one loads. */
  async function currentUsage() {
    if (Date.now() - usage.at > USAGE_FRESH_MS) {
      const loading = refreshUsage();
      if (!usage.value || usage.changed) {
        await Promise.race([loading, new Promise((r) => { setTimeout(r, USAGE_WAIT_MS).unref?.(); })]);
      }
    }
    return usage.value;
  }

  const admin = createAdmin({
    store,
    relOrThrow,
    clientKey: (req) => clientKey(req),
    onChange: () => {
      usage.at = 0;
      usage.changed = true;
    },
  });

  function clientKey(req) {
    if (cfg.web.trustProxy) {
      const cf = req.headers['cf-connecting-ip'];
      if (typeof cf === 'string' && cf) return cf.trim();
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  // Behind a Cloudflare tunnel or Caddy the browser is on https even though
  // we are spoken to in plain http. Trusting the header here is safe: a forged
  // value can only make the cookie stricter.
  function isHttps(req) {
    return req.socket.encrypted || /^https\b/i.test(String(req.headers['x-forwarded-proto'] ?? ''));
  }

  function sessionCookie(req, value, maxAgeSeconds) {
    return [
      `${COOKIE_NAME}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
      ...(isHttps(req) ? ['Secure'] : []),
    ].join('; ');
  }

  function html(res, status, body, headers = {}) {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body);
  }

  function json(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  }

  function redirect(res, location, extra = {}) {
    res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...extra });
    res.end();
  }

  async function handleLogin(req, res) {
    const key = clientKey(req);
    const wait = limiter.retryAfter(key);
    if (wait) {
      log.warn('login refused, too many failures', { client: key });
      return html(res, 429, loginPage({
        siteTitle,
        error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}.`,
      }), { 'Retry-After': String(wait) });
    }

    const form = await readForm(req);
    const next = safeNext(form.get('next'));
    const role = auth.checkPassword(form.get('password'));
    if (!role) {
      limiter.fail(key);
      log.info('failed login', { client: key });
      return html(res, 401, loginPage({ siteTitle, error: 'Wrong password.', next }));
    }

    limiter.succeed(key);
    log.info('signed in', { client: key, role });
    const { token, maxAgeMs } = auth.issue(role);
    return redirect(res, next, { 'Set-Cookie': sessionCookie(req, token, Math.floor(maxAgeMs / 1000)) });
  }

  async function handleBrowse(req, res, url, session) {
    const rel = relFromPath(url.pathname, '/browse/');
    if (!allowed(rel)) throw new HttpError(404, 'That folder does not exist');
    if (rel && !url.pathname.endsWith('/')) return redirect(res, `${url.pathname}/`);

    const [listed, storage] = await Promise.all([store.list(rel), currentUsage()]);
    const entries = cfg.web.showHidden ? listed : listed.filter((e) => !e.name.startsWith('.'));
    return html(res, 200, listingPage({
      siteTitle, rel, entries, formatDate, storage,
      admin: session.role === 'admin',
      csrf: session.role === 'admin' ? auth.csrfToken(session.token) : '',
    }));
  }

  async function handleDownload(req, res, url) {
    const rel = relFromPath(url.pathname, '/download/');
    if (!rel || !allowed(rel)) throw new HttpError(404, 'That file does not exist');
    const name = rel.split('/').pop();

    const file = await store.open(rel);
    const etag = `W/"${file.size.toString(16)}-${(file.mtime?.getTime() ?? 0).toString(16)}"`;
    const lastModified = file.mtime?.toUTCString();

    // A resumed download only gets a slice if the file is still the same one.
    let range = parseRange(req.headers.range, file.size);
    const ifRange = req.headers['if-range'];
    if (range && ifRange && ifRange !== etag && ifRange !== lastModified) range = null;

    const headers = {
      ...SECURITY_HEADERS,
      // Never let the browser render a file from the share on our origin.
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(name),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-cache',
      ETag: etag,
      ...(lastModified ? { 'Last-Modified': lastModified } : {}),
    };

    if (range === 'unsatisfiable') {
      file.release();
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${file.size}` });
      return res.end();
    }

    if (range) {
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${file.size}`,
        'Content-Length': range.end - range.start + 1,
      });
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': file.size });
    }

    if (req.method === 'HEAD' || file.size === 0) {
      file.release();
      return res.end();
    }

    const started = Date.now();
    log.info('download started', { file: rel, range: range ? `${range.start}-${range.end}` : 'all' });
    await new Promise((resolve) => {
      const expected = range ? range.end - range.start + 1 : file.size;
      let sent = 0;
      const source = file.stream(range ?? {});
      source.on('data', (chunk) => { sent += chunk.length; });

      pipeline(source, res, (err) => {
        if (!err || sent >= expected) {
          // After the last byte the client probes for EOF and closes the
          // remote handle; a failure there is invisible to the visitor.
          if (err) log.debug('remote file did not close cleanly after the download', { error: err.message });
          log.info('download finished', { file: rel, seconds: Math.round((Date.now() - started) / 1000) });
        } else if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
          // The visitor cancelled or lost their connection. Not our fault.
          log.info('download cancelled', { file: rel });
        } else {
          log.error('download failed part-way', err);
          reporter?.capture(err, { tags: { route: '/download' }, extra: { file: rel } });
        }
        resolve();
      });
    });
  }

  async function route(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end('{"status":"ok"}');
    }
    const asset = ASSETS[pathname];
    if (asset) {
      // Pages always link the hashed URL, which can be cached for good. An
      // unversioned or stale-version request still gets the current file,
      // just not cached.
      const current = url.searchParams.get('v') === asset.version;
      res.writeHead(200, {
        'Content-Type': asset.type,
        'Cache-Control': current ? 'public, max-age=31536000, immutable' : 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(asset.body);
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const session = { token, role: auth.verify(token) };
    const signedIn = Boolean(session.role);

    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      if (!auth.adminEnabled) throw new HttpError(404, 'There is nothing at this address');
      if (!signedIn) throw new HttpError(401, 'Sign in first');
      if (session.role !== 'admin') throw new HttpError(403, 'Only the admin password can change files');
      // Belt and braces against another site driving an admin's browser: the
      // token comes from the page, and a cross-site Origin is refused outright.
      const origin = req.headers.origin;
      if (origin && origin !== 'null') {
        let host = '';
        try { host = new URL(origin).host; } catch { /* stays empty */ }
        if (host !== req.headers.host) throw new HttpError(403, 'Cross-site request refused');
      }
      if (!auth.checkCsrf(token, req.headers['x-csrf-token'])) {
        throw new HttpError(403, 'Missing or stale page token - reload the page and try again');
      }
      return admin.route(req, res, url, (status, body) => json(res, status, body));
    }

    if (pathname === '/login') {
      if (method === 'POST') return handleLogin(req, res);
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if (signedIn) return redirect(res, safeNext(url.searchParams.get('next')));
      return html(res, 200, loginPage({ siteTitle, next: url.searchParams.get('next') ?? '' }));
    }
    if (pathname === '/logout') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      return redirect(res, '/login', { 'Set-Cookie': sessionCookie(req, '', 0) });
    }

    if (!signedIn) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(401, 'Sign in first');
      const next = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`;
      return redirect(res, `/login${next}`);
    }

    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');

    if (pathname === '/' || pathname === '/browse') return redirect(res, '/browse/');
    if (pathname.startsWith('/browse/')) return handleBrowse(req, res, url, session);
    if (pathname.startsWith('/download/')) return handleDownload(req, res, url);
    if (pathname === '/throw') {
      // Deliberate failure, for confirming error reporting end to end. Only
      // reachable signed in, so strangers cannot fill GlitchTip with it.
      const err = new Error('Test exception from /throw - error reporting is wired up');
      err.name = 'SftpProxyTestError';
      throw err;
    }
    throw new HttpError(404, 'There is nothing at this address');
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      return res.end();
    }

    route(req, res, url).catch((err) => {
      const status = err.status ?? 500;
      let eventId = null;

      if (status >= 500) {
        log.error(`${req.method} ${url.pathname} failed`, err);
        eventId = reporter?.capture(err, {
          request: {
            url: `${url.origin}${url.pathname}`,
            method: req.method,
            headers: { 'User-Agent': req.headers['user-agent'] ?? '' },
          },
          tags: { route: url.pathname.split('/')[1] || '/', status: String(status) },
        }) ?? null;
      } else {
        log.debug(`${req.method} ${url.pathname} -> ${status}`, { message: err.message });
      }

      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = status >= 500 && !(err instanceof HttpError)
        ? 'An unexpected error occurred. It has been logged.'
        : err.message;
      if (url.pathname.startsWith('/admin/')) {
        // Drain what is left of an upload so the browser reads our answer
        // instead of seeing the connection reset.
        if (!req.complete) req.resume();
        return json(res, status, { error: message, eventId, ...err.body });
      }
      const signedIn = Boolean(auth.verify(parseCookies(req.headers.cookie)[COOKIE_NAME]));
      html(res, status, errorPage({ siteTitle, status, message, eventId, signedIn }));
    });
  });

  server.on('error', (err) => {
    log.error('web server error', err);
    reporter?.capture(err, { tags: { component: 'web-server' } });
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  server.on('close', () => admin.close());

  // A 16 MB upload chunk on a slow line can take minutes; Node's default
  // five-minute cap on receiving a request would cut it off.
  server.requestTimeout = 30 * 60 * 1000;

  // Measure storage once at startup, so the first page view has a bar.
  refreshUsage();

  return server;
}

export function listen(server, { port, address }) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, address, () => {
      server.off('error', reject);
      log.info('listening', { address, port: server.address().port });
      resolve(server);
    });
  });
}
