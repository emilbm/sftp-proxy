import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, createLoginLimiter, parseCookies } from '../src/auth.js';

const base = {
  password: 'hunter2hunter2',
  adminPassword: 'a much longer admin secret',
  sessionSecret: 'k',
  sessionMaxAgeMs: 1000,
  adminSessionMaxAgeMs: 100,
};

test('each password maps to its role, anything else to nothing', () => {
  const auth = createAuth(base);
  assert.equal(auth.checkPassword('hunter2hunter2'), 'viewer');
  assert.equal(auth.checkPassword('a much longer admin secret'), 'admin');
  assert.equal(auth.checkPassword('hunter2hunter'), null);
  assert.equal(auth.checkPassword('Hunter2hunter2'), null);
  assert.equal(auth.checkPassword(''), null);
  assert.equal(auth.checkPassword(null), null);
});

test('without an admin password there is no admin role', () => {
  const auth = createAuth({ ...base, adminPassword: '' });
  assert.equal(auth.adminEnabled, false);
  assert.equal(auth.checkPassword('a much longer admin secret'), null);
});

test('a session carries its role and expires on its own clock', () => {
  let t = 0;
  const auth = createAuth({ ...base, now: () => t });
  const viewer = auth.issue('viewer');
  const admin = auth.issue('admin');
  assert.equal(viewer.maxAgeMs, 1000);
  assert.equal(admin.maxAgeMs, 100);
  assert.equal(auth.verify(viewer.token), 'viewer');
  assert.equal(auth.verify(admin.token), 'admin');
  t = 100;
  assert.equal(auth.verify(admin.token), null, 'admin sessions are shorter');
  assert.equal(auth.verify(viewer.token), 'viewer');
  t = 1000;
  assert.equal(auth.verify(viewer.token), null);
});

test('a viewer session cannot be promoted or tampered with', () => {
  const auth = createAuth({ ...base, now: () => 0 });
  const { token } = auth.issue('viewer');
  const [, expires, sig] = token.split('.');
  assert.equal(auth.verify(`admin.${expires}.${sig}`), null);
  assert.equal(auth.verify(`viewer.99999999999.${sig}`), null);
  assert.equal(auth.verify(`${token}.extra`), null);
  assert.equal(auth.verify('garbage'), null);
  assert.equal(auth.verify(''), null);
  assert.equal(auth.verify(undefined), null);
});

test('sessions survive a restart with the same secret', () => {
  const { token } = createAuth({ ...base, now: () => 0 }).issue('viewer');
  assert.equal(createAuth({ ...base, now: () => 0 }).verify(token), 'viewer');
});

test('changing one password signs out only that role', () => {
  const before = createAuth({ ...base, now: () => 0 });
  const viewer = before.issue('viewer').token;
  const admin = before.issue('admin').token;

  const newAdmin = createAuth({ ...base, adminPassword: 'another long admin secret', now: () => 0 });
  assert.equal(newAdmin.verify(viewer), 'viewer');
  assert.equal(newAdmin.verify(admin), null);

  const newViewer = createAuth({ ...base, password: 'different-pass', now: () => 0 });
  assert.equal(newViewer.verify(viewer), null);
  assert.equal(newViewer.verify(admin), 'admin');

  assert.equal(createAuth({ ...base, sessionSecret: 'other', now: () => 0 }).verify(admin), null);
});

test('without a secret, a random one is used and reported as such', () => {
  const a = createAuth({ ...base, sessionSecret: '' });
  const b = createAuth({ ...base, sessionSecret: '' });
  assert.equal(a.ephemeralSecret, true);
  assert.equal(b.verify(a.issue('viewer').token), null);
});

test('the anti-forgery token is tied to an admin session', () => {
  const auth = createAuth({ ...base, now: () => 0 });
  const admin = auth.issue('admin').token;
  const other = createAuth({ ...base, now: () => 1 }).issue('admin').token;
  const viewer = auth.issue('viewer').token;

  const csrf = auth.csrfToken(admin);
  assert.ok(csrf.length > 20);
  assert.equal(auth.checkCsrf(admin, csrf), true);
  assert.equal(auth.checkCsrf(other, csrf), false, 'not valid for another session');
  assert.equal(auth.checkCsrf(admin, ''), false);
  assert.equal(auth.checkCsrf(admin, undefined), false);
  assert.equal(auth.csrfToken(viewer), '', 'viewers get none');
  assert.equal(auth.checkCsrf(viewer, auth.csrfToken(viewer)), false);
});

test('the limiter locks a client out after too many failures, then forgives', () => {
  let t = 0;
  const limiter = createLoginLimiter({ maxFailures: 2, windowMs: 60_000, now: () => t });
  assert.equal(limiter.retryAfter('a'), 0);
  limiter.fail('a');
  assert.equal(limiter.retryAfter('a'), 0);
  limiter.fail('a');
  assert.equal(limiter.retryAfter('a'), 60);
  assert.equal(limiter.retryAfter('b'), 0, 'other clients are unaffected');

  t = 30_000;
  assert.equal(limiter.retryAfter('a'), 30);
  t = 60_001;
  assert.equal(limiter.retryAfter('a'), 0);
});

test('a successful login clears the failure count', () => {
  const limiter = createLoginLimiter({ maxFailures: 2, windowMs: 60_000 });
  limiter.fail('a');
  limiter.succeed('a');
  limiter.fail('a');
  assert.equal(limiter.retryAfter('a'), 0);
});

test('cookies are parsed leniently', () => {
  assert.deepEqual(parseCookies('a=1; b=two%20words; bad; =x; a=shadowed'), { a: '1', b: 'two words' });
  assert.deepEqual(parseCookies(undefined), {});
});
