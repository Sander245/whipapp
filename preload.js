const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  whipCrack: () => ipcRenderer.send('whip-crack'),
  whipDrop: () => ipcRenderer.send('whip-drop'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  ownGone: () => ipcRenderer.send('own-gone'),
  setCapture: (capture) => ipcRenderer.send('set-capture', capture),
  setProtect: (on) => ipcRenderer.send('set-protect', on),
  sendWhipState: (state) => ipcRenderer.send('whip-state', state),
  sendMouseKnock: (vx, vy) => ipcRenderer.send('mouse-knock', vx, vy),
  sendHit: (vid, vx, vy) => ipcRenderer.send('send-hit', vid, vx, vy),
  onVictimMouse: (fn) => ipcRenderer.on('victim-mouse', (e, id, x, y, name, color, cur) => fn(id, x, y, name, color, cur)),
  onLocalMouse: (fn) => ipcRenderer.on('local-mouse', (e, x, y) => fn(x, y)),
  onSpawnWhip: (fn) => ipcRenderer.on('spawn-whip', () => fn()),
  onDropWhip: (fn) => ipcRenderer.on('drop-whip', () => fn()),
  onSetMode: (fn) => ipcRenderer.on('set-mode', (e, mode, color, name, muted, volume, whipType) => fn(mode, color, name, muted, volume, whipType)),
  onSetMuted: (fn) => ipcRenderer.on('set-muted', (e, muted) => fn(muted)),
  onRemoteWhip: (fn) => ipcRenderer.on('remote-whip', (e, id, pts, color, type, name, machine) => fn(id, pts, color, type, name, machine)),
  onRemoteGone: (fn) => ipcRenderer.on('remote-gone', (e, id) => fn(id)),
  onRemoteCrack: (fn) => ipcRenderer.on('remote-crack', (e, t) => fn(t)),
});
