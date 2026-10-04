import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { startSftpServer } from './helpers/sftp-server.js';
import { createSftpStore, fingerprint, HttpError } from '../src/sftp.js';
import { configureLogger } from '../src/logger.js';

configureLogger({ level: 'error' });

function makeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-proxy-'));
  fs.mkdirSync(path.join(dir, 'public', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'private'));
  fs.writeFileSync(path.join(dir, 'public', 'hello.txt'), 'hello world');
  fs.writeFileSync(path.join(dir, 'public', 'sub', 'deep.bin'), Buffer.alloc(100_000, 7));
  fs.writeFileSync(path.join(dir, 'private', 'secret.txt'), 'nope');
  return dir;
}

async function setup(t, overrides = {}) {
  const dir = makeTree();
  const srv = await startSftpServer({ dir });
  const store = createSftpStore({
    host: '127.0.0.1',
    port: srv.port,
    username: srv.username,
    password: srv.password,
    root: 'public',
    connectTimeoutMs: 5000,
    idleCloseMs: 0,
    hostKeySha256: null,
    ...overrides,
  });
  t.after(async () => {
    await store.close();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, srv, store };
}

test('lists the public folder, with folders and files typed', async (t) => {
  const { store } = await setup(t);
  const entries = await store.list('');
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.deepEqual(Object.keys(byName).sort(), ['hello.txt', 'sub']);
  assert.equal(byName['hello.txt'].type, 'file');
  assert.equal(byName['hello.txt'].size, 11);
  assert.ok(byName['hello.txt'].mtime instanceof Date);
  assert.equal(byName.sub.type, 'dir');
  assert.equal(byName.sub.size, null);
});

test('lists a subfolder', async (t) => {
  const { store } = await setup(t);
  const entries = await store.list('sub');
  assert.deepEqual(entries.map((e) => [e.name, e.size]), [['deep.bin', 100_000]]);
});

test('streams a whole file and a byte range', async (t) => {
  const { store } = await setup(t);

  const whole = await store.open('hello.txt');
  assert.equal(whole.size, 11);
  assert.equal(await text(whole.stream()), 'hello world');

  const part = await store.open('hello.txt');
  assert.equal(await text(part.stream({ start: 6, end: 10 })), 'world');
});

test('missing paths are a 404, not a server error', async (t) => {
  const { store } = await setup(t);
  await assert.rejects(store.list('nope'), (err) => err instanceof HttpError && err.status === 404);
  await assert.rejects(store.open('nope.txt'), (err) => err.status === 404);
  await assert.rejects(store.open('sub'), (err) => err.status === 404);
});

test('a symlink cannot reach outside the public folder', { skip: process.platform === 'win32' && 'symlinks need admin on Windows' }, async (t) => {
  const { dir, store } = await setup(t);
  fs.symlinkSync(path.join(dir, 'private', 'secret.txt'), path.join(dir, 'public', 'escape.txt'));
  fs.symlinkSync(path.join(dir, 'private'), path.join(dir, 'public', 'escape-dir'));
  fs.symlinkSync(path.join(dir, 'public', 'hello.txt'), path.join(dir, 'public', 'alias.txt'));

  const names = (await store.list('')).map((e) => e.name).sort();
  assert.deepEqual(names, ['alias.txt', 'hello.txt', 'sub']);
  await assert.rejects(store.open('escape.txt'), (err) => err.status === 404);
  await assert.rejects(store.list('escape-dir'), (err) => err.status === 404);
  assert.equal(await text((await store.open('alias.txt')).stream()), 'hello world');
});

test('a pinned host key is accepted when it matches', async (t) => {
  const probe = await setup(t);
  const fp = fingerprint(probe.srv.publicKey);
  const store = createSftpStore({
    host: '127.0.0.1', port: probe.srv.port, username: 'test', password: 'secret',
    root: 'public', connectTimeoutMs: 5000, idleCloseMs: 0, hostKeySha256: fp,
  });
  t.after(() => store.close());
  assert.equal((await store.list('')).length, 2);
});

test('a host key mismatch refuses to connect and says why', async (t) => {
  const { store } = await setup(t, { hostKeySha256: 'A'.repeat(43) });
  await assert.rejects(store.list(''), (err) => err.status === 502 && /host key mismatch/.test(err.message));
});

test('a wrong password is a 502 that names the problem', async (t) => {
  const { store } = await setup(t, { password: 'wrong' });
  await assert.rejects(store.list(''), (err) => err.status === 502 && /authentication/i.test(err.message));
});

test('a missing public folder is reported clearly', async (t) => {
  const { store } = await setup(t, { root: 'not-there' });
  await assert.rejects(store.list(''), /public folder "not-there"/);
});

test('reconnects after the server drops the connection', async (t) => {
  const { srv, store } = await setup(t);
  await store.list('');
  assert.equal(store.status().connected, true);

  srv.dropAll();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await store.list('')).length, 2);
  assert.equal(srv.stats.connections, 2);
});

test('reuses one connection across requests', async (t) => {
  const { srv, store } = await setup(t);
  await Promise.all([store.list(''), store.list('sub'), store.list('')]);
  await store.list('');
  assert.equal(srv.stats.connections, 1);
});

test('closes an idle connection and opens a fresh one when needed', async (t) => {
  const { srv, store } = await setup(t, { idleCloseMs: 50 });
  await store.list('');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(store.status().connected, false);
  await store.list('');
  assert.equal(srv.stats.connections, 2);
});
