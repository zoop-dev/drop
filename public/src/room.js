const noPeersEl = document.getElementById('no-peers');
const noLobbyPeersEl = document.getElementById('no-lobby-peers');

if (!localStorage.getItem('drop-did')) localStorage.setItem('drop-did', crypto.randomUUID());
const myDeviceId = localStorage.getItem('drop-did');

function waitConnected() {
  if (state.ws?.readyState === WebSocket.OPEN && !state.reconnecting) return Promise.resolve();
  if (!connectedPromise) connectedPromise = new Promise(r => { connectedResolve = r; });
  return connectedPromise;
}

function resolveConnected() {
  if (connectedResolve) { connectedResolve(); connectedResolve = null; connectedPromise = null; }
}

async function waitForPeer(peerId, fileId, gen) {
  while (!state.peers[peerId]) {
    await new Promise(r => setTimeout(r, 200));
    if (state.sendGeneration[fileId] !== gen) return false;
  }
  return true;
}

function connect(code) {
  if (state.ws) { state.ws.onclose = null; state.ws.onerror = null; state.ws.close(); }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const uaInfo = getUAInfo();
  const pwh = state.roomPasswordHash ? `&pwh=${encodeURIComponent(state.roomPasswordHash)}` : '';
  state.ws = new WebSocket(`${proto}//${location.host}/ws/${code}?name=${encodeURIComponent(state.myName)}&ua=${encodeURIComponent(uaInfo)}&did=${encodeURIComponent(myDeviceId)}${pwh}`);
  state.ws.binaryType = 'arraybuffer';
  state.ws.onmessage = async (e) => {
    if (e.data instanceof ArrayBuffer) handleBinaryMessage(e.data);
    else handleMessage(JSON.parse(e.data));
  };
  state.ws.onerror = () => {};
  state.ws.onclose = (e) => {
    if (e.code === 1000 || e.code === 4001) return;
    state.reconnecting = true;
    renderPeers();
    if (state.roomCode && document.visibilityState === 'visible')
      setTimeout(() => { if (state.roomCode) connect(state.roomCode); }, 1000);
  };
}

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
      msg.peers.forEach(p => { addPeer(p.id, p.name, p.ua, p.did); send({ type: 'version-sync', to: p.id, v: APP_VERSION }); });
      if (!state.isCreator && msg.peers.length === 0)
        showRoomError('Room is empty — make sure the other device created the room first.');
      for (const [fileId, recv] of Object.entries(state.recvState)) {
        if (recv.received > 0 && recv.received < recv.total) {
          msg.peers.forEach(p => send({ type: 'resume-request', to: p.id, fileId, received: recv.received }));
        }
      }
      break;
    case 'peer-joined': addPeer(msg.peerId, msg.name, msg.ua, msg.did); if (rtcSupported()) initiateRtc(msg.peerId); send({ type: 'version-sync', to: msg.peerId, v: APP_VERSION }); break;
    case 'peer-left': removePeer(msg.peerId); break;
    case 'transfer-request': showIncomingRequest(msg); break;
    case 'batch-request': showIncomingRequest(msg); break;
    case 'transfer-accept': startSendingFile(msg.from, msg.fileId, 0); break;
    case 'resume-request': {
      const resumeEntry = state.sendQueue.find(e => e.fileId === msg.fileId);
      if (resumeEntry && !resumeEntry.done) startSendingFile(msg.from, msg.fileId, msg.received ?? 0);
      break;
    }
    case 'batch-accept': startSendingBatch(msg.from, msg.batchId); break;
    case 'chunk-ack': state.ackCount[msg.fileId] = msg.n; break;
    case 'version-sync': if (parseInt(APP_VERSION.slice(1)) < parseInt(msg.v.slice(1))) { const b = document.getElementById('update-banner'); if (b) b.classList.add('is-on'); } break;
    case 'rtc-offer': handleRtcOffer(msg); break;
    case 'rtc-answer': handleRtcAnswer(msg); break;
    case 'rtc-ice': handleRtcIce(msg); break;
    case 'transfer-decline': markTransferStatus(msg.fileId, 'Declined', 'transfer-error'); break;
    case 'batch-decline':
      state.sendQueue.filter(e => e.batchId === msg.batchId).forEach(e => markTransferStatus(e.fileId, 'Declined', 'transfer-error'));
      break;
    case 'transfer-error': markTransferStatus(msg.fileId, 'Transfer failed', 'transfer-error'); break;
    case 'transfer-cancel':
      delete state.decryptKeys[msg.fileId];
      delete state.recvState[msg.fileId];
      delete state.fileBatch[msg.fileId];
      state.requestQueue = state.requestQueue.filter(r => r.fileId !== msg.fileId);
      if (state.activeRequest?.fileId === msg.fileId) {
        state.activeRequest = null;
        drainRequestQueue();
      }
      markTransferStatus(msg.fileId, 'Cancelled', '');
      break;
    case 'text': await receiveText(msg); break;
    case 'auth-error': {
      const failedCode = state.roomCode;
      state.ws.onclose = null;
      state.ws.close();
      state.roomCode = null;
      state.roomPasswordHash = null;
      state.roomPassword = null;
      document.getElementById('code-input').value = failedCode ?? '';
      const pwErr = document.getElementById('join-pw-error');
      const pwInput = document.getElementById('join-password-input');
      pwErr.classList.remove('hidden');
      pwInput.value = '';
      showView('join');
      setTimeout(() => pwInput.focus(), 50);
      break;
    }
  }
}

