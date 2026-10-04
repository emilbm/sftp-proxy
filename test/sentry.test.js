import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseDsn, parseStack, createErrorReporter } from '../src/sentry.js';

// ------------------------------------------------------------- DSN parsing

test('a DSN is turned into the envelope endpoint', () => {
  assert.deepEqual(parseDsn('https://abc123@glitchtip.example.com/3'), {
    url: 'https://glitchtip.example.com/api/3/envelope/',
    publicKey: 'abc123',
    projectId: '3',
  });
});

test('a self-hosted DSN behind a path prefix keeps the prefix', () => {
  const t = parseDsn('https://key@example.com/glitchtip/inner/7');
  assert.equal(t.url, 'https://example.com/glitchtip/inner/api/7/envelope/');
  assert.equal(t.projectId, '7');
});

test('a legacy DSN with a secret still parses, using only the public key', () => {
  assert.equal(parseDsn('https://pub:secret@example.com/1').publicKey, 'pub');
});

test('plain http and a non-default port are accepted, for a LAN GlitchTip', () => {
  assert.equal(
    parseDsn('http://key@192.168.1.20:8000/2').url,
    'http://192.168.1.20:8000/api/2/envelope/',
  );
});

test('malformed DSNs are rejected with a message naming the problem', () => {
  assert.throws(() => parseDsn('not-a-url'), /not a valid URL/);
  assert.throws(() => parseDsn('ftp://key@host/1'), /must be http or https/);
  assert.throws(() => parseDsn('https://host.com/1'), /missing the public key/);
  assert.throws(() => parseDsn('https://key@host.com'), /missing the project id/);
});

// ---------------------------------------------------------- stack parsing

test('stack frames are reversed, because Sentry renders the crash last', () => {
  const stack = [
    'Error: boom',
    '    at inner (/app/src/a.js:10:5)',
    '    at middle (/app/src/b.js:20:7)',
    '    at outer (/app/src/c.js:30:9)',
  ].join('\n');

  assert.deepEqual(parseStack(stack).map((f) => f.function), ['outer', 'middle', 'inner']);
  assert.deepEqual(parseStack(stack).at(-1), {
    filename: '/app/src/a.js', function: 'inner', lineno: 10, colno: 5, in_app: true,
  });
});

test('ESM file:// frames are reduced to plain paths', () => {
  const [frame] = parseStack('Error: x\n    at run (file:///app/src/index.js:42:11)');
  assert.equal(frame.filename, '/app/src/index.js');
  assert.equal(frame.in_app, true);
});

test('anonymous and bare frames still parse', () => {
  const frames = parseStack([
    'Error: x',
    '    at /app/src/a.js:1:2',
    '    at async Server.handler (/app/src/b.js:3:4)',
  ].join('\n'));
  assert.equal(frames.length, 2);
  assert.ok(frames.some((f) => f.function === '<anonymous>' && f.filename === '/app/src/a.js'));
});

test('node internals and dependencies are marked out of app', () => {
  const frames = parseStack([
    'Error: x',
    '    at emit (node:events:520:28)',
    '    at thing (/app/node_modules/pkg/index.js:1:1)',
    '    at mine (/app/src/a.js:2:2)',
  ].join('\n'));
  const byFile = Object.fromEntries(frames.map((f) => [f.filename, f.in_app]));
  assert.equal(byFile['node:events'], false);
  assert.equal(byFile['/app/node_modules/pkg/index.js'], false);
  assert.equal(byFile['/app/src/a.js'], true);
});

test('a missing or junk stack yields no frames rather than throwing', () => {
  assert.deepEqual(parseStack(undefined), []);
  assert.deepEqual(parseStack('no frames here'), []);
});

// ------------------------------------------------------------- reporting

/** A stand-in GlitchTip that records what it was sent. */
async function fakeSentry({ status = 200, headers = {} } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers['x-sentry-auth'], type: req.headers['content-type'], body });
      res.writeHead(status, headers).end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    received,
    dsn: `http://testkey@127.0.0.1:${port}/9`,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Split an envelope into its three newline-delimited parts. */
function parseEnvelope(body) {
  const [header, itemHeader, payload] = body.split('\n');
  return {
    header: JSON.parse(header),
    itemHeader: JSON.parse(itemHeader),
    event: JSON.parse(payload),
  };
}

test('with no DSN the reporter is an inert no-op', () => {
  const r = createErrorReporter({});
  assert.equal(r.enabled, false);
  assert.equal(r.capture(new Error('ignored')), null);
  assert.deepEqual(r.stats(), { enabled: false, sent: 0, dropped: 0, failed: 0 });
});

