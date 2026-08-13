const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

require('./index.js');

const exe = path.join(__dirname, 'cloudflared.exe');
if (!fs.existsSync(exe)) {
  console.error('cloudflared.exe is missing from the server folder.');
  console.error('Download it from https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe');
  process.exit(1);
}

console.log('Starting tunnel, this takes a few seconds...');
const tunnel = spawn(exe, ['tunnel', '--url', 'http://localhost:' + (process.env.PORT || 8080)]);

let shown = false;
function scan(chunk) {
  if (shown) return;
  const m = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m) {
    shown = true;
    const wss = m[0].replace('https://', 'wss://');
    console.log('');
    console.log('==================================================');
    console.log('  Your whip server is live at:');
    console.log('');
    console.log('  ' + wss);
    console.log('');
    console.log('  Put this URL in the OpenWhip setup window on');
    console.log('  BOTH computers, pick the same room code, save.');
    console.log('');
    console.log('  Keep this window open while playing.');
    console.log('  The URL changes every time you restart this.');
    console.log('==================================================');
  }
}
tunnel.stdout.on('data', scan);
tunnel.stderr.on('data', scan);
tunnel.on('exit', code => {
  console.error('Tunnel closed (exit code ' + code + ').');
  process.exit(1);
});
