async function createShareLink(file) {
  const statusEl = document.getElementById('share-upload-status');
  const filenameEl = document.getElementById('share-upload-filename');
  const linkBox = document.getElementById('share-link-box');
  const linkInput = document.getElementById('share-link-input');
  
  linkBox.classList.add('hidden');
  filenameEl.textContent = file.name;
  filenameEl.style.display = 'block';
  statusEl.textContent = 'Encrypting...';
  state.activeShareId = null;

  try {
    const key = await generateKey();
    const keyB64 = await exportKey(key);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await file.arrayBuffer());
    statusEl.textContent = 'Uploading...';
    const res = await fetch('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: toB64(encrypted),
        iv: toB64(iv),
        mime: file.type || 'application/octet-stream',
        filename: file.name,
        size: String(file.size),
      }),
    });
    if (!res.ok) {
      let errMsg = 'Server error';
      try {
        const errJson = await res.json();
        errMsg = errJson.error || errMsg;
      } catch {
        errMsg = res.statusText || errMsg;
      }
      throw new Error(errMsg);
    }
    const { id } = await res.json();
    state.activeShareId = id;

    const url = `${location.origin}/share/${id}#key=${encodeURIComponent(keyB64)}`;
    linkInput.value = url;
    statusEl.textContent = 'Link ready — one-time use, expires in 24h';
    linkBox.classList.remove('hidden');
    document.getElementById('btn-share-close').textContent = 'Done';

    filenameEl.style.display = 'none';
    const renameSection = document.getElementById('share-rename-section');
    const renameInput = document.getElementById('share-rename-input');
    const renameStatus = document.getElementById('share-rename-status');
    renameStatus.textContent = '';
    renameSection.classList.remove('hidden');
    renameInput.value = file.name;
  } catch (err) {
    statusEl.textContent = 'Failed: ' + err.message;
    document.getElementById('btn-share-close').textContent = 'Close';
  }
}

document.getElementById('btn-create-share').addEventListener('click', () => {
  document.getElementById('share-file-input').value = '';
  document.getElementById('share-folder-input').value = '';
  document.getElementById('share-link-box').classList.add('hidden');
  
  document.getElementById('share-rename-section').classList.add('hidden');
  document.getElementById('share-rename-status').textContent = '';
  state.activeShareId = null;
  
  document.getElementById('share-drop-zone-container').style.display = 'block';
  document.getElementById('share-upload-progress-container').style.display = 'none';
  document.getElementById('btn-share-close').textContent = 'Cancel';
  
  document.getElementById('share-create-overlay').classList.remove('hidden');
});

const shareDropZone = document.getElementById('share-drop-zone');
const shareFileInput = document.getElementById('share-file-input');
const shareFolderInput = document.getElementById('share-folder-input');

shareDropZone.addEventListener('click', (e) => {
  if (e.target.closest('.browse-link')) return;
  shareFileInput.click();
});

document.getElementById('btn-share-browse-folder').addEventListener('click', (e) => {
  e.stopPropagation();
  shareFolderInput.click();
});

shareDropZone.addEventListener('dragover', e => {
  e.preventDefault();
  shareDropZone.classList.add('dragging');
});

shareDropZone.addEventListener('dragleave', () => {
  shareDropZone.classList.remove('dragging');
});

shareDropZone.addEventListener('drop', async e => {
  e.preventDefault();
  shareDropZone.classList.remove('dragging');
  
  const items = Array.from(e.dataTransfer.items || []);
  if (items.length) {
    const item = items[0];
    if (item.kind === 'file') {
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry && entry.isDirectory) {
        const statusEl = document.getElementById('share-upload-status');
        document.getElementById('share-drop-zone-container').style.display = 'none';
        document.getElementById('share-upload-progress-container').style.display = 'block';
        document.getElementById('share-upload-filename').textContent = entry.name + '.zip';
        statusEl.textContent = 'Zipping folder...';
        
        try {
          const zipFile = await zipFolder(entry);
          if (!zipFile) throw new Error('Empty folder');
          if (zipFile.size > 5 * 1024 * 1024) throw new Error('File exceeds 5 MB limit for share links');
          createShareLink(zipFile);
        } catch (err) {
          statusEl.textContent = 'Failed: ' + err.message;
          document.getElementById('btn-share-close').textContent = 'Close';
        }
      } else {
        const file = item.getAsFile();
        if (file) handleShareSelection(file);
      }
    }
  }
});

shareFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleShareSelection(file);
  e.target.value = '';
});

shareFolderInput.addEventListener('change', async () => {
  if (shareFolderInput.files.length) {
    const statusEl = document.getElementById('share-upload-status');
    document.getElementById('share-drop-zone-container').style.display = 'none';
    document.getElementById('share-upload-progress-container').style.display = 'block';
    
    const firstFile = shareFolderInput.files[0];
    let folderName = 'folder';
    if (firstFile && firstFile.webkitRelativePath) {
      folderName = firstFile.webkitRelativePath.split('/')[0];
    }
    
    document.getElementById('share-upload-filename').textContent = folderName + '.zip';
    statusEl.textContent = 'Zipping folder...';
    
    try {
      const filesToQueue = await processSelectedFiles(shareFolderInput.files);
      if (!filesToQueue.length) throw new Error('Empty folder');
      const zipFile = filesToQueue[0];
      if (zipFile.size > 5 * 1024 * 1024) throw new Error('File exceeds 5 MB limit for share links');
      createShareLink(zipFile);
    } catch (err) {
      statusEl.textContent = 'Failed: ' + err.message;
      document.getElementById('btn-share-close').textContent = 'Close';
    }
  }
  shareFolderInput.value = '';
});

function handleShareSelection(file) {
  const MAX = 5 * 1024 * 1024;
  if (file.size > MAX) {
    alert('Share links are limited to 5 MB. Use a room for larger files.');
    return;
  }
  document.getElementById('share-drop-zone-container').style.display = 'none';
  document.getElementById('share-upload-progress-container').style.display = 'block';
  document.getElementById('share-upload-filename').textContent = file.name;
  
  createShareLink(file);
}

document.getElementById('btn-copy-share').addEventListener('click', () => {
  const input = document.getElementById('share-link-input');
  navigator.clipboard.writeText(input.value).then(() => {
    document.getElementById('btn-copy-share').textContent = 'Copied!';
    setTimeout(() => { document.getElementById('btn-copy-share').textContent = 'Copy'; }, 2000);
  });
});

document.getElementById('btn-share-close').addEventListener('click', () => {
  document.getElementById('share-create-overlay').classList.add('hidden');
  state.activeShareId = null;
});
document.getElementById('btn-share-home').addEventListener('click', () => {
  history.pushState({}, '', '/');
  showView('home');
});

