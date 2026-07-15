const DROP_QR = (() => {
  function encode(text){
    try{
      const q=qrcode(0,'L');
      q.addData(text,'Byte');
      q.make();
      const N=q.getModuleCount();
      const matrix=Array.from({length:N},(_,r)=>Array.from({length:N},(_,c)=>q.isDark(r,c)));
      return{matrix,version:(N-17)/4};
    }catch{return null;}
  }

  function render(canvas,qr,modSize=12,quiet=4){
    const{matrix}=qr,N=matrix.length,SIZE=(N+2*quiet)*modSize;
    canvas.width=canvas.height=SIZE;
    const ctx=canvas.getContext('2d'),M=modSize,off=quiet*M;
    ctx.fillStyle='#fff';ctx.fillRect(0,0,SIZE,SIZE);
    ctx.fillStyle='#000';
    for(let r=0;r<N;r++)for(let c=0;c<N;c++){
      if(matrix[r][c])ctx.fillRect(off+c*M,off+r*M,M,M);
    }
  }

  return{encode,render};
})();







function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + id).classList.add('active');
  document.getElementById('back-btn').classList.toggle('hidden', id === 'home' || id === 'share');
}


function incUnread() {
  if (document.visibilityState === 'visible') return;
  unreadCount++;
  document.title = `(${unreadCount}) drop`;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    unreadCount = 0;
    document.title = 'drop';
    if (state.roomCode && state.reconnecting) {
      const ws = state.ws;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        connect(state.roomCode);
      }
    }
  }
});
















document.addEventListener('paste', e => {
  if (!state.roomCode) return;
  if (e.target.matches('input, textarea, [contenteditable]')) return;
  const items = Array.from(e.clipboardData.items);
  const files = items.filter(it => it.kind === 'file').map(it => it.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); pickTargetsAndSend(files); return; }
  const textItem = items.find(it => it.kind === 'string' && it.type === 'text/plain');
  if (textItem && Object.keys(state.peers).length) {
    e.preventDefault();
    textItem.getAsString(text => { if (text.trim()) sendText(text.trim()); });
  }
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
  Object.values(state.reconnectTimers).forEach(clearTimeout);
  Object.values(state.rtcPeers).forEach(p => { try { p.dc?.close(); } catch {} try { p.pc.close(); } catch {} });
  Object.assign(state, { roomCode: null, myId: null, isCreator: false, ws: null, reconnecting: false, peers: {}, requestQueue: [], activeRequest: null, decryptKeys: {}, recvState: {}, fileBatch: {}, batchRecvState: {}, batchProgress: {}, sendQueue: [], cancelledTransfers: new Set(), mySubnet: null, myV6: null, myAddressFamily: null, myPubHash: null, lobby: null, lobbyId: null, lobbyPeers: {}, peersByDid: {}, reconnectTimers: {}, sendGeneration: {}, rtcPeers: {}, ackCount: {}, pendingFiles: null });
  document.getElementById('send-target-overlay').classList.add('hidden');
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



let scanStream = null, scanInterval = null;

function showScanError(msg) {
  document.getElementById('scan-video').classList.add('hidden');
  document.querySelector('.scan-aim').classList.add('hidden');
  const el = document.getElementById('scan-error-msg');
  el.innerHTML = `<span class="scan-error-icon">📵</span>${msg}`;
  el.classList.remove('hidden');
  document.getElementById('scan-overlay').classList.remove('hidden');
}

async function startQRScan() {
  if (!('BarcodeDetector' in window)) {
    const code = prompt('QR scanning not supported — enter room code:');
    if (code?.trim().length === 6) enterRoom(code.trim().toUpperCase(), false);
    return;
  }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (err) {
    const denied = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError';
    showScanError(denied
      ? 'Camera access is blocked.\nEnable it in your browser or device settings, then try again.'
      : 'Could not access camera.\nMake sure a camera is available.');
    return;
  }
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
  document.getElementById('scan-video').classList.remove('hidden');
  document.querySelector('.scan-aim').classList.remove('hidden');
  const errEl = document.getElementById('scan-error-msg');
  errEl.classList.add('hidden');
  errEl.innerHTML = '';
}

document.getElementById('btn-scan-qr').addEventListener('click', startQRScan);
document.getElementById('btn-scan-close').addEventListener('click', stopQRScan);

let wakeLock = null;
document.getElementById('qr-canvas').addEventListener('click', async () => {
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



document.querySelector('.version-badge').addEventListener('click', () => {
  document.getElementById('changelog-overlay').classList.remove('hidden');
});
document.getElementById('btn-changelog-close').addEventListener('click', () => {
  document.getElementById('changelog-overlay').classList.add('hidden');
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });

document.getElementById('update-banner-reload')?.addEventListener('click', async () => {
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister()));
  }
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  location.reload();
});

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
    shareError('Invalid link — missing key');
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

