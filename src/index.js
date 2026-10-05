import { loadConfig } from './config.js';
import { configureLogger, createLogger } from './logger.js';
import { createErrorReporter } from './sentry.js';
import { createAuth, createLoginLimiter } from './auth.js';
import { createSftpStore } from './sftp.js';
import { createShareLinks } from './shares.js';
import { createWebServer, listen } from './web/server.js';

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(78); // EX_CONFIG
}

configureLogger({ level: cfg.logLevel, tz: cfg.tz });
const log = createLogger('main');

const reporter = createErrorReporter({
  dsn: cfg.sentry.dsn,
  environment: cfg.sentry.environment,
  release: cfg.sentry.release || undefined,
  serverName: cfg.sentry.serverName || undefined,
  maxEventsPerMinute: cfg.sentry.maxEventsPerMinute,
});

const auth = createAuth(cfg.auth);
const limiter = createLoginLimiter({
  maxFailures: cfg.auth.maxFailures,
  windowMs: cfg.auth.failureWindowMs,
});
const store = createSftpStore(cfg.sftp);
// Share links are sealed with a key from SESSION_SECRET. Without one, the key
// would change on every restart and break every link, so sharing stays off.
const shares = cfg.auth.sessionSecret ? createShareLinks({ secret: cfg.auth.sessionSecret }) : null;
const server = createWebServer({ cfg, store, auth, limiter, reporter, shares });

async function main() {
  log.info('sftp-proxy starting', {
    sftp: `${cfg.sftp.username}@${cfg.sftp.host}:${cfg.sftp.port}`,
    folder: cfg.sftp.root,
    hostKeyPinned: Boolean(cfg.sftp.hostKeySha256),
    admin: auth.adminEnabled ? 'enabled' : 'off (no ADMIN_PASSWORD)',
    shareLinks: shares ? 'enabled' : 'off (no SESSION_SECRET)',
  });
  if (auth.ephemeralSecret) {
    log.info('no SESSION_SECRET set - visitors will need to sign in again after a restart');
  }

  await listen(server, { port: cfg.web.port, address: cfg.web.address });

  // Connect once up front so a wrong host, password or host key shows up in
  // the log (and GlitchTip) at deploy time rather than on the first visit.
  // The site still starts either way; it retries on each request.
  store.list('').then(
    (entries) => log.info('public folder is readable', { entries: entries.length }),
    (err) => {
      log.error('could not read the public folder at startup', err);
      reporter.capture(err, { tags: { component: 'sftp', phase: 'startup' } });
    },
  );
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`received ${signal}, shutting down`);

  // Stop taking requests; in-flight downloads are cut off by closeAllConnections,
  // the browser can resume them once we are back.
  await new Promise((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
  await store.close();
  await reporter.flush();
  log.info('goodbye');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection', reason instanceof Error ? reason : { reason });
  reporter.capture(reason, { tags: { handler: 'unhandledRejection' } });
});
process.on('uncaughtException', (err) => {
  // Let the container restart us rather than continue in an unknown state,
  // but give the report a moment to leave first.
  log.error('uncaught exception, exiting so the supervisor can restart us', err);
  reporter.capture(err, { tags: { handler: 'uncaughtException' } });
  reporter.flush(2000).finally(() => process.exit(1));
});

main().catch((err) => {
  log.error('failed to start', err);
  reporter.capture(err, { tags: { handler: 'startup' } });
  reporter.flush(2000).finally(() => process.exit(1));
});