function addPeer(id, name, ua, did) {
  const oldId = did ? state.peersByDid[did] : null;
  if (oldId && oldId !== id && state.reconnectTimers[oldId]) {
    clearTimeout(state.reconnectTimers[oldId]);
    delete state.reconnectTimers[oldId];
    state.sendQueue.forEach(entry => {
      if (entry.pendingTargets.has(oldId)) {
        entry.pendingTargets.delete(oldId);
        entry.pendingTargets.add(id);
      }
    });
    for (const [fileId, recv] of Object.entries(state.recvState)) {
      if (recv.received > 0 && recv.received < recv.total) {
        send({ type: 'resume-request', to: id, fileId, received: recv.received });
      }
    }
  }
  state.peers[id] = { name, ua: ua || '', did: did || '' };
  if (did) state.peersByDid[did] = id;
  renderPeers();
  if (state.pendingShareFiles?.length && Object.keys(state.peers).length === 1) {
    const files = state.pendingShareFiles;
    state.pendingShareFiles = null;
    document.getElementById('share-banner')?.remove();
    pickTargetsAndSend(files);
  }
}

function removePeer(id) {
  cleanupRtcPeer(id);
  const peer = state.peers[id];
  state.sendQueue.forEach(entry => {
    if (entry.pendingTargets.has(id)) markTransferStatus(entry.fileId, 'Reconnecting...', '');
  });
  state.reconnectTimers[id] = setTimeout(() => {
    delete state.reconnectTimers[id];
    if (peer?.did) delete state.peersByDid[peer.did];
    state.sendQueue.forEach(entry => {
      if (entry.pendingTargets.has(id)) {
        markTransferStatus(entry.fileId, 'Connection lost', 'transfer-error');
        entry.pendingTargets.delete(id);
      }
      if (entry.activeSendTarget === id && !entry.done) {
        state.sendGeneration[entry.fileId] = (state.sendGeneration[entry.fileId] ?? 0) + 1;
        markTransferStatus(entry.fileId, 'Connection lost', 'transfer-error');
        entry.activeSendTarget = null;
        entry.done = true;
      }
    });
    state.requestQueue = [];
    state.activeRequest = null;
    document.getElementById('overlay')?.classList.add('hidden');
  }, 7000);
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
    
    const infoDiv = document.createElement('div');
    infoDiv.className = 'peer-info';
    
    const nameSpan = document.createElement('span');
    nameSpan.className = 'peer-name';
    nameSpan.textContent = state.peers[id].name;
    infoDiv.appendChild(nameSpan);
    
    if (state.peers[id].ua) {
      const uaSpan = document.createElement('span');
      uaSpan.className = 'peer-ua';
      uaSpan.textContent = state.peers[id].ua;
      infoDiv.appendChild(uaSpan);
    }
    
    const statusSpan = document.createElement('span');
    if (state.reconnecting) {
      statusSpan.className = 'peer-status reconnecting-status';
      statusSpan.textContent = 'Reconnecting...';
    } else {
      statusSpan.className = 'peer-status';
      const dot = document.createElement('span');
      const p2p = state.rtcPeers[id]?.ready;
      dot.className = p2p ? 'dot dot--p2p' : 'dot';
      statusSpan.appendChild(dot);
      statusSpan.append(p2p ? ' P2P' : ' Connected');
    }
    el.appendChild(infoDiv);
    el.appendChild(statusSpan);

    el.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); el.classList.add('drag-over'); dropZone.classList.remove('dragging'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', async e => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drag-over');
      if (state.reconnecting) return;
      const items = Array.from(e.dataTransfer.items || []);
      const filesToQueue = [];
      for (const item of items) {
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry && entry.isDirectory) {
          const zipFile = await zipFolder(entry);
          if (zipFile) filesToQueue.push(zipFile);
        } else {
          const file = item.getAsFile();
          if (file) filesToQueue.push(file);
        }
      }
      if (filesToQueue.length) queueFiles(filesToQueue, [id]);
    });

    list.appendChild(el);
  });
  setDropEnabled(!state.reconnecting);
}

function setDropEnabled(enabled) {
  const dz = document.getElementById('drop-zone');
  dz.classList.toggle('disabled', !enabled);
  dz.classList.toggle('has-peers', enabled);
  
  const sub = document.getElementById('drop-sub');
  if (enabled) {
    sub.innerHTML = `or click to browse <button class="browse-link" id="btn-browse-folder">folders</button>`;
    document.getElementById('btn-browse-folder').addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('folder-input').click();
    });
  } else {
    sub.textContent = 'Connect a device first';
  }
  
  document.getElementById('text-send-bar').classList.toggle('disabled', !enabled);
}

function addTransferItem(fileId, filename, size, direction, peerName) {
  const el = document.createElement('div');
  el.className = 'transfer-item';
  el.id = 'transfer-' + fileId;

  el.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('a')) return;
    if (el.classList.contains('collapsed')) {
      collapseCompletedTransfers();
      el.classList.remove('collapsed');
    } else {
      el.classList.add('collapsed');
    }
  });

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
      const entry = state.sendQueue.find(e => e.fileId === fileId);
      if (entry && entry.pendingTargets.size > 0 && !entry.done) {
        entry.pendingTargets.forEach(peerId => send({ type: 'transfer-cancel', to: peerId, fileId }));
        entry.pendingTargets.clear();
        entry.done = true;
        cancelBtn.remove();
        markTransferStatus(fileId, 'Cancelled', '');
      } else {
        state.cancelledTransfers.add(fileId);
        cancelBtn.remove();
        markTransferStatus(fileId, 'Cancelling...', '');
      }
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
  collapseCompletedTransfers();
}

