function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function getDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'Device';
}

function toB64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

async function generateKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
async function exportKey(key) {
  return toB64(await crypto.subtle.exportKey('raw', key));
}
async function importKey(b64) {
  return crypto.subtle.importKey('raw', fromB64(b64), { name: 'AES-GCM' }, false, ['decrypt']);
}
async function encryptChunk(key, buffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
  return { iv: toB64(iv), data: toB64(encrypted) };
}
async function decryptChunk(key, ivB64, dataB64) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(ivB64) }, key, fromB64(dataB64));
}

const CHUNK_SIZE = 49152;
const SAVED_NICKNAME_KEY = 'drop-nickname';

function fmtSpeed(bps) {
  if (bps < 1024) return bps.toFixed(0) + ' B/s';
  if (bps < 1048576) return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / 1048576).toFixed(1) + ' MB/s';
}
function fmtETA(secs) {
  if (secs < 60) return Math.ceil(secs) + 's';
  return Math.floor(secs / 60) + 'm ' + Math.ceil(secs % 60) + 's';
}
function isCompressible(mimeType, size) {
  if (size > 50 * 1024 * 1024) return false;
  const t = mimeType || '';
  if (t.startsWith('image/') || t.startsWith('video/') || t.startsWith('audio/')) return false;
  if (/zip|rar|7z|gz|bz2|xz|zst|br|lzma/.test(t)) return false;
  return true;
}
async function compressBuffer(buffer) {
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter();
  await w.write(new Uint8Array(buffer));
  await w.close();
  return new Response(cs.readable).arrayBuffer();
}
async function decompressBuffer(buffer) {
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter();
  await w.write(new Uint8Array(buffer));
  await w.close();
  return new Response(ds.readable).arrayBuffer();
}

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '');
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}
function bytesToUuid(b) {
  const h = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
async function encryptChunkRaw(key, buffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
  return { iv, data };
}

function sendBinaryChunk(toPeerId, fileId, index, total, iv, ciphertext, compressed, meta) {
  const metaBytes = meta ? new TextEncoder().encode(JSON.stringify(meta)) : null;
  const flags = (compressed ? 1 : 0) | (meta ? 2 : 0);
  const headerSize = 53 + (metaBytes ? 2 + metaBytes.length : 0);
  const frame = new Uint8Array(headerSize + ciphertext.byteLength);
  const dv = new DataView(frame.buffer);
  let o = 0;
  frame.set(uuidToBytes(toPeerId), o); o += 16;
  frame.set(uuidToBytes(fileId), o); o += 16;
  dv.setUint32(o, index, false); o += 4;
  dv.setUint32(o, total, false); o += 4;
  frame[o] = flags; o += 1;
  frame.set(iv, o); o += 12;
  if (metaBytes) { dv.setUint16(o, metaBytes.length, false); o += 2; frame.set(metaBytes, o); o += metaBytes.length; }
  frame.set(new Uint8Array(ciphertext), o);
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(frame.buffer);
}

async function handleBinaryMessage(buffer) {
  if (buffer.byteLength < 53) return;
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const from = bytesToUuid(bytes.slice(0, 16));
  const fileId = bytesToUuid(bytes.slice(16, 32));
  const index = dv.getUint32(32, false);
  const total = dv.getUint32(36, false);
  const flags = bytes[40];
  const compressed = !!(flags & 1);
  const isFirst = !!(flags & 2);
  const iv = bytes.slice(41, 53);
  let o = 53, meta = null;
  if (isFirst) {
    const metaLen = dv.getUint16(53, false); o = 55 + metaLen;
    meta = JSON.parse(new TextDecoder().decode(bytes.slice(55, o)));
  }
  const ciphertext = buffer.slice(o);
  if (!state.decryptKeys[fileId]) return;
  if (isFirst && !state.recvState[fileId]) {
    state.recvState[fileId] = { name: meta.filename, size: meta.size, mimeType: meta.mimeType, compressed, chunks: [], received: 0, total };
    addTransferItem(fileId, meta.filename, meta.size, 'recv', state.peers[from]?.name ?? from);
  }
  const recv = state.recvState[fileId];
  if (!recv) return;
  try {
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, state.decryptKeys[fileId], ciphertext);
    recv.chunks[index] = decrypted;
    recv.received++;
    updateProgress(fileId, Math.min(99, (recv.received / total) * 100), 'Receiving...');
    if (recv.received >= total) {
      let blob;
      if (recv.compressed) {
        const combined = await new Blob(recv.chunks.map(c => new Uint8Array(c))).arrayBuffer();
        blob = new Blob([await decompressBuffer(combined)], { type: recv.mimeType });
      } else {
        blob = new Blob(recv.chunks.map(c => new Uint8Array(c)), { type: recv.mimeType });
      }
      markTransferReceived(fileId, recv.name, URL.createObjectURL(blob), recv.mimeType);
      delete state.recvState[fileId];
      delete state.decryptKeys[fileId];
    }
  } catch {
    markTransferStatus(fileId, 'Decryption failed', 'transfer-error');
  }
}

const state = {
  roomCode: null,
  myId: null,
  myName: getDeviceName(),
  isCreator: false,
  ws: null,
  reconnecting: false,
  peers: {},
  requestQueue: [],
  activeRequest: null,
  decryptKeys: {},
  recvState: {},
  fileBatch: {},
  batchRecvState: {},
  sendQueue: [],
  lobby: null,
  lobbyId: null,
  mySubnet: null,
  lobbyPeers: {},
  pendingLobbyConnect: null,
  pendingShareFiles: null,
  cancelledTransfers: new Set(),
};

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + id).classList.add('active');
  document.getElementById('back-btn').classList.toggle('hidden', id === 'home' || id === 'share');
}

