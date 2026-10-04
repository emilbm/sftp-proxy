import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, contentDisposition } from '../src/web/server.js';
import { setup, PASSWORD } from './helpers/site.js';

// ----------------------------------------------------------------- helpers

test('parseRange handles the forms browsers and download managers send', () => {
  assert.deepEqual(parseRange('bytes=0-4', 10), { start: 0, end: 4 });
  assert.deepEqual(parseRange('bytes=5-', 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=8-100', 10), { start: 8, end: 9 });
  assert.deepEqual(parseRange('bytes=-100', 10), { start: 0, end: 9 });
  assert.equal(parseRange('bytes=10-', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=5-2', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-1,4-5', 10), null);
  assert.equal(parseRange('items=0-1', 10), null);
  assert.equal(parseRange(undefined, 10), null);
});

test('contentDisposition keeps the real name and an ASCII fallback', () => {
  assert.equal(
    contentDisposition('æøå "x".jpg'),
    `attachment; filename="___ _x_.jpg"; filename*=UTF-8''%C3%A6%C3%B8%C3%A5%20%22x%22.jpg`,
  );
});

// ------------------------------------------------------------------- auth

test('everything but login, health and styles needs the password', async (t) => {
  const { req } = await setup(t);
  assert.equal((await req('/health')).status, 200);
  assert.equal((await req('/static/styles.css')).status, 200);

  const page = await req('/browse/');
  assert.equal(page.status, 303);
  assert.equal(page.headers.get('location'), '/login?next=%2Fbrowse%2F');

  assert.equal((await req('/download/hello.txt')).headers.get('location'), '/login?next=%2Fdownload%2Fhello.txt');
  assert.equal((await req('/', { headers: { cookie: 'sftp_proxy_session=123.forged' } })).status, 303);
});

test('a wrong password is refused, and repeated failures lock the client out', async (t) => {
  const { login } = await setup(t);
  for (let i = 0; i < 3; i += 1) {
    const res = await login('wrong');
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.match(await res.text(), /Wrong password/);
  }
  // Even the right password is refused while locked out.
  const locked = await login();
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
});

test('behind a trusted proxy, lockout is per visitor rather than per proxy', async (t) => {
  const { login } = await setup(t, { web: { trustProxy: true } });
  for (let i = 0; i < 3; i += 1) await login('wrong', { 'CF-Connecting-IP': '203.0.113.9' });
  assert.equal((await login(PASSWORD, { 'CF-Connecting-IP': '203.0.113.9' })).status, 429);
  assert.equal((await login(PASSWORD, { 'CF-Connecting-IP': '198.51.100.4' })).status, 303);
});

test('the session cookie is HttpOnly, and Secure behind an https proxy', async (t) => {
  const { login } = await setup(t);
  const plain = (await login()).headers.get('set-cookie');
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Lax/);
  assert.doesNotMatch(plain, /Secure/);

  const proxied = (await login(PASSWORD, { 'X-Forwarded-Proto': 'https' })).headers.get('set-cookie');
  assert.match(proxied, /; Secure/);
});

test('login only redirects within the site', async (t) => {
  const { req } = await setup(t);
  const post = (next) => req('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: PASSWORD, next }),
  });
  assert.equal((await post('/download/hello.txt')).headers.get('location'), '/download/hello.txt');
  assert.equal((await post('https://evil.example/')).headers.get('location'), '/browse/');
  assert.equal((await post('//evil.example/browse/')).headers.get('location'), '/browse/');
});