function updateProgress(fileId, pct, statusText) {
  let batchId = state.fileBatch[fileId];
  let fileSize = 0;
  let isSend = false;
  
  if (!batchId) {
    const entry = state.sendQueue.find(e => e.fileId === fileId);
    if (entry && entry.batchId) {
      batchId = entry.batchId;
      fileSize = entry.file.size;
      isSend = true;
    }
  } else {
    const bs = state.batchRecvState[batchId];
    if (bs && bs.sizes) {
      fileSize = bs.sizes[fileId] || 0;
    }
  }
  
  if (batchId) {
    if (!state.batchProgress[batchId]) {
      state.batchProgress[batchId] = { files: {}, completedFiles: new Set(), completedCount: 0 };
    }
    const bytesTransferred = (pct / 100) * fileSize;
    state.batchProgress[batchId].files[fileId] = bytesTransferred;
    
    let totalSize = 0;
    if (isSend) {
      const entries = state.sendQueue.filter(e => e.batchId === batchId);
      totalSize = entries.reduce((acc, e) => acc + e.file.size, 0);
    } else {
      const bs = state.batchRecvState[batchId];
      totalSize = bs ? bs.totalSize : 0;
    }
    
    const totalTransferred = Object.values(state.batchProgress[batchId].files).reduce((acc, val) => acc + val, 0);
    const aggregatePct = totalSize > 0 ? Math.min(100, (totalTransferred / totalSize) * 100) : pct;
    
    let displayStatus = statusText || (isSend ? 'Sending...' : 'Receiving...');
    if (state.batchProgress[batchId].completedCount > 0) {
      const totalCount = isSend ? state.sendQueue.filter(e => e.batchId === batchId).length : state.batchRecvState[batchId].total;
      displayStatus = `${isSend ? 'Sending' : 'Receiving'} (${state.batchProgress[batchId].completedCount}/${totalCount})...`;
    }
    
    updateBatchProgress(batchId, aggregatePct, displayStatus);
    return;
  }

  const el = document.getElementById('transfer-' + fileId);
  if (!el) return;
  el.querySelector('.progress-fill').style.width = pct + '%';
  if (statusText) el.querySelector('.status-text').textContent = statusText;
  el.querySelector('.pct-text').textContent = pct < 100 ? Math.round(pct) + '%' : '';
}

function setTransferStats(fileId, totalSecs, avgBps) {
  const el = document.getElementById('transfer-' + fileId);
  if (!el) return;
  const stats = document.createElement('div');
  stats.className = 'transfer-stats';
  stats.textContent = fmtETA(totalSecs) + ' · ' + fmtSpeed(avgBps);
  const pb = el.querySelector('.progress-bar');
  if (pb) pb.after(stats);
}

function markTransferStatus(fileId, label, cls) {
  const entry = state.sendQueue.find(e => e.fileId === fileId);
  const batchId = entry?.batchId;
  if (batchId) {
    if (!state.batchProgress[batchId]) {
      state.batchProgress[batchId] = { files: {}, completedFiles: new Set(), completedCount: 0 };
    }
    if (label === 'Sent' || cls === 'transfer-error') {
      if (!state.batchProgress[batchId].completedFiles) {
        state.batchProgress[batchId].completedFiles = new Set();
      }
      if (!state.batchProgress[batchId].completedFiles.has(fileId)) {
        state.batchProgress[batchId].completedFiles.add(fileId);
        state.batchProgress[batchId].completedCount = state.batchProgress[batchId].completedFiles.size;
      }
    }
    const count = state.sendQueue.filter(e => e.batchId === batchId).length;
    const completed = state.batchProgress[batchId].completedCount;
    if (completed >= count) {
      markBatchStatus(batchId, 'Sent', 'transfer-done');
    } else {
      updateBatchStatusText(batchId, `Sending (${completed}/${count})...`);
    }
    return;
  }

  const el = document.getElementById('transfer-' + fileId);
  if (!el) return;
  const s = el.querySelector('.status-text');
  if (!s) return;
  s.className = 'status-text ' + (cls || '');
  s.textContent = label;
  const pctEl = el.querySelector('.pct-text');
  if (pctEl) pctEl.textContent = '';
  
  if (cls === 'transfer-done' || cls === 'transfer-error' || label === 'Cancelled') {
    const cancelBtn = el.querySelector('.btn-cancel-xfer');
    if (cancelBtn) cancelBtn.remove();
  }
  collapseCompletedTransfers();
}

function addBatchTransferItem(batchId, count, totalSize, direction, peerName) {
  const el = document.createElement('div');
  el.className = 'transfer-item';
  el.id = 'transfer-batch-' + batchId;
  el.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('a')) return;
    if (el.classList.contains('collapsed')) {
      collapseCompletedTransfers();
      el.classList.remove('collapsed');
    } else {
      el.classList.add('collapsed');
    }
  });
  const header = document.createElement('div');
  header.className = 'transfer-header';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'transfer-name';
  nameSpan.textContent = `${count} files`;
  const headerRight = document.createElement('span');
  headerRight.className = 'transfer-header-right';
  const sizeSpan = document.createElement('span');
  sizeSpan.className = 'transfer-size';
  sizeSpan.textContent = fmtSize(totalSize);
  headerRight.appendChild(sizeSpan);
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
  collapseCompletedTransfers();
}

