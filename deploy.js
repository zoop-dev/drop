#!/usr/bin/env node
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const root = __dirname;

const count = parseInt(execSync('git rev-list --count HEAD', { cwd: root }).toString().trim()) + 1;
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '') + count;

const varsPath = path.join(root, 'public/src/vars.js');
fs.writeFileSync(varsPath, fs.readFileSync(varsPath, 'utf8')
  .replace(/const APP_VERSION = 'v\d+';/, `const APP_VERSION = 'v${count}';`));

const swPath = path.join(root, 'public/sw.js');
fs.writeFileSync(swPath, fs.readFileSync(swPath, 'utf8')
  .replace(/const CACHE = 'drop-[^']+';/, `const CACHE = 'drop-${stamp}';`));

console.log(`Deploying v${count} (cache: drop-${stamp})`);

// Minify JS files in-place for deploy, restore readable source afterward
const jsDirs = [path.join(root, 'public/src')];
const originals = {};

(async () => {
  for (const dir of jsDirs) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.js')) continue;
      const fullPath = path.join(dir, file);
      const src = fs.readFileSync(fullPath, 'utf8');
      originals[fullPath] = src;
      const result = await minify(src, { ecma: 2020, compress: true, mangle: true });
      if (result.code) fs.writeFileSync(fullPath, result.code);
    }
  }

  const result = spawnSync('npx', ['wrangler', 'deploy'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });

  // Restore readable source
  for (const [p, src] of Object.entries(originals)) fs.writeFileSync(p, src);

  process.exit(result.status ?? 0);
})();
