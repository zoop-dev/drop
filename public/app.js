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

const state = {
  roomCode: null,
  myId: null,
  myName: getDeviceName(),
  isCreator: false,
  ws: null,
  peers: {},
  requestQueue: [],
  activeRequest: null,
  decryptKeys: {},
  recvState: {},
  sendQueue: [],
  lobby: null,
  lobbyId: null,
  lobbyPeers: {},
  pendingLobbyConnect: null,
};

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + id).classList.add('active');
  document.getElementById('back-btn').classList.toggle('hidden', id === 'home');
}

function showRoomError(msg) {
  document.getElementById('peers-list').innerHTML = `<div class="room-error">${msg}</div>`;
  setDropEnabled(false);
}

function connect(code) {
  if (state.ws) { state.ws.onclose = null; state.ws.close(); }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${proto}//${location.host}/ws/${code}?name=${encodeURIComponent(state.myName)}`);
  state.ws.onmessage = async (e) => handleMessage(JSON.parse(e.data));
  state.ws.onerror = () => showRoomError('Connection failed. Check your internet and try again.');
  state.ws.onclose = (e) => {
    if (e.code === 1000) return;
    setTimeout(() => {
      if (state.roomCode && document.visibilityState === 'visible') connect(state.roomCode);
    }, 1500);
  };
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.roomCode) {
    if (!state.ws || state.ws.readyState === WebSocket.CLOSED) connect(state.roomCode);
  }
});

function send(obj) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

async function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      state.myId = msg.peerId;
      msg.peers.forEach(p => addPeer(p.id, p.name));
      if (!state.isCreator && msg.peers.length === 0)
        showRoomError('Room is empty — make sure the other device created the room first.');
      break;
    case 'peer-joined': addPeer(msg.peerId, msg.name); break;
    case 'peer-left': removePeer(msg.peerId); break;
    case 'transfer-request': showIncomingRequest(msg); break;
    case 'transfer-accept': startSendingFile(msg.from, msg.fileId); break;
    case 'transfer-decline': markTransferStatus(msg.fileId, 'Declined', 'transfer-error'); break;
    case 'chunk': await receiveChunk(msg); break;
    case 'transfer-error': markTransferStatus(msg.fileId, 'Transfer failed', 'transfer-error'); break;
    case 'text': receiveText(msg); break;
  }
}

function addPeer(id, name) { state.peers[id] = { name }; renderPeers(); }
function removePeer(id) { delete state.peers[id]; renderPeers(); }

function renderPeers() {
  const list = document.getElementById('peers-list');
  const noPeers = document.getElementById('no-peers');
  const ids = Object.keys(state.peers);
  if (ids.length === 0) {
    list.innerHTML = '';
    list.appendChild(noPeers);
    noPeers.style.display = '';
    setDropEnabled(false);
    return;
  }
  noPeers.style.display = 'none';
  list.innerHTML = '';
  ids.forEach(id => {
    const el = document.createElement('div');
    el.className = 'peer-card';
    el.innerHTML = `<span class="peer-name">${state.peers[id].name}</span><span class="peer-status"><span class="dot"></span> Connected</span>`;
    list.appendChild(el);
  });
  setDropEnabled(true);
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
  el.innerHTML = `
    <div class="transfer-header">
      <span class="transfer-name">${filename}</span>
      <span class="transfer-size">${fmtSize(size)}</span>
    </div>
    <div class="transfer-peer">${direction === 'send' ? 'Sending to' : 'From'} ${peerName}</div>
    <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
    <div class="transfer-footer">
      <span class="status-text">${direction === 'send' ? 'Waiting for acceptance...' : 'Receiving...'}</span>
      <span class="pct-text"></span>
    </div>`;
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

function markTransferReceived(fileId, filename, blobUrl) {
  const el = document.getElementById('transfer-' + fileId);
  if (!el) return;
  el.querySelector('.progress-fill').style.width = '100%';
  const footer = el.querySelector('.transfer-footer');
  footer.innerHTML = `<span class="status-text transfer-done">Ready</span><a class="download-btn" href="${blobUrl}" download="${filename}">Save file</a>`;
  footer.querySelector('.download-btn').addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(blobUrl), 1000));
}

async function queueFiles(files) {
  const peerIds = Object.keys(state.peers);
  if (!peerIds.length) return;

  const isBatch = files.length > 1;
  const batchId = isBatch ? crypto.randomUUID() : null;

  for (const file of files) {
    const fileId = crypto.randomUUID();
    const key = await generateKey();
    const keyB64 = await exportKey(key);

    state.sendQueue.push({ file, fileId, key, pendingTargets: new Set(peerIds) });

    peerIds.forEach(peerId => {
      send({
        type: 'transfer-request',
        to: peerId,
        fileId,
        filename: isBatch ? `${files.length} files (${file.name}, ...)` : file.name,
        displayName: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        key: keyB64,
        batchId,
      });
      addTransferItem(fileId, file.name, file.size, 'send', state.peers[peerId]?.name ?? peerId);
    });
  }
}