function updateBatchProgress(batchId, pct, statusText) {
  const el = document.getElementById('transfer-batch-' + batchId);
  if (!el) return;
  el.querySelector('.progress-fill').style.width = pct + '%';
  if (statusText) el.querySelector('.status-text').textContent = statusText;
  el.querySelector('.pct-text').textContent = pct < 100 ? Math.round(pct) + '%' : '';
}

function updateBatchStatusText(batchId, statusText) {
  const el = document.getElementById('transfer-batch-' + batchId);
  if (!el) return;
  el.querySelector('.status-text').textContent = statusText;
}

function markBatchStatus(batchId, label, cls) {
  const el = document.getElementById('transfer-batch-' + batchId);
  if (!el) return;
  const s = el.querySelector('.status-text');
  s.className = 'status-text ' + (cls || '');
  s.textContent = label;
  el.querySelector('.pct-text').textContent = '';
  el.querySelector('.progress-fill').style.width = '100%';
  collapseCompletedTransfers();
}

function collapseCompletedTransfers() {
  const container = document.getElementById('transfers');
  if (!container) return;
  const items = Array.from(container.children);
  items.forEach((item, index) => {
    if (index === 0) {
      item.classList.remove('collapsed');
      return;
    }
    const statusTextEl = item.querySelector('.status-text');
    if (statusTextEl && (statusTextEl.classList.contains('transfer-done') || statusTextEl.classList.contains('transfer-error') || statusTextEl.textContent === 'Cancelled')) {
      item.classList.add('collapsed');
    } else {
      item.classList.remove('collapsed');
    }
  });
}

function markTransferReceived(fileId, filename, blobUrl, mimeType) {
  const batchId = state.fileBatch[fileId];
  if (batchId && state.batchRecvState[batchId]) {
    const bs = state.batchRecvState[batchId];
    if (!state.batchProgress[batchId]) {
      state.batchProgress[batchId] = { files: {}, completedFiles: new Set(), completedCount: 0 };
    }
    if (!state.batchProgress[batchId].completedFiles.has(fileId)) {
      state.batchProgress[batchId].completedFiles.add(fileId);
      state.batchProgress[batchId].completedCount = state.batchProgress[batchId].completedFiles.size;
    }
    bs.blobs.push({ filename, blobUrl });
    
    updateBatchStatusText(batchId, `Receiving (${bs.blobs.length}/${bs.total})...`);
    
    if (bs.blobs.length >= bs.total) {
      const blobs = bs.blobs.slice();
      const totalSize = bs.totalSize;
      delete state.batchRecvState[batchId];
      
      const progressCard = document.getElementById('transfer-batch-' + batchId);
      if (progressCard) progressCard.remove();
      
      const wrap = document.createElement('div');
      wrap.className = 'transfer-item batch-done';
      wrap.innerHTML = `<div class="transfer-header"><span class="transfer-name">${blobs.length} files ready</span><span class="transfer-size">${fmtSize(totalSize)}</span></div><div class="transfer-footer"><span class="status-text transfer-done">All received</span><button class="download-btn" id="save-all-${batchId}">Save all</button></div>`;
      wrap.querySelector('.download-btn').addEventListener('click', () => {
        blobs.forEach((b, i) => setTimeout(() => {
          const a = document.createElement('a');
          a.href = b.blobUrl; a.download = b.filename; a.click();
          setTimeout(() => URL.revokeObjectURL(b.blobUrl), 1000);
        }, i * 400));
      });
      wrap.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('a')) return;
        if (wrap.classList.contains('collapsed')) {
          collapseCompletedTransfers();
          wrap.classList.remove('collapsed');
        } else {
          wrap.classList.add('collapsed');
        }
      });
      document.getElementById('transfers').prepend(wrap);
    }
    delete state.fileBatch[fileId];
    collapseCompletedTransfers();
    return;
  }

  const el = document.getElementById('transfer-' + fileId);
  if (!el) return;
  el.querySelector('.progress-fill').style.width = '100%';
  incUnread();
  const isImage = mimeType?.startsWith('image/');
  if (isImage) {
    const thumb = document.createElement('img');
    thumb.className = 'transfer-thumb';
    thumb.src = blobUrl;
    thumb.alt = filename;
    el.querySelector('.progress-bar').after(thumb);
  }
  let footer = el.querySelector('.transfer-footer');
  if (!footer) {
    footer = document.createElement('div');
    footer.className = 'transfer-footer';
    el.appendChild(footer);
  }
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
  
  delete state.fileBatch[fileId];
  collapseCompletedTransfers();
}

function showRoomError(msg) {
  document.getElementById('peers-list').innerHTML = `<div class="room-error">${msg}</div>`;
  setDropEnabled(false);
}


