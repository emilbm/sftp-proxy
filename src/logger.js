const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let threshold = LEVELS.info;
let timeZone = 'UTC';

export function configureLogger({ level = 'info', tz = 'UTC' } = {}) {
  threshold = LEVELS[level] ?? LEVELS.info;
  timeZone = tz;
}

function stamp() {
  // Local wall-clock time, so log lines read the way the house clock does.
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(new Date());
}

function emit(level, scope, message, detail) {
  if (LEVELS[level] > threshold) return;
  let line = `${stamp()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  if (detail !== undefined) {
    line += ' ' + (detail instanceof Error
      ? (detail.stack ?? detail.message)
      : JSON.stringify(detail));
  }
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export function createLogger(scope) {
  return {
    error: (m, d) => emit('error', scope, m, d),
    warn: (m, d) => emit('warn', scope, m, d),
    info: (m, d) => emit('info', scope, m, d),
    debug: (m, d) => emit('debug', scope, m, d),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
