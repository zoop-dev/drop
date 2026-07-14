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

function getUAInfo() {
  const ua = navigator.userAgent;
  let os = 'Unknown OS';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Macintosh/.test(ua)) {
    if ('ontouchend' in document) os = 'iOS';
    else os = 'macOS';
  }
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Linux/.test(ua)) os = 'Linux';

  let browser = 'Unknown Browser';
  if (/Chrome/.test(ua) && /Safari/.test(ua) && !/Edge|Edg|OPR|Firefox/.test(ua)) browser = 'Chrome';
  else if (/Safari/.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  else if (/Firefox/.test(ua)) browser = 'Firefox';
  else if (/MSIE|Trident/.test(ua)) browser = 'IE';
  else if (/Edge|Edg/.test(ua)) browser = 'Edge';
  else if (/OPR|Opera/.test(ua)) browser = 'Opera';

  return `${os} · ${browser}`;
}

function fmtSpeed(bps) {
  if (bps < 1024) return bps.toFixed(0) + ' B/s';
  if (bps < 1048576) return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / 1048576).toFixed(1) + ' MB/s';
}

function fmtETA(secs) {
  const t = Math.round(secs);
  if (t < 60) return t + 's';
  return Math.floor(t / 60) + 'm ' + (t % 60) + 's';
}

function ipv6Prefix(addr) {
  let s = String(addr).toLowerCase().split('%')[0];
  if (s === '::1' || s === '::' || s.startsWith('::ffff:')) return null;
  if (!s.includes(':')) return null;
  let groups;
  if (s.includes('::')) {
    const parts = s.split('::');
    const head = parts[0] ? parts[0].split(':') : [];
    const tail = parts[1] ? parts[1].split(':') : [];
    const fill = Math.max(0, 8 - head.length - tail.length);
    groups = head.concat(Array(fill).fill('0'), tail);
  } else {
    groups = s.split(':');
    if (groups.length !== 8) return null;
  }
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  }
  return groups.slice(0, 4).join(':') + '::/64';
}

async function getLocalNetworkIds() {
  return new Promise(resolve => {
    let v4 = null, v6 = null;
    let pc = null;
    const finalize = () => {
      if (pc) try { pc.close(); } catch {}
      resolve({ v4, v6 });
    };
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('');
      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {});
      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        let addr;
        try {
          const parsed = new RTCIceCandidate(e.candidate);
          if (parsed.type !== 'host' || !parsed.address) return;
          addr = parsed.address;
        } catch { return; }
        if (addr.includes(':')) {
          if (!v6) {
            const p = ipv6Prefix(addr);
            if (p) v6 = p;
          }
        } else if (addr.includes('.')) {
          if (!v4 && !addr.startsWith('127.')) {
            const m = addr.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
            if (m) v4 = m[1];
          }
        }
        if (v4 && v6) finalize();
      };
      setTimeout(finalize, 1500);
    } catch { finalize(); }
  });
}

function computeAddressFamily(v4, v6) {
  if (v4 && v6) return 'dual';
  if (v4) return 'v4';
  if (v6) return 'v6';
  return 'none';
}

function isPeerNearby(subnet, subnet6, pubHash) {
  if (state.mySubnet && subnet && subnet === state.mySubnet) return true;
  if (state.myV6 && subnet6 && subnet6 === state.myV6) return true;
  if (state.myPubHash && pubHash && pubHash === state.myPubHash) return true;
  return false;
}

async function processSelectedFiles(fileList) {
  const files = Array.from(fileList);
  const filesToQueue = [];
  
  const folderGroups = {};
  const normalFiles = [];
  
  files.forEach(file => {
    if (file.webkitRelativePath) {
      const parts = file.webkitRelativePath.split('/');
      if (parts.length > 1) {
        const folderName = parts[0];
        if (!folderGroups[folderName]) folderGroups[folderName] = [];
        folderGroups[folderName].push(file);
        return;
      }
    }
    normalFiles.push(file);
  });
  
  for (const folderName of Object.keys(folderGroups)) {
    const groupFiles = folderGroups[folderName];
    const zip = new JSZip();
    groupFiles.forEach(file => {
      zip.file(file.webkitRelativePath, file);
    });
    const content = await zip.generateAsync({ type: 'blob' });
    const zipFile = new File([content], folderName + '.zip', { type: 'application/zip' });
    filesToQueue.push(zipFile);
  }
  
  filesToQueue.push(...normalFiles);
  return filesToQueue;
}
