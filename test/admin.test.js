import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, ADMIN } from './helpers/site.js';

// ------------------------------------------------------------------ roles

test('the admin password unlocks the admin tools; the download one does not', async (t) => {
  const { authed, req, asAdmin } = await setup(t);
  const viewerPage = await (await authed('/browse/')).text();
  assert.doesNotMatch(viewerPage, /app\.js|name="csrf"|Upload files|data-action/);

  const { cookie, csrf } = await asAdmin();
  assert.ok(csrf);
  const adminPage = await (await req('/browse/', { headers: { cookie } })).text();
  assert.match(adminPage, /<script src="\/static\/app.js" defer>/);
  assert.match(adminPage, /Upload files/);
  assert.match(adminPage, /class="badge">Admin/);
  assert.match(adminPage, /data-path="hello.txt"/);
});

test('an admin session is shorter-lived than a viewer one', async (t) => {
  const { login } = await setup(t);
  assert.match((await login()).headers.get('set-cookie'), /Max-Age=3600($|;)/);
  assert.match((await login(ADMIN)).headers.get('set-cookie'), /Max-Age=600($|;)/);
});

test('admin routes refuse visitors, viewers, missing tokens and other sites', async (t) => {
  const { req, authed, admin, asAdmin } = await setup(t);
  const body = JSON.stringify({ dir: '', name: 'x' });
  const json = { 'Content-Type': 'application/json' };

  assert.equal((await req('/admin/folders', { method: 'POST', headers: json, body })).status, 401);
  assert.equal((await authed('/admin/folders', { method: 'POST', headers: json, body })).status, 403);

  const { cookie } = await asAdmin();
  const noToken = await req('/admin/folders', { method: 'POST', headers: { ...json, cookie }, body });
  assert.equal(noToken.status, 403);
  assert.match((await noToken.json()).error, /token/);

  const forged = await admin('POST', '/admin/folders', { dir: '', name: 'x' }, { 'X-CSRF-Token': 'forged' });
  assert.equal(forged.status, 403);

  const crossSite = await admin('POST', '/admin/folders', { dir: '', name: 'x' }, { Origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403);
  assert.match((await crossSite.json()).error, /Cross-site/);
});

test('without ADMIN_PASSWORD the admin routes do not exist', async (t) => {
  const { authed, login } = await setup(t, { auth: { adminPassword: '' } });
  assert.equal((await authed('/admin/folders', { method: 'POST' })).status, 404);
  assert.equal((await login(ADMIN)).status, 401);
});

// ------------------------------------------------- folders, rename, delete

test('admins create, rename and delete, with a postfix on clashes', async (t) => {
  const { admin, dir } = await setup(t);
  const pub = path.join(dir, 'public');

  let res = await admin('POST', '/admin/folders', { dir: '', name: 'Photos 2026' });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { name: 'Photos 2026 (1)' });

  res = await admin('POST', '/admin/rename', { path: 'Photos 2026/æøå.jpg', name: 'beach.jpg' });
  assert.deepEqual(await res.json(), { name: 'beach.jpg' });
  assert.ok(fs.existsSync(path.join(pub, 'Photos 2026', 'beach.jpg')));

  res = await admin('POST', '/admin/rename', { path: 'Photos 2026 (1)', name: 'Photos 2026' });
  assert.deepEqual(await res.json(), { name: 'Photos 2026 (2)' });

  res = await admin('POST', '/admin/delete', { path: 'Photos 2026' });
  assert.equal(res.status, 200);
  assert.equal(fs.existsSync(path.join(pub, 'Photos 2026')), false);
});

