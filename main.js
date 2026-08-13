const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, clipboard, session, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const WebSocket = require('ws');

let tray, overlay, setupWin;
let overlayReady = false;
let spawnQueued = false;
let config = null;
let ws = null;
let wsConnected = false;
let reconnectTimer = null;
let tunnelProc = null;
let hostedUrl = null;
let hosting = false;
let lastWsError = null;
let knockTimer = null;
let ownWhipUp = false;
const clientId = Math.random().toString(36).slice(2, 10);

let setCursorPos = null;
let altDownFn = null;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const winSetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
    setCursorPos = (x, y) => winSetCursorPos(x, y);
    const winGetAsyncKeyState = user32.func('int16_t __stdcall GetAsyncKeyState(int vKey)');
    altDownFn = () => (winGetAsyncKeyState(0x12) & 0x8000) !== 0;
  } catch (e) {
    console.warn('koffi not available, mouse knockback disabled:', e.message);
  }
} else if (process.platform === 'linux') {
  setCursorPos = (x, y) => {
    execFile('xdotool', ['mousemove', String(x), String(y)], () => {});
  };
  try {
    const koffi = require('koffi');
    const x11 = koffi.load('libX11.so.6');
    const XOpenDisplay = x11.func('void *XOpenDisplay(const char *name)');
    const XQueryKeymap = x11.func('int XQueryKeymap(void *display, _Out_ uint8_t keys[32])');
    const disp = XOpenDisplay(null);
    if (disp) {
      const keymap = new Uint8Array(32);
      altDownFn = () => {
        XQueryKeymap(disp, keymap);
        return !!((keymap[8] & 0x01) || (keymap[13] & 0x10));
      };
    }
  } catch (e) {
    console.warn('X11 alt detection unavailable, gun will auto-fire:', e.message);
  }
}

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

const configPath = () => path.join(app.getPath('userData'), 'whip-config.json');

function normalizeConfig(cfg) {
  if (!cfg) return null;
  return {
    role: ['whipper', 'victim', 'solo'].includes(cfg.role) ? cfg.role : 'whipper',
    room: String(cfg.room || '').trim(),
    server: String(cfg.server || '').trim(),
    name: String(cfg.name || '').trim().slice(0, 20),
    color: /^#[0-9a-fA-F]{6}$/.test(cfg.color || '') ? cfg.color : '#000000',
    cursor: /^[\w.-]+\.png$/.test(cfg.cursor || '') ? cfg.cursor : 'default',
    muted: !!cfg.muted,
    whip: ['normal', 'long', 'fire', 'machine', 'gun'].includes(cfg.whip) ? cfg.whip : 'normal',
    volume: typeof cfg.volume === 'number' ? Math.max(0, Math.min(1, cfg.volume)) : 1,
    clickThrough: !!cfg.clickThrough,
  };
}

function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(configPath(), 'utf8')));
  } catch {
    return null;
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.warn('could not save config:', e.message);
  }
}

function getTrayIcon() {
  const img = nativeImage.createFromPath(ICON_PATH);
  if (img.isEmpty()) return nativeImage.createEmpty();
  const size = process.platform === 'darwin' ? 22 : 16;
  return img.resize({ width: size, height: size });
}

function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlayReady = false;
  overlay.loadFile('overlay.html');
  overlay.webContents.on('did-finish-load', () => {
    overlayReady = true;
    overlay.webContents.send(
      'set-mode',
      config && config.role === 'victim' ? 'remote' : 'local',
      config ? config.color : '#000000',
      config ? config.name : '',
      !!(config && config.muted),
      config ? config.volume : 1,
      config ? config.whip : 'normal',
      !!(config && config.clickThrough),
      !!altDownFn
    );
    if (spawnQueued && overlay && overlay.isVisible()) {
      spawnQueued = false;
      overlay.webContents.send('spawn-whip');
    }
  });
  overlay.on('closed', () => {
    overlay = null;
    overlayReady = false;
    spawnQueued = false;
    ownWhipUp = false;
    syncSetupZ();
  });
  overlay.webContents.on('render-process-gone', () => {
    if (overlay) {
      try { overlay.destroy(); } catch {}
    }
    overlay = null;
    overlayReady = false;
    spawnQueued = false;
    ownWhipUp = false;
    syncSetupZ();
  });
}

