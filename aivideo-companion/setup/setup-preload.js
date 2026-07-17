const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("inspiretechSetup", {
  getStatus: () => ipcRenderer.invoke("inspiretech:setup:status"),
  installCamera: () => ipcRenderer.invoke("inspiretech:setup:install-camera"),
  installAudio: () => ipcRenderer.invoke("inspiretech:setup:install-audio"),
  installAll: () => ipcRenderer.invoke("inspiretech:setup:install-all"),
  complete: () => ipcRenderer.invoke("inspiretech:setup:complete"),
  openExternal: (url) => ipcRenderer.invoke("inspiretech:setup:open-external", url),
});
