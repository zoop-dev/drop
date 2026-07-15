const APP_VERSION = 'v52';

const CHANGELOG = [
  {
    version: 'v52',
    changes: [
      'sender progress bar pauses when the other device disconnects mid-transfer',
      'transfer resumes from the correct position when they reconnect',
      'periodic ACKs keep sender and receiver in sync'
    ]
  },
  {
    version: 'v51',
    changes: [
      'golden dot on peer card when connected via P2P'
    ]
  },
  {
    version: 'v50',
    changes: [
      'show update banner with reload button when a newer version is detected in the room'
    ]
  },
  {
    version: 'v49',
    changes: [
      'P2P DataChannel carries binary file chunks only; control messages stay on WebSocket'
    ]
  },
  {
    version: 'v48',
    changes: [
      'version sync on connect — outdated client auto-reloads to match the room'
    ]
  },
  {
    version: 'v47',
    changes: [
      'WebRTC P2P upgrade — transfers go directly between devices when possible, falling back to relay if needed'
    ]
  },
  {
    version: 'v46',
    changes: [
      'show transfer duration and average speed after send/receive completes'
    ]
  },
  {
    version: 'v45',
    changes: [
      'fix compression deadlock that caused large files to hang at "Compressing..."',
      'skip compression for PDFs (already internally compressed)'
    ]
  },
  {
    version: 'v44',
    changes: [
      'show "Compressing..." status while preparing large files before send'
    ]
  },
  {
    version: 'v43',
    changes: [
      'fix lobby crash when clicking Connect on a stale toast after disconnect',
      'fix lobby accept crashing if connection drops during room creation',
      'fix decryption failure leaving orphaned receive state that blocks future transfers',
      'fix peer-gone race in Accept leaving a stuck "Receiving..." item with no cleanup',
      'fix sending to multiple peers creating duplicate DOM IDs (broken progress)',
      'fix lobby back→home leaving nickname input frozen',
      'fix simultaneous lobby connect-requests clobbering each other',
      'fix reconnect causing a tight retry loop on complete network loss (now 1s delay)',
      'fix share folder upload bypassing 5 MB size guard',
      'fix ETA display at segment boundaries (e.g. "60s" → "1m 0s")',
      'free compressed send buffer from memory after transfer completes'
    ]
  },
  {
    version: 'v42',
    changes: [
      'reconnect resilience: transfers resume automatically if either device briefly disconnects',
      '7-second grace period before a dropped connection is treated as a failure'
    ]
  },
  {
    version: 'v41',
    changes: [
      'receive-side transfer speed and ETA'
    ]
  },
  {
    version: 'v39',
    changes: [
      'fix auto-accept silently failing (transfer stuck at "Waiting for acceptance...")',
      'fix duplicate room creation when clicking Create room',
      'fix files sending twice on paste'
    ]
  },
  {
    version: 'v38',
    changes: [
      'fix duplicate transfer items when receiving with auto-accept'
    ]
  },
  {
    version: 'v37',
    changes: [
      'light mode fixes across all components',
      'tippy tooltips on all buttons',
      'zoop badge'
    ]
  },
  {
    version: 'v31',
    changes: [
      'modular architecture, improved stability',
      'theme toggle (dark/light)',
      'peer OS/browser display',
      'rename share links',
      'collapse completed transfers'
    ]
  },
  {
    version: 'v30',
    changes: [
      'tab title badge when files arrive',
      'paste to send files or text'
    ]
  },
  {
    version: 'v29',
    changes: [
      'better file batching',
      'added nearby matching for devices on the same network as you'
    ]
  },
  {
    version: 'v28',
    changes: [
      'E2EE for text sharing',
      'general tweaks and improvments'
    ]
  }
];
