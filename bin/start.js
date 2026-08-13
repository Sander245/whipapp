#!/usr/bin/env node
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const appDir = path.resolve(__dirname, '..');

function electronBinary() {
  try {
    const p = require('electron');
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  } catch {}
  return null;
}

let bin = electronBinary();

if (!bin) {
  console.log('First run: installing dependencies, this takes a few minutes...');
  const r = spawnSync('npm', ['install'], { cwd: appDir, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error('npm install failed, try running "npm install" yourself.');
    process.exit(1);
  }
  bin = electronBinary();
}

if (!bin) {
  console.log('Electron download was skipped, fetching it directly...');
  const r2 = spawnSync(
    process.execPath,
    [path.join(appDir, 'node_modules', 'electron', 'install.js')],
    { cwd: appDir, stdio: 'inherit', env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '' } }
  );
  if (r2.status !== 0) {
    console.error('Electron install failed. See the Linux notes in README.md.');
    process.exit(1);
  }
  bin = electronBinary();
}

if (!bin) {
  console.error('Could not set up Electron. See README.md for manual steps.');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(bin, [appDir], { detached: true, stdio: 'ignore', env });
child.on('error', err => {
  console.error('Failed to start whipapp:', err.message);
  process.exit(1);
});
child.unref();
console.log('whipapp started.');
