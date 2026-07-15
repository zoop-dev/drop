#!/usr/bin/env node
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = __dirname;

const count = parseInt(execSync('git rev-list --count HEAD', { cwd: root }).toString().trim()) + 1;
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '') + count;

const varsPath = path.join(root, 'public/src/vars.js');
const varsOrig = fs.readFileSync(varsPath, 'utf8');
fs.writeFileSync(varsPath, varsOrig.replace(/const APP_VERSION = 'v\d+';/, `const APP_VERSION = 'v${count}';`));

const swPath = path.join(root, 'public/sw.js');
const swOrig = fs.readFileSync(swPath, 'utf8');
fs.writeFileSync(swPath, swOrig.replace(/const CACHE = 'drop-[^']+';/, `const CACHE = 'drop-${stamp}';`));

console.log(`Deploying v${count} (cache: drop-${stamp})`);

const result = spawnSync('npx', ['wrangler', 'deploy'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

// Restore version strings so working copy stays clean
fs.writeFileSync(varsPath, varsOrig);
fs.writeFileSync(swPath, swOrig);

process.exit(result.status ?? 0);