function showRoomError(msg) {
  document.getElementById('peers-list').innerHTML = `<div class="room-error">${msg}</div>`;
  setDropEnabled(false);
}

let connectedResolve = null;
let connectedPromise = null;

function waitConnected() {
  if (state.ws?.readyState === WebSocket.OPEN && !state.reconnecting) return Promise.resolve();
  if (!connectedPromise) connectedPromise = new Promise(r => { connectedResolve = r; });
  return connectedPromise;
}

function resolveConnected() {
  if (connectedResolve) { connectedResolve(); connectedResolve = null; connectedPromise = null; }
}

function connect(code) {
  if (state.ws) { state.ws.onclose = null; state.ws.onerror = null; state.ws.close(); }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${proto}//${location.host}/ws/${code}?name=${encodeURIComponent(state.myName)}`);
  state.ws.binaryType = 'arraybuffer';
  state.ws.onmessage = async (e) => {
    if (e.data instanceof ArrayBuffer) handleBinaryMessage(e.data);
    else handleMessage(JSON.parse(e.data));
  };
  state.ws.onerror = () => {};
  state.ws.onclose = (e) => {
    if (e.code === 1000) return;
    state.reconnecting = true;
    renderPeers();
    if (state.roomCode && document.visibilityState === 'visible') connect(state.roomCode);
  };
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.roomCode && state.reconnecting) {
    const ws = state.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      connect(state.roomCode);
    }
  }
});

function send(obj) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

async function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      state.myId = msg.peerId;
      state.reconnecting = false;
      resolveConnected();
      Object.keys(state.peers).forEach(id => delete state.peers[id]);
      msg.peers.forEach(p => addPeer(p.id, p.name));
      if (!state.isCreator && msg.peers.length === 0)
        showRoomError('Room is empty — make sure the other device created the room first.');
      break;
    case 'peer-joined': addPeer(msg.peerId, msg.name); break;
    case 'peer-left': removePeer(msg.peerId); break;
    case 'transfer-request': showIncomingRequest(msg); break;
    case 'batch-request': showIncomingRequest(msg); break;
    case 'transfer-accept': startSendingFile(msg.from, msg.fileId); break;
    case 'batch-accept': startSendingBatch(msg.from, msg.batchId); break;
    case 'transfer-decline': markTransferStatus(msg.fileId, 'Declined', 'transfer-error'); break;
    case 'batch-decline':
      state.sendQueue.filter(e => e.batchId === msg.batchId).forEach(e => markTransferStatus(e.fileId, 'Declined', 'transfer-error'));
      break;
    case 'chunk': break;
    case 'transfer-error': markTransferStatus(msg.fileId, 'Transfer failed', 'transfer-error'); break;
    case 'transfer-cancel':
      delete state.decryptKeys[msg.fileId];
      delete state.recvState[msg.fileId];
      delete state.fileBatch[msg.fileId];
      markTransferStatus(msg.fileId, 'Cancelled', '');
      break;
    case 'text': await receiveText(msg); break;
  }
}

const noPeersEl = document.getElementById('no-peers');
const noLobbyPeersEl = document.getElementById('no-lobby-peers');

function addPeer(id, name) {
  state.peers[id] = { name };
  renderPeers();
  if (state.pendingShareFiles?.length && Object.keys(state.peers).length === 1) {
    const files = state.pendingShareFiles;
    state.pendingShareFiles = null;
    document.getElementById('share-banner')?.remove();
    queueFiles(files);
  }
}

function removePeer(id) {
  state.sendQueue.forEach(entry => {
    if (entry.pendingTargets.has(id)) {
      markTransferStatus(entry.fileId, 'Connection lost', 'transfer-error');
      entry.pendingTargets.delete(id);
    }
  });
  delete state.peers[id];
  renderPeers();
}

function cancelPendingTransfers() {
  state.sendQueue.forEach(entry => {
    if (entry.pendingTargets.size > 0) {
      markTransferStatus(entry.fileId, 'Connection lost', 'transfer-error');
      entry.pendingTargets.clear();
    }
  });
  state.requestQueue = [];
  state.activeRequest = null;
  document.getElementById('overlay').classList.add('hidden');
}

function renderPeers() {
  const list = document.getElementById('peers-list');
  const ids = Object.keys(state.peers);
  list.innerHTML = '';
  if (ids.length === 0) {
    if (state.reconnecting) {
      const el = document.createElement('div');
      el.className = 'no-peers';
      el.textContent = 'Reconnecting...';
      list.appendChild(el);
    } else {
      list.appendChild(noPeersEl);
    }
    setDropEnabled(false);
    return;
  }
  ids.forEach(id => {
    const el = document.createElement('div');
    el.className = 'peer-card';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'peer-name';
    nameSpan.textContent = state.peers[id].name;
    const statusSpan = document.createElement('span');
    if (state.reconnecting) {
      statusSpan.className = 'peer-status reconnecting-status';
      statusSpan.textContent = 'Reconnecting...';
    } else {
      statusSpan.className = 'peer-status';
      const dot = document.createElement('span');
      dot.className = 'dot';
      statusSpan.appendChild(dot);
      statusSpan.append(' Connected');
    }
    el.appendChild(nameSpan);
    el.appendChild(statusSpan);
    list.appendChild(el);
  });
  setDropEnabled(!state.reconnecting);
}

function setDropEnabled(enabled) {
  const dz = document.getElementById('drop-zone');
  dz.classList.toggle('disabled', !enabled);
  dz.classList.toggle('has-peers', enabled);
  document.getElementById('drop-sub').textContent = enabled ? 'or click to browse' : 'Connect a device first';
  document.getElementById('text-send-bar').classList.toggle('disabled', !enabled);
}

