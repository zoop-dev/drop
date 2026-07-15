const state = {
  roomCode: null,
  myId: null,
  isCreator: false,
  myName: localStorage.getItem('drop-nickname') || getDeviceName(),
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
  cancelledTransfers: new Set(),
  mySubnet: null,
  myV6: null,
  myAddressFamily: null,
  myPubHash: null,
  lobby: null,
  lobbyId: null,
  lobbyPeers: {},
  pendingLobbyConnect: null,
  pendingShareFiles: null,
  activeShareId: null,
  batchProgress: {},
  peersByDid: {},
  reconnectTimers: {},
  sendGeneration: {},
  rtcPeers: {},
  ackCount: {},
};

let connectedResolve = null;
let connectedPromise = null;

let unreadCount = 0;
