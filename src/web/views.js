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

function layout({ title, body, siteTitle, signedIn = false, admin = false, csrf = '', dir = null }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${csrf ? `<meta name="csrf" content="${esc(csrf)}">` : ''}
<title>${esc(title)}</title>
<link rel="stylesheet" href="${assetUrl('/static/styles.css')}">
${admin ? `<script src="${assetUrl('/static/app.js')}" defer></script>` : ''}
</head>
<body${dir !== null ? ` data-dir="${esc(dir)}"` : ''}>
<header class="top">
  <a class="brand" href="/browse/">${esc(siteTitle)}</a>
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

export function listingPage({
  siteTitle, rel, entries, formatDate, storage = null, admin = false, csrf = '',
}) {
  const sorted = sortEntries(entries);
  const prefix = rel ? `${rel}/` : '';
  const files = sorted.filter((e) => e.type === 'file');
  const total = files.reduce((sum, e) => sum + (e.size ?? 0), 0);
  const dirCount = sorted.length - files.length;
  const cols = admin ? 4 : 3;

  const rows = sorted.map((e) => {
    const target = encodePath(prefix + e.name);
    const href = e.type === 'dir' ? `/browse/${target}/` : `/download/${target}`;
    const actions = admin
      ? `<td class="actions"><button type="button" class="icon-btn rename" data-action="rename" title="Rename"><span class="sr">Rename</span></button><button type="button" class="icon-btn delete" data-action="delete" title="Delete"><span class="sr">Delete</span></button></td>`
      : '';
    return `<tr class="${e.type}"${admin ? ` data-path="${esc(prefix + e.name)}" data-name="${esc(e.name)}" data-type="${e.type}"` : ''}>
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
    dir: admin ? rel : null,
    body: `${storageBar(storage)}
${breadcrumbs(rel)}
${toolbar}
<div class="card">
${sorted.length || rel ? `<table>
<thead><tr><th class="name">Name</th><th class="size">Size</th><th class="date">Modified</th>${admin ? '<th class="actions"><span class="sr">Actions</span></th>' : ''}</tr></thead>
<tbody>
${parent}
${rows}
</tbody>
</table>` : ''}
${sorted.length ? '' : '<p class="empty">This folder is empty.</p>'}
</div>
<p class="summary">${esc(summary)}</p>
${admin ? '<div class="drop-overlay" hidden><p>Drop to upload here</p></div>' : ''}`,
  });
}

export function errorPage({ siteTitle, status, message, eventId, signedIn }) {
  return layout({
    title: `${status} · ${siteTitle}`,
    siteTitle,
    signedIn,
    body: `<div class="card">
  <h1>${status === 404 ? 'Not found' : 'Something went wrong'}</h1>
  <p>${esc(message)}</p>
  ${eventId ? `<p class="muted">Reference: <code>${esc(eventId)}</code></p>` : ''}
  <p><a href="/browse/">Back to the file list</a></p>
</div>`,
  });
}