function syncSetupZ() {
  if (!setupWin) return;
  if (overlay && overlay.isVisible()) {
    setupWin.setAlwaysOnTop(true, 'screen-saver', 1);
    setupWin.moveTop();
  } else {
    setupWin.setAlwaysOnTop(false);
  }
}

function ensureOverlay() {
  if (!overlay) createOverlay();
  overlay.show();
  syncSetupZ();
}

function showAndSpawn() {
  ensureOverlay();
  ownWhipUp = true;
  if (overlayReady) {
    overlay.webContents.send('spawn-whip');
  } else {
    spawnQueued = true;
  }
}

function toggleOverlay() {
  if (ownWhipUp && overlay && overlay.isVisible()) {
    overlay.webContents.send('drop-whip');
    return;
  }
  showAndSpawn();
  send({ type: 'spawn' });
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ...msg, id: clientId }));
  }
}

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.close();
    } catch {}
    ws = null;
  }
  wsConnected = false;
  if (!config || config.role === 'solo' || !config.server || !config.room) {
    updateTray();
    return;
  }

  try {
    ws = new WebSocket(config.server);
  } catch (e) {
    console.warn('bad server url:', e.message);
    updateTray();
    return;
  }

  ws.on('open', () => {
    wsConnected = true;
    lastWsError = null;
    send({ type: 'join', room: config.room });
    if (config.role === 'whipper' && overlay && overlay.isVisible()) {
      send({ type: 'spawn' });
    }
    updateTray();
  });

  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleRemote(msg);
  });

  ws.on('error', err => {
    console.warn('ws error:', err.message);
    lastWsError = friendlyWsError(err.message);
    updateTray();
  });

  ws.on('close', () => {
    wsConnected = false;
    updateTray();
    reconnectTimer = setTimeout(connect, 3000);
  });
}

function friendlyWsError(msg) {
  if (!msg) return null;
  if (msg.includes('530')) return 'that server link is dead or wrong, get the newest link';
  if (msg.includes('ENOTFOUND')) return 'server address not found, check the link';
  if (msg.includes('ECONNREFUSED')) return 'nothing is running at that address';
  return msg.slice(0, 60);
}

function handleRemote(msg) {
  try {
    handleRemoteInner(msg);
  } catch (e) {
    console.warn('handleRemote failed:', e.message);
  }
}

function handleRemoteInner(msg) {
  const id = typeof msg.id === 'string' ? msg.id.slice(0, 16) : '';
  if (!id || id === clientId) return;
  if (msg.type === 'spawn') {
    ensureOverlay();
    return;
  }
  if (msg.type === 'knock') {
    if (typeof msg.vx !== 'number' || typeof msg.vy !== 'number') return;
    if (msg.to === clientId && config.role === 'victim') {
      knockCursor(msg.vx, msg.vy);
      if (msg.k === 'gun' && overlay && overlayReady && overlay.isVisible()) {
        overlay.webContents.send('self-hit', msg.vx, msg.vy);
      }
    } else if (overlay && overlayReady && overlay.isVisible()) {
      overlay.webContents.send('other-hit', String(msg.to || ''), msg.vx, msg.vy, msg.k === 'gun' ? 'gun' : 'whip');
    }
    return;
  }
  if (msg.type === 'whip' && Array.isArray(msg.p)) {
    if (!overlay || !overlay.isVisible()) ensureOverlay();
    if (overlay && overlayReady) overlay.webContents.send('remote-whip', id, msg.p, msg.c, msg.t, msg.n, msg.m, msg.g, msg.b);
    return;
  }
  if (!overlay || !overlayReady) return;
  if (msg.type === 'gone') {
    overlay.webContents.send('remote-gone', id);
  } else if (msg.type === 'crack') {
    overlay.webContents.send('remote-crack', msg.t, msg.x);
  } else if (msg.type === 'vmouse' && typeof msg.x === 'number' && typeof msg.y === 'number') {
    if (overlay.isVisible()) overlay.webContents.send('victim-mouse', id, msg.x, msg.y, msg.n, msg.c, msg.cur);
  }
}

