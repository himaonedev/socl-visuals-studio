const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splash', {
  onUpdate: (cb) => ipcRenderer.on('splash-update', (_e, d) => cb(d)),
});