function addTransferItem(fileId, filename, size, direction, peerName) {
  const el = document.createElement('div');
  el.className = 'transfer-item';
  el.id = 'transfer-' + fileId;

  const header = document.createElement('div');
  header.className = 'transfer-header';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'transfer-name';
  nameSpan.textContent = filename;
  const headerRight = document.createElement('span');
  headerRight.className = 'transfer-header-right';
  const sizeSpan = document.createElement('span');
  sizeSpan.className = 'transfer-size';
  sizeSpan.textContent = fmtSize(size);
  headerRight.appendChild(sizeSpan);
  if (direction === 'send') {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-cancel-xfer';
    cancelBtn.title = 'Cancel';
    cancelBtn.textContent = '✕';
    cancelBtn.addEventListener('click', () => {
      state.cancelledTransfers.add(fileId);
      cancelBtn.remove();
      markTransferStatus(fileId, 'Cancelling...', '');
    });
    headerRight.appendChild(cancelBtn);
  }
  header.appendChild(nameSpan);
  header.appendChild(headerRight);

  const peerDiv = document.createElement('div');
  peerDiv.className = 'transfer-peer';
  peerDiv.textContent = (direction === 'send' ? 'Sending to ' : 'From ') + peerName;

  const progressBar = document.createElement('div');
  progressBar.className = 'progress-bar';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = '0%';
  progressBar.appendChild(fill);

  const footer = document.createElement('div');
  footer.className = 'transfer-footer';
  const statusSpan = document.createElement('span');
  statusSpan.className = 'status-text';
  statusSpan.textContent = direction === 'send' ? 'Waiting for acceptance...' : 'Receiving...';
  const pctSpan = document.createElement('span');
  pctSpan.className = 'pct-text';
  footer.appendChild(statusSpan);
  footer.appendChild(pctSpan);

  el.appendChild(header);
  el.appendChild(peerDiv);
  el.appendChild(progressBar);
  el.appendChild(footer);
  document.getElementById('transfers').prepend(el);
}

function updateProgress(fileId, pct, statusText) {
  const el = document.getElementById('transfer-' + fileId);
  if (!el) return;
  el.querySelector('.progress-fill').style.width = pct + '%';
  if (statusText) el.querySelector('.status-text').textContent = statusText;
  el.querySelector('.pct-text').textContent = pct < 100 ? Math.round(pct) + '%' : '';
}

function markTransferStatus(fileId, label, cls) {
  const el = document.getElementById('transfer-' + fileId);
  if (!el) return;
  const s = el.querySelector('.status-text');
  s.className = 'status-text ' + (cls || '');
  s.textContent = label;
  el.querySelector('.pct-text').textContent = '';
}

function markTransferReceived(fileId, filename, blobUrl, mimeType) {
  const el = document.getElementById('transfer-' + fileId);
  if (!el) return;
  el.querySelector('.progress-fill').style.width = '100%';
  const isImage = mimeType?.startsWith('image/');
  if (isImage) {
    const thumb = document.createElement('img');
    thumb.className = 'transfer-thumb';
    thumb.src = blobUrl;
    thumb.alt = filename;
    el.querySelector('.progress-bar').after(thumb);
  }
  const footer = el.querySelector('.transfer-footer');
  footer.innerHTML = '';
  const readySpan = document.createElement('span');
  readySpan.className = 'status-text transfer-done';
  readySpan.textContent = 'Ready';
  const saveLink = document.createElement('a');
  saveLink.className = 'download-btn';
  saveLink.href = blobUrl;
  saveLink.download = filename;
  saveLink.textContent = 'Save';
  if (!isImage) saveLink.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(blobUrl), 1000));
  footer.appendChild(readySpan);
  footer.appendChild(saveLink);

  const batchId = state.fileBatch[fileId];
  if (batchId && state.batchRecvState[batchId]) {
    const bs = state.batchRecvState[batchId];
    bs.blobs.push({ filename, blobUrl });
    if (bs.blobs.length >= bs.total) {
      const blobs = bs.blobs.slice();
      delete state.batchRecvState[batchId];
      const wrap = document.createElement('div');
      wrap.className = 'transfer-item batch-done';
      wrap.innerHTML = `<div class="transfer-header"><span class="transfer-name">${blobs.length} files ready</span></div><div class="transfer-footer"><span class="status-text transfer-done">All received</span><button class="download-btn" id="save-all-${batchId}">Save all</button></div>`;
      wrap.querySelector('.download-btn').addEventListener('click', () => {
        blobs.forEach((b, i) => setTimeout(() => {
          const a = document.createElement('a');
          a.href = b.blobUrl; a.download = b.filename; a.click();
          setTimeout(() => URL.revokeObjectURL(b.blobUrl), 1000);
        }, i * 400));
      });
      document.getElementById('transfers').prepend(wrap);
    }
  }
  delete state.fileBatch[fileId];
}

async function queueFiles(files) {
  if (state.roomCode && state.reconnecting) await waitConnected();
  const peerIds = Object.keys(state.peers);
  if (!peerIds.length) {
    const sub = document.getElementById('drop-sub');
    sub.textContent = 'No devices connected — reconnect first';
    sub.style.color = 'var(--danger)';
    setTimeout(() => { sub.textContent = 'Connect a device first'; sub.style.color = ''; }, 2500);
    return;
  }

  if (files.length === 1) {
    const file = files[0];
    const fileId = crypto.randomUUID();
    const key = await generateKey();
    const keyB64 = await exportKey(key);
    state.sendQueue.push({ file, fileId, key, pendingTargets: new Set(peerIds) });
    peerIds.forEach(peerId => {
      send({ type: 'transfer-request', to: peerId, fileId, filename: file.name, size: file.size, mimeType: file.type || 'application/octet-stream', key: keyB64 });
      addTransferItem(fileId, file.name, file.size, 'send', state.peers[peerId]?.name ?? peerId);
    });
    return;
  }

  const batchId = crypto.randomUUID();
  const batchEntries = [];
  for (const file of files) {
    const fileId = crypto.randomUUID();
    const key = await generateKey();
    const keyB64 = await exportKey(key);
    state.sendQueue.push({ file, fileId, key, batchId, pendingTargets: new Set(peerIds) });
    batchEntries.push({ fileId, filename: file.name, size: file.size, mimeType: file.type || 'application/octet-stream', key: keyB64 });
  }
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  peerIds.forEach(peerId => {
    send({ type: 'batch-request', to: peerId, batchId, files: batchEntries, count: files.length, totalSize });
    batchEntries.forEach(e => addTransferItem(e.fileId, e.filename, e.size, 'send', state.peers[peerId]?.name ?? peerId));
  });
}

