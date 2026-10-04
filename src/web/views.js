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
  const units = ['KB', 'MB', 'GB', 'TB'];
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

function layout({ title, body, siteTitle, signedIn = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/static/styles.css">
</head>
<body>
<header class="top">
  <a class="brand" href="/browse/">${esc(siteTitle)}</a>
  ${signedIn ? `<form method="post" action="/logout"><button class="link" type="submit">Sign out</button></form>` : ''}
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

export function listingPage({ siteTitle, rel, entries, formatDate }) {
  const sorted = sortEntries(entries);
  const prefix = rel ? `${rel}/` : '';
  const files = sorted.filter((e) => e.type === 'file');
  const total = files.reduce((sum, e) => sum + (e.size ?? 0), 0);
  const dirCount = sorted.length - files.length;

  const rows = sorted.map((e) => {
    const target = encodePath(prefix + e.name);
    const href = e.type === 'dir' ? `/browse/${target}/` : `/download/${target}`;
    return `<tr class="${e.type}">
  <td class="name"><a href="${esc(href)}"${e.type === 'file' ? ' download' : ''}><span class="icon" aria-hidden="true"></span>${esc(e.name)}${e.type === 'dir' ? '/' : ''}</a></td>
  <td class="size">${e.type === 'file' ? esc(formatSize(e.size)) : ''}</td>
  <td class="date">${e.mtime ? esc(formatDate(e.mtime)) : ''}</td>
</tr>`;
  }).join('\n');

  const summary = [
    dirCount ? `${dirCount} folder${dirCount === 1 ? '' : 's'}` : '',
    `${files.length} file${files.length === 1 ? '' : 's'}`,
    files.length ? formatSize(total) : '',
  ].filter(Boolean).join(' · ');

  const parent = rel
    ? `<tr class="up"><td class="name" colspan="3"><a href="/browse/${encodePath(rel.split('/').slice(0, -1).join('/'))}${rel.includes('/') ? '/' : ''}">..</a></td></tr>`
    : '';

  return layout({
    title: `${rel || 'public'} · ${siteTitle}`,
    siteTitle,
    signedIn: true,
    body: `${breadcrumbs(rel)}
<div class="card">
${sorted.length || rel ? `<table>
<thead><tr><th class="name">Name</th><th class="size">Size</th><th class="date">Modified</th></tr></thead>
<tbody>
${parent}
${rows}
</tbody>
</table>` : ''}
${sorted.length ? '' : '<p class="empty">This folder is empty.</p>'}
</div>
<p class="summary">${esc(summary)}</p>`,
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
