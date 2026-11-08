const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('licenseAPI', {
  activate:        (email, licenseKey) => ipcRenderer.invoke('license:activate', { email, licenseKey }),
  openPurchase:    ()                  => ipcRenderer.invoke('license:openPurchase'),
  notifyActivated: ()                  => ipcRenderer.send('license:activated'),
});
