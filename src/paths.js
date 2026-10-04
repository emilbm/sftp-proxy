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