function readCursor() {
  if (process.platform === 'linux') {
    try {
      const out = require('child_process')
        .execFileSync('xdotool', ['getmouselocation', '--shell'], { timeout: 500 })
        .toString();
      const mx = /X=(-?\d+)/.exec(out);
      const my = /Y=(-?\d+)/.exec(out);
      if (mx && my) return { x: parseInt(mx[1], 10), y: parseInt(my[1], 10) };
    } catch {}
  }
  const p = screen.getCursorScreenPoint();
  if (process.platform === 'win32' && typeof screen.dipToScreenPoint === 'function') {
    try { return screen.dipToScreenPoint(p); } catch {}
  }
  return p;
}

function knockCursor(vx, vy) {
  if (!setCursorPos) return;
  let b;
  if (process.platform === 'linux') {
    b = { x: 0, y: 0, width: 1920, height: 1080 };
    try {
      const g = require('child_process')
        .execFileSync('xdotool', ['getdisplaygeometry'], { timeout: 500 })
        .toString().trim().split(/\s+/);
      const gw = parseInt(g[0], 10);
      const gh = parseInt(g[1], 10);
      if (gw > 0 && gh > 0) { b.width = gw; b.height = gh; }
    } catch {}
  } else {
    b = screen.getPrimaryDisplay().bounds;
    if (process.platform === 'win32' && typeof screen.dipToScreenRect === 'function') {
      try { b = screen.dipToScreenRect(null, b); } catch {}
    }
  }
  const start = readCursor();
  let x = start.x;
  let y = start.y;
  let lastWX = Math.round(x);
  let lastWY = Math.round(y);
  const composeUserInput = process.platform === 'win32';
  if (knockTimer) clearInterval(knockTimer);
  let ticks = 0;
  knockTimer = setInterval(() => {
    if (composeUserInput) {
      const p = readCursor();
      const ux = p.x - lastWX;
      const uy = p.y - lastWY;
      if (Math.abs(ux) + Math.abs(uy) < 300) {
        x += ux;
        y += uy;
      }
    }
    x += vx;
    y += vy;
    vx *= 0.93;
    vy *= 0.93;
    let impact = 0;
    if (x < b.x) { x = b.x; impact = Math.abs(vx); vx = Math.abs(vx) * 0.65; }
    else if (x > b.x + b.width - 1) { x = b.x + b.width - 1; impact = Math.abs(vx); vx = -Math.abs(vx) * 0.65; }
    if (y < b.y) { y = b.y; impact = Math.max(impact, Math.abs(vy)); vy = Math.abs(vy) * 0.65; }
    else if (y > b.y + b.height - 1) { y = b.y + b.height - 1; impact = Math.max(impact, Math.abs(vy)); vy = Math.abs(vy) * 0.65 * -1; }
    if (impact > 12 && overlay && overlayReady && overlay.isVisible()) {
      overlay.webContents.send('wall-thud', Math.min(1, impact / 70), (x - b.x) / b.width);
    }
    lastWX = Math.round(x);
    lastWY = Math.round(y);
    setCursorPos(lastWX, lastWY);
    ticks++;
    if (ticks > 150 || (Math.abs(vx) < 0.7 && Math.abs(vy) < 0.7)) {
      clearInterval(knockTimer);
      knockTimer = null;
    }
  }, 16);
}

function sendHostResult(result) {
  if (setupWin) setupWin.webContents.send('host-result', result);
}