async function startSendingBatch(fromPeerId, batchId) {
  const entries = state.sendQueue.filter(e => e.batchId === batchId && e.pendingTargets.has(fromPeerId));
  for (const entry of entries) {
    await startSendingFile(fromPeerId, entry.fileId);
  }
}

async function startSendingFile(fromPeerId, fileId) {
  const entry = state.sendQueue.find(e => e.fileId === fileId);
  if (!entry) return;
  entry.pendingTargets.delete(fromPeerId);
  updateProgress(fileId, 0, 'Sending...');

  const { file, key } = entry;
  const mimeType = file.type || 'application/octet-stream';

  let srcBuf = null;
  let compressed = false;
  if (isCompressible(mimeType, file.size)) {
    try { srcBuf = await compressBuffer(await file.arrayBuffer()); compressed = true; } catch {}
  }

  const totalBytes = srcBuf ? srcBuf.byteLength : file.size;
  const total = Math.ceil(totalBytes / CHUNK_SIZE);
  let offset = 0, index = 0;
  const startTime = Date.now();

  try {
    while (offset < totalBytes) {
      if (state.cancelledTransfers.has(fileId)) {
        state.cancelledTransfers.delete(fileId);
        send({ type: 'transfer-cancel', to: fromPeerId, fileId });
        markTransferStatus(fileId, 'Cancelled', '');
        return;
      }
      const buffer = srcBuf ? srcBuf.slice(offset, offset + CHUNK_SIZE)
                            : await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      const { iv, data } = await encryptChunkRaw(key, buffer);
      const meta = index === 0 ? { filename: file.name, size: file.size, mimeType } : null;
      sendBinaryChunk(fromPeerId, fileId, index, total, iv, data, compressed, meta);
      offset += buffer.byteLength;
      index++;
      const elapsed = (Date.now() - startTime) / 1000 || 0.001;
      const speed = offset / elapsed;
      const eta = (totalBytes - offset) / speed;
      updateProgress(fileId, Math.min(99, (offset / totalBytes) * 100),
        fmtSpeed(speed) + (eta > 1 ? ` · ${fmtETA(eta)}` : ''));
      await new Promise(r => setTimeout(r, 0));
    }
    send({ type: 'transfer-complete', to: fromPeerId, fileId });
    markTransferStatus(fileId, 'Sent', 'transfer-done');
  } catch {
    send({ type: 'transfer-error', to: fromPeerId, fileId });
    markTransferStatus(fileId, 'Failed to send', 'transfer-error');
  }
}

async function receiveChunk(msg) {
  const { fileId, index, total, iv, data, filename, size, mimeType, compressed, from } = msg;
  if (!state.decryptKeys[fileId]) return;

  if (!state.recvState[fileId]) {
    state.recvState[fileId] = { name: filename, size, mimeType, compressed: !!compressed, chunks: [], received: 0, total };
    addTransferItem(fileId, filename, size, 'recv', state.peers[from]?.name ?? from);
  }

  try {
    const decrypted = await decryptChunk(state.decryptKeys[fileId], iv, data);
    const recv = state.recvState[fileId];
    recv.chunks[index] = decrypted;
    recv.received++;
    updateProgress(fileId, Math.min(99, (recv.received / total) * 100), 'Receiving...');
    if (recv.received >= total) {
      let blob;
      if (recv.compressed) {
        const combined = await new Blob(recv.chunks).arrayBuffer();
        blob = new Blob([await decompressBuffer(combined)], { type: recv.mimeType });
      } else {
        blob = new Blob(recv.chunks, { type: recv.mimeType });
      }
      markTransferReceived(fileId, recv.name, URL.createObjectURL(blob), recv.mimeType);
      delete state.recvState[fileId];
      delete state.decryptKeys[fileId];
    }
  } catch {
    markTransferStatus(fileId, 'Decryption failed', 'transfer-error');
  }
}

const AUTO_ACCEPT_KEY = 'drop-auto-accept';
let autoAccept = localStorage.getItem(AUTO_ACCEPT_KEY) === '1';
const autoAcceptToggle = document.getElementById('auto-accept-toggle');
autoAcceptToggle.checked = autoAccept;
autoAcceptToggle.addEventListener('change', () => {
  autoAccept = autoAcceptToggle.checked;
  localStorage.setItem(AUTO_ACCEPT_KEY, autoAccept ? '1' : '0');
});

async function autoAcceptRequest(msg) {
  const peerName = state.peers[msg.from]?.name ?? msg.from;
  if (msg.type === 'batch-request') {
    const keys = await Promise.all(msg.files.map(f => importKey(f.key)));
    state.batchRecvState[msg.batchId] = { total: msg.files.length, blobs: [] };
    msg.files.forEach((f, i) => {
      state.decryptKeys[f.fileId] = keys[i];
      state.fileBatch[f.fileId] = msg.batchId;
      addTransferItem(f.fileId, f.filename, f.size, 'recv', peerName);
    });
    send({ type: 'batch-accept', to: msg.from, batchId: msg.batchId });
  } else {
    state.decryptKeys[msg.fileId] = await importKey(msg.key);
    addTransferItem(msg.fileId, msg.filename, msg.size, 'recv', peerName);
    send({ type: 'transfer-accept', to: msg.from, fileId: msg.fileId });
  }
}