if (typeof tippy !== 'undefined') {
  tippy('[title]', {
    theme: 'drop',
    placement: 'top',
    delay: [1500, 0],
    content(reference) {
      const title = reference.getAttribute('title');
      reference.removeAttribute('title');
      return title;
    }
  });
}

window.addEventListener('popstate', () => {
  const roomPathMatch = location.pathname.match(/^\/room\/([A-Z0-9]{6})$/i);
  if (!roomPathMatch) {
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.onerror = null;
      state.ws.close(1000);
      state.ws = null;
    }
    const sharePathMatch = location.pathname.match(/^\/share\/([A-Za-z0-9_-]{10,16})$/);
    if (sharePathMatch) {
      showView('share');
    } else {
      Object.values(state.reconnectTimers).forEach(clearTimeout);
      Object.values(state.rtcPeers).forEach(p => { try { p.dc?.close(); } catch {} try { p.pc.close(); } catch {} });
      Object.assign(state, { roomCode: null, myId: null, isCreator: false, reconnecting: false, peers: {}, requestQueue: [], activeRequest: null, decryptKeys: {}, recvState: {}, fileBatch: {}, batchRecvState: {}, batchProgress: {}, sendQueue: [], cancelledTransfers: new Set(), peersByDid: {}, reconnectTimers: {}, sendGeneration: {}, rtcPeers: {}, ackCount: {} });
      connectedResolve = null; connectedPromise = null;
      const list = document.getElementById('peers-list');
      if (list) {
        list.innerHTML = '';
        list.appendChild(noPeersEl);
      }
      const roomCodeSec = document.getElementById('room-code-section');
      if (roomCodeSec) roomCodeSec.style.display = 'none';
      const transfers = document.getElementById('transfers');
      if (transfers) transfers.innerHTML = '';
      const overlay = document.getElementById('overlay');
      if (overlay) overlay.classList.add('hidden');
      const lobbyOverlay = document.getElementById('lobby-overlay');
      if (lobbyOverlay) lobbyOverlay.classList.add('hidden');
      setDropEnabled(false);
      showView('home');
    }
  } else {
    const code = roomPathMatch[1].toUpperCase();
    if (state.roomCode !== code) {
      const savedCode = sessionStorage.getItem('drop-room');
      const wasCreator = sessionStorage.getItem('drop-creator') === '1';
      enterRoom(code, savedCode === code && wasCreator);
    }
  }
});

if (typeof APP_VERSION !== 'undefined') {
  const badge = document.getElementById('version-badge');
  if (badge) badge.textContent = APP_VERSION;
}

if (typeof CHANGELOG !== 'undefined') {
  const list = document.getElementById('changelog-list');
  if (list) {
    list.innerHTML = CHANGELOG.map(entry => `
      <div class="changelog-item" style="margin-bottom: 16px;">
        <strong style="color: var(--blue); font-size: 14px; display: block; margin-bottom: 4px;">${entry.version}</strong>
        <span style="font-size: 13px; color: var(--muted); line-height: 1.5; display: block;">
          ${entry.changes.map(c => '• ' + c).join('<br>')}
        </span>
      </div>
    `).join('');
  }
}

const savedTheme = localStorage.getItem('drop-theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);

const themeToggleCb = document.getElementById('theme-toggle-checkbox');
if (themeToggleCb) {
  themeToggleCb.checked = savedTheme === 'light';
  themeToggleCb.addEventListener('change', (e) => {
    const newTheme = e.target.checked ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('drop-theme', newTheme);
  });
}