function pickTargetsAndSend(files) {
  const peerIds = Object.keys(state.peers);
  if (peerIds.length <= 1) { queueFiles(files, peerIds); return; }

  state.pendingFiles = files;
  const listEl = document.getElementById('send-target-list');
  listEl.innerHTML = '';
  peerIds.forEach(id => {
    const peer = state.peers[id];
    const row = document.createElement('div');
    row.className = 'send-target-peer';
    row.dataset.peerId = id;
    row.innerHTML = `
      <div class="send-target-check">
        <svg viewBox="0 0 12 10" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="10">
          <polyline points="1 5 4.5 8.5 11 1"></polyline>
        </svg>
      </div>
      <div>
        <div class="send-target-peer-name">${peer.name}</div>
        ${peer.ua ? `<div class="send-target-peer-ua">${peer.ua}</div>` : ''}
      </div>`;
    row.addEventListener('click', () => {
      row.classList.toggle('selected');
      updateSendConfirmBtn();
    });
    listEl.appendChild(row);
  });

  updateSendConfirmBtn();
  document.getElementById('send-target-overlay').classList.remove('hidden');
}

function updateSendConfirmBtn() {
  const selected = document.querySelectorAll('#send-target-list .send-target-peer.selected');
  document.getElementById('btn-send-target-confirm').disabled = selected.length === 0;
}

document.getElementById('btn-send-target-confirm').addEventListener('click', () => {
  const selected = Array.from(document.querySelectorAll('#send-target-list .send-target-peer.selected'));
  const peerIds = selected.map(el => el.dataset.peerId);
  document.getElementById('send-target-overlay').classList.add('hidden');
  if (state.pendingFiles && peerIds.length) queueFiles(state.pendingFiles, peerIds);
  state.pendingFiles = null;
});

document.getElementById('btn-send-target-all').addEventListener('click', () => {
  document.getElementById('send-target-overlay').classList.add('hidden');
  if (state.pendingFiles) queueFiles(state.pendingFiles);
  state.pendingFiles = null;
});

document.getElementById('btn-send-target-cancel').addEventListener('click', () => {
  document.getElementById('send-target-overlay').classList.add('hidden');
  state.pendingFiles = null;
});

async function queueFiles(files, peerIds = Object.keys(state.peers)) {
  if (!peerIds.length) return;
  
  if (files.length > 1) {
    const batchId = crypto.randomUUID();
    const batchEntries = [];
    for (const file of files) {
      const fileId = crypto.randomUUID();
      const key = await generateKey();
      const keyB64 = await exportKey(key);
      state.sendQueue.push({ file, fileId, key, batchId, pendingTargets: new Set(peerIds), prepared: false, srcBuf: null, compressed: false, done: false });
      batchEntries.push({ fileId, filename: file.name, size: file.size, mimeType: file.type || 'application/octet-stream', key: keyB64 });
    }
    const totalSize = files.reduce((s, f) => s + f.size, 0);
    peerIds.forEach(peerId => {
      send({ type: 'batch-request', to: peerId, batchId, files: batchEntries, count: files.length, totalSize });
      addBatchTransferItem(batchId, files.length, totalSize, 'send', state.peers[peerId]?.name ?? peerId);
    });
  } else {
    const file = files[0];
    for (const peerId of peerIds) {
      const fileId = crypto.randomUUID();
      const key = await generateKey();
      const keyB64 = await exportKey(key);
      state.sendQueue.push({ file, fileId, key, pendingTargets: new Set([peerId]), prepared: false, srcBuf: null, compressed: false, done: false });
      send({ type: 'transfer-request', to: peerId, fileId, filename: file.name, size: file.size, mimeType: file.type || 'application/octet-stream', key: keyB64 });
      addTransferItem(fileId, file.name, file.size, 'send', state.peers[peerId]?.name ?? peerId);
    }
  }
}

