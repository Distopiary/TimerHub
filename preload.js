// Pont sécurisé entre l'interface et le processus principal.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('timerhub', {
  launch: (type, target) => ipcRenderer.invoke('launch', type, target),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  pickExe: () => ipcRenderer.invoke('pick-exe'),
  notify: (title, body) => ipcRenderer.invoke('notify', title, body),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getUpdate: () => ipcRenderer.invoke('update:get'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (_e, version) => cb(version)),
});