function showIncomingRequest(msg) {
  if (autoAccept && state.peers[msg.from]) { autoAcceptRequest(msg); return; }
  state.requestQueue.push(msg);
  if (!state.activeRequest) drainRequestQueue();
}

function drainRequestQueue() {
  const msg = state.requestQueue.shift();
  if (!msg) { document.getElementById('overlay').classList.add('hidden'); return; }
  state.activeRequest = msg;
  const queued = state.requestQueue.length;
  document.getElementById('req-from').textContent = state.peers[msg.from]?.name ?? msg.from;
  if (msg.type === 'batch-request') {
    document.getElementById('req-filename').textContent = `${msg.count} files`;
    document.getElementById('req-filesize').textContent = fmtSize(msg.totalSize) + ' total · AES-256-GCM' + (queued ? ` · +${queued} more` : '');
  } else {
    document.getElementById('req-filename').textContent = msg.filename;
    document.getElementById('req-filesize').textContent = fmtSize(msg.size) + ' · AES-256-GCM encrypted' + (queued ? ` · +${queued} more` : '');
  }
  document.getElementById('overlay').classList.remove('hidden');
}

document.getElementById('btn-accept').addEventListener('click', async () => {
  const req = state.activeRequest;
  if (!req) return;
  state.activeRequest = null;
  if (req.type === 'batch-request') {
    const keys = await Promise.all(req.files.map(f => importKey(f.key)));
    const peerName = state.peers[req.from]?.name ?? req.from;
    state.batchRecvState[req.batchId] = { total: req.files.length, blobs: [] };
    req.files.forEach((f, i) => {
      state.decryptKeys[f.fileId] = keys[i];
      state.fileBatch[f.fileId] = req.batchId;
      addTransferItem(f.fileId, f.filename, f.size, 'recv', peerName);
    });
    send({ type: 'batch-accept', to: req.from, batchId: req.batchId });
  } else {
    state.decryptKeys[req.fileId] = await importKey(req.key);
    send({ type: 'transfer-accept', to: req.from, fileId: req.fileId });
  }
  drainRequestQueue();
});

document.getElementById('btn-decline').addEventListener('click', () => {
  const req = state.activeRequest;
  if (!req) return;
  state.activeRequest = null;
  if (req.type === 'batch-request') {
    send({ type: 'batch-decline', to: req.from, batchId: req.batchId });
  } else {
    send({ type: 'transfer-decline', to: req.from, fileId: req.fileId });
  }
  drainRequestQueue();
});

async function enterRoom(code, isCreator, showCode = true) {
  const nick = nicknameInput.value.trim();
  if (nick) state.myName = nick;
  state.roomCode = code.toUpperCase();
  state.isCreator = isCreator;
  connect(state.roomCode);
  showView('room');
  sessionStorage.setItem('drop-room', state.roomCode);
  sessionStorage.setItem('drop-creator', isCreator ? '1' : '0');
  if (location.pathname !== '/room/' + state.roomCode)
    history.pushState({}, '', '/room/' + state.roomCode);

  if (isCreator && showCode) {
    const section = document.getElementById('room-code-section');
    section.style.display = '';
    document.getElementById('room-code-text').textContent = state.roomCode;
    const joinUrl = `${location.origin}?join=${state.roomCode}`;
    const qrSrc = `/api/qr?size=320&data=${encodeURIComponent(joinUrl)}`;
    document.getElementById('qr-img').src = qrSrc;
    document.getElementById('qr-fullscreen-img').src = qrSrc;
    document.getElementById('copy-btn').onclick = () => {
      navigator.clipboard.writeText(joinUrl).then(() => {
        document.getElementById('copy-btn').textContent = 'Copied!';
        setTimeout(() => { document.getElementById('copy-btn').textContent = 'Copy link'; }, 2000);
      });
    };
  }
}

async function sendText(text) {
  const key = await generateKey();
  const keyB64 = await exportKey(key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  const payload = { type: 'text', key: keyB64, iv: toB64(iv), data: toB64(encrypted) };
  Object.keys(state.peers).forEach(peerId => send({ ...payload, to: peerId }));
  addTextItem(text, 'You', true);
}

async function receiveText(msg) {
  try {
    const key = await importKey(msg.key);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(msg.iv) }, key, fromB64(msg.data));
    addTextItem(new TextDecoder().decode(plain), state.peers[msg.from]?.name ?? msg.from, false);
  } catch {
    addTextItem('[decryption failed]', state.peers[msg.from]?.name ?? msg.from, false);
  }
}

function addTextItem(text, from, isMine) {
  const el = document.createElement('div');
  el.className = 'text-item';
  const meta = document.createElement('div');
  meta.className = 'text-item-meta';
  meta.textContent = isMine ? 'You' : from;
  const body = document.createElement('div');
  body.className = 'text-item-body';
  body.textContent = text;
  const actions = document.createElement('div');
  actions.className = 'text-item-actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn-copy-text';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', function() {
    navigator.clipboard.writeText(text).then(() => { this.textContent = 'Copied!'; setTimeout(() => this.textContent = 'Copy', 1500); });
  });
  actions.appendChild(copyBtn);
  el.appendChild(meta);
  el.appendChild(body);
  el.appendChild(actions);
  document.getElementById('transfers').prepend(el);
}

