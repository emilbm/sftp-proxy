import path from 'node:path';

/**
 * Normalise a browser-supplied path into a relative POSIX path inside the
 * public folder: no leading slash, no `.` or `..` segments, no empty segments.
 * Returns '' for the folder itself.
 *
 * Anything trying to climb out is rejected rather than clamped, so a crafted
 * link fails loudly instead of quietly showing a different folder.
 *
 * @returns {string|null} null when the path is not acceptable
 */
export function cleanRelative(input) {
  if (input === undefined || input === null) return '';
  const raw = String(input);
  if (raw.includes('\0') || raw.includes('\\')) return null;

  const segments = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    segments.push(seg);
  }
  return segments.join('/');
}

/** Join a cleaned relative path onto the absolute public root. */
export function resolveUnder(root, rel) {
  return rel ? path.posix.join(root, rel) : root;
}

/** True when `candidate` is `root` or somewhere below it. */
export function isWithin(root, candidate) {
  if (candidate === root) return true;
  const base = root.endsWith('/') ? root : `${root}/`;
  return candidate.startsWith(base);
}

/**
 * Is `name` acceptable for something an admin creates or renames to?
 *
 * Names starting with a dot are refused outright: they are hidden from the
 * listing, the upload staging folder is one, and on a loosely configured
 * server `.ssh` is how an upload turns into a login.
 *
 * @returns {string|null} why it is not acceptable, or null if it is
 */
export function invalidName(name) {
  if (typeof name !== 'string' || !name.trim()) return 'A name is required';
  if (name !== name.trim()) return 'Names cannot start or end with a space';
  if (name.startsWith('.')) return 'Names cannot start with a dot';
  if (/[/\\]/.test(name)) return 'Names cannot contain / or \\';
  if (/[\x00-\x1f\x7f]/.test(name)) return 'Names cannot contain control characters';
  if (Buffer.byteLength(name) > 255) return 'That name is too long';
  return null;
}

/**
 * `report.pdf` -> `report (2).pdf`. Keeps double extensions like `.tar.gz`
 * together, and treats a folder name as having no extension at all.
 */
export function withPostfix(name, n, { isDir = false } = {}) {
  if (n === 0) return name;
  const m = isDir ? null : /^(.+?)((?:\.tar)?\.[^.\s]{1,10})$/i.exec(name);
  return m ? `${m[1]} (${n})${m[2]}` : `${name} (${n})`;
}