async function startSendingFile(fromPeerId, fileId) {
  const entry = state.sendQueue.find(e => e.fileId === fileId);
  if (!entry) return;
  entry.pendingTargets.delete(fromPeerId);
  updateProgress(fileId, 0, 'Sending...');

  const { file, key } = entry;
  const total = Math.ceil(file.size / CHUNK_SIZE);
  let offset = 0, index = 0;

  try {
    while (offset < file.size) {
      const buffer = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      const { iv, data } = await encryptChunk(key, buffer);
      send({ type: 'chunk', to: fromPeerId, fileId, index, total, iv, data, filename: file.name, size: file.size, mimeType: file.type || 'application/octet-stream' });
      offset += buffer.byteLength;
      index++;
      updateProgress(fileId, Math.min(99, (offset / file.size) * 100), 'Sending...');
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
  const { fileId, index, total, iv, data, filename, size, mimeType, from } = msg;
  if (!state.decryptKeys[fileId]) return;

  if (!state.recvState[fileId]) {
    state.recvState[fileId] = { name: filename, size, mimeType, chunks: [], received: 0, total };
    addTransferItem(fileId, filename, size, 'recv', state.peers[from]?.name ?? from);
  }

  try {
    const decrypted = await decryptChunk(state.decryptKeys[fileId], iv, data);
    const recv = state.recvState[fileId];
    recv.chunks[index] = decrypted;
    recv.received++;
    updateProgress(fileId, Math.min(99, (recv.received / total) * 100), 'Receiving...');
    if (recv.received >= total) {
      markTransferReceived(fileId, recv.name, URL.createObjectURL(new Blob(recv.chunks, { type: recv.mimeType })));
      delete state.recvState[fileId];
      delete state.decryptKeys[fileId];
    }
  } catch {
    markTransferStatus(fileId, 'Decryption failed', 'transfer-error');
  }
}

function showIncomingRequest(msg) {
  state.requestQueue.push(msg);
  if (!state.activeRequest) drainRequestQueue();
}

function drainRequestQueue() {
  const msg = state.requestQueue.shift();
  if (!msg) { document.getElementById('overlay').classList.add('hidden'); return; }
  state.activeRequest = msg;
  const queued = state.requestQueue.length;
  const isBatch = !!msg.batchId;
  document.getElementById('req-from').textContent = state.peers[msg.from]?.name ?? msg.from;
  document.getElementById('req-filename').textContent = isBatch ? msg.filename : msg.filename;
  document.getElementById('req-filesize').textContent =
    fmtSize(msg.size) + ' · AES-256-GCM encrypted' + (queued ? ` · +${queued} more` : '');
  document.getElementById('overlay').classList.remove('hidden');
}

document.getElementById('btn-accept').addEventListener('click', async () => {
  const req = state.activeRequest;
  if (!req) return;
  state.activeRequest = null;
  state.decryptKeys[req.fileId] = await importKey(req.key);
  send({ type: 'transfer-accept', to: req.from, fileId: req.fileId });
  drainRequestQueue();
});

document.getElementById('btn-decline').addEventListener('click', () => {
  const req = state.activeRequest;
  if (!req) return;
  state.activeRequest = null;
  send({ type: 'transfer-decline', to: req.from, fileId: req.fileId });
  drainRequestQueue();
});

async function enterRoom(code, isCreator) {
  state.roomCode = code.toUpperCase();
  state.isCreator = isCreator;
  connect(state.roomCode);
  showView('room');

  if (isCreator) {
    const section = document.getElementById('room-code-section');
    section.style.display = '';
    document.getElementById('room-code-text').textContent = state.roomCode;
    const joinUrl = `${location.origin}?join=${state.roomCode}`;
    document.getElementById('qr-img').src =
      `https://api.qrserver.com/v1/create-qr-code/?size=160x160&qzone=2&data=${encodeURIComponent(joinUrl)}`;
    document.getElementById('copy-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(joinUrl).then(() => {
        document.getElementById('copy-btn').textContent = 'Copied!';
        setTimeout(() => { document.getElementById('copy-btn').textContent = 'Copy link'; }, 2000);
      });
    });
  }
}

function sendText(text) {
  Object.keys(state.peers).forEach(peerId => send({ type: 'text', to: peerId, text }));
  addTextItem(text, 'You', true);
}

function receiveText(msg) {
  addTextItem(msg.text, state.peers[msg.from]?.name ?? msg.from, false);
}

