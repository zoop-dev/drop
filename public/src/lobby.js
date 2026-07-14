async function connectLobby() {
  const nick = nicknameInput.value.trim();
  if (!nick) { nicknameInput.focus(); return; }
  localStorage.setItem(SAVED_NICKNAME_KEY, nick);

  const ids = await getLocalNetworkIds();
  state.mySubnet = ids?.v4 ?? null;
  state.myV6 = ids?.v6 ?? null;
  state.myAddressFamily = computeAddressFamily(state.mySubnet, state.myV6);

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams({ nickname: nick });
  if (state.mySubnet) qs.set('subnet', state.mySubnet);
  if (state.myV6) qs.set('subnet6', state.myV6);
  qs.set('family', state.myAddressFamily);
  
  renderLocalFamilyChip();
  state.lobby = new WebSocket(`${proto}//${location.host}/ws/lobby?${qs}`);

  state.lobby.onmessage = (e) => handleLobbyMessage(JSON.parse(e.data));
  state.lobby.onclose = () => {
    state.lobby = null;
    state.lobbyId = null;
    state.mySubnet = null;
    state.myV6 = null;
    state.myAddressFamily = null;
    state.myPubHash = null;
    state.lobbyPeers = {};
    renderLobbyPeers();
    document.getElementById('lobby-section').classList.add('hidden');
    document.querySelectorAll('.nearby-toast').forEach(t => t.remove());
    document.getElementById('btn-go-public').textContent = 'Go public';
    document.getElementById('btn-go-public').classList.remove('active');
    nicknameInput.disabled = false;
  };
}

function disconnectLobby() {
  if (state.lobby) {
    state.lobby.onclose = null;
    state.lobby.close(1000);
    state.lobby = null;
  }
  state.lobbyId = null;
  state.mySubnet = null;
  state.myV6 = null;
  state.myAddressFamily = null;
  state.myPubHash = null;
  state.lobbyPeers = {};
  renderLobbyPeers();
  document.getElementById('lobby-section').classList.add('hidden');
  document.querySelectorAll('.nearby-toast').forEach(t => t.remove());
  const goPublicBtn = document.getElementById('btn-go-public');
  goPublicBtn.textContent = 'Go public';
  goPublicBtn.classList.remove('active');
  nicknameInput.disabled = false;
}

function handleLobbyMessage(msg) {
  switch (msg.type) {
    case 'lobby-welcome':
      state.lobbyId = msg.peerId;
      if (msg.pubHash) state.myPubHash = msg.pubHash;
      msg.peers.forEach(p => {
        state.lobbyPeers[p.id] = { nickname: p.nickname, subnet: p.subnet, subnet6: p.subnet6, family: p.family, pubHash: p.pubHash };
        if (isPeerNearby(p.subnet, p.subnet6, p.pubHash)) {
          showNearbyToast(p.id, p.nickname);
        }
      });
      renderLobbyPeers();
      document.getElementById('lobby-section').classList.remove('hidden');
      renderLocalFamilyChip();
      break;
    case 'lobby-peer-joined':
      state.lobbyPeers[msg.peerId] = { nickname: msg.nickname, subnet: msg.subnet, subnet6: msg.subnet6, family: msg.family, pubHash: msg.pubHash };
      renderLobbyPeers();
      if (isPeerNearby(msg.subnet, msg.subnet6, msg.pubHash)) showNearbyToast(msg.peerId, msg.nickname);
      break;
    case 'lobby-peer-left':
      delete state.lobbyPeers[msg.peerId];
      renderLobbyPeers();
      document.querySelectorAll(`.nearby-toast[data-peer-id="${msg.peerId}"]`).forEach(t => t.remove());
      break;
    case 'connect-request':
      if (state.pendingLobbyConnect) {
        state.lobby?.send(JSON.stringify({ type: 'connect-decline', to: msg.from }));
      } else {
        showLobbyConnectRequest(msg);
      }
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

function familyLabel(f) {
  return f === 'dual' ? 'Dual' : f === 'v4' ? 'IPv4' : f === 'v6' ? 'IPv6' : 'Unknown';
}

function familyTooltip(f) {
  if (f === 'dual') return 'Both IPv4 and IPv6 detected';
  if (f === 'v4') return 'IPv4 only — using IPv4 fallback for nearby matching';
  if (f === 'v6') return 'IPv6 only';
  return 'No network info detected';
}

function renderLocalFamilyChip() {
  const section = document.getElementById('lobby-section');
  if (!section) return;
  const existing = document.getElementById('lobby-family-chip');
  if (existing) existing.remove();
  if (!state.myAddressFamily || state.myAddressFamily === 'none') return;
  const chip = document.createElement('div');
  chip.id = 'lobby-family-chip';
  chip.className = 'lobby-family-chip family-' + state.myAddressFamily;
  chip.textContent = 'Detected: ' + familyLabel(state.myAddressFamily);
  chip.title = familyTooltip(state.myAddressFamily);
  section.prepend(chip);
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
    const isNearby = isPeerNearby(peer.subnet, peer.subnet6, peer.pubHash);
    const isPending = state.pendingLobbyConnect === id;
    const el = document.createElement('div');
    el.className = 'lobby-peer-card' + (isNearby ? ' nearby' : '');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'lobby-peer-name';
    nameSpan.textContent = peer.nickname;
    if (peer.family && peer.family !== 'none') {
      const famChip = document.createElement('span');
      famChip.className = 'family-chip family-' + peer.family;
      famChip.textContent = familyLabel(peer.family);
      famChip.title = familyTooltip(peer.family);
      nameSpan.appendChild(famChip);
    }
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
  if (typeof tippy !== 'undefined') {
    tippy('#lobby-list [title]', {
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
}

function showNearbyToast(peerId, nickname) {
  document.querySelectorAll('.nearby-toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'nearby-toast';
  el.dataset.peerId = peerId;
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
  if (!state.lobby || state.lobby.readyState !== WebSocket.OPEN) return;
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
  let code;
  try {
    const res = await fetch('/api/room', { method: 'POST' });
    code = (await res.json()).code;
  } catch {
    state.pendingLobbyConnect = null;
    return;
  }
  if (!state.lobby || state.lobby.readyState !== WebSocket.OPEN) {
    state.pendingLobbyConnect = null;
    return;
  }
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
