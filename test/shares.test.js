import test from 'node:test';
import assert from 'node:assert/strict';
import { createShareLinks } from '../src/shares.js';
import { setup } from './helpers/site.js';

// ------------------------------------------------------------- the tokens

test('a link round-trips its file and expiry', () => {
  const links = createShareLinks({ secret: 'k', now: () => 1_000_000 });
  const token = links.create('Photos 2026/æøå.jpg', 5_000_000);
  assert.deepEqual(links.open(token), { rel: 'Photos 2026/æøå.jpg', expiresAt: 5_000_000, expired: false });
});

test('the file path is not readable from the link', () => {
  const token = createShareLinks({ secret: 'k' }).create('Secret Folder/plans.pdf', Date.now() + 1000);
  const decoded = Buffer.from(token, 'base64url').toString('latin1');
  assert.doesNotMatch(decoded, /Secret|plans/);
  assert.match(token, /^[\w-]+$/, 'URL-safe as-is');
});

test('expired links say so, rather than looking invalid', () => {
  let t = 0;
  const links = createShareLinks({ secret: 'k', now: () => t });
  const token = links.create('a.txt', 60_000);
  assert.equal(links.open(token).expired, false);
  t = 60_000;
  assert.equal(links.open(token).expired, true);
});

test('tampered, foreign and junk tokens are rejected', () => {
  const links = createShareLinks({ secret: 'k' });
  const token = links.create('a.txt', Date.now() + 60_000);
  const raw = Buffer.from(token, 'base64url');
  raw[14] ^= 1;
  assert.equal(links.open(raw.toString('base64url')), null);
  assert.equal(createShareLinks({ secret: 'other' }).open(token), null, 'a new SESSION_SECRET cancels links');

  // Another spelling of the same bytes (the last character's spare bits).
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const variants = [...alphabet].map((c) => token.slice(0, -1) + c)
    .filter((v) => v !== token && Buffer.from(v, 'base64url').equals(Buffer.from(token, 'base64url')));
  for (const v of variants) assert.equal(links.open(v), null, `${v.slice(-3)} is not the issued spelling`);
  for (const junk of ['', 'x', 'not/base64!', 'A'.repeat(5000), undefined]) {
    assert.equal(links.open(junk), null);
  }
});

// ---------------------------------------------------------------- the site

test('a viewer can create a link, and anyone can download with it', async (t) => {
  const { share, req } = await setup(t);
  const res = await share({ path: 'Photos 2026/æøå.jpg', days: 7 });
  assert.equal(res.status, 201);
  const { url, expiresAt } = await res.json();
  assert.match(url, /^\/s\/[\w-]+$/);
  const days = (new Date(expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 6.99 && days <= 7, `expires in ${days} days`);

  // No cookie: the link alone is enough.
  const page = await req(url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<h1>æøå\.jpg<\/h1>/);
  assert.match(html, /4 B · link expires/);
  assert.match(html, new RegExp(`href="${url}/download"`));
  assert.doesNotMatch(html, /Sign out|Photos 2026|\/browse\//, 'reveals nothing about the rest of the share');

  const file = await req(`${url}/download`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /^attachment;/);
  assert.equal(await file.text(), 'jpeg');

  const part = await req(`${url}/download`, { headers: { Range: 'bytes=1-' } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), 'peg');
});

test('links default to 30 days, and only offer the listed lengths', async (t) => {
  const { share } = await setup(t);
  const { expiresAt } = await (await share({ path: 'hello.txt' })).json();
  const days = (new Date(expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 29.99 && days <= 30);
  assert.equal((await share({ path: 'hello.txt', days: 10_000 })).status, 400);
  assert.equal((await share({ path: 'hello.txt', days: 0 })).status, 400);
});

test('admins can create links too', async (t) => {
  const { admin } = await setup(t);
  const res = await admin('POST', '/api/share', { path: 'hello.txt' });
  assert.equal(res.status, 201);
});

test('only existing, visible files can be shared', async (t) => {
  const { share } = await setup(t);
  for (const path of ['Photos 2026', 'nope.txt', '.hidden', '../outside.txt', '', '.uploads/x.part']) {
    const res = await share({ path });
    assert.ok([400, 404].includes(res.status), `${JSON.stringify(path)} -> ${res.status}`);
  }
});

test('creating a link needs a session and the page token', async (t) => {
  const { req, share, cookie } = await setup(t);
  const body = JSON.stringify({ path: 'hello.txt' });
  const json = { 'Content-Type': 'application/json' };
  assert.equal((await req('/api/share', { method: 'POST', headers: json, body })).status, 401);
  assert.equal((await req('/api/share', { method: 'POST', headers: { ...json, cookie }, body })).status, 403);
  assert.equal((await share({ path: 'hello.txt' }, { Origin: 'https://evil.example' })).status, 403);
});

test('an expired link explains itself, and serves nothing', async (t) => {
  let now = Date.now();
  const { share, req } = await setup(t, { now: () => now });
  const { url } = await (await share({ path: 'hello.txt', days: 1 })).json();
  now += 2 * 86_400_000;

  const page = await req(url);
  assert.equal(page.status, 410);
  const html = await page.text();
  assert.match(html, /This link has expired/);
  assert.doesNotMatch(html, /Back to the file list/);
  assert.equal((await req(`${url}/download`)).status, 410);
});

test('a broken or forged link is a plain 404', async (t) => {
  const { req } = await setup(t);
  for (const p of ['/s/', '/s/nonsense', '/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '/s/abc/other']) {
    const res = await req(p);
    assert.equal(res.status, 404, p);
    assert.match(await res.text(), /This link does not work/);
  }
});

test('a link to a file that has since gone says so', async (t) => {
  const { share, req, admin } = await setup(t);
  const { url } = await (await share({ path: 'hello.txt' })).json();
  await admin('POST', '/admin/delete', { path: 'hello.txt' });
  const res = await req(url);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /no longer there/);
});

test('every signed-in listing offers sharing on files only', async (t) => {
  const { authed } = await setup(t);
  const page = await (await authed('/browse/')).text();
  assert.match(page, /<dialog id="share-dialog"/);
  assert.match(page, /<option value="30" selected>30 days<\/option>/);
  assert.match(page, /data-name="hello.txt"[^>]*>[\s\S]*?data-action="share"/);
  assert.doesNotMatch(page, /data-name="Photos 2026"[^>]*>(?:(?!<\/tr>)[\s\S])*data-action="share"/);
});

test('without SESSION_SECRET sharing is off entirely', async (t) => {
  const { authed, share, req } = await setup(t, { sharing: false });
  const page = await (await authed('/browse/')).text();
  assert.doesNotMatch(page, /share-dialog|data-action="share"/);
  assert.equal((await share({ path: 'hello.txt' })).status, 404);
  assert.equal((await req('/s/anything')).status, 404);
});