function startHosting() {
  if (hostedUrl) {
    sendHostResult({ url: hostedUrl });
    return;
  }
  if (hosting) return;
  hosting = true;

  let startRelay;
  try {
    startRelay = require('./server/relay').startRelay;
  } catch (e) {
    hosting = false;
    sendHostResult({ error: 'The server folder is missing.' });
    return;
  }

  const exe = process.platform === 'win32'
    ? path.join(__dirname, 'server', 'cloudflared.exe')
    : 'cloudflared';
  if (process.platform === 'win32' && !fs.existsSync(exe)) {
    hosting = false;
    sendHostResult({ error: 'cloudflared.exe is missing from the server folder.' });
    return;
  }

  const port = 8080;
  startRelay(port, () => {
    tunnelProc = spawn(exe, ['tunnel', '--url', 'http://localhost:' + port]);
    const scan = chunk => {
      if (hostedUrl) return;
      const m = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        hostedUrl = m[0].replace('https://', 'wss://');
        hosting = false;
        clipboard.writeText(hostedUrl);
        sendHostResult({ url: hostedUrl });
      }
    };
    tunnelProc.stdout.on('data', scan);
    tunnelProc.stderr.on('data', scan);
    tunnelProc.on('error', () => {
      hosting = false;
      sendHostResult({ error: 'Could not start the tunnel.' });
    });
    tunnelProc.on('exit', () => {
      tunnelProc = null;
      if (!hostedUrl) {
        hosting = false;
        sendHostResult({ error: 'The tunnel closed unexpectedly.' });
      }
      hostedUrl = null;
    });
  }, err => {
    hosting = false;
    if (err.code === 'EADDRINUSE') {
      sendHostResult({ error: 'Port 8080 is already in use. Is the server already running?' });
    } else {
      sendHostResult({ error: 'Could not start the server: ' + err.message });
    }
  });
}

function openSetup() {
  if (setupWin) {
    setupWin.focus();
    syncSetupZ();
    return;
  }
  setupWin = new BrowserWindow({
    width: 400,
    height: 1020,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'WhipApp',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload-setup.js'),
    },
  });
  setupWin.setMenuBarVisibility(false);
  setupWin.loadFile('setup.html');
  setupWin.on('closed', () => { setupWin = null; });
  syncSetupZ();
}

ipcMain.handle('read-sound', (e, name) => {
  const safe = path.basename(String(name));
  return fs.readFileSync(path.join(__dirname, 'sounds', safe)).toString('base64');
});
ipcMain.on('whip-crack', (e, x) => send({
  type: 'crack',
  t: config ? config.whip : 'normal',
  x: typeof x === 'number' ? x : 0.5,
}));
ipcMain.on('whip-drop', () => {});
ipcMain.on('whip-state', (e, state) => {
  if (!state || !Array.isArray(state.p)) return;
  send({
    type: 'whip',
    p: state.p,
    m: Array.isArray(state.m) ? state.m : undefined,
    g: Array.isArray(state.g) ? state.g : undefined,
    b: Array.isArray(state.b) ? state.b : undefined,
    c: config ? config.color : '#000000',
    t: config ? config.whip : 'normal',
    n: config ? config.name : '',
  });
});
ipcMain.on('hide-overlay', () => {
  if (overlay) overlay.hide();
  syncSetupZ();
});
ipcMain.on('set-protect', (e, on) => {
  if (overlay) {
    try { overlay.setContentProtection(!!on); } catch {}
  }
});
ipcMain.on('own-gone', () => {
  ownWhipUp = false;
  send({ type: 'gone' });
});
ipcMain.on('set-capture', (e, capture) => {
  if (!overlay) return;
  if (config && config.role === 'victim') return;
  if (config && config.clickThrough && capture) return;
  overlay.setIgnoreMouseEvents(!capture);
});
ipcMain.on('mouse-knock', (e, vx, vy) => {
  if (config && config.role === 'victim' && typeof vx === 'number' && typeof vy === 'number') {
    knockCursor(vx, vy);
  }
});
ipcMain.on('send-hit', (e, vid, vx, vy, kind) => {
  if (typeof vid === 'string' && typeof vx === 'number' && typeof vy === 'number') {
    send({ type: 'knock', to: vid, vx, vy, k: kind === 'gun' ? 'gun' : undefined });
  }
});
ipcMain.on('host-server', () => startHosting());
ipcMain.on('copy-server-url', (e, url) => {
  if (url) clipboard.writeText(String(url).trim());
});
ipcMain.on('exit-app', () => app.quit());

