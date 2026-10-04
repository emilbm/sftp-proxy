import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureLogger } from '../../src/logger.js';
import { startSftpServer } from './sftp-server.js';
import { createSftpStore } from '../../src/sftp.js';
import { createAuth, createLoginLimiter } from '../../src/auth.js';
import { createWebServer, listen } from '../../src/web/server.js';

configureLogger({ level: 'error' });

/**
 * The whole site against a stand-in SFTP server over a temp folder, signed in
 * as a viewer, with helpers to act as admin.
 */
export const PASSWORD = 'correct horse battery';
export const ADMIN = 'the admin password, quite long';

export async function setup(t, { web = {}, reporter, sftp = {}, auth = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-proxy-web-'));
  fs.mkdirSync(path.join(dir, 'public', 'Photos 2026'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'public', 'hello.txt'), 'hello world');
  fs.writeFileSync(path.join(dir, 'public', "Tom & Jerry's.html"), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(dir, 'public', '.hidden'), 'shh');
  fs.writeFileSync(path.join(dir, 'public', 'Photos 2026', 'æøå.jpg'), 'jpeg');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'not public');

  const srv = await startSftpServer({ dir });
  const cfg = {
    tz: 'Europe/Copenhagen',
    sftp: {
      host: '127.0.0.1', port: srv.port, username: srv.username, password: srv.password,
      root: 'public', connectTimeoutMs: 5000, idleCloseMs: 0, hostKeySha256: null, ...sftp,
    },
    web: { title: 'Test files', showHidden: false, trustProxy: false, ...web },
    auth: {
      password: PASSWORD, sessionSecret: 's3cret', sessionMaxAgeMs: 3_600_000,
      adminPassword: ADMIN, adminSessionMaxAgeMs: 600_000,
      maxFailures: 3, failureWindowMs: 60_000, ...auth,
    },
  };
  const store = createSftpStore(cfg.sftp);
  const server = createWebServer({
    cfg,
    store,
    auth: createAuth(cfg.auth),
    limiter: createLoginLimiter({ maxFailures: 3, windowMs: 60_000 }),
    reporter,
  });
  await listen(server, { port: 0, address: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await store.close();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const req = (p, init = {}) => fetch(base + p, { redirect: 'manual', ...init });
  const login = async (password = PASSWORD, extra = {}) => req('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extra },
    body: new URLSearchParams({ password, next: '/browse/' }),
  });
  const cookie = (await login()).headers.get('set-cookie').split(';')[0];
  const authed = (p, init = {}) => req(p, { ...init, headers: { cookie, ...init.headers } });

  // An admin session, plus the page token every admin request must carry.
  let adminCookie = null;
  let csrf = null;
  const asAdmin = async () => {
    if (!adminCookie) {
      adminCookie = (await login(ADMIN)).headers.get('set-cookie').split(';')[0];
      const page = await (await req('/browse/', { headers: { cookie: adminCookie } })).text();
      csrf = /<meta name="csrf" content="([^"]+)">/.exec(page)?.[1];
    }
    return { cookie: adminCookie, csrf };
  };
  const admin = async (method, p, body, headers = {}) => {
    const a = await asAdmin();
    const isJson = body !== undefined && !(body instanceof Uint8Array);
    return req(p, {
      method,
      headers: {
        cookie: a.cookie,
        'X-CSRF-Token': a.csrf,
        ...(isJson ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: isJson ? JSON.stringify(body) : body,
    });
  };

  return { base, req, login, authed, cookie, srv, dir, admin, asAdmin };
}
