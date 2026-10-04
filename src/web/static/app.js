// Admin controls: upload, new folder, rename, delete. Only served to admin
// sessions; every request carries the page's anti-forgery token, and the
// server checks the role again regardless of what this script does.
(() => {
  const csrf = document.querySelector('meta[name="csrf"]')?.content;
  if (!csrf) return;

  const dir = document.body.dataset.dir ?? '';
  const CHUNK = 16 * 1024 * 1024;
  const MAX_RETRIES = 6;
  const uploadsList = document.getElementById('uploads');
  const fileInput = document.getElementById('file-input');
  const overlay = document.querySelector('.drop-overlay');
  let active = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'X-CSRF-Token': csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status, data });
    return data;
  }

  /** PUT one chunk, reporting bytes as they leave so the bar moves smoothly. */
  function putChunk(id, offset, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/admin/uploads/${id}?offset=${offset}`);
      xhr.setRequestHeader('X-CSRF-Token', csrf);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.responseType = 'json';
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => resolve({ status: xhr.status, data: xhr.response ?? {} });
      xhr.onerror = () => reject(new Error('network error'));
      xhr.ontimeout = () => reject(new Error('timed out'));
      xhr.send(blob);
    });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let n = bytes / 1024;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
  }

  function row(file) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'up-name';
    name.textContent = file.name;
    const bar = document.createElement('progress');
    bar.max = Math.max(file.size, 1);
    bar.value = 0;
    const state = document.createElement('span');
    state.className = 'up-state';
    state.textContent = 'Waiting';
    li.append(name, bar, state);
    uploadsList.hidden = false;
    uploadsList.append(li);
    return {
      progress(sent) {
        bar.value = sent;
        state.textContent = `${formatSize(sent)} of ${formatSize(file.size)}`;
      },
      done(text) { bar.value = bar.max; state.textContent = text; li.classList.add('ok'); },
      failed(text) { state.textContent = text; li.classList.add('failed'); },
    };
  }

  async function uploadOne(file, ui) {
    const { id } = await api('POST', '/admin/uploads', { dir, name: file.name, size: file.size });
    let offset = 0;
    let failures = 0;
    try {
      while (offset < file.size) {
        const end = Math.min(offset + CHUNK, file.size);
        try {
          const { status, data } = await putChunk(id, offset, file.slice(offset, end), (n) => ui.progress(offset + n));
          if (status === 200) {
            offset = data.received;
            failures = 0;
            continue;
          }
          // 409 tells us where the server actually is; other errors may too.
          if (typeof data.received === 'number' && (status === 409 || status >= 500) && failures < MAX_RETRIES) {
            offset = data.received;
            failures += 1;
            await sleep(1000 * failures);
            continue;
          }
          throw new Error(data.error || `HTTP ${status}`);
        } catch (err) {
          if (failures >= MAX_RETRIES || err.message.startsWith('HTTP') || !/network|timed out/.test(err.message)) throw err;
          // The connection dropped mid-chunk: ask how far it got and resume.
          failures += 1;
          await sleep(1500 * failures);
          offset = (await api('GET', `/admin/uploads/${id}`)).received;
        }
        ui.progress(offset);
      }
      const { name } = await api('POST', `/admin/uploads/${id}/complete`);
      ui.done(name === file.name ? 'Done' : `Saved as ${name}`);
    } catch (err) {
      api('DELETE', `/admin/uploads/${id}`).catch(() => {});
      throw err;
    }
  }

  async function uploadAll(files) {
    if (!files.length) return;
    active += 1;
    let failed = 0;
    // One file at a time: the SFTP server and a home uplink both do better
    // with a single stream than with many competing ones.
    for (const file of files) {
      const ui = row(file);
      try {
        await uploadOne(file, ui);
      } catch (err) {
        failed += 1;
        ui.failed(`Failed: ${err.message}`);
      }
    }
    active -= 1;
    if (!active && !failed) location.reload();
  }

  window.addEventListener('beforeunload', (e) => {
    if (active) e.preventDefault();
  });

  fileInput.addEventListener('change', () => {
    uploadAll([...fileInput.files]);
    fileInput.value = '';
  });

  // Drag and drop anywhere on the page.
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth += 1;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    // Folders dropped in show up as zero-byte entries with no type; skip them.
    const files = [...e.dataTransfer.files].filter((f) => f.size > 0 || f.type);
    uploadAll(files);
  });

  document.addEventListener('click', async (e) => {
    const button = e.target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const tr = button.closest('tr');

    try {
      if (action === 'upload') {
        fileInput.click();
      } else if (action === 'mkdir') {
        const name = prompt('Name of the new folder:', 'New folder');
        if (!name) return;
        const made = await api('POST', '/admin/folders', { dir, name: name.trim() });
        location.href = `${location.pathname.replace(/\/?$/, '/')}${encodeURIComponent(made.name)}/`;
      } else if (action === 'rename') {
        const name = prompt('New name:', tr.dataset.name);
        if (!name || name === tr.dataset.name) return;
        await api('POST', '/admin/rename', { path: tr.dataset.path, name: name.trim() });
        location.reload();
      } else if (action === 'delete') {
        const what = tr.dataset.type === 'dir'
          ? `the folder "${tr.dataset.name}" and everything in it`
          : `"${tr.dataset.name}"`;
        if (!confirm(`Delete ${what}? This cannot be undone.`)) return;
        button.disabled = true;
        await api('POST', '/admin/delete', { path: tr.dataset.path });
        location.reload();
      }
    } catch (err) {
      button.disabled = false;
      alert(err.status === 403 && /token/.test(err.message)
        ? 'Your admin session has expired. Sign in again.'
        : err.message);
    }
  });
})();