test('an error reaches the server as a well-formed Sentry envelope', async () => {
  const sentry = await fakeSentry();
  const r = createErrorReporter({ dsn: sentry.dsn, environment: 'test', release: '3.0.0' });

  const id = r.capture(new TypeError('something broke'), { tags: { route: '/throw' } });
  await r.flush();

  assert.match(id, /^[0-9a-f]{32}$/, 'event id is 32 hex chars');
  assert.equal(sentry.received.length, 1);

  const req = sentry.received[0];
  assert.equal(req.url, '/api/9/envelope/');
  assert.equal(req.type, 'application/x-sentry-envelope');
  assert.match(req.auth, /sentry_version=7/);
  assert.match(req.auth, /sentry_key=testkey/);

  const { header, itemHeader, event } = parseEnvelope(req.body);
  assert.equal(header.event_id, id);
  assert.equal(itemHeader.type, 'event');
  assert.equal(itemHeader.length, Buffer.byteLength(JSON.stringify(event)));

  assert.equal(event.exception.values[0].type, 'TypeError');
  assert.equal(event.exception.values[0].value, 'something broke');
  assert.ok(event.exception.values[0].stacktrace.frames.length > 0, 'carries a stack');
  assert.equal(event.environment, 'test');
  assert.equal(event.release, '3.0.0');
  assert.equal(event.level, 'error');
  assert.equal(event.tags.route, '/throw');

  await sentry.close();
});

test('a cause chain is reported oldest first', async () => {
  const sentry = await fakeSentry();
  const r = createErrorReporter({ dsn: sentry.dsn });

  const root = new Error('disk full');
  r.capture(new Error('could not save', { cause: root }));
  await r.flush();

  const { event } = parseEnvelope(sentry.received[0].body);
  assert.deepEqual(event.exception.values.map((v) => v.value), ['disk full', 'could not save']);
  await sentry.close();
});

test('a non-Error value is still reportable', async () => {
  const sentry = await fakeSentry();
  const r = createErrorReporter({ dsn: sentry.dsn });

  r.capture('just a string');
  await r.flush();

  assert.equal(parseEnvelope(sentry.received[0].body).event.exception.values[0].value, 'just a string');
  await sentry.close();
});

test('an unreachable server never throws into the caller', async () => {
  // Nothing is listening on this port.
  const r = createErrorReporter({ dsn: 'http://key@127.0.0.1:1/1' });
  assert.doesNotThrow(() => r.capture(new Error('boom')));
  await r.flush();
  assert.equal(r.stats().failed, 1);
  assert.equal(r.stats().sent, 0);
});

test('a rejecting server is counted, not retried into a storm', async () => {
  const sentry = await fakeSentry({ status: 500 });
  const r = createErrorReporter({ dsn: sentry.dsn });

  r.capture(new Error('boom'));
  await r.flush();

  assert.equal(sentry.received.length, 1, 'one attempt, no retry loop');
  assert.equal(r.stats().failed, 1);
  await sentry.close();
});

test('a burst is capped so one bad minute cannot become thousands of events', async () => {
  const sentry = await fakeSentry();
  const r = createErrorReporter({ dsn: sentry.dsn, maxEventsPerMinute: 3 });

  const ids = Array.from({ length: 10 }, (_, i) => r.capture(new Error(`boom ${i}`)));
  await r.flush();

  assert.equal(ids.filter(Boolean).length, 3, 'only the first three are captured');
  assert.equal(sentry.received.length, 3);
  assert.equal(r.stats().dropped, 7);
  await sentry.close();
});

test('a 429 mutes reporting until the server says it may resume', async () => {
  const sentry = await fakeSentry({ status: 429, headers: { 'retry-after': '120' } });
  const r = createErrorReporter({ dsn: sentry.dsn });

  r.capture(new Error('first'));
  await r.flush();
  assert.equal(sentry.received.length, 1);

  assert.equal(r.capture(new Error('second')), null, 'muted after the 429');
  await r.flush();
  assert.equal(sentry.received.length, 1, 'nothing further was sent');
  await sentry.close();
});

test('flush resolves even when the server never answers', async () => {
  const hung = http.createServer(() => { /* deliberately never responds */ });
  await new Promise((r) => hung.listen(0, '127.0.0.1', r));
  const r = createErrorReporter({ dsn: `http://k@127.0.0.1:${hung.address().port}/1` });

  r.capture(new Error('boom'));
  await r.flush(150); // must not hang the shutdown path

  hung.closeAllConnections();
  await new Promise((res) => hung.close(res));
});
