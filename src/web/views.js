import { assetUrl } from './assets.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Encode a relative path segment by segment, keeping the slashes. */
export function encodePath(rel) {
  return rel.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

export function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function sortEntries(entries) {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
}

function layout({
  title, body, siteTitle, signedIn = false, admin = false, csrf = '', dir = null, script = false,
  brandHref = '/browse/',
}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${csrf ? `<meta name="csrf" content="${esc(csrf)}">` : ''}
<title>${esc(title)}</title>
<link rel="stylesheet" href="${assetUrl('/static/styles.css')}">
${script ? `<script src="${assetUrl('/static/app.js')}" defer></script>` : ''}
</head>
<body${dir !== null ? ` data-dir="${esc(dir)}"` : ''}${admin ? ' data-admin' : ''}>
<header class="top">
  ${brandHref ? `<a class="brand" href="${brandHref}">${esc(siteTitle)}</a>` : `<span class="brand">${esc(siteTitle)}</span>`}
  ${signedIn ? `<div class="session">
    ${admin ? '<span class="badge">Admin</span>' : ''}
    <form method="post" action="/logout"><button class="link" type="submit">Sign out</button></form>
  </div>` : ''}
</header>
<main>
${body}
</main>
</body>
</html>
`;
}

export function loginPage({ siteTitle, error = '', next = '' }) {
  return layout({
    title: `Sign in · ${siteTitle}`,
    siteTitle,
    body: `<form class="card login" method="post" action="/login">
  <h1>Sign in</h1>
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
  <input type="hidden" name="next" value="${esc(next)}">
  <button type="submit">Sign in</button>
</form>`,
  });
}

function breadcrumbs(rel) {
  const parts = rel ? rel.split('/') : [];
  const crumbs = [parts.length ? '<a href="/browse/">public</a>' : '<span aria-current="page">public</span>'];
  parts.forEach((name, i) => {
    const href = `/browse/${encodePath(parts.slice(0, i + 1).join('/'))}/`;
    crumbs.push(i === parts.length - 1
      ? `<span aria-current="page">${esc(name)}</span>`
      : `<a href="${esc(href)}">${esc(name)}</a>`);
  });
  return `<nav class="crumbs" aria-label="Folder">${crumbs.join('<span class="sep">/</span>')}</nav>`;
}

const CATEGORIES = [
  ['photos', 'Photos'],
  ['videos', 'Videos'],
  ['music', 'Music'],
  ['documents', 'Documents'],
  ['archives', 'Archives'],
  ['other', 'Other files'],
];

/**
 * A storage bar in the style of macOS's: one rounded bar, a coloured segment
 * per kind of file in the share, grey for whatever else fills the disk, and
 * the rest empty. Drawn as SVG because the page's CSP allows no inline styles.
 */
export function storageBar(storage) {
  if (!storage) return '';
  const segments = CATEGORIES
    .map(([key, label]) => ({ key, label, bytes: storage.categories?.[key] ?? 0 }))
    .filter((s) => s.bytes > 0);
  const shared = segments.reduce((sum, s) => sum + s.bytes, 0);

  let total;
  let heading;
  let detail;
  if (storage.disk?.total > 0) {
    const used = storage.disk.total - storage.disk.free;
    const elsewhere = Math.max(0, used - shared);
    if (elsewhere > 0) segments.push({ key: 'system', label: 'Not in this share', bytes: elsewhere });
    total = storage.disk.total;
    heading = `${formatSize(used)} of ${formatSize(total)} used`;
    detail = `${formatSize(storage.disk.free)} available`;
  } else {
    total = shared;
    heading = `${formatSize(shared)} in this share`;
    detail = '';
  }
  if (storage.partial) detail = [detail, 'very large share, partly counted'].filter(Boolean).join(' · ');

  // Every segment gets a sliver of width, so a small category is still seen.
  const UNITS = 1000;
  let x = 0;
  const rects = total > 0 ? segments.map((s) => {
    const w = Math.max(3, (s.bytes / total) * UNITS);
    const rect = `<rect class="seg-${s.key}" x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="10"><title>${esc(s.label)}: ${esc(formatSize(s.bytes))}</title></rect>`;
    x += w;
    return rect;
  }).join('') : '';

  const legend = segments.map((s) => `<li><svg class="dot" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><circle class="seg-${s.key}" cx="5" cy="5" r="5"/></svg>${esc(s.label)} <span>${esc(formatSize(s.bytes))}</span></li>`).join('');

  return `<section class="storage" aria-label="Storage">
  <div class="storage-head"><strong>${esc(heading)}</strong>${detail ? `<span>${esc(detail)}</span>` : ''}</div>
  <svg class="storage-bar" width="100%" height="12" viewBox="0 0 ${UNITS} 10" preserveAspectRatio="none" role="img" aria-label="${esc(heading)}">
    <defs><clipPath id="bar-round"><rect width="${UNITS}" height="10" rx="5" ry="5"/></clipPath></defs>
    <g clip-path="url(#bar-round)"><rect class="seg-free" width="${UNITS}" height="10"/>${rects}</g>
  </svg>
  ${legend ? `<ul class="legend">${legend}</ul>` : ''}
</section>`;
}

function iconButton(action, label) {
  return `<button type="button" class="icon-btn ${action}" data-action="${action}" title="${label}"><span class="sr">${label}</span></button>`;
}

/** The "Share link" dialog, filled in and opened by app.js. */
function shareDialog(shareDays, defaultShareDays) {
  const options = shareDays.map((d) => `<option value="${d}"${d === defaultShareDays ? ' selected' : ''}>${d === 1 ? '1 day' : d === 365 ? '1 year' : `${d} days`}</option>`).join('');
  return `<dialog id="share-dialog" class="dialog">
  <form method="dialog" class="dialog-body">
    <h2>Share link</h2>
    <p class="muted">Anyone with the link can download <strong id="share-name"></strong>, without a password, until it expires.</p>
    <label for="share-days">Expires after</label>
    <div class="share-row">
      <select id="share-days">${options}</select>
      <button type="button" id="share-create" class="primary">Create link</button>
    </div>
    <div id="share-result" hidden>
      <label for="share-url">Link</label>
      <div class="share-row">
        <input id="share-url" type="text" readonly>
        <button type="button" id="share-copy" class="primary">Copy</button>
      </div>
      <p class="muted" id="share-expiry"></p>
    </div>
    <p class="error" id="share-error" hidden></p>
    <div class="dialog-actions"><button value="close" class="secondary">Done</button></div>
  </form>
</dialog>`;
}

export function listingPage({
  siteTitle, rel, entries, formatDate, storage = null, admin = false, csrf = '',
  sharing = false, shareDays = [], defaultShareDays = 30,
}) {
  const sorted = sortEntries(entries);
  const prefix = rel ? `${rel}/` : '';
  const files = sorted.filter((e) => e.type === 'file');
  const total = files.reduce((sum, e) => sum + (e.size ?? 0), 0);
  const dirCount = sorted.length - files.length;
  const interactive = admin || sharing;
  const cols = interactive ? 4 : 3;

  const rows = sorted.map((e) => {
    const target = encodePath(prefix + e.name);
    const href = e.type === 'dir' ? `/browse/${target}/` : `/download/${target}`;
    const buttons = [
      sharing && e.type === 'file' ? iconButton('share', 'Share link') : '',
      admin ? iconButton('rename', 'Rename') : '',
      admin ? iconButton('delete', 'Delete') : '',
    ].join('');
    const actions = interactive ? `<td class="actions">${buttons}</td>` : '';
    return `<tr class="${e.type}"${interactive ? ` data-path="${esc(prefix + e.name)}" data-name="${esc(e.name)}" data-type="${e.type}"` : ''}>
  <td class="name"><a href="${esc(href)}"${e.type === 'file' ? ' download' : ''}><span class="icon" aria-hidden="true"></span>${esc(e.name)}${e.type === 'dir' ? '/' : ''}</a>${e.type === 'file' ? `<small class="meta">${esc(formatSize(e.size))}</small>` : ''}</td>
  <td class="size">${e.type === 'file' ? esc(formatSize(e.size)) : ''}</td>
  <td class="date">${e.mtime ? esc(formatDate(e.mtime)) : ''}</td>${actions}
</tr>`;
  }).join('\n');

  const summary = [
    dirCount ? `${dirCount} folder${dirCount === 1 ? '' : 's'}` : '',
    `${files.length} file${files.length === 1 ? '' : 's'}`,
    files.length ? formatSize(total) : '',
  ].filter(Boolean).join(' · ');

  const parent = rel
    ? `<tr class="up"><td class="name" colspan="${cols}"><a href="/browse/${encodePath(rel.split('/').slice(0, -1).join('/'))}${rel.includes('/') ? '/' : ''}">..</a></td></tr>`
    : '';

  const toolbar = admin ? `<div class="toolbar">
  <button type="button" data-action="upload">Upload files</button>
  <button type="button" class="secondary" data-action="mkdir">New folder</button>
  <input type="file" id="file-input" multiple hidden>
  <span class="hint">or drop files anywhere on the page</span>
</div>
<ul id="uploads" class="uploads" hidden></ul>` : '';

  return layout({
    title: `${rel || 'public'} · ${siteTitle}`,
    siteTitle,
    signedIn: true,
    admin,
    csrf,
    script: interactive,
    dir: interactive ? rel : null,
    body: `${storageBar(storage)}
${breadcrumbs(rel)}
${toolbar}
<div class="card">
${sorted.length || rel ? `<table>
<thead><tr><th class="name">Name</th><th class="size">Size</th><th class="date">Modified</th>${interactive ? '<th class="actions"><span class="sr">Actions</span></th>' : ''}</tr></thead>
<tbody>
${parent}
${rows}
</tbody>
</table>` : ''}
${sorted.length ? '' : '<p class="empty">This folder is empty.</p>'}
</div>
<p class="summary">${esc(summary)}</p>
${admin ? '<div class="drop-overlay" hidden><p>Drop to upload here</p></div>' : ''}
${sharing ? shareDialog(shareDays, defaultShareDays) : ''}`,
  });
}

export function errorPage({ siteTitle, status, message, eventId, signedIn, heading, back = true }) {
  return layout({
    title: `${status} · ${siteTitle}`,
    siteTitle,
    signedIn,
    brandHref: back ? '/browse/' : '',
    body: `<div class="card">
  <h1>${esc(heading ?? (status === 404 ? 'Not found' : 'Something went wrong'))}</h1>
  <p>${esc(message)}</p>
  ${eventId ? `<p class="muted">Reference: <code>${esc(eventId)}</code></p>` : ''}
  ${back ? '<p><a href="/browse/">Back to the file list</a></p>' : ''}
</div>`,
  });
}

/** What someone opening a share link sees: the file, and a download button. */
export function sharePage({ siteTitle, name, size, expires, downloadHref }) {
  return layout({
    title: `${name} · ${siteTitle}`,
    siteTitle,
    brandHref: '',
    body: `<div class="card shared">
  <span class="file-glyph" aria-hidden="true"></span>
  <h1>${esc(name)}</h1>
  <p class="muted">${esc(formatSize(size))} · link expires ${esc(expires)}</p>
  <a class="button primary" href="${esc(downloadHref)}" download>Download</a>
</div>`,
  });
}
