import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, createLoginLimiter, parseCookies } from '../src/auth.js';

const base = { password: 'hunter2hunter2', sessionSecret: 'k', sessionMaxAgeMs: 1000 };

test('only the exact password is accepted', () => {
  const auth = createAuth(base);
  assert.equal(auth.checkPassword('hunter2hunter2'), true);
  assert.equal(auth.checkPassword('hunter2hunter'), false);
  assert.equal(auth.checkPassword('Hunter2hunter2'), false);
  assert.equal(auth.checkPassword(''), false);
  assert.equal(auth.checkPassword(null), false);
});

test('an issued session verifies until it expires', () => {
  let t = 0;
  const auth = createAuth({ ...base, now: () => t });
  const token = auth.issue();
  assert.equal(auth.verify(token), true);
  t = 999;
  assert.equal(auth.verify(token), true);
  t = 1000;
  assert.equal(auth.verify(token), false);
});

test('a tampered session is rejected', () => {
  const auth = createAuth({ ...base, now: () => 0 });
  const [, sig] = auth.issue().split('.');
  assert.equal(auth.verify(`99999999999.${sig}`), false);
  assert.equal(auth.verify('garbage'), false);
  assert.equal(auth.verify(''), false);
  assert.equal(auth.verify(undefined), false);
});

test('sessions survive a restart with the same secret', () => {
  const token = createAuth({ ...base, now: () => 0 }).issue();
  assert.equal(createAuth({ ...base, now: () => 0 }).verify(token), true);
});

test('changing the password or the secret signs everyone out', () => {
  const token = createAuth({ ...base, now: () => 0 }).issue();
  assert.equal(createAuth({ ...base, password: 'different-pass', now: () => 0 }).verify(token), false);
  assert.equal(createAuth({ ...base, sessionSecret: 'other', now: () => 0 }).verify(token), false);
});

test('without a secret, a random one is used and reported as such', () => {
  const a = createAuth({ ...base, sessionSecret: '' });
  const b = createAuth({ ...base, sessionSecret: '' });
  assert.equal(a.ephemeralSecret, true);
  assert.equal(b.verify(a.issue()), false);
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
