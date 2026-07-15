const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};
const DC_BUFFER_HIGH = 256 * 1024;

function rtcSupported() {
  return typeof RTCPeerConnection !== 'undefined';
}

function setupDataChannel(peerId, dc) {
  dc.binaryType = 'arraybuffer';
  state.rtcPeers[peerId].dc = dc;
  dc.onopen = () => {
    state.rtcPeers[peerId].ready = true;
    renderPeers();
  };
  dc.onclose = () => {
    if (state.rtcPeers[peerId]) state.rtcPeers[peerId].ready = false;
    renderPeers();
  };
  dc.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) handleBinaryMessage(e.data);
  };
  dc.onerror = () => cleanupRtcPeer(peerId);
}

async function initiateRtc(peerId) {
  if (!rtcSupported() || state.rtcPeers[peerId]) return;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.rtcPeers[peerId] = { pc, dc: null, ready: false };
  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'rtc-ice', to: peerId, candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') cleanupRtcPeer(peerId);
  };
  const dc = pc.createDataChannel('drop', { ordered: true });
  setupDataChannel(peerId, dc);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'rtc-offer', to: peerId, sdp: pc.localDescription });
  } catch {
    cleanupRtcPeer(peerId);
  }
}

async function handleRtcOffer(msg) {
  if (!rtcSupported()) return;
  cleanupRtcPeer(msg.from);
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.rtcPeers[msg.from] = { pc, dc: null, ready: false };
  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'rtc-ice', to: msg.from, candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') cleanupRtcPeer(msg.from);
  };
  pc.ondatachannel = (e) => setupDataChannel(msg.from, e.channel);
  try {
    await pc.setRemoteDescription(msg.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: 'rtc-answer', to: msg.from, sdp: pc.localDescription });
  } catch {
    cleanupRtcPeer(msg.from);
  }
}

async function handleRtcAnswer(msg) {
  const p = state.rtcPeers[msg.from];
  if (!p) return;
  try { await p.pc.setRemoteDescription(msg.sdp); } catch {}
}

async function handleRtcIce(msg) {
  const p = state.rtcPeers[msg.from];
  if (!p) return;
  try { await p.pc.addIceCandidate(msg.candidate); } catch {}
}

function cleanupRtcPeer(peerId) {
  const p = state.rtcPeers[peerId];
  if (!p) return;
  try { p.dc?.close(); } catch {}
  try { p.pc.close(); } catch {}
  delete state.rtcPeers[peerId];
}