async function startSendingFile(fromPeerId, fileId, fromChunk = 0) {
  const entry = state.sendQueue.find(e => e.fileId === fileId);
  if (!entry) return;
  entry.pendingTargets.delete(fromPeerId);

  state.sendGeneration[fileId] = (state.sendGeneration[fileId] ?? 0) + 1;
  const gen = state.sendGeneration[fileId];

  const { file, key } = entry;
  const mimeType = file.type || 'application/octet-stream';

  if (!entry.prepared) {
    if (isCompressible(mimeType, file.size)) {
      updateProgress(fileId, 0, 'Compressing 0%');
      try {
        entry.srcBuf = await compressBuffer(await file.arrayBuffer(), (pct) => {
          updateProgress(fileId, Math.round(pct * 100), `Compressing ${Math.round(pct * 100)}%`);
        });
        entry.compressed = true;
      } catch {}
    }
    entry.prepared = true;
  }
  const srcBuf = entry.srcBuf;
  const compressed = entry.compressed;

  const totalBytes = srcBuf ? srcBuf.byteLength : file.size;
  const total = Math.ceil(totalBytes / CHUNK_SIZE);
  let offset = fromChunk * CHUNK_SIZE;
  let index = fromChunk;
  entry.total = total;
  entry.activeSendTarget = fromPeerId;
  if (fromChunk === 0) state.ackCount[fileId] = 0;
  const approxPct = Math.min(99, (offset / totalBytes) * 100);
  updateProgress(fileId, fromChunk > 0 ? approxPct : 0, fromChunk > 0 ? 'Resuming...' : 'Uploading...');
  const startTime = Date.now();

  try {
    while (offset < totalBytes) {
      if (state.sendGeneration[fileId] !== gen) return;
      if (state.cancelledTransfers.has(fileId)) {
        state.cancelledTransfers.delete(fileId);
        send({ type: 'transfer-cancel', to: fromPeerId, fileId });
        markTransferStatus(fileId, 'Cancelled', '');
        entry.activeSendTarget = null;
        return;
      }
      await waitConnected();
      if (!state.peers[fromPeerId]) {
        updateProgress(fileId, Math.min(99, (state.ackCount[fileId] || 0) / total * 100), 'Waiting...');
        const ok = await waitForPeer(fromPeerId, fileId, gen);
        if (!ok) return;
      }
      if (state.sendGeneration[fileId] !== gen) return;
      const buffer = srcBuf ? srcBuf.slice(offset, offset + CHUNK_SIZE)
                            : await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      const { iv, data } = await encryptChunkRaw(key, buffer);
      const meta = index === 0 ? { filename: file.name, size: file.size, mimeType } : null;
      await sendBinaryChunk(fromPeerId, fileId, index, total, iv, data, compressed, meta);
      offset += buffer.byteLength;
      index++;
      const elapsed = (Date.now() - startTime) / 1000 || 0.001;
      const bytesSent = offset - fromChunk * CHUNK_SIZE;
      const speed = bytesSent / elapsed;
      const eta = (totalBytes - offset) / speed;
      updateProgress(fileId, Math.min(99, index / total * 100),
        fmtSpeed(speed) + (eta > 1 ? ` · ${fmtETA(eta)}` : ''));
      await new Promise(r => setTimeout(r, 0));
    }
    const uploadElapsed = (Date.now() - startTime) / 1000 || 0.001;
    const bytesSent = totalBytes - fromChunk * CHUNK_SIZE;
    entry.srcBuf = null;
    send({ type: 'transfer-complete', to: fromPeerId, fileId });
    updateProgress(fileId, Math.min(99, (state.ackCount[fileId] || 0) / total * 100), 'Transferring...');
    while ((state.ackCount[fileId] || 0) < total) {
      await new Promise(r => setTimeout(r, 50));
      if (state.sendGeneration[fileId] !== gen) return;
      updateProgress(fileId, Math.min(99, (state.ackCount[fileId] || 0) / total * 100), 'Transferring...');
    }
    setTransferStats(fileId, uploadElapsed, bytesSent / uploadElapsed);
    markTransferStatus(fileId, 'Sent', 'transfer-done');
    entry.activeSendTarget = null;
    entry.done = true;
    delete state.ackCount[fileId];
  } catch {
    send({ type: 'transfer-error', to: fromPeerId, fileId });
    markTransferStatus(fileId, 'Failed to send', 'transfer-error');
    entry.srcBuf = null;
    entry.activeSendTarget = null;
    entry.done = true;
    delete state.ackCount[fileId];
  }
}

async function startSendingBatch(fromPeerId, batchId) {
  const entries = state.sendQueue.filter(e => e.batchId === batchId && e.pendingTargets.has(fromPeerId));
  for (const entry of entries) {
    await startSendingFile(fromPeerId, entry.fileId);
  }
}

async function enterRoom(code, isCreator, showCode = true) {
  disconnectLobby();
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

  const viewRoom = document.getElementById('view-room');
  if (isCreator && showCode) {
    viewRoom.classList.remove('no-code');
    const section = document.getElementById('room-code-section');
    section.style.display = '';
    document.getElementById('room-code-text').textContent = state.roomCode;
    const pwSuffix = state.roomPassword ? `#pw=${encodeURIComponent(state.roomPassword)}` : '';
    const joinUrl = `${location.origin}?join=${state.roomCode}${pwSuffix}`;
    const qr = DROP_QR.encode(joinUrl);
    if (qr) {
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.getElementById('qr-canvas');
      DROP_QR.render(canvas, qr, Math.round(6 * dpr), Math.round(2 * dpr));
      canvas.style.width = canvas.style.height = `${canvas.width / dpr}px`;
      const fsCanvas = document.getElementById('qr-fullscreen-canvas');
      DROP_QR.render(fsCanvas, qr, 20, 4);
    }
    const copyBtn = document.getElementById('copy-btn');
    if (copyBtn) copyBtn.onclick = () => {
      navigator.clipboard.writeText(joinUrl).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 2000);
      });
    };
  } else {
    viewRoom.classList.add('no-code');
    document.getElementById('room-code-section').style.display = 'none';
  }
}