const textInput = document.getElementById('text-input');
document.getElementById('btn-send-text').addEventListener('click', async () => {
  const text = textInput.value.trim();
  if (!text || !Object.keys(state.peers).length) return;
  textInput.value = '';
  await sendText(text);
});
textInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('btn-send-text').click(); }
});

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragging'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragging');
  if (e.dataTransfer.files.length) queueFiles(Array.from(e.dataTransfer.files));
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) queueFiles(Array.from(fileInput.files));
  fileInput.value = '';
});

function requireNick() {
  const nick = nicknameInput.value.trim();
  if (!nick) {
    nicknameInput.focus();
    nicknameInput.style.borderColor = 'var(--danger)';
    setTimeout(() => { nicknameInput.style.borderColor = ''; }, 1200);
    return false;
  }
  return true;
}

document.getElementById('btn-create').addEventListener('click', async () => {
  if (!requireNick()) return;
  const { code } = await fetch('/api/room', { method: 'POST' }).then(r => r.json());
  await enterRoom(code, true);
});
document.getElementById('btn-join-show').addEventListener('click', () => {
  if (!requireNick()) return;
  showView('join');
});
document.getElementById('btn-join').addEventListener('click', () => {
  const code = document.getElementById('code-input').value.trim().toUpperCase();
  if (code.length === 6) enterRoom(code, false);
});
document.getElementById('code-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-join').click();
});

document.getElementById('back-btn').addEventListener('click', () => {
  if (state.ws) { state.ws.onclose = null; state.ws.onerror = null; state.ws.close(1000); }
  Object.assign(state, { roomCode: null, myId: null, isCreator: false, ws: null, reconnecting: false, peers: {}, requestQueue: [], activeRequest: null, decryptKeys: {}, recvState: {}, fileBatch: {}, batchRecvState: {}, sendQueue: [], cancelledTransfers: new Set() });
  connectedResolve = null; connectedPromise = null;
  const list = document.getElementById('peers-list');
  list.innerHTML = '';
  list.appendChild(noPeersEl);
  document.getElementById('room-code-section').style.display = 'none';
  document.getElementById('transfers').innerHTML = '';
  document.getElementById('code-input').value = '';
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('lobby-overlay').classList.add('hidden');
  setDropEnabled(false);
  sessionStorage.removeItem('drop-room');
  sessionStorage.removeItem('drop-creator');
  history.pushState({}, '', '/');
  showView('home');
});

const nicknameInput = document.getElementById('nickname-input');
nicknameInput.value = localStorage.getItem(SAVED_NICKNAME_KEY) || '';
nicknameInput.addEventListener('input', () => localStorage.setItem(SAVED_NICKNAME_KEY, nicknameInput.value.trim()));

async function getLocalSubnet() {
  return new Promise(resolve => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('');
      pc.createOffer().then(o => pc.setLocalDescription(o));
      const done = (subnet) => { pc.close(); resolve(subnet); };
      pc.onicecandidate = (e) => {
        if (!e.candidate) return done(null);
        const m = e.candidate.candidate.match(/(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}/);
        if (m && !m[1].startsWith('127.')) done(m[1]);
      };
      setTimeout(() => done(null), 1500);
    } catch { resolve(null); }
  });
}

async function connectLobby() {
  const nick = nicknameInput.value.trim();
  if (!nick) { nicknameInput.focus(); return; }
  localStorage.setItem(SAVED_NICKNAME_KEY, nick);

  const subnet = await getLocalSubnet();
  state.mySubnet = subnet;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams({ nickname: nick });
  if (subnet) qs.set('subnet', subnet);
  state.lobby = new WebSocket(`${proto}//${location.host}/ws/lobby?${qs}`);

  state.lobby.onmessage = (e) => handleLobbyMessage(JSON.parse(e.data));
  state.lobby.onclose = () => {
    state.lobbyId = null;
    state.mySubnet = null;
    state.lobbyPeers = {};
    renderLobbyPeers();
    document.getElementById('lobby-section').classList.add('hidden');
    document.getElementById('btn-go-public').textContent = 'Go public';
    document.getElementById('btn-go-public').classList.remove('active');
    nicknameInput.disabled = false;
  };
}

function disconnectLobby() {
  state.lobby?.close(1000);
  state.lobby = null;
}

function handleLobbyMessage(msg) {
  switch (msg.type) {
    case 'lobby-welcome':
      state.lobbyId = msg.peerId;
      msg.peers.forEach(p => { state.lobbyPeers[p.id] = { nickname: p.nickname, subnet: p.subnet }; });
      renderLobbyPeers();
      document.getElementById('lobby-section').classList.remove('hidden');
      break;
    case 'lobby-peer-joined':
      state.lobbyPeers[msg.peerId] = { nickname: msg.nickname, subnet: msg.subnet };
      renderLobbyPeers();
      if (state.mySubnet && msg.subnet && msg.subnet === state.mySubnet) showNearbyToast(msg.peerId, msg.nickname);
      break;
    case 'lobby-peer-left':
      delete state.lobbyPeers[msg.peerId];
      renderLobbyPeers();
      break;
    case 'connect-request':
      showLobbyConnectRequest(msg);
      break;
    case 'connect-accept':
      if (state.pendingLobbyConnect === msg.from) {
        state.pendingLobbyConnect = null;
        disconnectLobby();
        enterRoom(msg.roomCode, false);
      }
      break;
    case 'connect-decline':
      if (state.pendingLobbyConnect === msg.from) {
        state.pendingLobbyConnect = null;
        const btn = document.querySelector(`.btn-connect[data-id="${msg.from}"]`);
        if (btn) { btn.textContent = 'Declined'; btn.disabled = true; }
      }
      break;
  }
}

