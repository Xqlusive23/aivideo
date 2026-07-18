// preload.js — bridge between the loaded web app and Electron internals.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("inspiretechCompanion", {
  isDesktop: true,
  getSetupStatus: () => ipcRenderer.invoke("inspiretech:setup:status"),
  resetDriverSetup: (options) => ipcRenderer.invoke("inspiretech:setup:reset-for-install", options),
  installDrivers: (options) => ipcRenderer.invoke("inspiretech:setup:install-all", options),
  completeSetup: () => ipcRenderer.invoke("inspiretech:setup:complete"),
  sendFrame: (arrayBuffer) => {
    ipcRenderer.send("inspiretech:frame", arrayBuffer);
  },
  startAudio: (sampleRate) => {
    ipcRenderer.send("inspiretech:audio-start", sampleRate);
  },
  sendAudio: (arrayBuffer) => {
    ipcRenderer.send("inspiretech:audio-chunk", arrayBuffer);
  },
  stopAudio: () => {
    ipcRenderer.send("inspiretech:audio-stop");
  },
});