async function sendBinaryChunk(toPeerId, fileId, index, total, iv, ciphertext, compressed, meta) {
  const metaBytes = meta ? new TextEncoder().encode(JSON.stringify(meta)) : null;
  const flags = (compressed ? 1 : 0) | (meta ? 2 : 0);
  const headerSize = 53 + (metaBytes ? 2 + metaBytes.length : 0);
  const frame = new Uint8Array(headerSize + ciphertext.byteLength);
  const dv = new DataView(frame.buffer);
  let o = 0;
  const rtcPeer = state.rtcPeers[toPeerId];
  const useDC = rtcPeer?.ready && rtcPeer.dc?.readyState === 'open' && state.myId;
  frame.set(uuidToBytes(useDC ? state.myId : toPeerId), o); o += 16;
  frame.set(uuidToBytes(fileId), o); o += 16;
  dv.setUint32(o, index, false); o += 4;
  dv.setUint32(o, total, false); o += 4;
  frame[o] = flags; o += 1;
  frame.set(iv, o); o += 12;
  if (metaBytes) { dv.setUint16(o, metaBytes.length, false); o += 2; frame.set(metaBytes, o); o += metaBytes.length; }
  frame.set(new Uint8Array(ciphertext), o);
  if (useDC) {
    while (rtcPeer.dc.bufferedAmount > DC_BUFFER_HIGH) await new Promise(r => setTimeout(r, 10));
    rtcPeer.dc.send(frame.buffer);
  } else if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(frame.buffer);
  }
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
    state.recvState[fileId] = { name: meta.filename, size: meta.size, mimeType: meta.mimeType, compressed, chunks: [], received: 0, total, startTime: Date.now() };
    if (!state.fileBatch[fileId] && !document.getElementById('transfer-' + fileId)) {
      addTransferItem(fileId, meta.filename, meta.size, 'recv', state.peers[from]?.name ?? from);
    }
  }
  const recv = state.recvState[fileId];
  if (!recv) return;
  try {
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, state.decryptKeys[fileId], ciphertext);
    recv.chunks[index] = decrypted;
    recv.received++;
    if (recv.received % 50 === 0 || recv.received >= total) {
      send({ type: 'chunk-ack', to: from, fileId, n: recv.received });
    }
    const recvPct = recv.received / total;
    const recvElapsed = (Date.now() - recv.startTime) / 1000 || 0.001;
    const recvSpeed = (recvPct * recv.size) / recvElapsed;
    const recvEta = ((1 - recvPct) * recv.size) / recvSpeed;
    updateProgress(fileId, recvPct * 100, fmtSpeed(recvSpeed) + (recvEta > 1 ? ` · ${fmtETA(recvEta)}` : ''));
    if (recv.received >= total) {
      const ordered = Array.from({ length: total }, (_, i) => recv.chunks[i]);
      if (ordered.some(c => !c)) {
        markTransferStatus(fileId, 'Transfer incomplete — retry', 'transfer-error');
        delete state.recvState[fileId];
        delete state.decryptKeys[fileId];
        return;
      }
      let blob;
      try {
        if (recv.compressed) {
          const combined = await new Blob(ordered.map(c => new Uint8Array(c))).arrayBuffer();
          blob = new Blob([await decompressBuffer(combined)], { type: recv.mimeType });
        } else {
          blob = new Blob(ordered.map(c => new Uint8Array(c)), { type: recv.mimeType });
        }
      } catch {
        markTransferStatus(fileId, 'Failed to assemble file', 'transfer-error');
        delete state.recvState[fileId];
        delete state.decryptKeys[fileId];
        return;
      }
      const recvElapsedTotal = (Date.now() - recv.startTime) / 1000 || 0.001;
      setTransferStats(fileId, recvElapsedTotal, recv.size / recvElapsedTotal);
      markTransferReceived(fileId, recv.name, URL.createObjectURL(blob), recv.mimeType);
      delete state.recvState[fileId];
      delete state.decryptKeys[fileId];
    }
  } catch {
    markTransferStatus(fileId, 'Decryption failed', 'transfer-error');
    delete state.recvState[fileId];
    delete state.decryptKeys[fileId];
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
  if (!isMine) incUnread();
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

dropZone.addEventListener('click', (e) => {
  if (e.target.closest('.browse-link')) return;
  if (state.roomCode && Object.keys(state.peers).length) {
    fileInput.click();
  }
});

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragging'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));

dropZone.addEventListener('drop', async e => {
  e.preventDefault();
  dropZone.classList.remove('dragging');
  
  const items = Array.from(e.dataTransfer.items || []);
  if (items.length) {
    const filesToQueue = [];
    const sub = document.getElementById('drop-sub');
    const originalText = sub.textContent;
    
    sub.textContent = 'Processing...';
    
    try {
      for (const item of items) {
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry && entry.isDirectory) {
          sub.textContent = `Zipping "${entry.name}"...`;
          const zipFile = await zipFolder(entry);
          if (zipFile) filesToQueue.push(zipFile);
        } else {
          const file = item.getAsFile();
          if (file) filesToQueue.push(file);
        }
      }
    } catch {
      alert('Failed to process dropped directory.');
    } finally {
      sub.textContent = originalText;
    }
    
    if (filesToQueue.length) pickTargetsAndSend(filesToQueue);
  }
});

async function getFilesFromEntry(entry) {
  const files = [];
  
  async function traverse(item, currentPath = '') {
    if (item.isFile) {
      const file = await new Promise((resolve, reject) => {
        item.file(resolve, reject);
      });
      file.relativePath = currentPath + item.name;
      files.push(file);
    } else if (item.isDirectory) {
      const dirReader = item.createReader();
      const entries = await new Promise((resolve) => {
        const allEntries = [];
        const readBatch = () => {
          dirReader.readEntries((batch) => {
            if (batch.length === 0) {
              resolve(allEntries);
            } else {
              allEntries.push(...batch);
              readBatch();
            }
          }, () => resolve(allEntries));
        };
        readBatch();
      });
      
      for (const child of entries) {
        await traverse(child, currentPath + item.name + '/');
      }
    }
  }
  
  await traverse(entry);
  return files;
}

async function zipFolder(folderEntry) {
  const files = await getFilesFromEntry(folderEntry);
  if (files.length === 0) return null;
  
  const zip = new JSZip();
  files.forEach(file => {
    zip.file(file.relativePath, file);
  });
  
  const content = await zip.generateAsync({ type: 'blob' });
  const zipName = folderEntry.name + '.zip';
  return new File([content], zipName, { type: 'application/zip' });
}

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) pickTargetsAndSend(Array.from(fileInput.files));
  fileInput.value = '';
});