function renderLobbyPeers() {
  const list = document.getElementById('lobby-list');
  const ids = Object.keys(state.lobbyPeers);
  list.innerHTML = '';
  if (ids.length === 0) {
    list.appendChild(noLobbyPeersEl);
    return;
  }
  ids.forEach(id => {
    const peer = state.lobbyPeers[id];
    const isNearby = state.mySubnet && peer.subnet && peer.subnet === state.mySubnet;
    const isPending = state.pendingLobbyConnect === id;
    const el = document.createElement('div');
    el.className = 'lobby-peer-card' + (isNearby ? ' nearby' : '');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'lobby-peer-name';
    nameSpan.textContent = peer.nickname;
    if (isNearby) {
      const badge = document.createElement('span');
      badge.className = 'nearby-badge';
      badge.textContent = 'Nearby';
      nameSpan.appendChild(badge);
    }
    const btn = document.createElement('button');
    btn.className = 'btn-connect';
    btn.dataset.id = id;
    btn.disabled = isPending;
    btn.textContent = isPending ? 'Waiting...' : 'Connect';
    btn.addEventListener('click', () => sendLobbyConnectRequest(id));
    el.appendChild(nameSpan);
    el.appendChild(btn);
    list.appendChild(el);
  });
}

function showNearbyToast(peerId, nickname) {
  document.querySelectorAll('.nearby-toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'nearby-toast';
  const msg = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = nickname;
  msg.appendChild(strong);
  msg.append(' is nearby');
  const connectBtn = document.createElement('button');
  connectBtn.className = 'nearby-toast-connect';
  connectBtn.textContent = 'Connect';
  connectBtn.addEventListener('click', () => { sendLobbyConnectRequest(peerId); el.remove(); });
  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'nearby-toast-dismiss';
  dismissBtn.textContent = '✕';
  dismissBtn.addEventListener('click', () => el.remove());
  el.appendChild(msg);
  el.appendChild(connectBtn);
  el.appendChild(dismissBtn);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 12000);
}

function sendLobbyConnectRequest(peerId) {
  state.pendingLobbyConnect = peerId;
  state.lobby.send(JSON.stringify({ type: 'connect-request', to: peerId }));
  renderLobbyPeers();
}

function showLobbyConnectRequest(msg) {
  const name = state.lobbyPeers[msg.from]?.nickname ?? msg.from;
  document.getElementById('lobby-req-name').textContent = name;
  document.getElementById('lobby-overlay').classList.remove('hidden');
  state.pendingLobbyConnect = msg.from;
}

document.getElementById('lobby-btn-accept').addEventListener('click', async () => {
  const peerId = state.pendingLobbyConnect;
  if (!peerId) return;
  document.getElementById('lobby-overlay').classList.add('hidden');
  const { code } = await fetch('/api/room', { method: 'POST' }).then(r => r.json());
  state.lobby.send(JSON.stringify({ type: 'connect-accept', to: peerId, roomCode: code }));
  state.pendingLobbyConnect = null;
  disconnectLobby();
  enterRoom(code, true, false);
});

document.getElementById('lobby-btn-decline').addEventListener('click', () => {
  const peerId = state.pendingLobbyConnect;
  if (!peerId) return;
  document.getElementById('lobby-overlay').classList.add('hidden');
  state.lobby.send(JSON.stringify({ type: 'connect-decline', to: peerId }));
  state.pendingLobbyConnect = null;
});

document.getElementById('btn-go-public').addEventListener('click', async () => {
  const btn = document.getElementById('btn-go-public');
  if (state.lobby && state.lobby.readyState === WebSocket.OPEN) {
    disconnectLobby();
    btn.textContent = 'Go public';
    btn.classList.remove('active');
    nicknameInput.disabled = false;
    document.getElementById('lobby-section').classList.add('hidden');
  } else {
    const nick = nicknameInput.value.trim();
    if (!nick) { nicknameInput.focus(); nicknameInput.style.borderColor = 'var(--danger)'; setTimeout(() => nicknameInput.style.borderColor = '', 1200); return; }
    btn.textContent = 'Connecting...';
    btn.disabled = true;
    await connectLobby();
    btn.textContent = 'Go private';
    btn.classList.add('active');
    btn.disabled = false;
    nicknameInput.disabled = true;
  }
});

let scanStream = null, scanInterval = null;

async function startQRScan() {
  if (!('BarcodeDetector' in window)) {
    const code = prompt('QR scanning not supported — enter room code:');
    if (code?.trim().length === 6) enterRoom(code.trim().toUpperCase(), false);
    return;
  }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch { return; }
  const video = document.getElementById('scan-video');
  video.srcObject = scanStream;
  document.getElementById('scan-overlay').classList.remove('hidden');
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  scanInterval = setInterval(async () => {
    if (video.readyState < 2) return;
    try {
      const codes = await detector.detect(video);
      for (const c of codes) {
        const urlM = c.rawValue.match(/[?&]join=([A-Z0-9]{6})/i);
        const rawM = c.rawValue.match(/^[A-Z0-9]{6}$/i);
        const code = urlM?.[1] ?? (rawM ? c.rawValue : null);
        if (code) { stopQRScan(); enterRoom(code.toUpperCase(), false); return; }
      }
    } catch {}
  }, 200);
}

function stopQRScan() {
  clearInterval(scanInterval); scanInterval = null;
  scanStream?.getTracks().forEach(t => t.stop()); scanStream = null;
  document.getElementById('scan-overlay').classList.add('hidden');
}

document.getElementById('btn-scan-qr').addEventListener('click', startQRScan);
document.getElementById('btn-scan-close').addEventListener('click', stopQRScan);

let wakeLock = null;
document.getElementById('qr-img').addEventListener('click', async () => {
  const overlay = document.getElementById('qr-fullscreen');
  overlay.classList.remove('hidden');
  try { await overlay.requestFullscreen(); } catch {}
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
});
document.getElementById('qr-fullscreen').addEventListener('click', async () => {
  document.getElementById('qr-fullscreen').classList.add('hidden');
  try { if (document.fullscreenElement) await document.exitFullscreen(); } catch {}
  try { await wakeLock?.release(); wakeLock = null; } catch {}
});

