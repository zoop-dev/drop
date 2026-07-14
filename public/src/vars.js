const APP_VERSION = 'v42';

const CHANGELOG = [
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
