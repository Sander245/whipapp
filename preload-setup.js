const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  get: () => ipcRenderer.invoke('get-setup'),
  save: (cfg) => ipcRenderer.send('save-setup', cfg),
  hostServer: () => ipcRenderer.send('host-server'),
  onHostResult: (fn) => ipcRenderer.on('host-result', (e, result) => fn(result)),
  onStatus: (fn) => ipcRenderer.on('status', (e, status) => fn(status)),
  onMutedChanged: (fn) => ipcRenderer.on('muted-changed', (e, muted) => fn(muted)),
  copyServer: (url) => ipcRenderer.send('copy-server-url', url),
  exitApp: () => ipcRenderer.send('exit-app'),
});
