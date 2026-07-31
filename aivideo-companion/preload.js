// preload.js — bridge between the loaded web app and Electron internals.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("inspiretechCompanion", {
  isDesktop: true,
  getAppVersion: () => ipcRenderer.invoke("inspiretech:update:version"),
  checkForUpdates: () => ipcRenderer.invoke("inspiretech:update:check"),
  downloadUpdate: () => ipcRenderer.invoke("inspiretech:update:download"),
  installUpdate: () => ipcRenderer.invoke("inspiretech:update:install"),
  openReleasePage: () => ipcRenderer.invoke("inspiretech:update:open-release-page"),
  onUpdateEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("inspiretech:update:event", listener);
    return () => ipcRenderer.removeListener("inspiretech:update:event", listener);
  },
  getSetupStatus: () => ipcRenderer.invoke("inspiretech:setup:status"),
  resetDriverSetup: (options) => ipcRenderer.invoke("inspiretech:setup:reset-for-install", options),
  installDrivers: (options) => ipcRenderer.invoke("inspiretech:setup:install-all", options),
  installAudioDriver: (options) => ipcRenderer.invoke("inspiretech:setup:install-audio", options),
  setSkipAudio: (skipAudio) => ipcRenderer.invoke("inspiretech:setup:set-skip-audio", skipAudio),
  completeSetup: () => ipcRenderer.invoke("inspiretech:setup:complete"),
  sendFrame: (arrayBuffer) => {
    ipcRenderer.send("inspiretech:frame", arrayBuffer);
  },
  configureVirtualCam: ({ width, height }) =>
    ipcRenderer.invoke("inspiretech:feeder:configure", { width, height }),
  startVirtualCamFeeder: () => ipcRenderer.invoke("inspiretech:feeder:start"),
  startAudio: (sampleRate) => {
    ipcRenderer.send("inspiretech:audio-start", sampleRate);
  },
  sendAudio: (arrayBuffer) => {
    ipcRenderer.send("inspiretech:audio-chunk", arrayBuffer);
  },
  stopAudio: () => {
    ipcRenderer.send("inspiretech:audio-stop");
  },
  onForceTeardown: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("inspiretech:force-teardown", listener);
    return () => ipcRenderer.removeListener("inspiretech:force-teardown", listener);
  },
});