async function createShareLink(file) {
  const MAX = 5 * 1024 * 1024;
  if (file.size > MAX) {
    alert('Share links are limited to 5 MB. Use a room for larger files.');
    return;
  }
  const overlay = document.getElementById('share-create-overlay');
  const statusEl = document.getElementById('share-upload-status');
  const filenameEl = document.getElementById('share-upload-filename');
  const linkBox = document.getElementById('share-link-box');
  const linkInput = document.getElementById('share-link-input');
  overlay.classList.remove('hidden');
  linkBox.classList.add('hidden');
  filenameEl.textContent = file.name;
  statusEl.textContent = 'Encrypting...';

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
    if (!res.ok) throw new Error(await res.text());
    const { id } = await res.json();
    const url = `${location.origin}/share/${id}#key=${encodeURIComponent(keyB64)}`;
    linkInput.value = url;
    statusEl.textContent = 'Link ready — one-time use, expires in 24h';
    linkBox.classList.remove('hidden');
  } catch (err) {
    statusEl.textContent = 'Failed: ' + err.message;
  }
}

document.getElementById('btn-create-share').addEventListener('click', () => {
  document.getElementById('share-file-input').click();
});
document.getElementById('share-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) createShareLink(file);
  e.target.value = '';
});
document.getElementById('btn-copy-share').addEventListener('click', () => {
  const input = document.getElementById('share-link-input');
  navigator.clipboard.writeText(input.value).then(() => {
    document.getElementById('btn-copy-share').textContent = 'Copied!';
    setTimeout(() => { document.getElementById('btn-copy-share').textContent = 'Copy'; }, 2000);
  });
});
document.getElementById('btn-share-close').addEventListener('click', () => {
  document.getElementById('share-create-overlay').classList.add('hidden');
});

function shareError(msg) {
  const nameEl = document.getElementById('share-receive-name');
  const metaEl = document.getElementById('share-receive-meta');
  const note = document.getElementById('share-receive-note');
  nameEl.textContent = msg;
  metaEl.textContent = '';
  note.textContent = '';
  document.getElementById('btn-share-download').style.display = 'none';
}

async function receiveShareLink(id, keyB64) {
  showView('share');
  history.replaceState({}, '', location.pathname);
  const nameEl = document.getElementById('share-receive-name');
  const metaEl = document.getElementById('share-receive-meta');
  const btn = document.getElementById('btn-share-download');
  nameEl.textContent = 'Fetching...';
  metaEl.textContent = '';
  btn.style.display = 'none';

  let payload;
  try {
    let res;
    try {
      res = await fetch(`/api/share/${id}`);
    } catch {
      shareError('Could not reach server — check your connection');
      return;
    }
    if (res.status === 404) { shareError('Link not found or already used'); return; }
    if (!res.ok) { shareError(`Something went wrong (${res.status})`); return; }
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
  btn.style.display = '';

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Decrypting...';
    let key;
    try {
      key = await importKey(keyB64);
    } catch {
      btn.textContent = 'Bad key — check the full link was copied';
      btn.disabled = false;
      return;
    }
    let decrypted;
    try {
      decrypted = await decryptChunk(key, payload.iv, payload.data);
    } catch {
      btn.textContent = 'Decryption failed — link may be corrupted';
      btn.disabled = false;
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
      document.getElementById('share-receive-note').textContent = 'File removed from servers.';
    } catch {
      btn.textContent = 'Download failed — try again';
      btn.disabled = false;
    }
  }, { once: true });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });

const joinCode = new URLSearchParams(location.search).get('join');
const roomPathMatch = location.pathname.match(/^\/room\/([A-Z0-9]{6})$/i);
const sharePathMatch = location.pathname.match(/^\/share\/([A-Za-z0-9_-]{10,16})$/);
if (joinCode) {
  history.replaceState({}, '', '/');
  enterRoom(joinCode, false);
} else if (roomPathMatch) {
  const savedCode = sessionStorage.getItem('drop-room');
  const wasCreator = sessionStorage.getItem('drop-creator') === '1';
  const code = roomPathMatch[1].toUpperCase();
  enterRoom(code, savedCode === code && wasCreator);
} else if (sharePathMatch) {
  const keyB64 = decodeURIComponent(location.hash.replace('#key=', ''));
  if (keyB64) receiveShareLink(sharePathMatch[1], keyB64);
  else {
    showView('share');
    document.getElementById('share-receive-name').textContent = 'Invalid link — missing key';
  }
}

if (new URLSearchParams(location.search).get('incoming') === 'share') {
  history.replaceState({}, '', '/');
  if ('serviceWorker' in navigator) {
    const handler = (e) => {
      if (e.data?.type !== 'shared-files') return;
      navigator.serviceWorker.removeEventListener('message', handler);
      if (!e.data.files.length) return;
      state.pendingShareFiles = e.data.files;
      const banner = document.createElement('div');
      banner.id = 'share-banner';
      banner.className = 'share-banner';
      banner.innerHTML = `<span>${e.data.files.length} file${e.data.files.length > 1 ? 's' : ''} ready — create or join a room to send</span>`;
      document.querySelector('.main').prepend(banner);
    };
    navigator.serviceWorker.addEventListener('message', handler);
    const claimShare = () => navigator.serviceWorker.controller?.postMessage('claim-share');
    navigator.serviceWorker.ready.then(() => {
      if (navigator.serviceWorker.controller) {
        claimShare();
      } else {
        navigator.serviceWorker.addEventListener('controllerchange', claimShare, { once: true });
      }
    });
  }
}