ipcMain.handle('get-setup', () => {
  const base = config || { role: 'whipper', room: '', server: '', name: '', color: '#000000', cursor: 'default', muted: false };
  let cursors = [];
  try {
    cursors = fs.readdirSync(path.join(__dirname, 'assets', 'cursors'))
      .filter(f => f.toLowerCase().endsWith('.png'))
      .sort();
  } catch {}
  return { ...base, hostedUrl, status: trayStatus(), cursors };
});

ipcMain.on('save-setup', (e, cfg) => {
  let server = String(cfg.server || '').trim();
  if (/^https:\/\//i.test(server)) server = 'wss://' + server.slice(8);
  else if (/^http:\/\//i.test(server)) server = 'ws://' + server.slice(7);
  else if (server && !/^wss?:\/\//i.test(server)) server = 'wss://' + server;
  config = normalizeConfig({ ...cfg, server, muted: !!(config && config.muted) });
  lastWsError = null;
  saveConfig(config);
  if (setupWin) setupWin.close();
  if (overlay) {
    overlay.destroy();
    overlay = null;
    overlayReady = false;
    spawnQueued = false;
  }
  connect();
  updateTray();
  if (config.role !== 'victim') toggleOverlay();
});

function toggleMute() {
  if (!config) return;
  config.muted = !config.muted;
  saveConfig(config);
  updateTray();
  if (overlay && overlayReady) overlay.webContents.send('set-muted', config.muted);
  if (setupWin) setupWin.webContents.send('muted-changed', config.muted);
}

function trayStatus() {
  if (!config) return 'not set up yet';
  if (config.role === 'solo') return 'solo mode';
  const who = config.role === 'whipper' ? 'whipper' : 'victim';
  if (wsConnected) return `${who}, room "${config.room}", connected`;
  let s = `${who}, room "${config.room}", not connected`;
  if (lastWsError) s += ` (${lastWsError})`;
  return s;
}

function updateTray() {
  if (setupWin) {
    try { setupWin.webContents.send('status', trayStatus()); } catch {}
  }
  if (!tray) return;
  tray.setToolTip(`WhipApp (${trayStatus()})`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: trayStatus(), enabled: false },
      { type: 'separator' },
      { label: 'Mute sounds', type: 'checkbox', checked: !!(config && config.muted), enabled: !!config, click: toggleMute },
      { label: 'Settings', click: openSetup },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

function onTrayClick() {
  if (!config) {
    openSetup();
    return;
  }
  if (config.role === 'victim') {
    openSetup();
    return;
  }
  toggleOverlay();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openSetup());

  app.whenReady().then(() => {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then(sources => {
        const primaryId = String(screen.getPrimaryDisplay().id);
        const src = sources.find(s => s.display_id === primaryId) || sources[0];
        callback(src ? { video: src } : {});
      }).catch(() => callback({}));
    });

    config = loadConfig();
    tray = new Tray(getTrayIcon());
    updateTray();
    tray.on('click', onTrayClick);
    openSetup();
    if (config) connect();

    let pollTick = 0;
    let altWasDown = false;
    setInterval(() => {
      if (!config) return;
      pollTick++;
      const b = screen.getPrimaryDisplay().bounds;
      const p = screen.getCursorScreenPoint();
      if (overlay && overlayReady && overlay.isVisible()) {
        overlay.webContents.send('local-mouse', p.x - b.x, p.y - b.y);
        if (altDownFn && config.role !== 'victim') {
          let altDown = false;
          try { altDown = altDownFn(); } catch {}
          if (altDown && !altWasDown) {
            overlay.webContents.send('fire-gun');
          }
          altWasDown = altDown;
        }
      }
      if (config.role === 'victim' && wsConnected && pollTick % 2 === 0) {
        send({
          type: 'vmouse',
          x: (p.x - b.x) / b.width,
          y: (p.y - b.y) / b.height,
          n: config.name,
          c: config.color,
          cur: config.cursor,
        });
      }
    }, 16);
  });
}

app.on('window-all-closed', e => e.preventDefault());

app.on('will-quit', () => {
  if (tunnelProc) {
    try { tunnelProc.kill(); } catch {}
    tunnelProc = null;
  }
});