const folderInput = document.getElementById('folder-input');
folderInput.addEventListener('change', async () => {
  if (folderInput.files.length) {
    const sub = document.getElementById('drop-sub');
    const originalText = sub.innerHTML;
    sub.textContent = 'Zipping folder...';
    try {
      const filesToQueue = await processSelectedFiles(folderInput.files);
      if (filesToQueue.length) pickTargetsAndSend(filesToQueue);
    } catch (err) {
      alert('Failed to process selected folder.');
    } finally {
      sub.innerHTML = originalText;
      document.getElementById('btn-browse-folder').addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('folder-input').click();
      });
    }
  }
  folderInput.value = '';
});


const nicknameInput = document.getElementById('nickname-input');
nicknameInput.value = localStorage.getItem(SAVED_NICKNAME_KEY) || '';
nicknameInput.addEventListener('input', () => localStorage.setItem(SAVED_NICKNAME_KEY, nicknameInput.value.trim()));

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
  try {
    if (msg.type === 'batch-request') {
      const keys = await Promise.all(msg.files.map(f => importKey(f.key)));
      if (!state.peers[msg.from]) return;
      state.batchRecvState[msg.batchId] = {
        total: msg.files.length,
        blobs: [],
        sizes: {},
        filenames: {},
        totalSize: msg.totalSize
      };
      msg.files.forEach((f, i) => {
        state.decryptKeys[f.fileId] = keys[i];
        state.fileBatch[f.fileId] = msg.batchId;
        state.batchRecvState[msg.batchId].sizes[f.fileId] = f.size;
        state.batchRecvState[msg.batchId].filenames[f.fileId] = f.filename;
      });
      addBatchTransferItem(msg.batchId, msg.files.length, msg.totalSize, 'recv', peerName);
      await waitConnected();
      send({ type: 'batch-accept', to: msg.from, batchId: msg.batchId });
    } else {
      state.decryptKeys[msg.fileId] = await importKey(msg.key);
      if (!state.peers[msg.from]) { delete state.decryptKeys[msg.fileId]; return; }
      addTransferItem(msg.fileId, msg.filename, msg.size, 'recv', peerName);
      await waitConnected();
      send({ type: 'transfer-accept', to: msg.from, fileId: msg.fileId });
    }
  } catch {
    if (msg.type !== 'batch-request') {
      delete state.decryptKeys[msg.fileId];
      document.getElementById('transfer-' + msg.fileId)?.remove();
    }
    state.requestQueue.push(msg);
    if (!state.activeRequest) drainRequestQueue();
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
  
  const peerName = state.peers[msg.from]?.name ?? msg.from;
  const overlay = document.getElementById('overlay');
  const reqDesc = document.getElementById('req-desc');
  const reqDetails = document.getElementById('req-details');
  const badge = document.getElementById('req-badge');
  
  if (msg.type === 'batch-request') {
    reqDesc.textContent = `${peerName} wants to send you ${msg.count} files`;
    reqDetails.textContent = fmtSize(msg.totalSize);
  } else {
    reqDesc.textContent = `${peerName} wants to send you a file`;
    reqDetails.textContent = `${msg.filename} (${fmtSize(msg.size)})`;
  }
  
  if (badge) {
    if (queued > 0) {
      badge.textContent = `+${queued} more`;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }
  
  overlay.classList.remove('hidden');
}
document.getElementById('btn-accept').addEventListener('click', async () => {
  const msg = state.activeRequest;
  if (!msg) return;
  const peerName = state.peers[msg.from]?.name ?? msg.from;
  
  if (msg.type === 'batch-request') {
    const keys = await Promise.all(msg.files.map(f => importKey(f.key)));
    if (!state.peers[msg.from]) { state.activeRequest = null; drainRequestQueue(); return; }
    state.batchRecvState[msg.batchId] = {
      total: msg.files.length,
      blobs: [],
      sizes: {},
      filenames: {},
      totalSize: msg.totalSize
    };
    msg.files.forEach((f, i) => {
      state.decryptKeys[f.fileId] = keys[i];
      state.fileBatch[f.fileId] = msg.batchId;
      state.batchRecvState[msg.batchId].sizes[f.fileId] = f.size;
      state.batchRecvState[msg.batchId].filenames[f.fileId] = f.filename;
    });
    addBatchTransferItem(msg.batchId, msg.files.length, msg.totalSize, 'recv', peerName);
    send({ type: 'batch-accept', to: msg.from, batchId: msg.batchId });
  } else {
    state.decryptKeys[msg.fileId] = await importKey(msg.key);
    if (!state.peers[msg.from]) { delete state.decryptKeys[msg.fileId]; state.activeRequest = null; drainRequestQueue(); return; }
    addTransferItem(msg.fileId, msg.filename, msg.size, 'recv', peerName);
    send({ type: 'transfer-accept', to: msg.from, fileId: msg.fileId });
  }

  state.activeRequest = null;
  drainRequestQueue();
});

document.getElementById('btn-decline').addEventListener('click', () => {
  const msg = state.activeRequest;
  if (!msg) return;
  
  if (msg.type === 'batch-request') {
    send({ type: 'batch-decline', to: msg.from, batchId: msg.batchId });
  } else {
    send({ type: 'transfer-decline', to: msg.from, fileId: msg.fileId });
  }
  
  state.activeRequest = null;
  drainRequestQueue();
});
