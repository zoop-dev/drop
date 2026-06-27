#!/usr/bin/env node
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = __dirname;

const count = parseInt(execSync('git rev-list --count HEAD', { cwd: root }).toString().trim()) + 1;
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '') + count;

const htmlPath = path.join(root, 'public/index.html');
fs.writeFileSync(htmlPath, fs.readFileSync(htmlPath, 'utf8')
  .replace(/<span class="version-badge">v\d+<\/span>/, `<span class="version-badge">v${count}</span>`));

const swPath = path.join(root, 'public/sw.js');
fs.writeFileSync(swPath, fs.readFileSync(swPath, 'utf8')
  .replace(/const CACHE = 'drop-[^']+';/, `const CACHE = 'drop-${stamp}';`));

console.log(`Deploying v${count} (cache: drop-${stamp})`);

const result = spawnSync('npx', ['wrangler', 'deploy'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: '5745d698d83c15e655924b25248a3029' },
});

process.exit(result.status ?? 0);
