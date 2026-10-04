import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, 'static');

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/**
 * The stylesheet and script, read once at startup and addressed by a hash of
 * their contents (`/static/styles.css?v=1a2b3c4d`). A new build is a new
 * URL, so neither the browser nor a proxy can keep serving the old file -
 * Cloudflare, for one, rewrites `no-cache` into a four-hour browser cache.
 */
export const ASSETS = Object.fromEntries(['styles.css', 'app.js'].map((name) => {
  const body = fs.readFileSync(path.join(DIR, name));
  const version = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
  return [`/static/${name}`, {
    body,
    version,
    type: TYPES[path.extname(name)],
    url: `/static/${name}?v=${version}`,
  }];
}));

export const assetUrl = (pathname) => ASSETS[pathname].url;