test('admin writes cannot reach hidden files, staging or outside the folder', async (t) => {
  const { admin, dir } = await setup(t);
  const tries = [
    ['/admin/delete', { path: '.hidden' }],
    ['/admin/delete', { path: '../outside.txt' }],
    ['/admin/delete', { path: '.uploads' }],
    ['/admin/rename', { path: 'hello.txt', name: '../escaped.txt' }],
    ['/admin/rename', { path: 'hello.txt', name: '.ssh' }],
    ['/admin/folders', { dir: '..', name: 'x' }],
    ['/admin/delete', { path: '' }],
  ];
  for (const [route, body] of tries) {
    const res = await admin('POST', route, body);
    assert.ok([400, 404].includes(res.status), `${route} ${JSON.stringify(body)} -> ${res.status}`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'outside.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'public', '.hidden')));
  assert.ok(fs.existsSync(path.join(dir, 'public', 'hello.txt')));
});

// ---------------------------------------------------------------- uploads

test('a chunked upload lands under its name, postfixed on a clash', async (t) => {
  const { admin, dir, authed } = await setup(t);
  const data = Buffer.from('0123456789abcdef');

  let res = await admin('POST', '/admin/uploads', { dir: '', name: 'hello.txt', size: data.length });
  assert.equal(res.status, 201);
  const { id } = await res.json();

  res = await admin('PUT', `/admin/uploads/${id}?offset=0`, data.subarray(0, 10));
  assert.deepEqual(await res.json(), { received: 10 });

  // Not visible, not downloadable, while it is still arriving.
  assert.doesNotMatch(await (await authed('/browse/')).text(), /\.uploads/);
  assert.equal((await authed(`/download/.uploads/${id}.part`)).status, 404);

  res = await admin('POST', `/admin/uploads/${id}/complete`);
  assert.equal(res.status, 409, 'cannot finish early');
  assert.equal((await res.json()).received, 10);

  res = await admin('PUT', `/admin/uploads/${id}?offset=10`, data.subarray(10));
  assert.deepEqual(await res.json(), { received: 16 });

  res = await admin('POST', `/admin/uploads/${id}/complete`);
  assert.deepEqual(await res.json(), { name: 'hello (1).txt' });
  assert.equal(fs.readFileSync(path.join(dir, 'public', 'hello (1).txt'), 'utf8'), data.toString());
  assert.equal(fs.readFileSync(path.join(dir, 'public', 'hello.txt'), 'utf8'), 'hello world', 'original untouched');
});

test('an upload resumes from where the server got to', async (t) => {
  const { admin, dir } = await setup(t);
  const data = Buffer.from('abcdefghij');
  const { id } = await (await admin('POST', '/admin/uploads', { dir: 'Photos 2026', name: 'r.bin', size: 10 })).json();
  await admin('PUT', `/admin/uploads/${id}?offset=0`, data.subarray(0, 4));

  // Skipping ahead is refused, with the real position to resume from.
  let res = await admin('PUT', `/admin/uploads/${id}?offset=8`, data.subarray(8));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).received, 4);

  res = await admin('GET', `/admin/uploads/${id}`);
  assert.deepEqual(await res.json(), { received: 4, size: 10 });

  // Re-sending bytes it already has is fine.
  await admin('PUT', `/admin/uploads/${id}?offset=2`, data.subarray(2, 10));
  res = await admin('POST', `/admin/uploads/${id}/complete`);
  assert.deepEqual(await res.json(), { name: 'r.bin' });
  assert.equal(fs.readFileSync(path.join(dir, 'public', 'Photos 2026', 'r.bin'), 'utf8'), 'abcdefghij');
});

test('uploads validate up front and can be cancelled', async (t) => {
  const { admin, dir } = await setup(t);
  assert.equal((await admin('POST', '/admin/uploads', { dir: 'nope', name: 'a', size: 1 })).status, 404);
  assert.equal((await admin('POST', '/admin/uploads', { dir: '', name: '.bashrc', size: 1 })).status, 400);
  assert.equal((await admin('POST', '/admin/uploads', { dir: '', name: 'a', size: -1 })).status, 400);

  const { id } = await (await admin('POST', '/admin/uploads', { dir: '', name: 'big.bin', size: 4 })).json();
  const tooLong = await admin('PUT', `/admin/uploads/${id}?offset=0`, Buffer.from('12345'));
  assert.equal(tooLong.status, 400, 'past the end');
  assert.equal((await admin('DELETE', `/admin/uploads/${id}`)).status, 200);
  assert.equal((await admin('GET', `/admin/uploads/${id}`)).status, 404);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'public', '.uploads')), []);
});

test('an empty file uploads too', async (t) => {
  const { admin, dir } = await setup(t);
  const { id } = await (await admin('POST', '/admin/uploads', { dir: '', name: 'empty.txt', size: 0 })).json();
  const res = await admin('POST', `/admin/uploads/${id}/complete`);
  assert.deepEqual(await res.json(), { name: 'empty.txt' });
  assert.equal(fs.statSync(path.join(dir, 'public', 'empty.txt')).size, 0);
});

test('the staging folder stays hidden even when dotfiles are shown', async (t) => {
  const { admin, authed } = await setup(t, { web: { showHidden: true } });
  await admin('POST', '/admin/uploads', { dir: '', name: 'x.bin', size: 1 });
  const page = await (await authed('/browse/')).text();
  assert.match(page, /\.hidden/);
  assert.doesNotMatch(page, /\.uploads/);
  assert.equal((await authed('/browse/.uploads/')).status, 404);
});

// ---------------------------------------------------------------- storage

test('the listing shows a storage bar for the share', async (t) => {
  const { authed } = await setup(t);
  const page = await (await authed('/browse/')).text();
  assert.match(page, /class="storage"/);
  // The stand-in server has no disk statistics, so it sums the share itself.
  assert.match(page, /in this share/);
  assert.match(page, /class="seg-photos"/);
  assert.match(page, /Documents <span>11 B<\/span>/);
});

test('the storage bar refreshes after an admin change', async (t) => {
  const { authed, admin } = await setup(t);
  await authed('/browse/');
  await admin('POST', '/admin/delete', { path: 'hello.txt' });
  // The very next page already reflects it, rather than the cached figure.
  assert.doesNotMatch(await (await authed('/browse/')).text(), /Documents <span>/);
});
