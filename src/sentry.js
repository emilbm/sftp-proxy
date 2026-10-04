import os from 'node:os';
import { createLogger } from './logger.js';

const log = createLogger('sentry');

const SDK_NAME = 'sftp-proxy';
const SEND_TIMEOUT_MS = 10_000;

/**
 * Minimal Sentry-protocol error reporter.
 *
 * Speaks the envelope API directly over `fetch`, which is all GlitchTip
 * ingests for errors, and keeps the project free of dependencies. Deliberately
 * unconditionally safe: a misconfigured DSN, an unreachable server or a
 * malformed event can never throw into the caller or take the process down -
 * an error reporter that causes errors is worse than none.
 */

/**
 * @param {string} dsn e.g. https://<key>@glitchtip.example.com/3
 * @returns {{url: string, publicKey: string, projectId: string}}
 */
export function parseDsn(dsn) {
  let u;
  try {
    u = new URL(dsn);
  } catch {
    throw new Error(`SENTRY_DSN is not a valid URL: "${dsn}"`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`SENTRY_DSN must be http or https, got "${u.protocol}"`);
  }
  if (!u.username) {
    throw new Error('SENTRY_DSN is missing the public key (the part before "@")');
  }

  // The project id is the last path segment; anything before it is a path
  // prefix, which self-hosted GlitchTip behind a subpath will have.
  const segments = u.pathname.split('/').filter(Boolean);
  const projectId = segments.pop();
  if (!projectId) {
    throw new Error('SENTRY_DSN is missing the project id (the last path segment)');
  }
  const prefix = segments.length ? `/${segments.join('/')}` : '';

  return {
    url: `${u.protocol}//${u.host}${prefix}/api/${projectId}/envelope/`,
    publicKey: u.username,
    projectId,
  };
}

const FRAME = /^\s*at\s+(?:(?<fn>.+?)\s+\()?(?<file>.+?):(?<line>\d+):(?<col>\d+)\)?\s*$/;

function isInApp(filename) {
  if (!filename) return false;
  if (filename.startsWith('node:')) return false;
  if (filename.includes('node_modules')) return false;
  return filename.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filename);
}

/**
 * Turn a V8 stack string into Sentry frames.
 * Sentry renders frames oldest-first, so the throwing frame must come last -
 * the reverse of how V8 prints them.
 */
export function parseStack(stack) {
  if (typeof stack !== 'string') return [];
  const frames = [];

  for (const line of stack.split('\n')) {
    const m = FRAME.exec(line);
    if (!m) continue;
    let filename = m.groups.file;
    // ESM stacks carry file:// URLs; the bare path reads better in the UI.
    if (filename.startsWith('file://')) {
      try {
        filename = decodeURIComponent(new URL(filename).pathname).replace(/^\/([A-Za-z]:)/, '$1');
      } catch { /* keep the original */ }
    }
    frames.push({
      filename,
      function: m.groups.fn ?? '<anonymous>',
      lineno: Number(m.groups.line),
      colno: Number(m.groups.col),
      in_app: isInApp(filename),
    });
  }

  return frames.reverse();
}

/** Sentry wants 32 lowercase hex characters, no dashes. */
function eventId() {
  return crypto.randomUUID().replace(/-/g, '');
}

/** Unwrap an error chain into Sentry's exception list, oldest cause first. */
function exceptionValues(err) {
  const chain = [];
  let current = err;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    chain.push({
      type: current.name || 'Error',
      value: String(current.message ?? ''),
      stacktrace: { frames: parseStack(current.stack) },
      mechanism: { type: 'generic', handled: true },
    });
    current = current.cause;
  }
  return chain.reverse();
}

export function createErrorReporter(cfg = {}, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const {
    dsn, environment = 'production', release, serverName = os.hostname(),
    maxEventsPerMinute = 30,
  } = cfg;

  if (!dsn) {
    log.info('error reporting disabled (no SENTRY_DSN set)');
    return {
      enabled: false,
      capture: () => null,
      flush: async () => {},
      stats: () => ({ enabled: false, sent: 0, dropped: 0, failed: 0 }),
    };
  }

  const target = parseDsn(dsn);
  const inFlight = new Set();
  let sent = 0;
  let dropped = 0;
  let failed = 0;
  let windowStart = now();
  let windowCount = 0;
  let mutedUntil = 0;

  log.info('error reporting enabled', {
    server: new URL(target.url).origin,
    project: target.projectId,
    environment,
    release,
  });

  function allowed() {
    const t = now();
    if (t < mutedUntil) return false;
    if (t - windowStart >= 60_000) {
      windowStart = t;
      windowCount = 0;
    }
    // A TCP server can fail in a tight loop; a cap keeps one bad minute from
    // turning into thousands of events.
    if (windowCount >= maxEventsPerMinute) return false;
    windowCount += 1;
    return true;
  }

  function envelope(event) {
    const header = JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString(), dsn });
    const body = JSON.stringify(event);
    const item = JSON.stringify({ type: 'event', length: Buffer.byteLength(body) });
    return `${header}\n${item}\n${body}\n`;
  }

  async function send(event) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetchImpl(target.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': [
            'Sentry sentry_version=7',
            `sentry_client=${SDK_NAME}/${release ?? '0'}`,
            `sentry_key=${target.publicKey}`,
          ].join(', '),
        },
        body: envelope(event),
        signal: ac.signal,
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || 60;
        mutedUntil = now() + retryAfter * 1000;
        failed += 1;
        log.warn('rate limited by the error reporting server', { retryAfterSeconds: retryAfter });
        return;
      }
      if (!res.ok) {
        failed += 1;
        const text = await res.text().catch(() => '');
        log.warn('error reporting server rejected the event', {
          status: res.status, body: text.slice(0, 200),
        });
        return;
      }
      sent += 1;
      log.debug('reported event', { eventId: event.event_id });
    } catch (err) {
      // Never escalate: reporting failures are logged and forgotten.
      failed += 1;
      log.debug('could not reach the error reporting server', { error: err.message });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    enabled: true,

    /**
     * Queue an error for delivery and return its event id immediately, so a
     * caller can show it to the user without waiting on the network.
     * @returns {string|null} null when the event was dropped
     */
    capture(err, context = {}) {
      try {
        if (!allowed()) {
          dropped += 1;
          return null;
        }

        const id = eventId();
        const event = {
          event_id: id,
          timestamp: now() / 1000,
          platform: 'node',
          level: context.level ?? 'error',
          logger: context.logger ?? 'sftp-proxy',
          server_name: serverName,
          environment,
          ...(release ? { release } : {}),
          exception: { values: exceptionValues(err instanceof Error ? err : new Error(String(err))) },
          tags: { runtime: `node ${process.versions.node}`, ...context.tags },
          extra: context.extra ?? {},
          ...(context.request ? { request: context.request } : {}),
          contexts: {
            runtime: { name: 'node', version: process.versions.node },
            os: { name: process.platform },
          },
        };

        const p = send(event).finally(() => inFlight.delete(p));
        inFlight.add(p);
        return id;
      } catch (reportingError) {
        log.debug('failed to build an error event', { error: reportingError.message });
        return null;
      }
    },

    /** Wait for queued events, so a shutdown does not lose the last report. */
    async flush(timeoutMs = 3000) {
      if (!inFlight.size) return;
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((r) => { setTimeout(r, timeoutMs).unref?.(); }),
      ]);
    },

    stats: () => ({ enabled: true, sent, dropped, failed, inFlight: inFlight.size }),
  };
}
