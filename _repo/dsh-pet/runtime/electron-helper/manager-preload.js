'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopManager', {
  get: () => ipcRenderer.invoke('pet-manager:call', 'get'),
  refresh: () => ipcRenderer.invoke('pet-manager:call', 'refresh'),
  update: (id, patch) => ipcRenderer.invoke('pet-manager:call', 'update', { id, patch }),
  preferences: (patch) => ipcRenderer.invoke('pet-manager:call', 'preferences', patch),
  recover: (id) => ipcRenderer.invoke('pet-manager:call', 'recover', { id }),
  hide: () => ipcRenderer.invoke('pet-manager:call', 'hide'),
});