document.getElementById('btn-share-rename').addEventListener('click', async () => {
  const id = state.activeShareId;
  if (!id) return;
  
  const renameInput = document.getElementById('share-rename-input');
  const renameBtn = document.getElementById('btn-share-rename');
  const renameStatus = document.getElementById('share-rename-status');
  const newName = renameInput.value.trim();
  
  if (!newName) {
    renameStatus.textContent = 'Name cannot be empty';
    renameStatus.style.color = '#ff9592';
    return;
  }
  
  renameBtn.disabled = true;
  renameStatus.textContent = 'Updating filename...';
  renameStatus.style.color = 'var(--muted)';
  
  try {
    const res = await fetch(`/api/share/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: newName })
    });
    if (!res.ok) throw new Error();
    renameStatus.textContent = 'Name updated successfully!';
    renameStatus.style.color = '#3dd68c';
  } catch {
    renameStatus.textContent = 'Failed to update name';
    renameStatus.style.color = '#ff9592';
  } finally {
    renameBtn.disabled = false;
  }
});

function shareError(msg) {
  const nameEl = document.getElementById('share-receive-name');
  const metaEl = document.getElementById('share-receive-meta');
  const note = document.getElementById('share-receive-note');
  const iconWrapper = document.getElementById('share-icon-wrapper');
  
  nameEl.textContent = 'Link Invalid';
  metaEl.textContent = '';
  
  note.textContent = msg;
  note.style.display = 'block';
  note.className = 'share-receive-note';
  
  iconWrapper.className = 'share-icon-wrapper error';
  iconWrapper.innerHTML = `
    <svg class="share-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="8" x2="12" y2="12"></line>
      <line x1="12" y1="16" x2="12.01" y2="16"></line>
    </svg>
  `;
  
  document.getElementById('btn-share-download').style.display = 'none';
  document.getElementById('btn-share-home').style.display = 'block';
}

async function receiveShareLink(id, keyB64) {
  showView('share');
  history.replaceState({}, '', location.pathname);
  const nameEl = document.getElementById('share-receive-name');
  const metaEl = document.getElementById('share-receive-meta');
  const note = document.getElementById('share-receive-note');
  const btn = document.getElementById('btn-share-download');
  const homeBtn = document.getElementById('btn-share-home');
  const iconWrapper = document.getElementById('share-icon-wrapper');

  nameEl.textContent = 'Fetching file details...';
  metaEl.textContent = '';
  note.textContent = '';
  note.style.display = 'none';
  btn.style.display = 'none';
  homeBtn.style.display = 'none';
  
  iconWrapper.className = 'share-icon-wrapper loading';
  iconWrapper.innerHTML = `
    <svg class="share-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="2" x2="12" y2="6"></line>
      <line x1="12" y1="18" x2="12" y2="22"></line>
      <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
      <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
      <line x1="2" y1="12" x2="6" y2="12"></line>
      <line x1="18" y1="12" x2="22" y2="12"></line>
      <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
      <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
    </svg>
  `;

  let payload;
  try {
    let res;
    try {
      res = await fetch(`/api/share/${id}`);
    } catch {
      shareError('Could not reach server — check your connection');
      return;
    }
    if (res.status === 404) { shareError('Link not found or already expired/used'); return; }
    if (!res.ok) {
      let errMsg = 'Server error';
      try {
        const errJson = await res.json();
        errMsg = errJson.error || errMsg;
      } catch {
        errMsg = res.statusText || errMsg;
      }
      shareError(errMsg);
      return;
    }
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) { shareError('Unexpected server response'); return; }
    payload = await res.json();
    if (!payload?.data || !payload?.iv) { shareError('Corrupt or incomplete link'); return; }
  } catch {
    shareError('Failed to load share link');
    return;
  }

  nameEl.textContent = payload.filename || 'file';
  metaEl.textContent = payload.size ? fmtSize(payload.size) + ' · AES-256-GCM' : 'AES-256-GCM encrypted';
  
  note.textContent = 'This link is single-use and will self-destruct once downloaded.';
  note.className = 'share-receive-note info-note';
  note.style.display = 'block';
  
  iconWrapper.className = 'share-icon-wrapper success';
  iconWrapper.innerHTML = `
    <svg class="share-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
      <line x1="12" y1="18" x2="12" y2="12"></line>
      <polyline points="9 15 12 18 15 15"></polyline>
    </svg>
  `;

  btn.style.display = 'block';
  btn.textContent = 'Download File';
  btn.disabled = false;
  homeBtn.style.display = 'block';

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Decrypting...';
    
    iconWrapper.className = 'share-icon-wrapper loading';
    iconWrapper.innerHTML = `
      <svg class="share-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="2" x2="12" y2="6"></line>
        <line x1="12" y1="18" x2="12" y2="22"></line>
        <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
        <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
        <line x1="2" y1="12" x2="6" y2="12"></line>
        <line x1="18" y1="12" x2="22" y2="12"></line>
        <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
        <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
      </svg>
    `;

    let key;
    try {
      key = await importKey(keyB64);
    } catch {
      btn.textContent = 'Bad key — check full link';
      btn.disabled = false;
      iconWrapper.className = 'share-icon-wrapper error';
      iconWrapper.innerHTML = `
        <svg class="share-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
      `;
      return;
    }
    let decrypted;
    try {
      decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(fromB64(payload.iv)) }, key, fromB64(payload.data));
    } catch {
      btn.textContent = 'Decryption failed';
      btn.disabled = false;
      iconWrapper.className = 'share-icon-wrapper error';
      iconWrapper.innerHTML = `
        <svg class="share-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
      `;
      return;
    }
    try {
      const blob = new Blob([decrypted], { type: payload.mime });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = payload.filename || 'file';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 3000);
      
      btn.textContent = 'Downloaded';
      note.style.display = 'none';
      
      iconWrapper.className = 'share-icon-wrapper success';
      iconWrapper.innerHTML = `
        <svg class="share-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
      `;
    } catch {
      btn.textContent = 'Download failed — try again';
      btn.disabled = false;
      iconWrapper.className = 'share-icon-wrapper error';
      iconWrapper.innerHTML = `
        <svg class="share-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
      `;
    }
  }, { once: true });
}