test('signing out clears the cookie', async (t) => {
  const { authed } = await setup(t);
  const res = await authed('/logout', { method: 'POST' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('set-cookie'), /sftp_proxy_session=;.*Max-Age=0/);
});

// ---------------------------------------------------------------- listing

test('lists the public folder, escaping names and hiding dotfiles', async (t) => {
  const { authed } = await setup(t);
  const res = await authed('/browse/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  const body = await res.text();

  assert.match(body, /href="\/download\/hello.txt"/);
  assert.match(body, /href="\/browse\/Photos%202026\/"/);
  assert.match(body, /Tom &amp; Jerry&#39;s.html/);
  assert.match(body, /href="\/download\/Tom%20%26%20Jerry&#39;s.html"/);
  assert.doesNotMatch(body, /\.hidden/);
  assert.doesNotMatch(body, /outside\.txt/);
  // Folders sort before files.
  assert.ok(body.indexOf('Photos 2026') < body.indexOf('hello.txt'));
});

test('shows dotfiles when asked to', async (t) => {
  const { authed } = await setup(t, { web: { showHidden: true } });
  assert.match(await (await authed('/browse/')).text(), /\.hidden/);
  assert.equal((await authed('/download/.hidden')).status, 200);
});

test('browses into a subfolder with an encoded name', async (t) => {
  const { authed } = await setup(t);
  const body = await (await authed('/browse/Photos%202026/')).text();
  assert.match(body, /href="\/download\/Photos%202026\/%C3%A6%C3%B8%C3%A5.jpg"/);
  assert.match(body, /aria-current="page">Photos 2026</);

  const noSlash = await authed('/browse/Photos%202026');
  assert.equal(noSlash.headers.get('location'), '/browse/Photos%202026/');
});

test('cannot climb out of the public folder', async (t) => {
  const { authed } = await setup(t);
  for (const p of [
    '/browse/../', '/browse/%2E%2E/', '/browse/..%2F', '/download/..%2Foutside.txt',
    '/download/%2E%2E/outside.txt', '/download/sub%5C..%5C..%5Coutside.txt',
  ]) {
    const res = await authed(p);
    assert.ok([303, 404].includes(res.status), `${p} -> ${res.status}`);
    if (res.status !== 303) assert.doesNotMatch(await res.text(), /not public/);
  }
});

test('a missing folder or file is a friendly 404', async (t) => {
  const { authed } = await setup(t);
  const res = await authed('/browse/nope/');
  assert.equal(res.status, 404);
  assert.match(await res.text(), /does not exist/);
  assert.equal((await authed('/download/nope.txt')).status, 404);
});

// -------------------------------------------------------------- downloads

test('downloads a file as an attachment, never rendered inline', async (t) => {
  const { authed } = await setup(t);
  const res = await authed("/download/Tom%20%26%20Jerry's.html");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition'), /^attachment;/);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(await res.text(), '<script>alert(1)</script>');
});

test('downloads a file with a non-ASCII name', async (t) => {
  const { authed } = await setup(t);
  const res = await authed('/download/Photos%202026/%C3%A6%C3%B8%C3%A5.jpg');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''%C3%A6%C3%B8%C3%A5.jpg/);
  assert.equal(await res.text(), 'jpeg');
});

test('serves byte ranges so downloads can resume', async (t) => {
  const { authed } = await setup(t);
  const res = await authed('/download/hello.txt', { headers: { Range: 'bytes=6-' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 6-10/11');
  assert.equal(res.headers.get('content-length'), '5');
  assert.equal(await res.text(), 'world');

  const bad = await authed('/download/hello.txt', { headers: { Range: 'bytes=50-' } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), 'bytes */11');
});

test('a resume against a changed file gets the whole file instead', async (t) => {
  const { authed } = await setup(t);
  const res = await authed('/download/hello.txt', {
    headers: { Range: 'bytes=6-', 'If-Range': 'W/"stale"' },
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'hello world');

  const etag = (await authed('/download/hello.txt', { method: 'HEAD' })).headers.get('etag');
  const same = await authed('/download/hello.txt', { headers: { Range: 'bytes=6-', 'If-Range': etag } });
  assert.equal(same.status, 206);
  await same.arrayBuffer();
});

test('HEAD answers with headers and no body', async (t) => {
  const { authed } = await setup(t);
  const res = await authed('/download/hello.txt', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), '11');
  assert.equal(await res.text(), '');
});

test('a cancelled download frees the connection for the next request', async (t) => {
  const { authed } = await setup(t);
  const ac = new AbortController();
  const res = await authed('/download/hello.txt', { signal: ac.signal });
  ac.abort();
  await res.text().catch(() => {});
  assert.equal((await authed('/browse/')).status, 200);
});

// ------------------------------------------------------------ error paths

test('an unreachable SFTP server is a 502 page and is reported', async (t) => {
  const captured = [];
  const reporter = { capture: (err, ctx) => { captured.push({ err, ctx }); return 'evt123'; } };
  const { authed } = await setup(t, { reporter, sftp: { password: 'wrong' } });

  const res = await authed('/browse/');
  assert.equal(res.status, 502);
  const body = await res.text();
  assert.match(body, /Could not reach the SFTP server/);
  assert.match(body, /evt123/);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].ctx.tags.status, '502');
});

test('/throw reports a test exception, and only when signed in', async (t) => {
  const captured = [];
  const reporter = { capture: (err) => { captured.push(err); return 'evt456'; } };
  const { req, authed } = await setup(t, { reporter });

  assert.equal((await req('/throw')).status, 303);
  assert.equal(captured.length, 0);

  const res = await authed('/throw');
  assert.equal(res.status, 500);
  assert.match(await res.text(), /evt456/);
  assert.equal(captured[0].name, 'SftpProxyTestError');
});

test('404s and visitor mistakes are not reported', async (t) => {
  const captured = [];
  const reporter = { capture: (err) => { captured.push(err); return null; } };
  const { authed, login } = await setup(t, { reporter });
  await authed('/browse/nope/');
  await authed('/elsewhere');
  await login('wrong');
  assert.equal(captured.length, 0);
});

test('assets are linked by content hash and cached for good only at that URL', async (t) => {
  const { authed, req } = await setup(t);
  const page = await (await authed('/browse/')).text();
  const href = /<link rel="stylesheet" href="([^"]+)">/.exec(page)[1];
  assert.match(href, /^\/static\/styles\.css\?v=[0-9a-f]{12}$/);

  const current = await req(href);
  assert.match(current.headers.get('cache-control'), /immutable/);
  assert.match(await current.text(), /storage-bar/);

  // An old or missing version still gets the file, but never a cacheable one.
  assert.equal((await req('/static/styles.css?v=000000000000')).headers.get('cache-control'), 'no-store');
  assert.equal((await req('/static/styles.css')).headers.get('cache-control'), 'no-store');
});
