import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, parseFingerprint } from '../src/config.js';
import { cleanRelative, isWithin } from '../src/paths.js';

const minimal = {
  SFTP_HOST: 'sftp.lan',
  SFTP_USERNAME: 'web',
  SFTP_PASSWORD: 'pw',
  SITE_PASSWORD: 'long enough',
};

test('a minimal configuration loads with sensible defaults', () => {
  const cfg = loadConfig(minimal);
  assert.equal(cfg.sftp.port, 22);
  assert.equal(cfg.sftp.root, 'public');
  assert.equal(cfg.sftp.hostKeySha256, null);
  assert.equal(cfg.web.port, 8080);
  assert.equal(cfg.web.showHidden, false);
  assert.equal(cfg.auth.sessionMaxAgeMs, 30 * 86_400_000);
  assert.equal(cfg.sentry.dsn, '');
});

test('every missing required setting is listed at once', () => {
  assert.throws(() => loadConfig({}), (err) => {
    for (const name of ['SFTP_HOST', 'SFTP_USERNAME', 'SITE_PASSWORD']) {
      assert.match(err.message, new RegExp(`${name} is required`));
    }
    return true;
  });
});

test('the proxy needs some way to log in to the SFTP server', () => {
  const { SFTP_PASSWORD, ...rest } = minimal;
  assert.throws(() => loadConfig(rest), /SFTP_PASSWORD or SFTP_PRIVATE_KEY_PATH/);
});

test('a private key is read from the given path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-proxy-cfg-'));
  const keyPath = path.join(dir, 'id');
  fs.writeFileSync(keyPath, 'KEY');
  const { SFTP_PASSWORD, ...rest } = minimal;
  const cfg = loadConfig({ ...rest, SFTP_PRIVATE_KEY_PATH: keyPath });
  assert.equal(cfg.sftp.privateKey.toString(), 'KEY');
  assert.throws(() => loadConfig({ ...rest, SFTP_PRIVATE_KEY_PATH: path.join(dir, 'missing') }), /could not be read/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a short site password is refused', () => {
  assert.throws(() => loadConfig({ ...minimal, SITE_PASSWORD: 'short' }), /at least 8 characters/);
});

test('a malformed DSN fails at startup', () => {
  assert.throws(() => loadConfig({ ...minimal, SENTRY_DSN: 'nope' }), /SENTRY_DSN/);
});

test('host key fingerprints are accepted in the forms ssh-keygen prints', () => {
  const bare = 'k2B73yd8l/LptkVYbn6MI8ktxHGtyPsDHK+s3niwZEE';
  assert.equal(parseFingerprint(`SHA256:${bare}`), bare);
  assert.equal(parseFingerprint(`${bare}=`), bare);
  assert.equal(parseFingerprint(''), null);
  assert.throws(() => parseFingerprint('MD5:aa:bb'), /SHA256 fingerprint/);
});

test('relative paths are cleaned, and climbing out is rejected', () => {
  assert.equal(cleanRelative(''), '');
  assert.equal(cleanRelative(undefined), '');
  assert.equal(cleanRelative('/a//b/./c/'), 'a/b/c');
  assert.equal(cleanRelative('a/../b'), null);
  assert.equal(cleanRelative('..'), null);
  assert.equal(cleanRelative('a\\..\\b'), null);
  assert.equal(cleanRelative('a\0b'), null);
  assert.equal(cleanRelative('...'), '...');
});

test('isWithin does not confuse a sibling with a prefix', () => {
  assert.equal(isWithin('/srv/public', '/srv/public'), true);
  assert.equal(isWithin('/srv/public', '/srv/public/a'), true);
  assert.equal(isWithin('/srv/public', '/srv/public-not'), false);
  assert.equal(isWithin('/', '/anything'), true);
});