function addTextItem(text, from, isMine) {
  const el = document.createElement('div');
  el.className = 'text-item';
  el.innerHTML = `
    <div class="text-item-meta">${isMine ? 'You' : from}</div>
    <div class="text-item-body">${text.replace(/</g, '&lt;')}</div>
    <div class="text-item-actions"><button class="btn-copy-text">Copy</button></div>`;
  el.querySelector('.btn-copy-text').addEventListener('click', function() {
    navigator.clipboard.writeText(text).then(() => { this.textContent = 'Copied!'; setTimeout(() => this.textContent = 'Copy', 1500); });
  });
  document.getElementById('transfers').prepend(el);
}

const textInput = document.getElementById('text-input');
document.getElementById('btn-send-text').addEventListener('click', () => {
  const text = textInput.value.trim();
  if (!text || !Object.keys(state.peers).length) return;
  sendText(text);
  textInput.value = '';
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

document.getElementById('btn-create').addEventListener('click', async () => {
  const { code } = await fetch('/api/room', { method: 'POST' }).then(r => r.json());
  await enterRoom(code, true);
});
document.getElementById('btn-join-show').addEventListener('click', () => showView('join'));
document.getElementById('btn-join').addEventListener('click', () => {
  const code = document.getElementById('code-input').value.trim().toUpperCase();
  if (code.length === 6) enterRoom(code, false);
});
document.getElementById('code-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-join').click();
});

document.getElementById('back-btn').addEventListener('click', () => {
  state.ws?.close(1000);
  Object.assign(state, { roomCode: null, myId: null, isCreator: false, ws: null, peers: {}, requestQueue: [], activeRequest: null, decryptKeys: {}, recvState: {}, sendQueue: [] });
  const list = document.getElementById('peers-list');
  const noPeers = document.getElementById('no-peers');
  list.innerHTML = '';
  list.appendChild(noPeers);
  noPeers.style.display = '';
  document.getElementById('room-code-section').style.display = 'none';
  document.getElementById('transfers').innerHTML = '';
  document.getElementById('code-input').value = '';
  setDropEnabled(false);
  showView('home');
});

const nicknameInput = document.getElementById('nickname-input');
nicknameInput.value = localStorage.getItem(SAVED_NICKNAME_KEY) || '';
nicknameInput.addEventListener('input', () => localStorage.setItem(SAVED_NICKNAME_KEY, nicknameInput.value.trim()));

function connectLobby() {
  const nick = nicknameInput.value.trim();
  if (!nick) { nicknameInput.focus(); return; }
  localStorage.setItem(SAVED_NICKNAME_KEY, nick);

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.lobby = new WebSocket(`${proto}//${location.host}/ws/lobby?nickname=${encodeURIComponent(nick)}`);

  state.lobby.onmessage = (e) => handleLobbyMessage(JSON.parse(e.data));
  state.lobby.onclose = () => {
    state.lobbyId = null;
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
      msg.peers.forEach(p => { state.lobbyPeers[p.id] = { nickname: p.nickname }; });
      renderLobbyPeers();
      document.getElementById('lobby-section').classList.remove('hidden');
      break;
    case 'lobby-peer-joined':
      state.lobbyPeers[msg.peerId] = { nickname: msg.nickname };
      renderLobbyPeers();
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
  const noPeers = document.getElementById('no-lobby-peers');
  const ids = Object.keys(state.lobbyPeers);
  if (ids.length === 0) {
    list.innerHTML = '';
    list.appendChild(noPeers);
    return;
  }
  noPeers.remove();
  list.innerHTML = '';
  ids.forEach(id => {
    const el = document.createElement('div');
    el.className = 'lobby-peer-card';
    const isPending = state.pendingLobbyConnect === id;
    el.innerHTML = `
      <span class="lobby-peer-name">${state.lobbyPeers[id].nickname}</span>
      <button class="btn-connect" data-id="${id}" ${isPending ? 'disabled' : ''}>${isPending ? 'Waiting...' : 'Connect'}</button>`;
    el.querySelector('.btn-connect').addEventListener('click', () => sendLobbyConnectRequest(id));
    list.appendChild(el);
  });
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
  enterRoom(code, true);
});

document.getElementById('lobby-btn-decline').addEventListener('click', () => {
  const peerId = state.pendingLobbyConnect;
  if (!peerId) return;
  document.getElementById('lobby-overlay').classList.add('hidden');
  state.lobby.send(JSON.stringify({ type: 'connect-decline', to: peerId }));
  state.pendingLobbyConnect = null;
});

document.getElementById('btn-go-public').addEventListener('click', () => {
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
    connectLobby();
    btn.textContent = 'Go private';
    btn.classList.add('active');
    nicknameInput.disabled = true;
  }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

const joinCode = new URLSearchParams(location.search).get('join');
if (joinCode) {
  history.replaceState({}, '', '/');
  enterRoom(joinCode, false);
}
